import { matchesCommandPatterns } from './detect.js'

interface BuildStats {
  compiled: number
  errors: string[][]
  warnings: string[]
}

const BUILD_COMMAND_PATTERNS = [
  /^cargo\s+(build|check)\b/,
  /^bun\s+build\b/,
  /^npm\s+run\s+build\b/,
  /^yarn\s+build\b/,
  /^pnpm\s+build\b/,
  /^(?:npx\s+)?tsc\b/,
  /^make\b/,
  /^cmake\b/,
  /^gradle\b/,
  /^mvn\b/,
  /^go\s+(build|install)\b/,
  /^python\s+setup\.py\s+build\b/,
  /^pip\s+install\b/,
] as const

/** Progress chatter that carries no actionable information. */
const SKIP_PATTERNS = [
  /^\s*Compiling\s+/,
  /^\s*Checking\s+/,
  /^\s*Downloading\s+/,
  /^\s*Downloaded\s+/,
  /^\s*Fetching\s+/,
  /^\s*Fetched\s+/,
  /^\s*Updating\s+/,
  /^\s*Updated\s+/,
  /^\s*Building\s+/,
  /^\s*Generated\s+/,
  /^\s*Creating\s+/,
  /^\s*Running\s+/,
]

const ERROR_START_PATTERNS = [/^error\[/, /^error:/, /^\[ERROR\]/, /^FAIL/]
const WARNING_PATTERNS = [/^warning:/, /^\[WARNING\]/, /^warn:/]
const COMPILE_PROGRESS_PATTERN = /^\s*(Compiling|Checking|Building)\s+/

const MAX_ERRORS = 5
const MAX_ERROR_LINES = 10
const BLANKS_TO_CLOSE_BLOCK = 2

function isSkipLine(line: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * Reduce compiler output to its errors and warnings.
 *
 * Errors keep their indented continuation lines (the source excerpt and the
 * `-->` location) because that detail is what makes an error actionable;
 * progress lines and everything else are dropped. A build with no diagnostics
 * collapses to a one-line success marker, which is the common case and the
 * largest saving.
 *
 * @param output - raw build output.
 * @param command - the command that produced it; drives the applicability check.
 * @returns the summary, or `null` when the command is not a build command.
 */
export function filterBuildOutput(output: string, command: string | undefined | null): string | null {
  if (!matchesCommandPatterns(command, BUILD_COMMAND_PATTERNS)) return null

  const lines = output.split('\n')
  const stats: BuildStats = { compiled: 0, errors: [], warnings: [] }

  let inErrorBlock = false
  let currentError: string[] = []
  let blankCount = 0

  for (const line of lines) {
    if (COMPILE_PROGRESS_PATTERN.test(line)) {
      stats.compiled++
      continue
    }
    if (isSkipLine(line)) continue

    if (ERROR_START_PATTERNS.some((pattern) => pattern.test(line))) {
      if (inErrorBlock && currentError.length > 0) stats.errors.push([...currentError])
      inErrorBlock = true
      currentError = [line]
      blankCount = 0
      continue
    }

    if (WARNING_PATTERNS.some((pattern) => pattern.test(line))) {
      stats.warnings.push(line)
      continue
    }

    if (!inErrorBlock) continue

    if (line.trim() === '') {
      blankCount++
      if (blankCount >= BLANKS_TO_CLOSE_BLOCK && currentError.length > 3) {
        stats.errors.push([...currentError])
        inErrorBlock = false
        currentError = []
      } else {
        currentError.push(line)
      }
      continue
    }

    if (line.match(/^\s/) || line.match(/^-->/)) {
      currentError.push(line)
      blankCount = 0
      continue
    }

    stats.errors.push([...currentError])
    inErrorBlock = false
    currentError = []
  }

  if (inErrorBlock && currentError.length > 0) stats.errors.push(currentError)

  if (stats.errors.length === 0 && stats.warnings.length === 0) {
    return `[OK] Build successful (${stats.compiled} units compiled)`
  }

  const result: string[] = []
  if (stats.errors.length > 0) {
    result.push(`[ERROR] ${stats.errors.length} error(s):`)
    for (const error of stats.errors.slice(0, MAX_ERRORS)) {
      result.push(...error.slice(0, MAX_ERROR_LINES))
      if (error.length > MAX_ERROR_LINES) result.push('  ...')
    }
    if (stats.errors.length > MAX_ERRORS) result.push(`... and ${stats.errors.length - MAX_ERRORS} more errors`)
  }
  if (stats.warnings.length > 0) result.push(`\n[WARN] ${stats.warnings.length} warning(s)`)

  return result.join('\n')
}
