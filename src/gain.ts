import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { runExecutable, type RtkRunResult } from './rtk-executable.js'

/**
 * The savings ledger behind the Configure page's Gain panel.
 *
 * Every number shown there comes from `rtk gain`, run against the *isolated*
 * database this plugin rewrites into (`RTK_DB_PATH`), never the user's global
 * one: the two ledgers record different commands, and reading the global one
 * would silently attribute other tools' savings to this plugin.
 *
 * `rtk gain -p` filters by the process working directory, so "workspace" is
 * expressed as the child's `cwd`. Two things `rtk gain` cannot answer come from
 * the same database instead: the workspace list (its `project_path` column; the
 * host prefers the native workspace registry when one is mounted) and the
 * per-command breakdown (its `commands` table — neither the JSON nor the CSV
 * form of `rtk gain` carries one).
 */

/** Path of the rtk history database this plugin scopes rewritten commands to. */
export function rtkHistoryDbPath(): string {
  return join(tmpdir(), 'dsh-rtk', 'history.db')
}

/** Time windows the panel offers. */
export const GAIN_RANGES = ['today', 'week', 'month', 'all'] as const

/** One selectable time window. */
export type GainRange = (typeof GAIN_RANGES)[number]

/** Totals for one window, in the units rtk records (tokens and milliseconds). */
export interface GainSummary {
  commands: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPercent: number
  totalTimeMs: number
  avgTimeMs: number
}

/** One day's row of rtk's daily breakdown. */
export interface GainDay {
  date: string
  commands: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPercent: number
  totalTimeMs: number
  avgTimeMs: number
}

/** One selectable workspace. */
export interface GainWorkspace {
  path: string
  /** Display title from the native workspace registry, when there is one. */
  title?: string
  /** How many rewritten commands this workspace has; absent for registry entries. */
  commands?: number
  lastUsedAt?: string
}

/** One command category in the per-command breakdown. */
export interface GainCommand {
  /** Short label, e.g. `rtk grep`. */
  command: string
  calls: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPercent: number
}

/** Payload the browser may send; every field is validated here. */
export interface GainRequest {
  range?: unknown
  workspace?: unknown
  refresh?: unknown
}

/** What the panel renders. */
export interface GainReport {
  /** Whether `rtk gain` produced a usable answer. */
  available: boolean
  /** Why it did not, or what could not be parsed. */
  reason?: string
  /** The database that was queried, shown so the panel is never ambiguous. */
  database: string
  range: GainRange
  /** The workspace filter that was applied, or null for the whole ledger. */
  workspace: string | null
  workspaces: GainWorkspace[]
  summary: GainSummary
  daily: GainDay[]
  /** Per-command breakdown, heaviest savings first. */
  commands: GainCommand[]
  generatedAt: number
}

/** The result envelope the Web RPC bridge expects. */
export type GainResult =
  | { ok: true; value: GainReport }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** The parts of `rtk gain -f json` this module reads. */
interface RawGain {
  summary: GainSummary
  daily: GainDay[]
}

/** Read one numeric field, treating anything unexpected as zero. */
function numeric(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Map rtk's summary object onto this module's shape. */
function summaryOf(source: Record<string, unknown>): GainSummary {
  return {
    commands: numeric(source, 'total_commands'),
    inputTokens: numeric(source, 'total_input'),
    outputTokens: numeric(source, 'total_output'),
    savedTokens: numeric(source, 'total_saved'),
    savingsPercent: numeric(source, 'avg_savings_pct'),
    totalTimeMs: numeric(source, 'total_time_ms'),
    avgTimeMs: numeric(source, 'avg_time_ms'),
  }
}

/** Map one daily row onto this module's shape. */
function dayOf(source: Record<string, unknown>): GainDay {
  return {
    date: typeof source['date'] === 'string' ? source['date'] : '',
    commands: numeric(source, 'commands'),
    inputTokens: numeric(source, 'input_tokens'),
    outputTokens: numeric(source, 'output_tokens'),
    savedTokens: numeric(source, 'saved_tokens'),
    savingsPercent: numeric(source, 'savings_pct'),
    totalTimeMs: numeric(source, 'total_time_ms'),
    avgTimeMs: numeric(source, 'avg_time_ms'),
  }
}

/**
 * Parse `rtk gain -d -f json`.
 *
 * @param stdout - the command's standard output.
 * @returns the summary and daily rows, or undefined when the output is not the
 * JSON shape this module understands (an older rtk, or an error page on stdout).
 */
export function parseGainJson(stdout: string): RawGain | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const rawSummary = root['summary']
  if (typeof rawSummary !== 'object' || rawSummary === null) return undefined
  const daily: GainDay[] = []
  const rawDaily = root['daily']
  if (Array.isArray(rawDaily)) {
    for (const row of rawDaily) {
      if (typeof row === 'object' && row !== null) daily.push(dayOf(row as Record<string, unknown>))
    }
  }
  daily.sort((left, right) => left.date.localeCompare(right.date))
  return { summary: summaryOf(rawSummary as Record<string, unknown>), daily }
}

