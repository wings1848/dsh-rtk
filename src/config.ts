import z from '@deepseek-ai/schemastery'

/**
 * How bash commands are handled.
 *
 * - `rewrite` — a command with an RTK equivalent is replaced before it runs.
 * - `suggest` — the command runs unchanged; the rewrite is only reported.
 */
export type RtkMode = 'rewrite' | 'suggest'

/** Source-code filtering strength applied to `read` output. */
export type SourceCodeFilteringLevel = 'none' | 'minimal' | 'aggressive'

/** Line-based truncation for `read` output. */
export interface SmartTruncateConfig {
  enabled: boolean
  maxLines: number
}

/** Final character-budget enforcement applied to every compacted text. */
export interface TruncateConfig {
  enabled: boolean
  maxChars: number
}

/** Lossy compaction for `read` output; off by default so code reads stay exact. */
export interface ReadCompactionConfig {
  enabled: boolean
}

/** The output-compaction pipeline's switches. */
export interface OutputCompactionConfig {
  enabled: boolean
  stripAnsi: boolean
  readCompaction: ReadCompactionConfig
  sourceCodeFilteringEnabled: boolean
  preserveExactSkillReads: boolean
  sourceCodeFiltering: SourceCodeFilteringLevel
  aggregateTestOutput: boolean
  filterBuildOutput: boolean
  compactGitOutput: boolean
  aggregateLinterOutput: boolean
  groupSearchOutput: boolean
  trackSavings: boolean
  smartTruncate: SmartTruncateConfig
  truncate: TruncateConfig
}

/** The plugin's fully-resolved configuration. */
export interface RtkConfig {
  enabled: boolean
  mode: RtkMode
  guardWhenRtkMissing: boolean
  showRewriteNotifications: boolean
  /** Executable used for both `--version` probes and `rtk rewrite`. */
  rtkExecutable: string
  /** Deadline for one `rtk rewrite` call. */
  rewriteTimeoutMs: number
  /** Tools whose results pass through the compaction pipeline. */
  compactedTools: string[]
  outputCompaction: OutputCompactionConfig
}

/** Defaults for every field; also the fallback when a layer omits one. */
export const DEFAULT_CONFIG: RtkConfig = {
  enabled: true,
  mode: 'rewrite',
  guardWhenRtkMissing: true,
  // Deliberately off, unlike pi-rtk-optimizer's equivalent flag. There the
  // notice is a TUI toast; here it is appended to the tool result, so it would
  // sit in the model's context on every rewritten call. The saving is the
  // point of the plugin, and `/rtk stats` already reports what happened.
  showRewriteNotifications: false,
  rtkExecutable: 'rtk',
  rewriteTimeoutMs: 3000,
  compactedTools: ['bash', 'read', 'grep'],
  outputCompaction: {
    enabled: true,
    stripAnsi: true,
    readCompaction: { enabled: false },
    sourceCodeFilteringEnabled: false,
    preserveExactSkillReads: false,
    sourceCodeFiltering: 'none',
    aggregateTestOutput: true,
    filterBuildOutput: true,
    compactGitOutput: true,
    aggregateLinterOutput: true,
    groupSearchOutput: true,
    trackSavings: true,
    smartTruncate: { enabled: false, maxLines: 220 },
    truncate: { enabled: true, maxChars: 12000 },
  },
}

const SOURCE_CODE_FILTERING_LEVELS: readonly SourceCodeFilteringLevel[] = ['none', 'minimal', 'aggressive']

/** Bounds published in the configuration catalog and enforced during normalization. */
export const BOUNDS = {
  maxLines: { min: 40, max: 4000 },
  maxChars: { min: 1000, max: 200000 },
} as const

/**
 * The composition-facing configuration schema.
 *
 * Exported as both a value (the schemastery schema the loader validates and
 * fills defaults with) and, through declaration merging, the resolved type.
 * No explicit annotation is attached: `z.object` already infers the pair, and
 * a hand-written one would have to restate every nested field.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('Master switch for command rewriting and output compaction.'),
  mode: z
    .union([z.const('rewrite'), z.const('suggest')])
    .default(DEFAULT_CONFIG.mode)
    .description('`rewrite` replaces a supported command; `suggest` only reports the equivalent.'),
  guardWhenRtkMissing: z
    .boolean()
    .default(DEFAULT_CONFIG.guardWhenRtkMissing)
    .description('Run the original command unchanged when the rtk executable is unavailable.'),
  showRewriteNotifications: z
    .boolean()
    .default(DEFAULT_CONFIG.showRewriteNotifications)
    .description('Record rewrite decisions so they are visible in the session log.'),
  rtkExecutable: z.string().default(DEFAULT_CONFIG.rtkExecutable).description('Executable name or path for rtk.'),
  rewriteTimeoutMs: z.natural().default(DEFAULT_CONFIG.rewriteTimeoutMs).description('Deadline in milliseconds for one `rtk rewrite` call.'),
  compactedTools: z
    .array(z.string())
    .default([...DEFAULT_CONFIG.compactedTools])
    .description('Tool names whose text results pass through the compaction pipeline.'),
  outputCompaction: z
    .object({
      enabled: z.boolean().default(true),
      stripAnsi: z.boolean().default(true),
      readCompaction: z.object({ enabled: z.boolean().default(false) }),
      sourceCodeFilteringEnabled: z.boolean().default(false),
      preserveExactSkillReads: z.boolean().default(false),
      sourceCodeFiltering: z
        .union([z.const('none'), z.const('minimal'), z.const('aggressive')])
        .default(DEFAULT_CONFIG.outputCompaction.sourceCodeFiltering),
      aggregateTestOutput: z.boolean().default(true),
      filterBuildOutput: z.boolean().default(true),
      compactGitOutput: z.boolean().default(true),
      aggregateLinterOutput: z.boolean().default(true),
      groupSearchOutput: z.boolean().default(true),
      trackSavings: z.boolean().default(true),
      smartTruncate: z.object({
        enabled: z.boolean().default(false),
        maxLines: z.natural().default(DEFAULT_CONFIG.outputCompaction.smartTruncate.maxLines),
      }),
      truncate: z.object({
        enabled: z.boolean().default(true),
        maxChars: z.natural().default(DEFAULT_CONFIG.outputCompaction.truncate.maxChars),
      }),
    })
    .default(DEFAULT_CONFIG.outputCompaction),
})

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function pickStringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const names = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  return names.length > 0 ? names : [...fallback]
}

/**
 * Normalize arbitrary configuration into a complete {@link RtkConfig}.
 *
 * The loader already validates the composition's `config:` block, but this
 * entry is also reachable from tests, from `apply()` called directly, and from
 * a runtime patch, so every field is re-derived rather than trusted. Numbers
 * are clamped to {@link BOUNDS} so a hand-edited value cannot disable the
 * pipeline's safeguards by accident.
 */
