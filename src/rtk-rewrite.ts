/** One `rtk rewrite` outcome. */
export interface RtkRewriteResult {
  changed: boolean
  originalCommand: string
  rewrittenCommand: string
  exitCode: number
  error?: string
}

/** Injected runner so tests never spawn a process. */
export type RtkRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Options for {@link resolveRtkRewrite}. */
export interface RtkRewriteOptions {
  runner: RtkRunner
  executable: string
  timeoutMs?: number
  signal?: AbortSignal
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Split leading `KEY=VALUE` assignments off a command line.
 *
 * Shell treats a run of assignments before the command word as that command's
 * environment, so `FOO=1 ls` invokes `ls`, not `FOO=1`. Detection must look at
 * the command word; passing the whole line would classify `FOO=1 git status`
 * as unsupported.
 *
 * @param command - raw command line.
 * @returns the assignment prefix (verbatim, including trailing space) and the command word onward.
 */
export function splitLeadingEnvAssignments(command: string): { envPrefix: string; command: string } {
  let index = 0
  let prefixEnd = 0

  while (index < command.length) {
    const rest = command.slice(index)
    const match = ENV_ASSIGNMENT.exec(rest)
    if (match === null) break

    let cursor = index + match[0].length
    if (cursor >= command.length) return { envPrefix: '', command }

    const first = command[cursor]
    if (first === '"' || first === "'") {
      cursor += 1
      while (cursor < command.length && command[cursor] !== first) cursor += 1
      if (cursor >= command.length) return { envPrefix: '', command }
      cursor += 1
    } else {
      while (cursor < command.length && !/\s/.test(command[cursor] as string)) cursor += 1
    }

    if (cursor < command.length && !/\s/.test(command[cursor] as string)) return { envPrefix: '', command }
    while (cursor < command.length && /\s/.test(command[cursor] as string)) cursor += 1
    prefixEnd = cursor
    index = cursor
  }

  return { envPrefix: command.slice(0, prefixEnd), command: command.slice(prefixEnd) }
}

/**
 * Whether a command (ignoring a leading assignment run) already invokes rtk.
 *
 * Rewriting an rtk command would produce `rtk rtk …`, and the guard also saves
 * a process spawn on every already-optimized call.
 */
export function isAlreadyRtkCommand(command: string): boolean {
  const effective = splitLeadingEnvAssignments(command.trimStart()).command.trimStart()
  return effective === 'rtk' || effective.startsWith('rtk ')
}

const RTK_HISTORY_ENV = 'RTK_DB_PATH'

/** Which shell dialect an assignment prefix must be written in. */
export type ShellKind = 'posix' | 'powershell'

/// Matches a PowerShell environment assignment already present at the head.
const PWSH_ASSIGNMENT = /^\$env:RTK_DB_PATH\s*=/

/**
 * Prefix a command with an isolated `RTK_DB_PATH` so rtk's usage history lands
 * in a scratch directory instead of the working tree.
 *
 * The two shells need different syntax: `export NAME='value'` is a syntax error
 * in PowerShell, which spells the same thing `$env:NAME = 'value'`. Both the
 * harness's `pwsh` tool and its `bash` tool are rewrite targets, so the caller
 * passes the dialect rather than assuming one.
 *
 * The assignment is skipped when the command already sets it or the ambient
 * environment provides one, so an explicit choice is never overridden.
 *
 * @param command - the rewritten command.
 * @param historyDbPath - absolute path for this deployment's rtk history database.
 * @param ambientValue - value currently in the environment, if any.
 * @param shell - the dialect of the command being prefixed.
 * @returns the command to run, prefixed only when isolation applies.
 */
export function applyRtkHistoryScope(
  command: string,
  historyDbPath: string,
  ambientValue: string | undefined,
  shell: ShellKind = 'posix',
): string {
  if (!command.trim() || !historyDbPath.trim()) return command
  if (ambientValue !== undefined && ambientValue.trim()) return command

  const trimmed = command.trimStart()

  if (shell === 'powershell') {
    if (PWSH_ASSIGNMENT.test(trimmed)) return command
    // PowerShell escapes a literal quote by doubling it.
    return `$env:${RTK_HISTORY_ENV} = '${historyDbPath.replace(/'/g, "''")}'; ${command}`
  }

  if (splitLeadingEnvAssignments(trimmed).envPrefix.includes(`${RTK_HISTORY_ENV}=`)) return command
  return `export ${RTK_HISTORY_ENV}='${historyDbPath.replace(/'/g, "'\\''")}'; ${command}`
}

/**
 * Ask the installed rtk binary how it would rewrite a command.
 *
 * rtk owns the rewrite rules; this plugin deliberately carries no duplicate
 * table. The exit-code contract is rtk's:
 *
 * | code | meaning |
 * |------|---------|
 * | 0, 3 | stdout is the rewritten command |
 * | 1    | no rtk equivalent — run the command unchanged |
 * | 2    | rtk refused the rewrite; stderr explains why |
 *
 * A non-zero code is an ordinary outcome, never a rejection: the caller always
 * has the original command to fall back on.
 *
 * @param command - the raw command the model asked to run.
 * @param options - runner, executable, deadline, and caller cancellation.
 * @returns the decision, including the fallback command when nothing changed.
 */
export async function resolveRtkRewrite(command: string, options: RtkRewriteOptions): Promise<RtkRewriteResult> {
  const unchanged = (exitCode: number, error?: string): RtkRewriteResult => ({
    changed: false,
    originalCommand: command,
    rewrittenCommand: command,
    exitCode,
    ...(error === undefined ? {} : { error }),
  })

  if (!command || !command.trim()) return unchanged(1)
  if (isAlreadyRtkCommand(command)) return unchanged(1)

  let result: { code: number; stdout: string; stderr: string }
  try {
    const runOptions: { timeoutMs?: number; signal?: AbortSignal } = {}
    if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs
    if (options.signal !== undefined) runOptions.signal = options.signal
    result = await options.runner(options.executable, ['rewrite', command], runOptions)
  } catch (error) {
    return unchanged(-1, error instanceof Error ? error.message : String(error))
  }

  if (result.code === 1) return unchanged(1)
  if (result.code === 2) return unchanged(2, result.stderr.trim() || 'rtk refused the rewrite')

  if (result.code === 0 || result.code === 3) {
    const rewritten = result.stdout.trim()
    if (!rewritten) return unchanged(result.code, 'rtk returned empty output')
    if (rewritten === command) return unchanged(result.code)
    return { changed: true, originalCommand: command, rewrittenCommand: rewritten, exitCode: result.code }
  }

  return unchanged(result.code, `unexpected rtk exit code ${result.code}`)
}
