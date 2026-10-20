import z from '@deepseek-ai/schemastery'

/**
 * What the plugin does with a shell command.
 *
 * - `off` — the plugin registers its listeners but takes no action: commands
 *   run as written and results are not compacted.
 * - `rewrite` — a command with an RTK equivalent is replaced before it runs.
 * - `suggest` — the command runs unchanged; the rewrite is only reported.
 */
export type RtkMode = 'off' | 'rewrite' | 'suggest'

/**
 * Lossy `read` compaction strength.
 *
 * - `none` — reads stay byte-exact (the default; edits are written against them).
 * - `budget` — only the character budget applies; source text is untouched.
 * - `minimal` — ordinary comments are dropped, documentation comments stay.
 * - `aggressive` — imports and signatures stay; bodies are replaced by markers.
 */
export type ReadCompaction = 'none' | 'budget' | 'minimal' | 'aggressive'

/** The plugin's fully-resolved configuration. */
export interface RtkConfig {
  /** Master switch; `off` disables both halves. */
  mode: RtkMode
  /** Whether tool results pass through the compaction pipeline. */
  compact: boolean
  /** Final character budget applied to compacted text. */
  maxChars: number
  /** `read` compaction strength. */
  readCompaction: ReadCompaction
  /** Executable used for both `--version` probes and `rtk rewrite`. */
  rtkExecutable: string
}

/** Defaults for every field; also the fallback when a layer omits one. */
export const DEFAULT_CONFIG: RtkConfig = {
  mode: 'rewrite',
  compact: true,
  maxChars: 12000,
  // Deliberately off: filtering or truncating a `read` result can make the
  // model's copy differ from the file, and edits are written against that copy.
  readCompaction: 'none',
  rtkExecutable: 'rtk',
}

/** Bounds published in the configuration catalog and enforced during normalization. */
export const BOUNDS = {
  maxChars: { min: 1000, max: 200000 },
} as const

/**
 * Deadline for one `rtk rewrite` call.
 *
 * Not configurable any more: rtk answers locally, and a hung probe is already
 * bounded by the call's own signal. The value matches the previous default.
 */
export const REWRITE_TIMEOUT_MS = 3000

/**
 * Tool names whose text results pass through the compaction pipeline.
 *
 * Not configurable any more: these are exactly the tools with a compactor. The
 * list is fixed so a name that has no matching branch cannot silently do
 * nothing.
 */
export const COMPACTED_TOOLS: readonly string[] = ['bash', 'read', 'grep', 'ops_bash', 'ops_grep']

/**
 * Mark one schema field live-editable at runtime (schemastery's `volatile` role).
 *
 * Feature-detected, because the two harness generations this plugin supports
 * ship different schemastery lines: `Schema.prototype.volatile` exists from
 * 3.18.4 on, and a schema built against 3.18.2 must stay loadable there. The
 * old settings provider registers the whole namespace regardless; the modern
 * settings page only lists fields carrying this mark.
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
  mode: editable(
    z
      .union([z.const('off'), z.const('rewrite'), z.const('suggest')])
      .default(DEFAULT_CONFIG.mode)
      .description('`off` disables both halves; `rewrite` replaces a supported command; `suggest` only reports the equivalent.'),
  ),
  compact: editable(
    z.boolean().default(DEFAULT_CONFIG.compact).description('Compact tool output before it reaches the model.'),
  ),
  maxChars: editable(
    z
      .natural()
      .min(BOUNDS.maxChars.min)
      .max(BOUNDS.maxChars.max)
      .default(DEFAULT_CONFIG.maxChars)
      .description('Character budget for compacted text (1000–200000).'),
  ),
  readCompaction: editable(
    z
      .union([z.const('none'), z.const('budget'), z.const('minimal'), z.const('aggressive')])
      .default(DEFAULT_CONFIG.readCompaction)
      .description('`none` keeps reads exact; `budget` truncates only; `minimal` also drops ordinary comments; `aggressive` keeps imports and signatures.'),
  ),
  rtkExecutable: editable(
    z
      .string()
      .default(DEFAULT_CONFIG.rtkExecutable)
      .description('Executable name or absolute path for rtk; empty means auto-detect (the plugin fills in the path it finds).'),
  ),
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

/**
 * Resolve the rtk executable setting.
 *
 * A missing field keeps the shipped default, but an explicit empty string is
 * preserved: it is the "auto-detect" state the plugin writes when no rtk was
 * found, and the form must be able to show it.
 */
function pickExecutable(value: unknown): string {
  return typeof value === 'string' ? value.trim() : DEFAULT_CONFIG.rtkExecutable
}

const MODES: readonly RtkMode[] = ['off', 'rewrite', 'suggest']
const READ_COMPACTIONS: readonly ReadCompaction[] = ['none', 'budget', 'minimal', 'aggressive']

