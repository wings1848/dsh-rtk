import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { OutputCompactionConfig, RtkConfig } from '../config.js'
import { aggregateLinterOutput } from './linter.js'
import { filterBuildOutput } from './build.js'
import { aggregateTestOutput } from './test-output.js'
import { compactGitOutput } from './git.js'
import { groupSearchResults } from './search.js'
import { detectLanguage, filterSourceCode, smartTruncate } from './source.js'
import { NO_OUTPUT_PLACEHOLDER, parseBashResult, renderBashResult } from './dsh-result.js'
import { countLines, stripAnsi, truncate } from './text.js'

/** Techniques whose effect cannot be undone by re-reading a smaller range. */
const LOSSY_TECHNIQUES = ['build', 'test', 'git', 'linter', 'search', 'truncate', 'smart-truncate', 'source:'] as const

/** Reads at or below this many lines are always left exact. */
const READ_EXACT_LINE_THRESHOLD = 80

/** Banner prefixed to a `read` result that lost information. */
export const READ_COMPACTION_BANNER_PREFIX = '[rtk compacted output:'

/** The tool-result projection compaction reads and writes. */
export interface CompactionInput {
  toolName: string
  args: unknown
  content: unknown
}

/** What one compaction pass did, for the session metrics. */
export interface CompactionMetadata {
  applied: boolean
  techniques: string[]
  truncated: boolean
  originalCharCount: number
  compactedCharCount: number
  originalLineCount: number
  compactedLineCount: number
}

/** The pipeline's verdict for one tool result. */
export interface CompactionOutcome {
  changed: boolean
  content?: unknown[]
  techniques: string[]
  metadata?: CompactionMetadata
}

interface TextTransform {
  text: string
  techniques: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  const record = asRecord(block)
  return record.type === 'text' && typeof record.text === 'string'
}

function hasLossyTechnique(techniques: readonly string[]): boolean {
  return techniques.some((technique) =>
    LOSSY_TECHNIQUES.some((prefix) => (prefix.endsWith(':') ? technique.startsWith(prefix) : technique === prefix)),
  )
}

/** Apply one nullable technique, recording it only when it changed the text. */
function applyNullable(state: TextTransform, result: string | null, technique: string): void {
  if (result === null || result === state.text) return
  state.text = result
  state.techniques.push(technique)
}

function applyAnsi(state: TextTransform, compaction: OutputCompactionConfig): void {
  if (!compaction.stripAnsi) return
  const stripped = stripAnsi(state.text)
  if (stripped !== state.text) {
    state.text = stripped
    state.techniques.push('ansi')
  }
}

/**
 * Compact a bash result without disturbing its status markers.
 *
 * stdout is summarized by whichever technique recognizes the command; stderr is
 * only stripped of escape codes, because an error message's exact wording is
 * what the reader acts on. The trailing markers are re-attached verbatim, and
 * a final budget check truncates the bodies while never cutting a marker.
 */
function compactBashText(text: string, command: string | undefined, compaction: OutputCompactionConfig): TextTransform {
  const parts = parseBashResult(text)
  if (parts.empty) return { text, techniques: [] }

  const state: TextTransform = { text: parts.stdout, techniques: [] }
  applyAnsi(state, compaction)

  if (compaction.filterBuildOutput) applyNullable(state, filterBuildOutput(state.text, command), 'build')
  if (compaction.aggregateTestOutput) applyNullable(state, aggregateTestOutput(state.text, command), 'test')
  if (compaction.compactGitOutput) applyNullable(state, compactGitOutput(state.text, command), 'git')
  if (compaction.aggregateLinterOutput) applyNullable(state, aggregateLinterOutput(state.text, command), 'linter')

  let stdout = state.text
  let stderr = parts.stderr
  if (stderr !== undefined && compaction.stripAnsi) stderr = stripAnsi(stderr)

  const render = (): string =>
    renderBashResult({
      empty: false,
      stdout,
      ...(stderr === undefined ? {} : { stderr }),
      markers: parts.markers,
    })

  let rendered = render()
  if (compaction.truncate.enabled && rendered.length > compaction.truncate.maxChars) {
    const markerOverhead = renderBashResult({ empty: false, stdout: '', markers: parts.markers }).length
    const budget = Math.max(1, compaction.truncate.maxChars - markerOverhead - 8)
    // stderr keeps the smaller share: it is usually short, and when it is not,
    // its head is still the diagnostic while its tail is usually a stack dump.
    const stderrBudget = stderr === undefined ? 0 : Math.min(stderr.length, Math.floor(budget * 0.4))
    const stdoutBudget = Math.max(1, budget - stderrBudget)
    if (stdout.length > stdoutBudget) stdout = truncate(stdout, stdoutBudget)
    if (stderr !== undefined && stderr.length > stderrBudget) stderr = truncate(stderr, stderrBudget)
    rendered = render()
    state.techniques.push('truncate')
  }

  // Compaction must never make a result bigger than the text it replaced.
  if (rendered.length >= text.length) return { text, techniques: [] }
  return { text: rendered, techniques: state.techniques }
}

/**
 * Whether a `read` result must stay byte-exact.
 *
 * Three cases: the caller asked for a narrow range (the tool already bounded
 * it, and the caller will edit against what it sees), the file is short enough
 * that filtering saves nothing worth the risk, or the path lives under a skill
 * directory — skills are instructions the agent follows verbatim.
 */