/** How many calendar days a bounded window covers, counting today. */
const WINDOW_DAYS: Record<Exclude<GainRange, 'all'>, number> = { today: 1, week: 7, month: 30 }

/**
 * First date (inclusive, `YYYY-MM-DD`) a window keeps.
 *
 * The ledger stores UTC timestamps and rtk groups days by that same clock, so
 * the window is computed in UTC too — a local-time boundary would split a day
 * somewhere in the middle of rtk's own rows.
 *
 * @param range - the window.
 * @param now - current instant.
 * @returns the inclusive start date, or undefined for `all`.
 */
export function rangeStartDate(range: GainRange, now: Date): string | undefined {
  if (range === 'all') return undefined
  const start = new Date(now.getTime() - (WINDOW_DAYS[range] - 1) * 86_400_000)
  return start.toISOString().slice(0, 10)
}

/** Recompute totals from the daily rows a window keeps. */
function summarize(days: readonly GainDay[]): GainSummary {
  let commands = 0
  let inputTokens = 0
  let outputTokens = 0
  let savedTokens = 0
  let totalTimeMs = 0
  for (const day of days) {
    commands += day.commands
    inputTokens += day.inputTokens
    outputTokens += day.outputTokens
    savedTokens += day.savedTokens
    totalTimeMs += day.totalTimeMs
  }
  return {
    commands,
    inputTokens,
    outputTokens,
    savedTokens,
    savingsPercent: inputTokens === 0 ? 0 : Math.round((savedTokens / inputTokens) * 1000) / 10,
    totalTimeMs,
    avgTimeMs: commands === 0 ? 0 : Math.round(totalTimeMs / commands),
  }
}

/**
 * Narrow rtk's all-time answer to one window.
 *
 * `all` keeps rtk's own summary, which is authoritative even when it counts
 * more than the daily rows it printed; the bounded windows must add the rows
 * they keep so the headline cannot disagree with the chart under it.
 *
 * @param raw - parsed rtk output.
 * @param range - the window.
 * @param now - current instant.
 * @returns the summary and daily rows for that window.
 */
export function sliceGain(raw: RawGain, range: GainRange, now: Date): RawGain {
  const start = rangeStartDate(range, now)
  if (start === undefined) return { summary: raw.summary, daily: [...raw.daily] }
  const daily = raw.daily.filter((day) => day.date >= start)
  return { summary: summarize(daily), daily }
}

/**
 * Turn a stored `project_path` into the path form `path.isAbsolute` and
 * `spawn` accept: strip the Windows verbatim prefix and a trailing separator.
 *
 * @param raw - the value stored in the ledger.
 * @returns the normalized path (empty when the input was empty).
 */
export function normalizeProjectPath(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('\\\\?\\UNC\\')) value = '\\\\' + value.slice(8)
  else if (value.startsWith('\\\\?\\')) value = value.slice(4)
  if (value.length > 3 && (value.endsWith('\\') || value.endsWith('/'))) value = value.slice(0, -1)
  return value
}

/**
 * Accept a workspace only when it can be used as a child process directory.
 *
 * The path is never interpolated into a command, but `spawn` still needs a real
 * directory; an unknown or vanished path degrades to the whole ledger instead
 * of failing the panel.
 *
 * @param value - untrusted payload field.
 * @returns the normalized absolute path, or undefined.
 */
export function usableWorkspace(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = normalizeProjectPath(value)
  if (path === '' || path.length > 4096 || !isAbsolute(path)) return undefined
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}

/** One opened ledger database. */
interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

/** The subset of `node:sqlite` used here; kept structural so an absent module is not a type error. */
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

/**
 * Load `node:sqlite` lazily.
 *
 * The module is still experimental on older Node lines, and a deployment
 * without it should lose the database-backed extras rather than the panel.
 *
 * @returns the module, or undefined when it cannot be loaded.
 */
async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    const specifier: string = 'node:sqlite'
    return (await import(specifier)) as unknown as SqliteModule
  } catch {
    return undefined
  }
}

/**
 * Enumerate the workspaces present in the ledger.
 *
 * `rtk gain` can filter by project but cannot list projects, so the distinct
 * `project_path` values come straight from the database.
 *
 * @param database - path of the ledger database.
 * @returns workspaces ordered by command count, most used first.
 */
