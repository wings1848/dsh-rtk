import { matchesCommandPatterns, normalizeCommandForDetection } from './detect.js'
import { compactPath } from './text.js'

const LINTER_COMMAND_PATTERNS = [
  /^(?:pnpm\s+)?(?:npx\s+)?eslint\b/,
  /^(?:npx\s+)?prettier\b/,
  /^ruff\b/,
  /^pylint\b/,
  /^mypy\b/,
  /^flake8\b/,
  /^black\b/,
  /^cargo\s+clippy\b/,
  /^golangci-lint\b/,
] as const

interface Issue {
  severity: 'ERROR' | 'WARNING'
  rule: string
  file: string
  line?: number
  message: string
}

const MAX_RULES = 10
const MAX_FILES = 10
const MAX_RULES_PER_FILE = 3

/** Whether the command is a linter this module understands. */
export function isLinterCommand(command: string | undefined | null): boolean {
  return matchesCommandPatterns(command, LINTER_COMMAND_PATTERNS)
}

function parseIssueLine(line: string): Issue | null {
  const fileLineMatch = line.match(/^(.+):(\d+):(\d+):\s*(.+)$/)
  if (fileLineMatch) {
    const lineNumber = Number.parseInt(fileLineMatch[2] ?? '0', 10)
    const content = fileLineMatch[4] ?? line
    return {
      severity: /warning/i.test(content) ? 'WARNING' : 'ERROR',
      rule: content.match(/\[(.+?)\]$/)?.[1] ?? 'unknown',
      file: fileLineMatch[1] ?? 'unknown',
      ...(Number.isNaN(lineNumber) ? {} : { line: lineNumber }),
      message: content,
    }
  }

  const rustMatch = line.match(/^(error|warning):\s*(.+?)\s+at\s+(.+):(\d+):(\d+)$/)
  if (rustMatch) {
    const lineNumber = Number.parseInt(rustMatch[4] ?? '0', 10)
    return {
      severity: (rustMatch[1]?.toUpperCase() ?? 'ERROR') as 'ERROR' | 'WARNING',
      rule: 'unknown',
      file: rustMatch[3] ?? 'unknown',
      ...(Number.isNaN(lineNumber) ? {} : { line: lineNumber }),
      message: rustMatch[2] ?? line,
    }
  }

  return null
}

function detectLinterType(command: string | undefined | null): string {
  const normalized = normalizeCommandForDetection(command)
  if (!normalized) return 'Linter'
  if (/(?:^|\s)eslint\b/.test(normalized)) return 'ESLint'
  if (/^ruff\b/.test(normalized)) return 'Ruff'
  if (/^pylint\b/.test(normalized)) return 'Pylint'
  if (/^mypy\b/.test(normalized)) return 'MyPy'
  if (/^flake8\b/.test(normalized)) return 'Flake8'
  if (/clippy\b/.test(normalized)) return 'Clippy'
  if (/^golangci-lint\b/.test(normalized)) return 'GolangCI-Lint'
  if (/prettier\b/.test(normalized)) return 'Prettier'
  return 'Linter'
}

/**
 * Reduce linter output to counts plus the rules and files that dominate.
 *
 * The full issue list is usually thousands of near-identical lines; the
 * distribution is what a reader acts on. Individual messages are dropped in
 * favor of counts, which is lossy by design — the reader re-runs on the file
 * they choose to fix.
 */
export function aggregateLinterOutput(output: string, command: string | undefined | null): string | null {
  if (!isLinterCommand(command)) return null

  const linterType = detectLinterType(command)
  const issues: Issue[] = []
  for (const line of output.split('\n')) {
    const issue = parseIssueLine(line)
    if (issue) issues.push(issue)
  }

  if (issues.length === 0) return `[OK] ${linterType}: No issues found`

  const errors = issues.filter((issue) => issue.severity === 'ERROR').length
  const warnings = issues.filter((issue) => issue.severity === 'WARNING').length

  const byRule = new Map<string, number>()
  const byFile = new Map<string, Issue[]>()
  for (const issue of issues) {
    byRule.set(issue.rule, (byRule.get(issue.rule) ?? 0) + 1)
    const existing = byFile.get(issue.file) ?? []
    existing.push(issue)
    byFile.set(issue.file, existing)
  }

  let result = `${linterType}: ${errors} errors, ${warnings} warnings in ${byFile.size} files\n`
  result += '═══════════════════════════════════════\n'
  result += 'Top rules:\n'
  for (const [rule, count] of Array.from(byRule.entries()).sort((left, right) => right[1] - left[1]).slice(0, MAX_RULES)) {
    result += `  ${rule} (${count}x)\n`
  }

  result += '\nTop files:\n'
  const sortedFiles = Array.from(byFile.entries()).sort((left, right) => right[1].length - left[1].length).slice(0, MAX_FILES)
  for (const [file, fileIssues] of sortedFiles) {
    result += `  ${compactPath(file, 40)} (${fileIssues.length} issues)\n`
    const fileRules = new Map<string, number>()
    for (const issue of fileIssues) fileRules.set(issue.rule, (fileRules.get(issue.rule) ?? 0) + 1)
    const topRules = Array.from(fileRules.entries()).sort((left, right) => right[1] - left[1]).slice(0, MAX_RULES_PER_FILE)
    for (const [rule, count] of topRules) result += `    ${rule} (${count})\n`
  }

  return result
}