function isMode(value: unknown): value is RtkMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function isReadCompaction(value: unknown): value is ReadCompaction {
  return typeof value === 'string' && (READ_COMPACTIONS as readonly string[]).includes(value)
}

/**
 * Resolve the master switch, migrating the retired `enabled` field.
 *
 * Every released configuration carried `enabled`; it now folds into `mode`.
 * An explicit `enabled: false` still means "off", so a patch or settings layer
 * written for the old schema keeps its intent instead of silently turning the
 * plugin back on.
 */
function normalizeMode(root: Record<string, unknown>): RtkMode {
  if (root.enabled === false) return 'off'
  return isMode(root.mode) ? root.mode : DEFAULT_CONFIG.mode
}

/**
 * Whether a field carries an explicit value rather than the schema default.
 *
 * The loader validates the composition's `config:` block before `apply` sees
 * it, and validation fills every field with its schema default. So "the new
 * field is present" cannot mean "the user set it": a configuration written for
 * the retired schema arrives with all five new fields already populated. A
 * retired key therefore wins only when the new field still holds the default —
 * the transitional case where a user pinned the new field to exactly the
 * default while also carrying the old key is the one this cannot distinguish,
 * and it is not worth the complexity.
 */
function isExplicit(value: unknown, isDefault: boolean, legacyPresent: boolean): boolean {
  if (value === undefined) return false
  return isDefault ? !legacyPresent : true
}

/**
 * Resolve read compaction, migrating the retired `outputCompaction` fields.
 *
 * The old shape needed three fields to express one behavior: the enable flag,
 * the filtering flag, and the filtering level. Their combination maps onto the
 * single enum:
 *
 * - `readCompaction.enabled !== true` → `none`
 * - enabled with filtering at `minimal` / `aggressive` → the same level
 * - enabled without filtering (level `none`, or the filtering flag off) →
 *   `budget`, which keeps the character bound but leaves source text alone
 */
function normalizeReadCompaction(root: Record<string, unknown>, legacy: Record<string, unknown>): ReadCompaction {
  const legacyRead = asRecord(legacy.readCompaction)
  const legacyPresent = legacyRead.enabled !== undefined
  const explicit = isExplicit(
    root.readCompaction,
    root.readCompaction === DEFAULT_CONFIG.readCompaction,
    legacyPresent,
  )
  if (explicit && isReadCompaction(root.readCompaction)) return root.readCompaction

  if (legacyRead.enabled !== true) return DEFAULT_CONFIG.readCompaction

  const filtering = legacy.sourceCodeFilteringEnabled === true
  if (filtering && legacy.sourceCodeFiltering === 'minimal') return 'minimal'
  if (filtering && legacy.sourceCodeFiltering === 'aggressive') return 'aggressive'
  return 'budget'
}

/**
 * Normalize arbitrary configuration into a complete {@link RtkConfig}.
 *
 * The loader already validates the composition's `config:` block, but this
 * entry is also reachable from tests, from `apply()` called directly, from a
 * runtime patch, and from settings layers written for the previous schema, so
 * every field is re-derived rather than trusted. Retired fields are migrated
 * (see {@link normalizeMode} and {@link normalizeReadCompaction}); numbers are
 * clamped to {@link BOUNDS} so a hand-edited value cannot disable the
 * pipeline's safeguards by accident. Volatile references (the modern harness's
 * live-editable fields) are read through on the way, so callers on either
 * harness generation can hand in whatever their config object holds.
 */
export function normalizeConfig(raw: unknown): RtkConfig {
  const root = asRecord(plainize(raw))
  const legacy = asRecord(root.outputCompaction)
  const legacyTruncate = asRecord(legacy.truncate)

  // A field the loader defaulted is not an explicit choice, so the retired key
  // may still speak for it (see {@link isExplicit}).
  const rawMaxChars =
    isExplicit(root.maxChars, root.maxChars === DEFAULT_CONFIG.maxChars, legacyTruncate.maxChars !== undefined)
      ? root.maxChars
      : legacyTruncate.maxChars
  const rawCompact =
    isExplicit(root.compact, root.compact === DEFAULT_CONFIG.compact, legacy.enabled !== undefined)
      ? root.compact
      : legacy.enabled

  return {
    mode: normalizeMode(root),
    compact: pickBoolean(rawCompact, DEFAULT_CONFIG.compact),
    maxChars: pickNumber(rawMaxChars, DEFAULT_CONFIG.maxChars, BOUNDS.maxChars.min, BOUNDS.maxChars.max),
    readCompaction: normalizeReadCompaction(root, legacy),
    rtkExecutable: pickExecutable(root.rtkExecutable),
  }
}