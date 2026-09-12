import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

import { Config, normalizeConfig, type RtkConfig } from './config.js'
import { READ_COMPACTION_BANNER_PREFIX, compactToolResult } from './compact/index.js'
import { createMetricsTracker } from './metrics.js'
import { createRtkCommand } from './command.js'
import { resolveRtkExecutable, runExecutable } from './rtk-executable.js'
import { applyRtkHistoryScope, resolveRtkRewrite } from './rtk-rewrite.js'
import { isStatusStale, shouldRequireRtkAvailability, shouldSkipRewrite, type RtkRuntimeStatus } from './runtime-guard.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rtk'

/**
 * The tool runtime is a hard dependency: both halves of this plugin are
 * `tools/*` listeners, and without the registry there is nothing to rewrite or
 * compact. Everything else — commands, settings, the prompt registry — is
 * optional and resolved with `ctx.get`, so a composition that omits them still
 * gets the optimization.
 */
export const inject = ['tools']

export { Config }

/** Tools whose `command` argument can be rewritten. */
const REWRITABLE_TOOLS = new Set(['bash', 'pwsh'])

/** Path of the rtk history database this plugin scopes rewritten commands to. */
function rtkHistoryDbPath(): string {
  return join(tmpdir(), 'dsh-rtk', 'history.db')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The guidance injected while lossy read compaction is active. */
const SOURCE_FILTER_TROUBLESHOOTING_NOTE =
  'RTK note: if a file edit repeatedly fails because the old text does not match, read compaction may have altered the copy you are editing against. Ask the user to turn off `readCompaction` in the rtk settings, re-read the file, apply the edit, then turn it back on.'

/** Whether lossy `read` compaction is enabled together with its safeguards. */
function needsSourceFilterNote(config: RtkConfig): boolean {
  const compaction = config.outputCompaction
  return (
    config.enabled &&
    compaction.enabled &&
    compaction.readCompaction.enabled &&
    compaction.sourceCodeFilteringEnabled &&
    compaction.sourceCodeFiltering !== 'none' &&
    (compaction.smartTruncate.enabled || compaction.truncate.enabled)
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
  let config = normalizeConfig(rawConfig)
  let runtimeStatus: RtkRuntimeStatus = { rtkAvailable: false }
  const metrics = createMetricsTracker()
  /** Rewrite decisions awaiting their result, keyed by call id, for `suggest` mode. */
  const pendingSuggestions = new Map<string, string>()

  // The settings namespace is process-global, so only the first instance of
  // this plugin can own it. A host-plane row and a preset row both mounted, or
  // two presets mounting the same row, would otherwise fail the second mount
  // outright — a configuration convenience must never be the reason a whole
  // preset refuses to activate. The loser follows the winner through the
  // settings event instead.
  const settings = ctx.get('settings') as SettingsProvider | undefined
  let ownedScope: SettingsScope<unknown> | undefined
  if (settings !== undefined) {
    try {
      const scope = settings.register('dsh-rtk', Config, { base: rawConfig })
      ownedScope = scope as unknown as SettingsScope<unknown>
      config = normalizeConfig(scope.get())
      scope.watch((next) => {
        config = normalizeConfig(next)
        applySourceFilterNote()
      })
    } catch {
      const existing = settings.get('dsh-rtk')
      if (existing !== undefined) config = normalizeConfig(existing)
      ctx.on('settings/updated', (ns: string, next: unknown) => {
        if (ns !== 'dsh-rtk') return
        config = normalizeConfig(next)
        applySourceFilterNote()
      })
    }
  }

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
    return runtimeStatus
  }

  async function ensureRuntimeStatusFresh(): Promise<void> {
    if (!shouldRequireRtkAvailability(config)) return
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
    if (!config.enabled) return next()
    if (config.mode !== 'rewrite') return next()
    if (!REWRITABLE_TOOLS.has(exec.name)) return next()

    const args = asRecord(exec.arguments)
    if (args === undefined || typeof args.command !== 'string') return next()

    await ensureRuntimeStatusFresh()
    if (shouldSkipRewrite(config, runtimeStatus)) return next()

    const decision = await resolveRtkRewrite(args.command, {
      runner: runExecutable,
      executable: runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable,
      timeoutMs: config.rewriteTimeoutMs,
      signal: exec.signal,
    })
    if (!decision.changed) return next()

    const command = applyRtkHistoryScope(decision.rewrittenCommand, rtkHistoryDbPath(), process.env.RTK_DB_PATH)
    if (config.showRewriteNotifications) pendingSuggestions.set(exec.callId, `[rtk] rewrote: ${decision.originalCommand} -> ${decision.rewrittenCommand}`)

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
    if (!config.enabled || config.mode !== 'suggest') return next()
    if (!REWRITABLE_TOOLS.has(exec.name)) return next()

    const args = asRecord(exec.arguments)
    if (args === undefined || typeof args.command !== 'string') return next()

    await ensureRuntimeStatusFresh()
    if (shouldSkipRewrite(config, runtimeStatus)) return next()

    const decision = await resolveRtkRewrite(args.command, {
      runner: runExecutable,
      executable: runtimeStatus.rtkExecutableCommand ?? config.rtkExecutable,
      timeoutMs: config.rewriteTimeoutMs,
      signal: exec.signal,
    })
    if (decision.changed) pendingSuggestions.set(exec.callId, `[rtk] suggestion: ${decision.rewrittenCommand}`)
    return next()
  })

  // ── output compaction ────────────────────────────────────────────────────

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const decision = await next()
    const notice = pendingSuggestions.get(exec.callId)
    pendingSuggestions.delete(exec.callId)

    if (decision.kind !== 'accept') return decision
    if (!config.enabled) return decision

    const source: readonly ContentBlock[] = decision.content ?? result.content
    if (source.length === 0) return decision

    let content: readonly ContentBlock[] = source
    try {
      const outcome = compactToolResult({ toolName: exec.name, args: exec.arguments, content: source }, config)
      if (outcome.changed && outcome.content !== undefined) {
        content = outcome.content as ContentBlock[]
        if (outcome.metadata !== undefined && config.outputCompaction.trackSavings) {
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

    if (notice === undefined) {
      return content === source ? decision : { kind: 'accept', content: [...content] }
    }
    return { kind: 'accept', content: appendNotice(content, notice) }
  })

  // ── the /rtk command ─────────────────────────────────────────────────────

  const commands = ctx.get('commands') as CommandRuntime | undefined
  if (commands !== undefined) {
    const location = settings === undefined ? 'composition config (settings service unavailable)' : 'the `dsh-rtk` namespace in the harness settings document'
    const command = createRtkCommand({
      getConfig: () => config,
      resetConfig: async () => {
        if (ownedScope === undefined) return
        await ownedScope.replace({})
        config = normalizeConfig(settings?.get('dsh-rtk'))
      },
      getRuntimeStatus: () => runtimeStatus,
      refreshRuntimeStatus,
      getMetrics: () => metrics.summary(),
      clearMetrics: () => metrics.clear(),
      configLocation: () => location,
    })
    ctx.effect(() => commands.register(command), 'dsh-rtk.command')
  }
}

/** Append a one-line notice to the last text block of a result. */
function appendNotice(content: readonly ContentBlock[], notice: string): ContentBlock[] {
  const blocks: ContentBlock[] = [...content]
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block !== undefined && block.type === 'text') {
      blocks[index] = { type: 'text', text: `${block.text}\n${notice}` }
      return blocks
    }
  }
  return [...blocks, { type: 'text', text: notice }]
}

export { READ_COMPACTION_BANNER_PREFIX }
