import type { SourceCodeFilteringLevel } from '../config.js'

/** A language whose comment syntax this module knows. */
export type Language = 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'c' | 'shell' | 'ruby' | 'unknown'

const LANGUAGE_EXTENSIONS: Record<string, Language> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.mts': 'javascript',
  '.cts': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'c',
  '.cpp': 'c',
  '.hpp': 'c',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.rb': 'ruby',
}

const LINE_COMMENT: Record<Language, string | undefined> = {
  javascript: '//',
  python: '#',
  rust: '//',
  go: '//',
  java: '//',
  c: '//',
  shell: '#',
  ruby: '#',
  unknown: undefined,
}

const BLOCK_COMMENT: Partial<Record<Language, readonly [string, string]>> = {
  javascript: ['/*', '*/'],
  rust: ['/*', '*/'],
  go: ['/*', '*/'],
  java: ['/*', '*/'],
  c: ['/*', '*/'],
}

/** Signature/declaration lines worth keeping when lines must be dropped. */
const SIGNATURE_PATTERN = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|def|fn|const|let|var|public|private|protected|static|pub|package|import|from|use|mod)\b/
const IMPORT_PATTERN = /^(?:import|from|use|require|#include|package|mod)\b/

/** Infer a source language from a file extension. */
export function detectLanguage(filePath: string): Language {
  const lastDot = filePath.lastIndexOf('.')
  if (lastDot === -1) return 'unknown'
  return LANGUAGE_EXTENSIONS[filePath.slice(lastDot).toLowerCase()] ?? 'unknown'
}

/**
 * Keep the most informative `maxLines` lines of a source read.
 *
 * The first half of the budget is kept verbatim, after which only structural
 * lines survive — signatures, imports, and lone braces — with a marker where
 * body lines were dropped. This preserves the shape of the file (what is
 * defined where) rather than an arbitrary prefix, which is what makes the
 * result still usable for orientation.
 *
 * @param content - file text.
 * @param maxLines - line budget.
 * @returns the reduced text.
 */
export function smartTruncate(content: string, maxLines: number): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content

  const result: string[] = []
  let keptLines = 0
  let skippedSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    const isImportant =
      SIGNATURE_PATTERN.test(trimmed) ||
      IMPORT_PATTERN.test(trimmed) ||
      trimmed.startsWith('pub ') ||
      trimmed.startsWith('export ') ||
      trimmed === '}' ||
      trimmed === '{'

    if (isImportant || keptLines < maxLines / 2) {
      if (skippedSection) {
        result.push(`    // ... ${lines.length - keptLines} lines omitted`)
        skippedSection = false
      }
      result.push(line)
      keptLines += 1
    } else {
      skippedSection = true
    }

    if (keptLines >= maxLines - 1) break
  }

  if (skippedSection || keptLines < lines.length) {
    result.push(`// ... ${lines.length - keptLines} more lines (total: ${lines.length})`)
  }

  return result.join('\n')
}

/**
 * Remove non-documentation comments and collapse blank runs.
 *
 * Documentation comments — line docs and block docs alike — are kept: they
 * carry the contract, which is the part a reader most often needs. A line
 * whose comment marker appears inside a string literal is left alone, which is
 * why the check is prefix-anchored rather than a plain substring search.
 */
function filterMinimal(content: string, language: Language): string {
  const lineComment = LINE_COMMENT[language]
  const block = BLOCK_COMMENT[language]
  const lines = content.split('\n')
  const result: string[] = []
  let inBlockComment = false
  let inDocstring = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (inBlockComment) {
      if (block !== undefined && trimmed.includes(block[1])) inBlockComment = false
      continue
    }
    if (inDocstring) {
      result.push(line)
      if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) inDocstring = false
      continue
    }

    if (language === 'python' && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
      result.push(line)
      const isSingleLine = trimmed.length > 3 && (trimmed.endsWith('"""') || trimmed.endsWith("'''"))
      if (!isSingleLine) inDocstring = true
      continue
    }

    if (block !== undefined && trimmed.startsWith(block[0]) && !trimmed.includes(block[1], block[0].length)) {
      // A doc block (an extra `*` after the opener) is kept verbatim; any other
      // block comment opens and hides the lines that follow it.
      const afterOpener = trimmed.charAt(block[0].length)
      if (afterOpener === '*') {
        result.push(line)
      } else {
        inBlockComment = true
      }
      continue
    }

    if (lineComment !== undefined && trimmed.startsWith(lineComment)) {
      // Doc comments stay; ordinary comments go. A doc marker is the comment
      // prefix followed by `/` (`///`) or `!` (`//!`).
      const afterMarker = trimmed.charAt(lineComment.length)
      if (afterMarker === '/' || afterMarker === '!') result.push(line)
      continue
    }

    result.push(line)
  }

  const collapsed: string[] = []
  let blankRun = 0
  for (const line of result) {
    if (line.trim() === '') {
      blankRun++
      if (blankRun > 1) continue
    } else {
      blankRun = 0
    }
    collapsed.push(line)
  }

  return collapsed.join('\n')
}

/**
 * Keep imports, constants, and signatures while replacing bodies with a marker.
 *
 * Deliberately the most lossy level: it answers "what is in this file" without
 * pretending to answer "how does it work".
 */
function filterAggressive(content: string, language: Language): string {
  const lines = content.split('\n')
  const result: string[] = []
  let bodyDepth = 0
  let skipped = 0

  for (const line of lines) {
    const trimmed = line.trim()
    const isStructural =
      IMPORT_PATTERN.test(trimmed) ||
      SIGNATURE_PATTERN.test(trimmed) ||
      /^[A-Z_][A-Z0-9_]*\s*=/.test(trimmed) ||
      trimmed === '}' ||
      trimmed === '{' ||
      trimmed === ''

    if (isStructural) {
      if (skipped > 0) {
        result.push(`    // ... ${skipped} implementation lines omitted`)
        skipped = 0
      }
      result.push(line)
      bodyDepth = trimmed.endsWith('{') || trimmed.endsWith(':') ? bodyDepth + 1 : Math.max(0, bodyDepth - 1)
      continue
    }

    if (bodyDepth > 0) {
      skipped++
      continue
    }
    result.push(line)
  }

  if (skipped > 0) result.push(`    // ... ${skipped} implementation lines omitted`)
  return result.join('\n')
}

/** Apply the configured source-filtering level. */
export function filterSourceCode(content: string, language: Language, level: SourceCodeFilteringLevel): string {
  switch (level) {
    case 'none':
      return content
    case 'minimal':
      return filterMinimal(content, language)
    case 'aggressive':
      return filterAggressive(content, language)
    default:
      return content
  }
}
