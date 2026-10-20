import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

import { Config, REWRITE_TIMEOUT_MS, type RtkConfig } from './config.js'
import { createSettingsBridge } from './settings-compat.js'
import { READ_COMPACTION_BANNER_PREFIX, compactToolResult } from './compact/index.js'
import { parseBashResult, renderBashResult } from './compact/dsh-result.js'
import { createMetricsTracker } from './metrics.js'
import { createRtkCommand } from './command.js'
import { createGainReader, rtkHistoryDbPath, type GainRequest } from './gain.js'
import { decideExecutableSetting, resolveRtkExecutable, runExecutable, type RtkExecutableResolution } from './rtk-executable.js'
import { scrubbedEnv } from './child-env.js'
import { applyRtkHistoryScope, resolveRtkRewrite, type ShellKind } from './rtk-rewrite.js'
import { isStatusStale, needsAvailabilityProbe, shouldSkipRewrite, type RtkRuntimeStatus } from './runtime-guard.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rtk'

/**
 * Exact browser route for the Gain panel.
 *
 * It lives under the connection's authenticated `/api` prefix because that
 * prefix is the only browser-facing transport the connection service mounts
 * unconditionally; the generic RPC channel's route registration depends on a
 * service its own context cannot reach (HTTP 405).
 */
const GAIN_ROUTE_PATH = '/api/dsh-rtk/gain'

/**
 * The tool runtime is a hard dependency: both halves of this plugin are
 * `tools/*` listeners, and without the registry there is nothing to rewrite or
 * compact.
 *
 * `settings` is deliberately NOT declared. The plugin runs entirely from the
 * composition's `config:` block; the live-settings integration is an upgrade,
 * not a prerequisite, and declaring it required would park rewriting and
 * compaction whenever a composition ships without that service. The service
 * also registers *asynchronously* (it reads the settings document first), so
 * `apply` starts on the composition bridge and swaps in the real one when the
 * service appears — see the `ctx.inject(['settings'], …)` call at the end.
 *
 * `commands` and `systemPrompt` stay optional `ctx.get` lookups: they are
 * registered early enough to be present, and a composition without them should
 * still get the optimization.
 */
export const inject = ['tools']

export { Config }

/**
 * Tools whose `command` argument can be rewritten.
 *
 * `ops_bash` is dsh-ops' own bash tool: same `command` argument and the same
 * trailing `[exit code: N]` marker, so it rides the same rewrite path.
 */