export async function readWorkspaces(database: string): Promise<GainWorkspace[]> {
  const sqlite = await loadSqlite()
  if (sqlite === undefined) return []
  let db: SqliteDatabase | undefined
  try {
    db = new sqlite.DatabaseSync(database, { readOnly: true })
    const rows = db
      .prepare(
        "select project_path as path, count(*) as commands, max(timestamp) as lastUsedAt from commands where project_path <> '' group by project_path order by commands desc limit 100",
      )
      .all()
    const seen = new Set<string>()
    const workspaces: GainWorkspace[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as Record<string, unknown>
      const path = normalizeProjectPath(typeof record['path'] === 'string' ? record['path'] : '')
      if (path === '') continue
      const key = process.platform === 'win32' ? path.toLowerCase() : path
      if (seen.has(key)) continue
      seen.add(key)
      const workspace: GainWorkspace = {
        path,
        commands: typeof record['commands'] === 'number' ? record['commands'] : 0,
      }
      if (typeof record['lastUsedAt'] === 'string') workspace.lastUsedAt = record['lastUsedAt']
      workspaces.push(workspace)
    }
    return workspaces
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // The ledger is read-only; a close failure changes nothing observable.
    }
  }
}

/** Filter shared by the database-backed breakdowns. */
export interface LedgerFilter {
  /** Inclusive start date (`YYYY-MM-DD`), or undefined for all time. */
  startDate?: string
  /** Normalized workspace path, or undefined for the whole ledger. */
  workspace?: string
}

/**
 * Shorten a rewritten command to a category label.
 *
 * `rtk grep`/{`rtk read`}/`rtk ls` are the categories rtk itself reports; the
 * arguments after the verb are noise for a savings table, so the label keeps
 * the executable and its first argument only.
 *
 * @param rewritten - the `rtk_cmd` stored in the ledger.
 * @returns a non-empty label.
 */
export function commandLabel(rewritten: unknown): string {
  const tokens = String(rewritten ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) return '(unknown)'
  const first = tokens[0] ?? ''
  if (first === 'rtk' && tokens.length > 1) return `rtk ${tokens[1] ?? ''}`.trim()
  return first
}

/**
 * Build the per-command breakdown from the ledger database.
 *
 * Neither `rtk gain -f json` nor `-f csv` includes a per-command table, so
 * this reads the plugin's own `commands` rows and aggregates them. Filtering
 * happens in JavaScript after normalization: the stored `project_path` carries
 * the Windows verbatim prefix, which SQL string equality would miss.
 *
 * @param database - path of the ledger database.
 * @param filter - time window and workspace, both optional.
 * @returns categories ordered by saved tokens, heaviest first.
 */
export async function readCommands(database: string, filter: LedgerFilter = {}): Promise<GainCommand[]> {
  const sqlite = await loadSqlite()
  if (sqlite === undefined) return []
  let db: SqliteDatabase | undefined
  try {
    db = new sqlite.DatabaseSync(database, { readOnly: true })
    const rows = db.prepare('select rtk_cmd, project_path, timestamp, input_tokens, output_tokens, saved_tokens from commands').all()
    const wanted = filter.workspace === undefined ? undefined : normalizeProjectPath(filter.workspace)
    const byLabel = new Map<string, GainCommand>()
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as Record<string, unknown>
      const timestamp = typeof record['timestamp'] === 'string' ? record['timestamp'] : ''
      if (filter.startDate !== undefined && timestamp.slice(0, 10) < filter.startDate) continue
      const stored = normalizeProjectPath(typeof record['project_path'] === 'string' ? record['project_path'] : '')
      if (wanted !== undefined) {
        const same = process.platform === 'win32' ? stored.toLowerCase() === wanted.toLowerCase() : stored === wanted
        if (!same) continue
      }
      const label = commandLabel(record['rtk_cmd'])
      const bucket = byLabel.get(label) ?? {
        command: label,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        savedTokens: 0,
        savingsPercent: 0,
      }
      bucket.calls += 1
      bucket.inputTokens += numeric(record, 'input_tokens')
      bucket.outputTokens += numeric(record, 'output_tokens')
      bucket.savedTokens += numeric(record, 'saved_tokens')
      byLabel.set(label, bucket)
    }
    const commands = [...byLabel.values()].map((bucket) => ({
      ...bucket,
      savingsPercent: bucket.inputTokens === 0 ? 0 : Math.round((bucket.savedTokens / bucket.inputTokens) * 1000) / 10,
    }))
    commands.sort((left, right) => right.savedTokens - left.savedTokens)
    return commands.slice(0, 20)
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // The ledger is read-only; a close failure changes nothing observable.
    }
  }
}

