import { matchesCommandPatterns } from './detect.js'

interface TestSummary {
  passed: number
  failed: number
  skipped: number
  failures: string[]
}

const TEST_COMMAND_PATTERNS = [
  /^npm\s+test\b/,
  /^pnpm\s+test\b/,
  /^yarn\s+test\b/,
  /^bun\s+test\b/,
  /^cargo\s+test\b/,
  /^go\s+test\b/,
  /^pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^(?:pnpm\s+)?(?:npx\s+)?vitest\b/,
  /^(?:npx\s+)?jest\b/,
  /^mocha\b/,
  /^ava\b/,
  /^tap\b/,
  /^node\s+--test\b/,
] as const

const TEST_RESULT_PATTERNS = [
  /test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/,
  /#\s*tests\s+(\d+)\s*$/m,
  /(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
  /(\d+)\s*pass(?:,\s*(\d+)\s*fail)?(?:,\s*(\d+)\s*skip)?/i,
  /tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
]

const FAILURE_START_PATTERNS = [
  /^FAIL\s+/,
  /^FAILED\s+/,
  /^\s*●\s+/,
  // U+2715 and U+2716 look alike and are both in the wild; `node --test` uses
  // the heavy form, which a pattern written for the light one silently misses.
  /^\s*[✕✖]\s+/,
  /^\s*not ok\s+/,
  /test\s+\w+\s+\.\.\.\s*FAILED/,
  /thread\s+'\w+'\s+panicked/,
]

const FALLBACK_PASS_PATTERN = /(?:\b(?:ok|PASS)\b|[✓✔])/
const FALLBACK_FAIL_PATTERN = /(?:\b(?:FAIL|fail)\b|[✗✕✖])/

const MAX_FAILURES = 5
const MAX_FAILURE_LINES = 4
const BLANKS_TO_CLOSE_BLOCK = 2

/**
 * Read `node --test`'s tallies, which it prints on separate lines:
 * `ℹ tests 2` / `ℹ pass 1` / `ℹ fail 1`.
 *
 * These are authoritative — the runner counted them — so they are preferred
 * over every scraped-marker fallback.
 */
function extractNodeTestStats(output: string): Partial<TestSummary> | undefined {
  const passed = output.match(/^\u2139\s*pass\s+(\d+)/m)
  if (passed === null) return undefined
  return {
    passed: Number.parseInt(passed[1] ?? '0', 10) || 0,
    failed: Number.parseInt(output.match(/^\u2139\s*fail\s+(\d+)/m)?.[1] ?? '0', 10) || 0,
    skipped: Number.parseInt(output.match(/^\u2139\s*skipped\s+(\d+)/m)?.[1] ?? '0', 10) || 0,
  }
}

function extractTestStats(output: string): Partial<TestSummary> {
  const fromNodeTest = extractNodeTestStats(output)
  if (fromNodeTest !== undefined) return fromNodeTest

  for (const pattern of TEST_RESULT_PATTERNS) {
    const match = output.match(pattern)
    if (!match) continue
    return {
      passed: Number.parseInt(match[1] ?? '0', 10) || 0,
      failed: Number.parseInt(match[2] ?? '0', 10) || 0,
      skipped: Number.parseInt(match[3] ?? '0', 10) || 0,
    }
  }
  return {}
}

/** Whether the command is a test runner this module understands. */
export function isTestCommand(command: string | undefined | null): boolean {
  return matchesCommandPatterns(command, TEST_COMMAND_PATTERNS)
}

/**
 * Collapse test-runner output to a pass/fail/skip summary plus the first few
 * failure excerpts.
 *
 * When no runner summary line can be parsed, per-line pass/fail markers are
 * counted instead, so an unusual runner still yields a usable shape rather than
 * a bare "0 passed".
 */
export function aggregateTestOutput(output: string, command: string | undefined | null): string | null {
  if (!isTestCommand(command)) return null

  const lines = output.split('\n')
  const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, failures: [] }

  const stats = extractTestStats(output)
  summary.passed = stats.passed ?? 0
  summary.failed = stats.failed ?? 0
  summary.skipped = stats.skipped ?? 0

  if (summary.passed === 0 && summary.failed === 0) {
    for (const line of lines) {
      if (FALLBACK_PASS_PATTERN.test(line)) summary.passed++
      if (FALLBACK_FAIL_PATTERN.test(line)) summary.failed++
    }
  }

  if (summary.failed > 0) {
    let inFailure = false
    let currentFailure: string[] = []
    let blankCount = 0

    for (const line of lines) {
      if (FAILURE_START_PATTERNS.some((pattern) => pattern.test(line))) {
        if (inFailure && currentFailure.length > 0) summary.failures.push(currentFailure.join('\n'))
        inFailure = true
        currentFailure = [line]
        blankCount = 0
        continue
      }

      if (!inFailure) continue

      if (line.trim() === '') {
        blankCount++
        if (blankCount >= BLANKS_TO_CLOSE_BLOCK && currentFailure.length > 3) {
          summary.failures.push(currentFailure.join('\n'))
          inFailure = false
          currentFailure = []
        } else {
          currentFailure.push(line)
        }
        continue
      }

      if (line.match(/^\s/) || line.match(/^-/)) {
        currentFailure.push(line)
        blankCount = 0
        continue
      }

      summary.failures.push(currentFailure.join('\n'))
      inFailure = false
      currentFailure = []
    }

    if (inFailure && currentFailure.length > 0) summary.failures.push(currentFailure.join('\n'))
  }

  const result: string[] = ['Test Results:']
  result.push(`   PASS: ${summary.passed} passed`)
  if (summary.failed > 0) result.push(`   FAIL: ${summary.failed} failed`)
  if (summary.skipped > 0) result.push(`   SKIP: ${summary.skipped} skipped`)

  if (summary.failed > 0 && summary.failures.length > 0) {
    result.push('\n   Failures:')
    for (const failure of summary.failures.slice(0, MAX_FAILURES)) {
      const failureLines = failure.split('\n')
      const firstLine = failureLines[0] ?? ''
      result.push(`   - ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '...' : ''}`)
      for (const detailLine of failureLines.slice(1, MAX_FAILURE_LINES)) {
        if (detailLine.trim()) result.push(`     ${detailLine.slice(0, 65)}${detailLine.length > 65 ? '...' : ''}`)
      }
      if (failureLines.length > MAX_FAILURE_LINES) {
        result.push(`     ... (${failureLines.length - MAX_FAILURE_LINES} more lines)`)
      }
    }
    if (summary.failures.length > MAX_FAILURES) {
      result.push(`   ... and ${summary.failures.length - MAX_FAILURES} more failures`)
    }
  }

  return result.join('\n')
}
