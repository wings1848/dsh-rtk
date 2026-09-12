import { matchesCommandPatterns, normalizeCommandForDetection } from './detect.js'

const GIT_COMMAND_PATTERNS = [/^git\s+(diff|status|log|show|stash)\b/] as const
const RAW_GIT_DIFF_PATTERN = /^diff --git /m
const RAW_GIT_STATUS_PATTERN = /^(?:## |(?:M|A|D|R|C|U|\?| )\S)/m

/**
 * One line of `git status --porcelain` output.
 *
 * Covers the v1 branch header (`## main...origin/main`), the v2 headers
 * (`# branch.head main`), the `??` untracked form, and the two-column status
 * form. The human report contains none of these shapes.
 */
const PORCELAIN_STATUS_LINE = /^(?:##?\s|\?\? .+|[ MADRCU?!]{2} .+)/

/** Share of non-blank lines that must parse as porcelain before summarizing. */
const PORCELAIN_LINE_MIN_RATIO = 0.8

/**
 * Whether a body is `git status --porcelain` rather than the human report.
 *
 * The two are indistinguishable line by line — ` M path` is valid porcelain
 * and also occurs inside the human report — but only porcelain may be sliced
 * with fixed column offsets. Running the summarizer over the human text
 * silently invents and drops entries, so the body must be *consistently*
 * porcelain before any of it is interpreted.
 */
function isPorcelainStatus(output: string): boolean {
  const lines = output.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return false
  const matches = lines.filter((line) => PORCELAIN_STATUS_LINE.test(line)).length
  return matches / lines.length >= PORCELAIN_LINE_MIN_RATIO
}

/** Whether the command is one of the git commands this module understands. */
export function isGitCommand(command: string | undefined | null): boolean {
  return matchesCommandPatterns(command, GIT_COMMAND_PATTERNS)
}

/**
 * Condense a unified diff to file headers, hunk headers, and a bounded sample
 * of changed lines, with an added/removed count per file.
 */
export function compactDiff(output: string, maxLines = 50): string {
  const lines = output.split('\n')
  const result: string[] = []
  let currentFile = ''
  let added = 0
  let removed = 0
  let inHunk = false
  let hunkLines = 0
  const maxHunkLines = 10

  for (const line of lines) {
    if (result.length >= maxLines) {
      result.push('\n... (more changes truncated)')
      break
    }

    if (line.startsWith('diff --git')) {
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`)
      const match = line.match(/diff --git a\/(.+) b\/(.+)/)
      currentFile = match?.[2] ?? 'unknown'
      result.push(`\n> ${currentFile}`)
      added = 0
      removed = 0
      inHunk = false
      continue
    }

    if (line.startsWith('@@')) {
      inHunk = true
      hunkLines = 0
      result.push(`  ${line.match(/@@ .+ @@/)?.[0] ?? '@@'}`)
      continue
    }

    if (!inHunk) continue

    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
      if (hunkLines < maxHunkLines) {
        result.push(`  ${line}`)
        hunkLines++
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
      if (hunkLines < maxHunkLines) {
        result.push(`  ${line}`)
        hunkLines++
      }
    } else if (hunkLines < maxHunkLines && !line.startsWith('\\')) {
      if (hunkLines > 0) {
        result.push(`  ${line}`)
        hunkLines++
      }
    }

    if (hunkLines === maxHunkLines) {
      result.push('  ... (truncated)')
      hunkLines++
    }
  }

  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`)
  return result.join('\n')
}

interface StatusStats {
  staged: number
  modified: number
  untracked: number
  conflicts: number
  stagedFiles: string[]
  modifiedFiles: string[]
  untrackedFiles: string[]
}

/** Condense `git status` porcelain output into per-bucket counts and samples. */
export function compactStatus(output: string): string {
  const lines = output.split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0]?.trim() === '')) return 'Clean working tree'

  const stats: StatusStats = {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    stagedFiles: [],
    modifiedFiles: [],
    untrackedFiles: [],
  }
  let branchName = ''

  for (const line of lines) {
    if (line.startsWith('##')) {
      const match = line.match(/## (.+)/)
      if (match?.[1]) branchName = match[1].split('...')[0] ?? match[1]
      continue
    }
    if (line.length < 3) continue

    const status = line.slice(0, 2)
    const filename = line.slice(3)
    const indexStatus = status[0]
    const worktreeStatus = status[1]

    if (indexStatus !== undefined && ['M', 'A', 'D', 'R', 'C'].includes(indexStatus)) {
      stats.staged++
      stats.stagedFiles.push(filename)
    }
    if (indexStatus === 'U') stats.conflicts++
    if (worktreeStatus !== undefined && ['M', 'D'].includes(worktreeStatus)) {
      stats.modified++
      stats.modifiedFiles.push(filename)
    }
    if (status === '??') {
      stats.untracked++
      stats.untrackedFiles.push(filename)
    }
  }

  let result = `Branch: ${branchName}\n`
  const append = (label: string, count: number, files: string[], shown: number): void => {
    if (count === 0) return
    result += `${label}: ${count} files\n`
    for (const file of files.slice(0, shown)) result += `  ${file}\n`
    if (count > shown) result += `  ... +${count - shown} more\n`
  }
  append('Staged', stats.staged, stats.stagedFiles, 5)
  append('Modified', stats.modified, stats.modifiedFiles, 5)
  append('Untracked', stats.untracked, stats.untrackedFiles, 3)
  if (stats.conflicts > 0) result += `Conflicts: ${stats.conflicts} files\n`

  return result.trim()
}

/** Keep the first `limit` log lines, capping each line's width. */
export function compactLog(output: string, limit = 20): string {
  const lines = output.split('\n')
  const result: string[] = []
  for (const line of lines.slice(0, limit)) {
    result.push(line.length > 80 ? `${line.slice(0, 77)}...` : line)
  }
  if (lines.length > limit) result.push(`... and ${lines.length - limit} more commits`)
  return result.join('\n')
}

/**
 * Compact a git command's output, or `null` when nothing applies.
 *
 * Each branch first checks that the output actually looks like raw git output.
 * A command like `git diff --stat` inside a wrapper, or a script whose name
 * merely starts with `git`, would otherwise be rewritten into a summary of
 * text this module never parsed correctly.
 */
export function compactGitOutput(output: string, command: string | undefined | null): string | null {
  if (!isGitCommand(command)) return null
  const normalized = normalizeCommandForDetection(command)
  if (!normalized) return null

  if (normalized.startsWith('git diff')) return RAW_GIT_DIFF_PATTERN.test(output) ? compactDiff(output) : null
  if (normalized.startsWith('git status')) {
    if (!isPorcelainStatus(output)) return null
    return RAW_GIT_STATUS_PATTERN.test(output) ? compactStatus(output) : null
  }
  if (normalized.startsWith('git log')) return compactLog(output)
  return null
}