export function normalizeConfig(raw: unknown): RtkConfig {
  const root = asRecord(raw)
  const compaction = asRecord(root.outputCompaction)
  const readCompaction = asRecord(compaction.readCompaction)
  const smartTruncate = asRecord(compaction.smartTruncate)
  const truncate = asRecord(compaction.truncate)

  const mode = root.mode === 'suggest' ? 'suggest' : 'rewrite'
  const filtering = SOURCE_CODE_FILTERING_LEVELS.includes(compaction.sourceCodeFiltering as SourceCodeFilteringLevel)
    ? (compaction.sourceCodeFiltering as SourceCodeFilteringLevel)
    : DEFAULT_CONFIG.outputCompaction.sourceCodeFiltering

  return {
    enabled: pickBoolean(root.enabled, DEFAULT_CONFIG.enabled),
    mode,
    guardWhenRtkMissing: pickBoolean(root.guardWhenRtkMissing, DEFAULT_CONFIG.guardWhenRtkMissing),
    showRewriteNotifications: pickBoolean(root.showRewriteNotifications, DEFAULT_CONFIG.showRewriteNotifications),
    rtkExecutable: pickString(root.rtkExecutable, DEFAULT_CONFIG.rtkExecutable),
    rewriteTimeoutMs: pickNumber(root.rewriteTimeoutMs, DEFAULT_CONFIG.rewriteTimeoutMs, 100, 60000),
    compactedTools: pickStringList(root.compactedTools, DEFAULT_CONFIG.compactedTools),
    outputCompaction: {
      enabled: pickBoolean(compaction.enabled, DEFAULT_CONFIG.outputCompaction.enabled),
      stripAnsi: pickBoolean(compaction.stripAnsi, DEFAULT_CONFIG.outputCompaction.stripAnsi),
      readCompaction: {
        enabled: pickBoolean(readCompaction.enabled, DEFAULT_CONFIG.outputCompaction.readCompaction.enabled),
      },
      sourceCodeFilteringEnabled: pickBoolean(
        compaction.sourceCodeFilteringEnabled,
        DEFAULT_CONFIG.outputCompaction.sourceCodeFilteringEnabled,
      ),
      preserveExactSkillReads: pickBoolean(compaction.preserveExactSkillReads, DEFAULT_CONFIG.outputCompaction.preserveExactSkillReads),
      sourceCodeFiltering: filtering,
      aggregateTestOutput: pickBoolean(compaction.aggregateTestOutput, DEFAULT_CONFIG.outputCompaction.aggregateTestOutput),
      filterBuildOutput: pickBoolean(compaction.filterBuildOutput, DEFAULT_CONFIG.outputCompaction.filterBuildOutput),
      compactGitOutput: pickBoolean(compaction.compactGitOutput, DEFAULT_CONFIG.outputCompaction.compactGitOutput),
      aggregateLinterOutput: pickBoolean(compaction.aggregateLinterOutput, DEFAULT_CONFIG.outputCompaction.aggregateLinterOutput),
      groupSearchOutput: pickBoolean(compaction.groupSearchOutput, DEFAULT_CONFIG.outputCompaction.groupSearchOutput),
      trackSavings: pickBoolean(compaction.trackSavings, DEFAULT_CONFIG.outputCompaction.trackSavings),
      smartTruncate: {
        enabled: pickBoolean(smartTruncate.enabled, DEFAULT_CONFIG.outputCompaction.smartTruncate.enabled),
        maxLines: pickNumber(smartTruncate.maxLines, DEFAULT_CONFIG.outputCompaction.smartTruncate.maxLines, BOUNDS.maxLines.min, BOUNDS.maxLines.max),
      },
      truncate: {
        enabled: pickBoolean(truncate.enabled, DEFAULT_CONFIG.outputCompaction.truncate.enabled),
        maxChars: pickNumber(truncate.maxChars, DEFAULT_CONFIG.outputCompaction.truncate.maxChars, BOUNDS.maxChars.min, BOUNDS.maxChars.max),
      },
    },
  }
}
