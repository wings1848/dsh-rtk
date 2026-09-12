import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRtkCommand } from '../lib/command.js'
import { normalizeConfig } from '../lib/config.js'
import { createMetricsTracker } from '../lib/metrics.js'
import { parseExecutablePath, resolverNameFor, resolveRtkExecutable } from '../lib/rtk-executable.js'
import { isStatusStale, shouldRequireRtkAvailability, shouldSkipRewrite } from '../lib/runtime-guard.js'

describe('rtk executable resolution', () => {
  it('picks the resolver command for the platform', () => {
    assert.equal(resolverNameFor('win32'), 'where')
    assert.equal(resolverNameFor('linux'), 'which')
    assert.equal(resolverNameFor('darwin'), 'which')
  })

  it('takes the first non-empty line and strips wrapping quotes', () => {
    assert.equal(parseExecutablePath('\n  /usr/bin/rtk  \n'), '/usr/bin/rtk')
    assert.equal(parseExecutablePath('"/usr/bin/rtk"'), '/usr/bin/rtk')
    assert.equal(parseExecutablePath("'/usr/bin/rtk'"), '/usr/bin/rtk')
    assert.equal(parseExecutablePath(''), undefined)
    assert.equal(parseExecutablePath('   \n\n'), undefined)
  })

  it('uses a configured path verbatim without probing PATH', async () => {
    const resolution = await resolveRtkExecutable({ configured: '/opt/custom/rtk' })
    assert.equal(resolution.command, '/opt/custom/rtk')
    assert.equal(resolution.resolvedPath, '/opt/custom/rtk')
    assert.equal(resolution.resolver, 'configured')
    assert.equal(resolution.warning, undefined)
  })

  it('falls back to the bare name when the lookup fails, without throwing', async () => {
    const resolution = await resolveRtkExecutable({
      configured: 'definitely-not-a-real-binary-name',
      resolverCommand: 'which',
    })
    assert.equal(resolution.command, 'definitely-not-a-real-binary-name')
    assert.equal(resolution.resolvedPath, undefined)
    assert.match(String(resolution.warning), /could not resolve/)
  })

  it('resolves a real binary when one is on PATH', async () => {
    const resolution = await resolveRtkExecutable({ configured: 'sh' })
    assert.equal(resolution.resolver, 'which')
    assert.match(String(resolution.resolvedPath), /\/sh$/)
  })
})

describe('runtime guard', () => {
  const base = normalizeConfig({})

  it('consults availability only in rewrite mode', () => {
    assert.equal(shouldRequireRtkAvailability(base), true)
    assert.equal(shouldRequireRtkAvailability(normalizeConfig({ mode: 'suggest' })), false)
    assert.equal(shouldRequireRtkAvailability(normalizeConfig({ enabled: false })), false)
  })

  it('stands rewriting down when rtk is missing and the guard is on', () => {
    assert.equal(shouldSkipRewrite(base, { rtkAvailable: false }), true)
    assert.equal(shouldSkipRewrite(base, { rtkAvailable: true }), false)
    assert.equal(shouldSkipRewrite(normalizeConfig({ guardWhenRtkMissing: false }), { rtkAvailable: false }), false)
    assert.equal(shouldSkipRewrite(normalizeConfig({ enabled: false }), { rtkAvailable: true }), true)
  })

  it('treats an unprobed or old status as stale', () => {
    assert.equal(isStatusStale({ rtkAvailable: false }, 1000), true)
    assert.equal(isStatusStale({ rtkAvailable: true, lastCheckedAt: 1000 }, 1000 + 29_000), false)
    assert.equal(isStatusStale({ rtkAvailable: true, lastCheckedAt: 1000 }, 1000 + 31_000), true)
  })
})

describe('metrics tracker', () => {
  it('accumulates savings per tool and per technique', () => {
    const tracker = createMetricsTracker()
    tracker.track('a'.repeat(100), 'a'.repeat(40), 'bash', ['git', 'ansi'])
    tracker.track('b'.repeat(50), 'b'.repeat(45), 'bash', ['ansi'])
    tracker.track('c'.repeat(10), 'c'.repeat(10), 'grep', [])

    const summary = tracker.summary()
    assert.equal(summary.calls, 3)
    assert.equal(summary.originalChars, 160)
    assert.equal(summary.compactedChars, 95)
    assert.equal(summary.savedChars, 65)
    assert.equal(summary.savedPercent, 40.6)
    assert.equal(summary.byTool.bash?.calls, 2)
    assert.equal(summary.byTool.grep?.calls, 1)
    assert.equal(summary.byTechnique.ansi, 2)
    assert.equal(summary.byTechnique.git, 1)
  })

  it('clears every accumulator', () => {
    const tracker = createMetricsTracker()
    tracker.track('a'.repeat(100), 'a'.repeat(10), 'bash', ['git'])
    tracker.clear()
    const summary = tracker.summary()
    assert.equal(summary.calls, 0)
    assert.equal(summary.savedChars, 0)
    assert.equal(summary.savedPercent, 0)
    assert.deepEqual(summary.byTool, {})
  })

  it('never reports a negative saving', () => {
    const tracker = createMetricsTracker()
    tracker.track('short', 'a much longer replacement', 'bash', [])
    assert.equal(tracker.summary().savedChars, 0)
  })
})

