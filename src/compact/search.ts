import { compactPath } from './text.js'

interface SearchResult {
  file: string
  lineNumber: string
  content: string
}

/** Minimum share of non-blank lines that must parse as `file:line:content`. */
const MIN_MATCH_RATIO = 0.6

/**
 * Group `grep`-style matches by file.
 *
 * Returns `null` when the output is not recognizably a match list. The format
 * check is what keeps this safe across search tools: ripgrep, GNU grep, and the
 * harness's own `grep` all print `path:line:text`, but a command whose name
 * merely resembles a search may print anything at all, and summarizing that
 * would silently discard real output. Erring toward `null` leaves the text
 * untouched, which is always correct.
 *
 * @param output - raw search output.
 * @param maxResults - cap on rendered match lines across all files.
 * @returns the grouped summary, or `null` when the shape does not match.
 */
export function groupSearchResults(output: string, maxResults = 50): string | null {
  const lines = output.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null

  const results: SearchResult[] = []
  let parseable = 0

  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+)?:(.*)$/)
    if (!match) continue
    parseable++
    results.push({
      file: match[1] ?? 'unknown',
      lineNumber: match[2] ?? '?',
      content: match[3] ?? '',
    })
  }

  if (results.length === 0) return null
  if (parseable / lines.length < MIN_MATCH_RATIO) return null

  const byFile = new Map<string, SearchResult[]>()
  for (const result of results) {
    const existing = byFile.get(result.file) ?? []
    existing.push(result)
    byFile.set(result.file, existing)
  }

  let outputText = `${results.length} matches in ${byFile.size} files:\n\n`
  const sortedFiles = Array.from(byFile.entries()).sort((left, right) => left[0].localeCompare(right[0]))

  let shown = 0
  for (const [file, matches] of sortedFiles) {
    if (shown >= maxResults) break
    outputText += `> ${compactPath(file, 50)} (${matches.length} matches):\n`
    for (const match of matches.slice(0, 10)) {
      let cleaned = match.content.trim()
      if (cleaned.length > 70) cleaned = `${cleaned.slice(0, 67)}...`
      outputText += `    ${match.lineNumber}: ${cleaned}\n`
      shown++
    }
    if (matches.length > 10) outputText += `  +${matches.length - 10} more\n`
    outputText += '\n'
  }

  if (results.length > shown) outputText += `... +${results.length - shown} more\n`
  return outputText
}
