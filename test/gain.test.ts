import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  commandLabel,
  createGainReader,
  normalizeProjectPath,
  parseGainJson,
  rangeStartDate,
  readCommands,
  sliceGain,
  usableWorkspace,
  GAIN_RANGES,
  type GainReport,
} from '../lib/gain.js'

/**
 * Coverage for the Gain panel's host half.
 *
 * The reader's two side effects — spawning `rtk gain` and opening the ledger
 * database — are injected seams, so these tests pin the argument shape, the
 * window arithmetic, and the failure modes without depending on either.
 */

const SAMPLE = JSON.stringify({
  summary: {
    total_commands: 520,
    total_input: 235262,
    total_output: 76292,
    total_saved: 159049,
    avg_savings_pct: 67.6,
    total_time_ms: 44490,
    avg_time_ms: 85,
  },
  daily: [
    { date: '2026-10-20', commands: 23, input_tokens: 1913, output_tokens: 894, saved_tokens: 1019, savings_pct: 53.3, total_time_ms: 681, avg_time_ms: 29 },
    { date: '2026-10-13', commands: 120, input_tokens: 50000, output_tokens: 20000, saved_tokens: 30000, savings_pct: 60, total_time_ms: 9000, avg_time_ms: 75 },
    { date: '2026-10-19', commands: 497, input_tokens: 233349, output_tokens: 75398, saved_tokens: 157951, savings_pct: 67.7, total_time_ms: 43809, avg_time_ms: 88 },
  ],
})

const NOW = new Date('2026-10-20T09:00:00.000Z')

describe('parseGainJson', () => {
  it('maps rtk summary keys and sorts the daily rows', () => {
    const parsed = parseGainJson(SAMPLE)
    assert.ok(parsed !== undefined)
    assert.equal(parsed.summary.commands, 520)
    assert.equal(parsed.summary.inputTokens, 235262)
    assert.equal(parsed.summary.savedTokens, 159049)
    assert.deepEqual(
      parsed.daily.map((day) => day.date),
      ['2026-10-13', '2026-10-19', '2026-10-20'],
    )
  })

  it('rejects output that is not the expected JSON shape', () => {
    assert.equal(parseGainJson('not json'), undefined)
    assert.equal(parseGainJson('{"daily": []}'), undefined, 'a summary is required')
    assert.equal(parseGainJson('[]'), undefined)
  })

  it('treats missing numbers as zero instead of NaN', () => {
    const parsed = parseGainJson('{"summary": {}, "daily": [{"date": "2026-10-20"}]}')
    assert.ok(parsed !== undefined)
    assert.equal(parsed.summary.commands, 0)
    assert.equal(parsed.daily[0]?.commands, 0)
  })
})

describe('time windows', () => {
  it('computes inclusive UTC start dates', () => {
    assert.equal(rangeStartDate('today', NOW), '2026-10-20')
    assert.equal(rangeStartDate('week', NOW), '2026-10-14')
    assert.equal(rangeStartDate('month', NOW), '2026-09-21')
    assert.equal(rangeStartDate('all', NOW), undefined)
  })

  it('keeps only the rows a window covers and recomputes the summary', () => {
    const parsed = parseGainJson(SAMPLE)
    assert.ok(parsed !== undefined)
    const week = sliceGain(parsed, 'week', NOW)
    assert.deepEqual(
      week.daily.map((day) => day.date),
      ['2026-10-19', '2026-10-20'],
    )
    assert.equal(week.summary.commands, 520)
    assert.equal(week.summary.savedTokens, 158970)
    assert.equal(week.summary.savingsPercent, 67.6)

    const today = sliceGain(parsed, 'today', NOW)
    assert.equal(today.summary.commands, 23)
    assert.equal(today.summary.avgTimeMs, 30)

    const all = sliceGain(parsed, 'all', NOW)
    assert.equal(all.summary.savedTokens, 159049, 'all time keeps rtk own totals')
    assert.equal(all.daily.length, 3)
  })
})

