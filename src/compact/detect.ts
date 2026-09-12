/**
 * Command classification helpers.
 *
 * Every technique asks the same question first — "is this the kind of command
 * whose output I know how to summarize?" — so the normalization lives here
 * rather than being repeated (and drifting) per technique.
 */

const ENV_PREFIX_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/
const CHAIN_OPERATORS = ['&&', '||', ';', '|'] as const

function sliceFirstSegment(command: string): string {
  let cutIndex = -1
  for (const operator of CHAIN_OPERATORS) {
    const index = command.indexOf(operator)
    if (index === -1) continue
    if (cutIndex === -1 || index < cutIndex) cutIndex = index
  }
  return cutIndex === -1 ? command : command.slice(0, cutIndex)
}

/**
 * Reduce a command line to its first simple command, lower-cased.
 *
 * `FOO=1 git status | head` normalizes to `git status`: the assignment run is
 * not the command, and the pipeline is not part of what the first command is.
 * A pattern that matches the whole line would classify every prefixed or
 * piped invocation as unknown and skip compaction entirely.
 *
 * @param command - raw command line, possibly multi-line.
 * @returns the normalized first command, or `null` when there is none.
 */
export function normalizeCommandForDetection(command: string | undefined | null): string | null {
  if (typeof command !== 'string') return null

  const firstNonEmptyLine = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstNonEmptyLine) return null

  const withoutEnvPrefix = firstNonEmptyLine.replace(ENV_PREFIX_PATTERN, '').trim()
  if (!withoutEnvPrefix) return null

  const firstSegment = sliceFirstSegment(withoutEnvPrefix).trim().toLowerCase()
  return firstSegment || null
}

/** Whether the command's first simple command matches any pattern. */
export function matchesCommandPatterns(command: string | undefined | null, patterns: readonly RegExp[]): boolean {
  const normalized = normalizeCommandForDetection(command)
  if (!normalized) return false
  return patterns.some((pattern) => pattern.test(normalized))
}