/** Everything the reader needs; all fields have production defaults. */
export interface GainReaderOptions {
  /** The rtk executable to run, resolved at call time so config edits apply. */
  executable: () => string
  /** The ledger database; defaults to this plugin's isolated one. */
  database?: () => string
  /** Runs one process; overridable so tests never spawn rtk. */
  runner?: (command: string, args: readonly string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string }) => Promise<RtkRunResult>
  /** Workspace enumeration; overridable for tests. */
  listWorkspaces?: (database: string) => Promise<GainWorkspace[]>
  /**
   * Native workspace registry snapshot. When it returns entries they are the
   * picker's source of truth; an undefined return (no registry mounted) falls
   * back to the ledger's own `project_path` values.
   */
  workspaceDirectory?: () => readonly { path: string; title?: string }[] | undefined
  /** Per-command breakdown; overridable for tests. */
  readCommands?: (database: string, filter: LedgerFilter) => Promise<GainCommand[]>
  /** Current time; overridable so window tests are deterministic. */
  now?: () => number
  /** How long one report stays warm; the panel's reload button bypasses it. */
  cacheTtlMs?: number
  /** Upper bound for one `rtk gain` run. */
  timeoutMs?: number
}

/** One reader per plugin application. */
export interface GainReader {
  /** Produce a report for one payload, using the cache unless `refresh` is set. */
  report(request: GainRequest): Promise<GainReport>
}

/**
 * Resolve the workspace picker's entries.
 *
 * The native workspace registry is the product's own project list, so it wins
 * whenever it is mounted; the ledger's `project_path` history is only a
 * fallback for deployments without that service.
 *
 * @param options - reader options carrying both sources.
 * @param database - path of the ledger database.
 * @returns normalized, de-duplicated workspaces.
 */
async function workspaceList(options: GainReaderOptions, database: string): Promise<GainWorkspace[]> {
  const native = options.workspaceDirectory?.()
  if (native === undefined || native.length === 0) return (options.listWorkspaces ?? readWorkspaces)(database)
  const seen = new Set<string>()
  const workspaces: GainWorkspace[] = []
  for (const entry of native) {
    const path = normalizeProjectPath(entry.path)
    if (path === '') continue
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    workspaces.push(entry.title === undefined ? { path } : { path, title: entry.title })
  }
  return workspaces
}

/** Pick a window from an untrusted payload, falling back to the week. */
function pickRange(value: unknown): GainRange {
  return typeof value === 'string' && (GAIN_RANGES as readonly string[]).includes(value) ? (value as GainRange) : 'week'
}

/**
 * Build the reader behind the panel.
 *
 * @param options - executable resolution, database, and test seams.
 * @returns a reader whose reports are cached briefly.
 */
export function createGainReader(options: GainReaderOptions): GainReader {
  const databaseOf = options.database ?? rtkHistoryDbPath
  const runner = options.runner ?? runExecutable
  const listWorkspaces = options.listWorkspaces ?? readWorkspaces
  const now = options.now ?? (() => Date.now())
  const cacheTtlMs = options.cacheTtlMs ?? 30_000
  const timeoutMs = options.timeoutMs ?? 15_000
  const cache = new Map<string, { at: number; report: GainReport }>()

  const readBreakdown = options.readCommands ?? readCommands

  return {
    async report(request) {
      const range = pickRange(request.range)
      const workspace = usableWorkspace(request.workspace)
      const database = databaseOf()
      const key = `${range}|${workspace ?? ''}`
      const cached = cache.get(key)
      if (cached !== undefined && request.refresh !== true && now() - cached.at < cacheTtlMs) return cached.report

      const args = ['gain', ...(workspace === undefined ? [] : ['-p']), '-d', '-f', 'json']
      const result = await runner(options.executable(), args, {
        timeoutMs,
        env: { ...process.env, RTK_DB_PATH: database },
        ...(workspace === undefined ? {} : { cwd: workspace }),
      })
      const generatedAt = now()
      const startDate = rangeStartDate(range, new Date(generatedAt))
      const commands = await readBreakdown(database, {
        ...(startDate === undefined ? {} : { startDate }),
        ...(workspace === undefined ? {} : { workspace }),
      })
      const workspaces = await workspaceList(options, database)
      const base = { database, range, workspace: workspace ?? null, workspaces, commands, generatedAt }

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim()
        const report: GainReport = {
          ...base,
          available: false,
          reason: detail || `rtk gain exited with code ${result.code}`,
          summary: summarize([]),
          daily: [],
        }
        cache.set(key, { at: generatedAt, report })
        return report
      }

      const parsed = parseGainJson(result.stdout)
      if (parsed === undefined) {
        const report: GainReport = {
          ...base,
          available: false,
          reason: 'rtk gain did not return the expected JSON',
          summary: summarize([]),
          daily: [],
        }
        cache.set(key, { at: generatedAt, report })
        return report
      }

      const sliced = sliceGain(parsed, range, new Date(generatedAt))
      const report: GainReport = { ...base, available: true, ...sliced }
      cache.set(key, { at: generatedAt, report })
      return report
    },
  }
}
