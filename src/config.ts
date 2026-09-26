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
  /**
   * Yield oversized results to the harness's own spill policy when it is
   * mounted, instead of hard-truncating them first.
   */
  deferToHarnessSpill: boolean
  smartTruncate: SmartTruncateConfig
  truncate: TruncateConfig
}

/** The plugin's fully-resolved configuration. */
export interface RtkConfig {
  enabled: boolean
  mode: RtkMode
  guardWhenRtkMissing: boolean
  showRewriteNotifications: boolean
  /** Whether a session is told once that rewriting is off because rtk is absent. */
  notifyWhenRtkMissing: boolean
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
  // On: a missing binary is the one condition that silently costs the user the
  // whole feature. The notice is emitted once per session, so its cost is
  // bounded even though it is on by default.
  notifyWhenRtkMissing: true,
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
    // The harness spill policy truncates recoverably (full output on disk,
    // head/tail preview inline); this plugin's hard truncation does not. It
    // also runs first, so at 12 000 characters it fires far below spill's
    // threshold and spill never sees a large result. Deferring is the default;
    // `false` keeps this plugin's own bound even when spill is mounted.
    deferToHarnessSpill: true,
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
 * Mark one schema field live-editable at runtime (schemastery's `volatile` role).
 *
 * Feature-detected, because the two harness generations this plugin supports
 * ship different schemastery lines: `Schema.prototype.volatile` exists from
 * 3.18.4 on, and a schema built against 3.18.2 must stay loadable there. The
 * old settings provider registers the whole namespace regardless; the modern
 * settings page only lists fields carrying this mark. Adding a top-level field
 * to {@link Config} means wrapping it here once — fields added *inside*
 * `outputCompaction` inherit editability from the container.
 *
 * The return type deliberately stays `T`: `RtkConfig` is hand-written and
 * normalized separately, so the volatile wrapper never leaks into the types
 * this plugin passes around (on old hosts the values are not wrapped at all).
 *
 * Exported for the schema-contract test, which pins both halves of the
 * behavior: marked on a modern schemastery, and left untouched on one without
 * the method.
 */
export function editable<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => unknown }
  return typeof candidate.volatile === 'function' ? (candidate.volatile() as T) : schema
}

/**
 * The composition-facing configuration schema.
 *
 * Exported as both a value (the schemastery schema the loader validates and
 * fills defaults with) and, through declaration merging, the resolved type.
 * No explicit annotation is attached: `z.object` already infers the pair, and
 * a hand-written one would have to restate every nested field.
 */
export const Config = z.object({
  enabled: editable(z.boolean().default(DEFAULT_CONFIG.enabled).description('Master switch for command rewriting and output compaction.')),
  mode: editable(
    z
      .union([z.const('rewrite'), z.const('suggest')])
      .default(DEFAULT_CONFIG.mode)
      .description('`rewrite` replaces a supported command; `suggest` only reports the equivalent.'),
  ),
  guardWhenRtkMissing: editable(
    z
      .boolean()
      .default(DEFAULT_CONFIG.guardWhenRtkMissing)
      .description('Run the original command unchanged when the rtk executable is unavailable.'),
  ),
  showRewriteNotifications: editable(
    z
      .boolean()
      .default(DEFAULT_CONFIG.showRewriteNotifications)
      .description('Record rewrite decisions so they are visible in the session log.'),
  ),
  notifyWhenRtkMissing: editable(
    z
      .boolean()
      .default(DEFAULT_CONFIG.notifyWhenRtkMissing)
      .description('Tell each session once that command rewriting is off because rtk is not installed.'),
  ),
  rtkExecutable: editable(z.string().default(DEFAULT_CONFIG.rtkExecutable).description('Executable name or path for rtk.')),
  rewriteTimeoutMs: editable(z.natural().default(DEFAULT_CONFIG.rewriteTimeoutMs).description('Deadline in milliseconds for one `rtk rewrite` call.')),
  compactedTools: editable(
    z
      .array(z.string())
      .default([...DEFAULT_CONFIG.compactedTools])
      .description('Tool names whose text results pass through the compaction pipeline.'),
  ),
  outputCompaction: editable(
    z
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
      deferToHarnessSpill: z.boolean().default(true),
      smartTruncate: z.object({
        enabled: z.boolean().default(false),
        maxLines: z.natural().default(DEFAULT_CONFIG.outputCompaction.smartTruncate.maxLines),
      }),
      truncate: z.object({
        enabled: z.boolean().default(true),
        maxChars: z.natural().default(DEFAULT_CONFIG.outputCompaction.truncate.maxChars),
      }),
    })
    .default(DEFAULT_CONFIG.outputCompaction)),
})

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * Identify cosmokit Volatile references without importing cosmokit.
 *
 * Fields marked {@link editable} are handed to the plugin as live references
 * (`config.field.get()`), and the loader updates them in place on a settings
 * edit. The reference protocol is identified by a *registered* symbol exactly
 * so consumers can recognize it across ESM/CJS copies and across the library
 * versions the two harness generations ship — so this check is the contract,
 * not a guess.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function unwrapVolatile(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const holder = value as Record<PropertyKey, unknown>
  return VOLATILE_WRITE in holder && typeof holder.get === 'function' ? (holder.get as () => unknown)() : value
}

/** Deep-copy plain configuration data, reading any Volatile reference on the way. */
function plainize(value: unknown): unknown {
  const direct = unwrapVolatile(value)
  if (Array.isArray(direct)) return direct.map(plainize)
  if (typeof direct === 'object' && direct !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(direct)) result[key] = plainize(item)
    return result
  }
  return direct
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
 * pipeline's safeguards by accident. Volatile references (the modern harness's
 * live-editable fields) are read through on the way, so callers on either
 * harness generation can hand in whatever their config object holds.
 */
export function normalizeConfig(raw: unknown): RtkConfig {
  const root = asRecord(plainize(raw))
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
    notifyWhenRtkMissing: pickBoolean(root.notifyWhenRtkMissing, DEFAULT_CONFIG.notifyWhenRtkMissing),
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
      deferToHarnessSpill: pickBoolean(compaction.deferToHarnessSpill, DEFAULT_CONFIG.outputCompaction.deferToHarnessSpill),
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