describe('/rtk command', () => {
  const tracker = createMetricsTracker()
  const config = normalizeConfig({})
  const command = createRtkCommand({
    getConfig: () => config,
    resetConfig: async () => {},
    getRuntimeStatus: () => ({ rtkAvailable: true, rtkExecutablePath: '/usr/bin/rtk' }),
    refreshRuntimeStatus: async () => ({ rtkAvailable: true, rtkExecutablePath: '/usr/bin/rtk' }),
    getMetrics: () => tracker.summary(),
    clearMetrics: () => tracker.clear(),
    configLocation: () => 'the `dsh-rtk` namespace',
  })

  it('is registered under the name rtk', () => {
    assert.equal(command.name, 'rtk')
  })

  it('shows configuration and status for no argument or `show`', async () => {
    for (const input of ['', '   ', 'show']) {
      const result = await command.handler({ rawInput: input })
      assert.equal(result.kind, 'success')
      assert.match(String(result.text), /dsh-rtk: on/)
      assert.match(String(result.text), /mode: rewrite/)
      assert.match(String(result.text), /rtk binary: available/)
    }
  })

  it('reports the verification outcome', async () => {
    const ok = await command.handler({ rawInput: 'verify' })
    assert.equal(ok.kind, 'success')
    assert.match(String(ok.text), /rtk is available at \/usr\/bin\/rtk/)
  })

  it('reports a failed verification as an error', async () => {
    const failing = createRtkCommand({
      getConfig: () => config,
      resetConfig: async () => {},
      getRuntimeStatus: () => ({ rtkAvailable: false }),
      refreshRuntimeStatus: async () => ({ rtkAvailable: false, lastError: 'spawn rtk ENOENT' }),
      getMetrics: () => tracker.summary(),
      clearMetrics: () => {},
      configLocation: () => 'x',
    })
    const result = await failing.handler({ rawInput: 'verify' })
    assert.equal(result.kind, 'error')
    assert.match(String(result.text), /spawn rtk ENOENT/)
  })

  it('reports empty stats before anything was compacted', async () => {
    const result = await command.handler({ rawInput: 'stats' })
    assert.equal(result.kind, 'success')
    assert.match(String(result.text), /no compaction recorded/)
  })

  it('reports totals once compaction happened', async () => {
    tracker.track('a'.repeat(200), 'a'.repeat(50), 'bash', ['git'])
    const result = await command.handler({ rawInput: 'stats' })
    assert.match(String(result.text), /compacted calls: 1/)
    assert.match(String(result.text), /saved 150/)
    assert.match(String(result.text), /bash: 1 call\(s\)/)
    assert.match(String(result.text), /git: 1/)
    await command.handler({ rawInput: 'clear-stats' })
  })

  it('clears stats on request', async () => {
    tracker.track('a'.repeat(200), 'a'.repeat(50), 'bash', ['git'])
    const cleared = await command.handler({ rawInput: 'clear-stats' })
    assert.equal(cleared.kind, 'success')
    assert.equal(tracker.summary().calls, 0)
  })

  it('accepts a reset and prints help', async () => {
    assert.equal((await command.handler({ rawInput: 'reset' })).kind, 'success')
    const help = await command.handler({ rawInput: 'help' })
    assert.match(String(help.text), /\/rtk verify/)
  })

  it('rejects an unknown subcommand', async () => {
    const result = await command.handler({ rawInput: 'frobnicate' })
    assert.equal(result.kind, 'error')
    assert.match(String(result.text), /unknown subcommand "frobnicate"/)
  })

  it('ignores case in the subcommand', async () => {
    const result = await command.handler({ rawInput: 'SHOW' })
    assert.equal(result.kind, 'success')
    assert.match(String(result.text), /dsh-rtk: on/)
  })
})