const REWRITABLE_TOOLS = new Set(['bash', 'pwsh', 'ops_bash'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Appended once per session when rtk cannot be found.
 *
 * A missing binary is the only failure that silently costs the user the whole
 * feature, so it is worth one short line — but only one, and only for a
 * session that has not been told yet.
 */
const MISSING_RTK_NOTICE = '[rtk] rtk not found; rewriting is off — /rtk verify shows install options'

/** The guidance injected while lossy read compaction is active. */
const SOURCE_FILTER_TROUBLESHOOTING_NOTE =
  'RTK note: if a file edit repeatedly fails because the old text does not match, read compaction may have altered the copy you are editing against. Ask the user to turn off `readCompaction` in the rtk settings, re-read the file, apply the edit, then turn it back on.'

/** Whether lossy `read` compaction is enabled together with its safeguards. */
function needsSourceFilterNote(config: RtkConfig): boolean {
  return (
    config.mode !== 'off' &&
    config.compact &&
    (config.readCompaction === 'minimal' || config.readCompaction === 'aggressive')
  )
}

/**
 * Register RTK command rewriting and tool-output compaction.
 *
 * Both halves hang off the tool pipeline rather than wrapping a tool:
 *
 * - **Rewriting** rides `tools/execute`. The harness deliberately keeps
 *   `tools/pre-execute` from mutating arguments (they are logged and presented
 *   before dispatch), so the around-dispatch stage is the only seam where the
 *   command that actually runs can differ from the one that was recorded. The
 *   replacement is scoped to the call: the original arguments are restored as
 *   soon as dispatch returns, so later pipeline stages and the session log see
 *   what the model asked for.
 * - **Compaction** rides `tools/post-execute`, which is the stage that may
 *   replace result content.
 *
 * @param ctx - the agent-scoped context this row was mounted into.
 * @param rawConfig - the row's `config:` block, already schema-validated.
 */
export function apply(ctx: Context, rawConfig: RtkConfig): void {
  /**
   * Whether the harness bounds oversized results itself.
   *
   * `dsh-spill-policy` writes a full output to disk and keeps a head/tail
   * preview inline, so it truncates *recoverably*. This plugin's own hard
   * truncation is lossy, and it runs first: at 12 000 characters it fires far
   * below spill's threshold (50 000 by default), so spill never sees a large
   * result at all and the reader loses the spill file that would have let them
   * read the rest. When spill is mounted this plugin steps aside; when it is
   * not, the truncation stays as the only bound on a runaway command.
   */
  const spillHandlesLargeOutput = ctx.get('spillStore') !== undefined

  // Presence of the service is the whole decision; there is no switch, because
  // a switch could only make the reader worse off (see the comment above).

  // The settings seam differs between harness generations (see
  // settings-compat.ts for the two shapes and why detection is by shape). The
  // plugin's own behavior never depends on which one answered: configuration
  // is `bridge.read()`, edits arrive through `bridge.onChange`, and an
  // unrecognized service costs the live-settings integration only.
  let bridge = createSettingsBridge(ctx, rawConfig)
  let config = bridge.read()
  let runtimeStatus: RtkRuntimeStatus = { rtkAvailable: false }
  const metrics = createMetricsTracker()
  /** Rewrite decisions awaiting their result, keyed by call id, for `suggest` mode. */
  const pendingSuggestions = new Map<string, string>()
  /** Call ids whose result should carry the one-time "rtk is missing" notice. */
  const missingRtkCalls = new Set<string>()
  /** Sessions already told that rtk is absent, so the notice is emitted once each. */
  const notifiedAgents = new Set<string>()

  // Keep the normalized copy in step with committed settings edits. The bridge
  // abstracts over how each harness generation announces them (`scope.watch`
  // on the old one, `loader/volatile-update` on the new one); either way the
  // fixpoint is `bridge.read()`.
  let disposeSettingsWatch: (() => void) | undefined
  function watchSettings(): void {
    disposeSettingsWatch?.()
    disposeSettingsWatch = bridge.onChange(() => {
      config = bridge.read()
      // The new values may point at a different executable, so the cached probe
      // answer is no longer this configuration's answer.
      runtimeStatus = { rtkAvailable: false }
      applySourceFilterNote()
    })
  }
  watchSettings()
  ctx.effect(() => () => {
    disposeSettingsWatch?.()
    disposeSettingsWatch = undefined
  }, 'dsh-rtk.settings-watch')

  let disposeNote: (() => void) | undefined
  const systemPrompt = ctx.get('systemPrompt') as SystemPrompt | undefined
  function applySourceFilterNote(): void {
    if (systemPrompt === undefined) return
    if (needsSourceFilterNote(config)) {
      if (disposeNote !== undefined) return
      disposeNote = systemPrompt.section({ name: 'rtk:read-compaction', order: 1010, text: SOURCE_FILTER_TROUBLESHOOTING_NOTE })
      return
    }
    disposeNote?.()
    disposeNote = undefined
  }
  applySourceFilterNote()
  ctx.effect(() => () => {
    disposeNote?.()
    disposeNote = undefined
  }, 'dsh-rtk.prompt-note')

  /** The rtkExecutable value this plugin wrote itself on an earlier pass. */
  let autoPersistedExecutable: string | undefined
  let syncingExecutable = false

  /**
   * Fill the rtk executable setting in from detection.
   *
   * The setting is what the configuration page shows, so a path the plugin
   * found must land there — until this existed, every call resolved rtk while
   * the field kept reading the bare name, and a Windows harness whose PATH
   * missed the install directory showed "not found" with no hint of the real
   * path. A found path replaces a value this plugin owns (empty or the shipped
   * `rtk` default); a hand-typed value and a failed detection are left alone,
   * so the user layer never gains an explicit override nobody asked for. A
   * settings layer that refuses writes costs this convenience only.
   */
  async function syncDetectedExecutable(resolution?: RtkExecutableResolution): Promise<void> {
    if (syncingExecutable) return
    syncingExecutable = true
    try {
      const current = config.rtkExecutable
      const resolved = resolution ?? (await resolveRtkExecutable({ configured: current }))
      const next = decideExecutableSetting({
        current,
        ...(resolved.resolvedPath === undefined ? {} : { detected: resolved.resolvedPath }),
        ...(autoPersistedExecutable === undefined ? {} : { autoWritten: autoPersistedExecutable }),
      })
      if (next === undefined) return
      if (!(await bridge.persistRtkExecutable(next))) return
      autoPersistedExecutable = next
      config = bridge.read()
    } catch {
      // Detection is a convenience; a failure here must never reach the user.
    } finally {
      syncingExecutable = false
    }
  }

  async function refreshRuntimeStatus(): Promise<RtkRuntimeStatus> {
    const resolution = await resolveRtkExecutable({ configured: config.rtkExecutable })
    const probe = await runExecutable(resolution.command, ['--version'], { timeoutMs: 5000 })
    const base = {
      rtkExecutableCommand: resolution.command,
      ...(resolution.resolvedPath === undefined ? {} : { rtkExecutablePath: resolution.resolvedPath }),
      rtkExecutableResolver: resolution.resolver,
      ...(resolution.warning === undefined ? {} : { rtkExecutableResolutionWarning: resolution.warning }),
      lastCheckedAt: Date.now(),
    }
    runtimeStatus =
      probe.code === 0
        ? { rtkAvailable: true, ...base }
        : {
            rtkAvailable: false,
            ...base,
            lastError: (probe.stderr || probe.stdout).replace(/\s+/g, ' ').trim() || `exit ${probe.code}`,
          }
    // The probe already resolved a real path; keep the setting in step so the
    // configuration page shows it (and shows "empty" when rtk is gone).
    await syncDetectedExecutable(resolution)
    return runtimeStatus
  }

  async function ensureRuntimeStatusFresh(): Promise<void> {
    if (!needsAvailabilityProbe(config)) return
    if (!isStatusStale(runtimeStatus, Date.now())) return
    try {
      await refreshRuntimeStatus()
    } catch (error) {
      runtimeStatus = {
        rtkAvailable: false,
        lastCheckedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ── command rewriting ────────────────────────────────────────────────────

  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
    if (config.mode !== 'rewrite') return next()
    if (!REWRITABLE_TOOLS.has(exec.name)) return next()

    const args = asRecord(exec.arguments)
    if (args === undefined || typeof args.command !== 'string') return next()

    await ensureRuntimeStatusFresh()
    if (shouldSkipRewrite(config, runtimeStatus)) {
      // The guard is standing the rewrite down because rtk is unavailable. Flag
      // this result so post-execute can say so once per session.
      if (missingRtkCalls.size > 256) missingRtkCalls.clear()
      missingRtkCalls.add(exec.callId)
      return next()
    }

    const decision = await resolveRtkRewrite(args.command, {
      runner: runExecutable,
      executable: runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable,
      timeoutMs: REWRITE_TIMEOUT_MS,
      signal: exec.signal,
    })
    if (!decision.changed) return next()

    // `pwsh` is a rewrite target too, and PowerShell has no `export`.
    const shell: ShellKind = exec.name === 'pwsh' ? 'powershell' : 'posix'
    const command = applyRtkHistoryScope(decision.rewrittenCommand, rtkHistoryDbPath(), process.env.RTK_DB_PATH, shell)
    // `arguments` is declared readonly, but the around-dispatch stage is the
    // one place the registry re-reads it before invoking the body. Restoring it
    // in `finally` keeps every later stage — post-execute, content
    // finalization, and the observation in `tools/result` — looking at the call
    // the model actually made.
    const mutable = exec as unknown as { arguments: unknown }
    mutable.arguments = { ...args, command }
    try {
      return await next()
    } catch (error) {
      pendingSuggestions.delete(exec.callId)
      throw error
    } finally {
      mutable.arguments = args
    }
  })

  // ── suggest mode ─────────────────────────────────────────────────────────

  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
    if (config.mode !== 'suggest') return next()
    if (!REWRITABLE_TOOLS.has(exec.name)) return next()

    const args = asRecord(exec.arguments)
    if (args === undefined || typeof args.command !== 'string') return next()

    await ensureRuntimeStatusFresh()
    if (shouldSkipRewrite(config, runtimeStatus)) {
      // The guard is standing the rewrite down because rtk is unavailable. Flag
      // this result so post-execute can say so once per session.
      if (missingRtkCalls.size > 256) missingRtkCalls.clear()
      missingRtkCalls.add(exec.callId)
      return next()
    }

    const decision = await resolveRtkRewrite(args.command, {
      runner: runExecutable,
      executable: runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable,
      timeoutMs: REWRITE_TIMEOUT_MS,
      signal: exec.signal,
    })
    if (decision.changed) {
      if (pendingSuggestions.size > 256) pendingSuggestions.clear()
      pendingSuggestions.set(exec.callId, `[rtk] suggestion: ${decision.rewrittenCommand}`)
    }
    try {
      return await next()
    } catch (error) {
      pendingSuggestions.delete(exec.callId)
      throw error
    }
  })

  // ── output compaction ────────────────────────────────────────────────────

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const decision = await next()
    let notice = pendingSuggestions.get(exec.callId)
    pendingSuggestions.delete(exec.callId)

    if (missingRtkCalls.delete(exec.callId)) {
      const agentKey = exec.agent?.id
      if (agentKey !== undefined && !notifiedAgents.has(agentKey)) {
        if (notifiedAgents.size > 256) notifiedAgents.clear()
        notifiedAgents.add(agentKey)
        notice = MISSING_RTK_NOTICE
      }
    }

    if (decision.kind !== 'accept') return decision
    if (config.mode === 'off') return decision

    const source: readonly ContentBlock[] = decision.content ?? result.content
    if (source.length === 0) return decision

    let content: readonly ContentBlock[] = source
    try {
      const outcome = compactToolResult({ toolName: exec.name, args: exec.arguments, content: source }, config, {
        deferToHarnessSpill: spillHandlesLargeOutput,
      })
      if (outcome.changed && outcome.content !== undefined) {
        content = outcome.content as ContentBlock[]
        if (outcome.metadata !== undefined) {
          metrics.track(
            source.map((block) => (block as { text?: string }).text ?? '').join('\n'),
            content.map((block) => (block as { text?: string }).text ?? '').join('\n'),
            exec.name,
            outcome.techniques,
          )
        }
      }
    } catch {
      // Compaction is an optimization; a bug in it must not break the tool call.
      return notice === undefined ? decision : { kind: 'accept', content: appendNotice(source, notice) }
    }

    // A sibling listener may have attached contexts for the next request.
    // Rebuilding the decision without them would drop them silently, and the
    // shipped search tool does exactly that when a result was capped.
    const contexts = decision.additionalContexts
    const rebuild = (blocks: ContentBlock[]): PostToolDecision => ({
      kind: 'accept',
      content: blocks,
      ...(contexts === undefined ? {} : { additionalContexts: contexts }),
    })

    if (notice === undefined) {
      return content === source ? decision : rebuild([...content])
    }
    return rebuild(appendNotice(content, notice))
  })

  // ── the /rtk command ─────────────────────────────────────────────────────

  const commands = ctx.get('commands') as CommandRuntime | undefined
  if (commands !== undefined) {
    const command = createRtkCommand({
      getConfig: () => config,
      resetConfig: async () => {
        const result = await bridge.reset()
        config = bridge.read()
        runtimeStatus = { rtkAvailable: false }
        return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
      },
      getRuntimeStatus: () => runtimeStatus,
      refreshRuntimeStatus,
      getMetrics: () => metrics.summary(),
      clearMetrics: () => metrics.clear(),
      runGain: async (args) => {
        const tokens = args.length === 0 ? [] : args.split(/\s+/)
        const destructive = tokens.find((token) => token === '--reset' || token === '--yes')
        if (destructive !== undefined) {
          return {
            kind: 'error',
            text: `\`/rtk gain\` refuses \`${destructive}\`: it would erase the ledger. Run \`rtk gain --reset\` yourself if that is intended.`,
          }
        }
        const executable = runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable
        const result = await runExecutable(executable, ['gain', ...tokens], {
          timeoutMs: 15000,
          env: scrubbedEnv({ RTK_DB_PATH: rtkHistoryDbPath() }),
        })
        const text = [result.stdout, result.stderr]
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join('\n')
        if (result.code !== 0) return { kind: 'error', text: text || `rtk gain exited with code ${result.code}` }
        return { kind: 'success', text: text || 'rtk gain printed nothing.' }
      },
      configLocation: () => bridge.note,
    })
    ctx.effect(() => commands.register(command), 'dsh-rtk.command')
  }

  // ── the browser-facing savings panel ─────────────────────────────────────

  /**
   * The Configure page's Gain panel reads `rtk gain` from the host over an
   * exact Fetch route under the Web connection's authenticated `/api` prefix.
   *
   * The generic `connection.rpc` channel is not usable here: its handler
   * registers a prefix route through the connection service's own Context, which
   * does not inject `webServer`, so `rpc.handle` throws and the request falls
   * through to the SPA fallback as HTTP 405. Exact Fetch routes have no such
   * dependency — the `/api` route dispatches them after admission.
   */
  const gainReader = createGainReader({
    executable: () => runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable,
    database: rtkHistoryDbPath,
    // Prefer the product's own project list; the ledger only keeps history.
    workspaceDirectory: () => {
      const registry = ctx.get('workspaceRegistry') as
        | { list?: () => readonly { path?: unknown; title?: unknown }[] }
        | undefined
      if (registry === undefined || typeof registry.list !== 'function') return undefined
      const entries: { path: string; title?: string }[] = []
      for (const entity of registry.list()) {
        if (typeof entity?.path !== 'string') continue
        entries.push(typeof entity.title === 'string' ? { path: entity.path, title: entity.title } : { path: entity.path })
      }
      return entries
    },
  })
  const registerGainRemote = (scoped: Context): void => {
    const connection = scoped.get('connection') as
      | {
          fetch?: {
            register(route: {
              path: string
              methods: readonly string[]
              requestBody: string
              fetch: (request: Request) => Promise<Response>
            }): () => void
          }
        }
      | undefined
    const routes = connection?.fetch
    if (routes === undefined) return
    scoped.effect(() => {
      try {
        return routes.register({
          path: GAIN_ROUTE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let payload: unknown = {}
            try {
              payload = await request.json()
            } catch {
              payload = {}
            }
            const want = typeof payload === 'object' && payload !== null ? (payload as GainRequest) : {}
            try {
              return Response.json({ ok: true, value: await gainReader.report(want) })
            } catch (error) {
              return Response.json({
                ok: false,
                error: {
                  code: 'dsh-rtk/gain',
                  message: error instanceof Error ? error.message : String(error),
                  details: {},
                },
              })
            }
          },
        })
      } catch (error) {
        // A registration that fails must not take the rewriting and compaction
        // halves down with it: the panel then reports the ledger as unavailable.
        // Logged through the context logger so the host decides where it lands.
        const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-rtk') : undefined
        logger?.warn('gain route was not registered', error)
        return () => {}
      }
    }, 'dsh-rtk: gain route')
  }
  // `ctx.inject` exists on every real Context; the guard keeps stand-in
  // contexts (tests) without a service registry alive.
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], registerGainRemote)

  // Fill the executable setting in once per activation, so the configuration
  // page shows where rtk actually lives without waiting for a first command.
  if (bridge.writable) void syncDetectedExecutable()

  // Upgrade to the live-settings integration when the service shows up. It
  // registers asynchronously on every harness generation (it reads the settings
  // document first), so a `ctx.get` during `apply` can legitimately find
  // nothing; declaring the dependency instead would park the whole plugin.
  if (!bridge.attached && typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scoped: Context) => {
      bridge = createSettingsBridge(scoped, rawConfig)
      if (!bridge.attached) return
      config = bridge.read()
      watchSettings()
      applySourceFilterNote()
      if (bridge.writable) void syncDetectedExecutable()
    })
  }
}

/**
 * Insert a one-line notice into a result, ahead of any trailing status markers.
 *
 * The markers must stay last. The harness parses the final line for the exit
 * status — the model is told to check `[exit code: N]` on every call, and the
 * Web UI derives its exit-status pill from the same line. Appending a notice
 * after them would break both silently, which is exactly what an earlier
 * version of this function did.
 */
function appendNotice(content: readonly ContentBlock[], notice: string): ContentBlock[] {
  const blocks: ContentBlock[] = [...content]
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block === undefined || block.type !== 'text') continue

    const parts = parseBashResult(block.text)
    if (parts.empty || parts.markers.length === 0) {
      blocks[index] = { type: 'text', text: `${block.text}\n${notice}` }
      return blocks
    }

    const stdout = parts.stdout.length > 0 ? `${parts.stdout}\n${notice}` : notice
    blocks[index] = { type: 'text', text: renderBashResult({ ...parts, stdout }) }
    return blocks
  }
  return [...blocks, { type: 'text', text: notice }]
}

export { READ_COMPACTION_BANNER_PREFIX }