function shouldPreserveExactRead(text: string, args: Record<string, unknown>, compaction: OutputCompactionConfig): boolean {
  if (!compaction.readCompaction.enabled) return true
  if (args.offset !== undefined || args.limit !== undefined) return true
  if (countLines(text) <= READ_EXACT_LINE_THRESHOLD) return true

  if (compaction.preserveExactSkillReads && typeof args.path === 'string') {
    const target = resolve(args.path)
    const roots = [resolve(homedir(), '.agents', 'skills'), resolve(homedir(), '.dsh', 'skills')]
    let cursor = process.cwd()
    for (;;) {
      roots.push(resolve(cursor, '.agents', 'skills'))
      const parent = resolve(cursor, '..')
      if (parent === cursor) break
      cursor = parent
    }
    if (roots.some((root) => target === root || target.startsWith(`${root}/`))) return true
  }

  return false
}

function compactReadText(
  text: string,
  args: Record<string, unknown>,
  compaction: OutputCompactionConfig,
): TextTransform {
  if (shouldPreserveExactRead(text, args, compaction)) return { text, techniques: [] }

  const state: TextTransform = { text, techniques: [] }
  applyAnsi(state, compaction)

  const filePath = typeof args.path === 'string' ? args.path : ''
  const language = detectLanguage(filePath)

  if (compaction.sourceCodeFilteringEnabled && compaction.sourceCodeFiltering !== 'none') {
    applyNullable(state, filterSourceCode(state.text, language, compaction.sourceCodeFiltering), `source:${compaction.sourceCodeFiltering}`)
  }

  if (compaction.smartTruncate.enabled && countLines(state.text) > compaction.smartTruncate.maxLines) {
    applyNullable(state, smartTruncate(state.text, compaction.smartTruncate.maxLines), 'smart-truncate')
  }

  if (compaction.truncate.enabled && state.text.length > compaction.truncate.maxChars) {
    applyNullable(state, truncate(state.text, compaction.truncate.maxChars), 'truncate')
  }

  if (state.techniques.length === 0) return { text, techniques: [] }

  // The banner is part of the returned result, so the size guard must weigh it.
  // Filtering one comment line out of a short file saves less than the banner
  // costs, and without this the result would come back longer than the text it
  // replaced — the exact invariant the guard exists to hold.
  const banner = `${READ_COMPACTION_BANNER_PREFIX} ${state.techniques.join(', ')}]`
  const rendered = `${banner}\n${state.text}`
  if (rendered.length >= text.length) return { text, techniques: [] }
  return { text: rendered, techniques: state.techniques }
}

function compactGrepText(text: string, compaction: OutputCompactionConfig): TextTransform {
  const state: TextTransform = { text, techniques: [] }
  applyAnsi(state, compaction)

  if (compaction.groupSearchOutput) applyNullable(state, groupSearchResults(state.text), 'search')

  if (compaction.truncate.enabled && state.text.length > compaction.truncate.maxChars) {
    applyNullable(state, truncate(state.text, compaction.truncate.maxChars), 'truncate')
  }

  if (state.text.length >= text.length) return { text, techniques: [] }
  return state
}

/**
 * Run every enabled technique over one tool result.
 *
 * Returns `changed: false` whenever the result would not actually shrink, so a
 * caller can treat "no outcome" and "no improvement" identically and the model
 * never pays for a rewrite that saved nothing.
 *
 * @param input - the tool name, its parsed arguments, and the content blocks.
 * @param config - the resolved plugin configuration.
 * @returns the replacement content and the techniques that fired.
 */
export function compactToolResult(input: CompactionInput, config: RtkConfig): CompactionOutcome {
  const compaction = config.outputCompaction
  if (!config.enabled || !compaction.enabled) return { changed: false, techniques: [] }
  if (!config.compactedTools.includes(input.toolName)) return { changed: false, techniques: [] }

  const sourceContent = asArray(input.content)
  if (sourceContent.length === 0) return { changed: false, techniques: [] }

  const args = asRecord(input.args)
  const command = typeof args.command === 'string' ? args.command : undefined
  const techniques = new Set<string>()
  const originalChunks: string[] = []
  const compactedChunks: string[] = []
  let changed = false

  const nextContent = sourceContent.map((block) => {
    if (!isTextBlock(block)) return block

    let transformed: TextTransform = { text: block.text, techniques: [] }
    if (input.toolName === 'bash') transformed = compactBashText(block.text, command, compaction)
    else if (input.toolName === 'read') transformed = compactReadText(block.text, args, compaction)
    else if (input.toolName === 'grep') transformed = compactGrepText(block.text, compaction)

    for (const technique of transformed.techniques) techniques.add(technique)
    originalChunks.push(block.text)
    compactedChunks.push(transformed.text)

    if (transformed.text === block.text) return block
    changed = true
    return { ...(block as Record<string, unknown>), text: transformed.text }
  })

  if (!changed) return { changed: false, techniques: [] }
  if (originalChunks.join('\n') === NO_OUTPUT_PLACEHOLDER) return { changed: false, techniques: [] }

  const originalText = originalChunks.join('\n')
  const compactedText = compactedChunks.join('\n')
  const applied = Array.from(techniques)

  return {
    changed: true,
    content: nextContent,
    techniques: applied,
    metadata: {
      applied: true,
      techniques: applied,
      truncated: hasLossyTechnique(applied),
      originalCharCount: originalText.length,
      compactedCharCount: compactedText.length,
      originalLineCount: countLines(originalText),
      compactedLineCount: countLines(compactedText),
    },
  }
}