describe('workspace paths', () => {
  it('strips the Windows verbatim prefix and trailing separators', () => {
    assert.equal(normalizeProjectPath('\\\\?\\G:\\GitWork\\dsh-rtk'), 'G:\\GitWork\\dsh-rtk')
    assert.equal(normalizeProjectPath('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x')
    assert.equal(normalizeProjectPath('G:\\GitWork\\dsh-rtk\\'), 'G:\\GitWork\\dsh-rtk')
    assert.equal(normalizeProjectPath('  '), '')
  })

  it('accepts only existing absolute directories', () => {
    assert.equal(usableWorkspace(process.cwd()), process.cwd())
    assert.equal(usableWorkspace('relative/path'), undefined)
    assert.equal(usableWorkspace('/definitely/not/a/real/directory/here'), undefined)
    assert.equal(usableWorkspace(42), undefined)
  })
})

describe('createGainReader', () => {
  it('runs rtk gain against the plugin ledger and slices the window', async () => {
    const calls: { command: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv; cwd?: string } }[] = []
    const reader = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      listWorkspaces: async () => [{ path: '/work/one', commands: 3 }],
      runner: async (command, args, options) => {
        calls.push({ command, args, options })
        return { code: 0, stdout: SAMPLE, stderr: '' }
      },
    })

    const report = await reader.report({ range: 'week' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.command, 'rtk')
    assert.deepEqual(calls[0]?.args, ['gain', '-d', '-f', 'json'])
    assert.equal(calls[0]?.options.env?.['RTK_DB_PATH'], '/tmp/ledger.db')
    assert.equal(calls[0]?.options.cwd, undefined, 'without a workspace rtk reads the whole ledger')
    assert.equal(report.available, true)
    assert.equal(report.range, 'week')
    assert.equal(report.workspace, null)
    assert.deepEqual(report.workspaces, [{ path: '/work/one', commands: 3 }])
    assert.equal(report.summary.commands, 520)
    assert.equal(report.daily.length, 2)
  })

  it('filters by workspace through cwd and -p', async () => {
    const calls: { args: readonly string[]; options: { cwd?: string } }[] = []
    const reader = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      listWorkspaces: async () => [],
      runner: async (_command, args, options) => {
        calls.push({ args, options })
        return { code: 0, stdout: SAMPLE, stderr: '' }
      },
    })

    const report = await reader.report({ range: 'today', workspace: process.cwd(), refresh: true })
    assert.deepEqual(calls[0]?.args, ['gain', '-p', '-d', '-f', 'json'])
    assert.equal(calls[0]?.options.cwd, process.cwd())
    assert.equal(report.workspace, process.cwd())
  })

  it('falls back to the week for an unknown range and drops an unusable workspace', async () => {
    const runs: string[][] = []
    const reader = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      listWorkspaces: async () => [],
      runner: async (_command, args) => {
        runs.push([...args])
        return { code: 0, stdout: SAMPLE, stderr: '' }
      },
    })

    const report = await reader.report({ range: 'decade', workspace: '/not/here' })
    assert.equal(report.range, 'week')
    assert.equal(report.workspace, null)
    assert.deepEqual(runs[0], ['gain', '-d', '-f', 'json'])
  })

  it('reports an unavailable ledger when rtk fails or prints something else', async () => {
    const failing = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      listWorkspaces: async () => [],
      runner: async () => ({ code: 1, stdout: '', stderr: 'rtk: not found' }),
    })
    const missing = await failing.report({ range: 'week' })
    assert.equal(missing.available, false)
    assert.equal(missing.reason, 'rtk: not found')
    assert.equal(missing.summary.commands, 0)

    const garbled = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      listWorkspaces: async () => [],
      runner: async () => ({ code: 0, stdout: 'hello', stderr: '' }),
    })
    const unparsed = await garbled.report({ range: 'week' })
    assert.equal(unparsed.available, false)
    assert.match(String(unparsed.reason), /JSON/)
  })

  it('reuses a warm report until the refresh flag or the TTL ends', async () => {
    let runs = 0
    let clock = NOW.getTime()
    const reader = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => clock,
      cacheTtlMs: 1_000,
      listWorkspaces: async () => [],
      runner: async () => {
        runs += 1
        return { code: 0, stdout: SAMPLE, stderr: '' }
      },
    })

    await reader.report({ range: 'week' })
    await reader.report({ range: 'week' })
    assert.equal(runs, 1, 'a warm report must not respawn rtk')
    await reader.report({ range: 'week', refresh: true })
    assert.equal(runs, 2, 'refresh must bypass the cache')
    clock += 1_500
    await reader.report({ range: 'week' })
    assert.equal(runs, 3, 'an expired report must be recomputed')
  })

  it('exposes every range the panel offers', () => {
    assert.deepEqual([...GAIN_RANGES], ['today', 'week', 'month', 'all'])
  })

  it('reports the shape the Web RPC handler returns', () => {
    // The handler wraps this report in { ok: true, value }; pin the fields the
    // browser reads so a host-side rename cannot silently break the panel.
    const fields: (keyof GainReport)[] = [
      'available',
      'database',
      'range',
      'workspace',
      'workspaces',
      'summary',
      'daily',
      'commands',
      'generatedAt',
    ]
    assert.equal(fields.length, 9)
  })

  it('prefers the native workspace registry over the ledger history', async () => {
    let ledgerCalls = 0
    const reader = createGainReader({
      executable: () => 'rtk',
      database: () => '/tmp/ledger.db',
      now: () => NOW.getTime(),
      readCommands: async () => [],
      listWorkspaces: async () => {
        ledgerCalls += 1
        return []
      },
      workspaceDirectory: () => [
        { path: '\\\\?\\G:\\GitWork\\dsh-rtk', title: 'dsh-rtk' },
        { path: 'G:\\GitWork\\dsh-rtk', title: 'duplicate' },
        { path: 'C:\\Users\\lenovo\\Documents\\deepseek-harness\\default-workspace', title: 'default-workspace' },
      ],
      runner: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }),
    })
    const report = await reader.report({ range: 'week' })
    assert.equal(ledgerCalls, 0, 'the native registry is the picker source of truth')
    assert.equal(report.workspaces.length, 2, 'verbatim and plain paths are the same workspace')
    assert.equal(report.workspaces[0]?.title, 'dsh-rtk')
    assert.equal(report.workspaces[0]?.path, 'G:\\GitWork\\dsh-rtk')
  })
})

