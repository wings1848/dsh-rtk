import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { compactToolResult } from '../lib/compact/index.js'
import { createRtkCommand } from '../lib/command.js'
import { createMetricsTracker } from '../lib/metrics.js'

/**
 * Keyless snapshots of what the model and the user actually see.
 *
 * The compaction pipeline and `/rtk show` are the two surfaces this plugin
 * changes for someone other than itself, so their exact text is pinned here:
 * a change in wording, marker placement, or budget arithmetic fails the suite
 * instead of silently reaching a model request. No model API is involved.
 */

describe('model-visible text', () => {
  it('truncates an oversized result without cutting the exit marker', () => {
    // The harness tells the model to read the trailing marker, and the Web UI
    // derives its status pill from the same line, so truncation must never
    // consume it.
    let stdout = ''
    for (let index = 0; index < 200; index += 1) stdout += `row ${index} ${'y'.repeat(120)}\n`
    const outcome = compactToolResult(
      { toolName: 'bash', args: { command: 'cat big' }, content: [{ type: 'text', text: `${stdout}[exit code: 0]` }] },
      normalizeConfig({}),
    )
    assert.equal(outcome.changed, true)
    assert.deepEqual(outcome.techniques, ['truncate'])
    const text = (outcome.content?.[0] as { text: string }).text
    assert.ok(text.length <= 12000, 'the truncation must respect maxChars')
    assert.ok(text.startsWith('row 0 '), 'the head of the output must survive')
    assert.equal(text.endsWith('[exit code: 0]'), true, 'the trailing marker must stay last')
  })

  it('leaves a short read byte-exact by default', () => {
    const raw = 'export const VALUE = 1\n'
    const outcome = compactToolResult(
      { toolName: 'read', args: { path: '/tmp/a.ts' }, content: [{ type: 'text', text: raw }] },
      normalizeConfig({}),
    )
    assert.equal(outcome.changed, false, 'readCompaction: none must keep reads exact')
  })

  it('pins the /rtk status report', async () => {
    const tracker = createMetricsTracker()
    const command = createRtkCommand({
      getConfig: () => normalizeConfig({}),
      resetConfig: async () => ({ kind: 'success', text: 'reset' }),
      getRuntimeStatus: () => ({ rtkAvailable: true, rtkExecutablePath: '/usr/bin/rtk' }),
      refreshRuntimeStatus: async () => ({ rtkAvailable: true }),
      getMetrics: () => tracker.summary(),
      clearMetrics: () => {},
      runGain: async () => ({ kind: 'success', text: '' }),
      configLocation: () => 'the `rtk` entry in the harness settings document',
    })
    const result = (await command.handler({ rawInput: 'show' })) as { kind: string; text: string }
    assert.equal(result.kind, 'success')
    assert.equal(result.text, [
      'dsh-rtk: rewrite   compact: on   maxChars: 12000',
      'readCompaction: none',
      'rtk executable: rtk',
      'rtk binary: available (/usr/bin/rtk)',
      'config: the `rtk` entry in the harness settings document',
    ].join('\n'))
  })
})
