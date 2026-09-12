/**
 * Split and reassemble the harness `bash` result envelope.
 *
 * The bash tool renders a result as the stdout tail, an optional `[stderr]`
 * section, and a run of trailing status markers (`[exit code: N]`,
 * `[timed out after …]`, `[sandbox: …]`, …). Those markers are load-bearing:
 * the model is told to check `[exit code: N]` on every call, and the Web UI
 * parses that same line to draw its exit-status pill.
 *
 * Compaction rewrites the output body, so anything that rebuilds the text
 * wholesale — the git, build, and test summarizers all do — would drop the
 * markers with it. This module is the boundary that keeps that from happening:
 * markers are lifted out before compaction and put back after, in their
 * original order.
 */

/** Markers the bash tool appends after the output body. */
const TRAILING_MARKER_PATTERNS = [
  /^\[exit code: -?\d+\]$/,
  /^\[killed by signal: .+\]$/,
  /^\[timed out after \d+ms\]$/,
  /^\[output truncated; full output: .+\]$/,
  /^\[some output was dropped from memory; full output: .+\]$/,
  /^\[sandbox: .+\]$/,
] as const

const STDERR_HEADER = '[stderr]'
/** The bash tool's placeholder for a command that printed nothing at all. */
export const NO_OUTPUT_PLACEHOLDER = '(no output)'

function isTrailingMarker(line: string): boolean {
  return TRAILING_MARKER_PATTERNS.some((pattern) => pattern.test(line))
}

/** A bash result decomposed into the parts compaction must treat differently. */
export interface BashResultParts {
  /** True when the tool rendered its "printed nothing" placeholder. */
  empty: boolean
  /** stdout body, without the `[stderr]` section or trailing markers. */
  stdout: string
  /** stderr body when the result carried a `[stderr]` section. */
  stderr?: string
  /** Trailing status markers, in their original order. */
  markers: string[]
}

/**
 * Decompose a rendered bash result.
 *
 * Trailing markers are peeled from the end first, then the `[stderr]` section
 * is split off. Only the first `[stderr]` header counts: if the command's own
 * output contains that literal line, everything after it belongs to stderr,
 * which is what the renderer produced.
 *
 * @param text - the rendered bash result.
 * @returns the decomposed parts.
 */
export function parseBashResult(text: string): BashResultParts {
  if (text === NO_OUTPUT_PLACEHOLDER) {
    return { empty: true, stdout: '', markers: [] }
  }

  const lines = text.split('\n')
  const markers: string[] = []
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last === undefined || !isTrailingMarker(last)) break
    markers.unshift(last)
    lines.pop()
  }

  const headerIndex = lines.indexOf(STDERR_HEADER)
  if (headerIndex === -1) {
    return { empty: false, stdout: lines.join('\n'), markers }
  }

  const stdout = lines.slice(0, headerIndex).join('\n')
  const stderr = lines.slice(headerIndex + 1).join('\n')
  return { empty: false, stdout, stderr, markers }
}

/**
 * Reassemble a bash result from its parts.
 *
 * The inverse of {@link parseBashResult}, so the model-visible contract — the
 * marker lines the agent loop and the UI both depend on — survives a
 * compaction pass untouched.
 */
export function renderBashResult(parts: BashResultParts): string {
  const sections: string[] = []
  if (parts.empty) {
    sections.push(NO_OUTPUT_PLACEHOLDER)
  } else {
    if (parts.stdout.length > 0) sections.push(parts.stdout)
    if (parts.stderr !== undefined) sections.push(STDERR_HEADER, parts.stderr)
  }
  sections.push(...parts.markers)
  return sections.join('\n')
}