describe('per-command breakdown', () => {
  it('labels a rewritten command by its verb pair', () => {
    assert.equal(commandLabel('rtk grep'), 'rtk grep')
    assert.equal(commandLabel('rtk ls D:/tmp/x'), 'rtk ls')
    assert.equal(commandLabel('rtk read -n src/a.ts'), 'rtk read')
    assert.equal(commandLabel('something-else --flag'), 'something-else')
    assert.equal(commandLabel(''), '(unknown)')
  })

  it('aggregates ledger rows by command, window and workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-rtk-commands-'))
    const database = join(directory, 'history.db')
    const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite')
    const db = new DatabaseSync(database)
    db.exec(
      "create table commands (id integer primary key, timestamp text not null, original_cmd text not null, rtk_cmd text not null, input_tokens integer not null, output_tokens integer not null, saved_tokens integer not null, savings_pct real not null, exec_time_ms integer default 0, project_path text default '')",
    )
    const insert = db.prepare(
      'insert into commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, project_path) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('2026-10-20T01:00:00+00:00', 'grep -n x', 'rtk grep', 100, 40, 60, 60, '\\\\?\\G:\\GitWork\\dsh-rtk')
    insert.run('2026-10-20T02:00:00+00:00', 'grep -n y', 'rtk grep', 50, 20, 30, 60, '\\\\?\\G:\\GitWork\\dsh-rtk')
    insert.run('2026-10-20T03:00:00+00:00', 'ls src', 'rtk ls src', 10, 8, 2, 20, '\\\\?\\G:\\GitWork\\dsh-rtk')
    insert.run('2026-10-10T03:00:00+00:00', 'read a', 'rtk read a', 999, 1, 998, 99, '\\\\?\\G:\\GitWork\\dsh-rtk')
    insert.run('2026-10-20T04:00:00+00:00', 'grep -n z', 'rtk grep', 200, 100, 100, 50, '\\\\?\\C:\\other')
    db.close()

    const windowed = await readCommands(database, { startDate: '2026-10-14', workspace: 'G:\\GitWork\\dsh-rtk' })
    assert.deepEqual(
      windowed.map((entry) => entry.command),
      ['rtk grep', 'rtk ls'],
      'sorted by saved tokens, old rows and other workspaces excluded',
    )
    assert.equal(windowed[0]?.calls, 2)
    assert.equal(windowed[0]?.inputTokens, 150)
    assert.equal(windowed[0]?.outputTokens, 60)
    assert.equal(windowed[0]?.savedTokens, 90)
    assert.equal(windowed[0]?.savingsPercent, 60)

    const all = await readCommands(database)
    assert.equal(all.reduce((sum, entry) => sum + entry.calls, 0), 5)

    const missing = await readCommands(join(directory, 'nope.db'))
    assert.deepEqual(missing, [])
  })
})
