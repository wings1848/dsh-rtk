import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRtkCommand } from '../lib/command.js'
import { normalizeConfig } from '../lib/config.js'
import { createMetricsTracker } from '../lib/metrics.js'
import { parseExecutablePath, resolverNameFor, resolveRtkExecutable } from '../lib/rtk-executable.js'
import { isStatusStale, needsAvailabilityProbe, shouldSkipRewrite } from '../lib/runtime-guard.js'

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

  it('uses an existing configured path verbatim without probing PATH', async () => {
    const resolution = await resolveRtkExecutable({ configured: '/opt/custom/rtk', exists: async () => true })
    assert.equal(resolution.command, '/opt/custom/rtk')
    assert.equal(resolution.resolvedPath, '/opt/custom/rtk')
    assert.equal(resolution.resolver, 'configured')
    assert.equal(resolution.warning, undefined)
  })

  it('does not trust a configured path that is gone; it looks the name up again', async () => {
    const resolution = await resolveRtkExecutable({
      configured: '/opt/custom/rtk',
      platform: 'linux',
      resolverCommand: 'definitely-not-a-real-resolver',
      exists: async () => false,
    })
    assert.equal(resolution.command, 'rtk', 'a stale path must not be handed to the probe')
    assert.equal(resolution.resolver, 'which')
    assert.match(String(resolution.warning), /could not resolve rtk/)
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
    const resolution = await resolveRtkExecutable({ configured: 'node' })
    assert.equal(resolution.resolver, resolverNameFor(process.platform))
    assert.match(String(resolution.resolvedPath), /node(?:\.exe)?$/)
  })
})

describe('runtime guard', () => {
  const base = normalizeConfig({})

  it('probes availability in every mode that can use an answer', () => {
    assert.equal(needsAvailabilityProbe(base), true)
    // `suggest` mode reports what rtk would do, so it cannot skip the probe —
    // skipping it is how the mode used to report a missing binary that was
    // installed and suggest nothing at all.
    assert.equal(needsAvailabilityProbe(normalizeConfig({ mode: 'suggest' })), true)
    assert.equal(needsAvailabilityProbe(normalizeConfig({ mode: 'off' })), false)
  })

  it('stands rewriting down when rtk is missing, and when the plugin is off', () => {
    assert.equal(shouldSkipRewrite(base, { rtkAvailable: false }), true)
    assert.equal(shouldSkipRewrite(base, { rtkAvailable: true }), false)
    assert.equal(shouldSkipRewrite(normalizeConfig({ mode: 'off' }), { rtkAvailable: true }), true)
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
    resetConfig: async () => ({ kind: 'success', text: 'dsh-rtk: the row is back to the values it inherits from the composition.' }),
    getRuntimeStatus: () => ({ rtkAvailable: true, rtkExecutablePath: '/usr/bin/rtk' }),
    refreshRuntimeStatus: async () => ({ rtkAvailable: true, rtkExecutablePath: '/usr/bin/rtk' }),
    getMetrics: () => tracker.summary(),
    clearMetrics: () => tracker.clear(),
    runGain: async (args) => ({ kind: 'success', text: `gain stubbed with args: ${args}` }),
    configLocation: () => 'the `dsh-rtk` namespace',
  })

  it('is registered under the name rtk', () => {
    assert.equal(command.name, 'rtk')
  })

  it('declares an input hint so `/rtk <subcommand>` is routed as a command', () => {
    assert.equal(typeof command.input.hint, 'string')
    for (const subcommand of ['show', 'path', 'verify', 'stats', 'gain', 'clear-stats', 'reset', 'help']) {
      assert.match(command.input.hint, new RegExp(subcommand))
    }
  })

  it('shows configuration and status for no argument or `show`', async () => {
    for (const input of ['', '   ', 'show']) {
      const result = await command.handler({ rawInput: input })
      assert.equal(result.kind, 'success')
      assert.match(String(result.text), /dsh-rtk: rewrite/)
      assert.match(String(result.text), /compact: on/)
      assert.match(String(result.text), /maxChars: 12000/)
      assert.match(String(result.text), /readCompaction: none/)
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
      resetConfig: async () => ({ kind: 'success', text: 'reset' }),
      getRuntimeStatus: () => ({ rtkAvailable: false }),
      refreshRuntimeStatus: async () => ({ rtkAvailable: false, lastError: 'spawn rtk ENOENT' }),
      getMetrics: () => tracker.summary(),
      clearMetrics: () => {},
      runGain: async () => ({ kind: 'success', text: '' }),
      configLocation: () => 'x',
    })
    const result = await failing.handler({ rawInput: 'verify' })
    assert.equal(result.kind, 'error')
    assert.match(String(result.text), /spawn rtk ENOENT/)
    // A user who cannot run the tool needs the way out of that state.
    assert.match(String(result.text), /brew install rtk/)
    assert.match(String(result.text), /cargo install --git https:\/\/github\.com\/rtk-ai\/rtk/)
    assert.match(String(result.text), /unrelated crate of the same name/, 'the crates.io name collision must be called out')
  })

  it('forwards `gain` arguments to the rtk ledger query', async () => {
    const bare = await command.handler({ rawInput: 'gain' })
    assert.equal(bare.kind, 'success')
    assert.equal(String(bare.text), 'gain stubbed with args: ')

    const flagged = await command.handler({ rawInput: 'gain -H' })
    assert.equal(String(flagged.text), 'gain stubbed with args: -H')

    const formatted = await command.handler({ rawInput: '  gain  -f json  ' })
    assert.equal(String(formatted.text), 'gain stubbed with args: -f json')
  })

  it('reports a failed `gain` query as an error', async () => {
    const failing = createRtkCommand({
      getConfig: () => config,
      resetConfig: async () => ({ kind: 'success', text: 'reset' }),
      getRuntimeStatus: () => ({ rtkAvailable: true }),
      refreshRuntimeStatus: async () => ({ rtkAvailable: true }),
      getMetrics: () => ({ calls: 0 }),
      clearMetrics: () => {},
      runGain: async () => ({ kind: 'error', text: 'spawn rtk ENOENT' }),
      configLocation: () => 'x',
    })
    const result = await failing.handler({ rawInput: 'gain' })
    assert.equal(result.kind, 'error')
    assert.match(String(result.text), /ENOENT/)
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

  it('reports a refused reset as an error rather than a success', async () => {
    const refusing = createRtkCommand({
      getConfig: () => config,
      resetConfig: async () => ({ kind: 'error', text: 'dsh-rtk: reset was refused (read-only profile)' }),
      getRuntimeStatus: () => ({ rtkAvailable: true }),
      refreshRuntimeStatus: async () => ({ rtkAvailable: true }),
      getMetrics: () => tracker.summary(),
      clearMetrics: () => {},
      runGain: async () => ({ kind: 'success', text: '' }),
      configLocation: () => 'x',
    })
    const result = await refusing.handler({ rawInput: 'reset' })
    assert.equal(result.kind, 'error', 'a refused reset must not read as a success')
    assert.match(String(result.text), /refused/)
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
    assert.match(String(result.text), /dsh-rtk: rewrite/)
  })
})