import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BOUNDS, DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'

describe('normalizeConfig', () => {
  it('returns every default when given nothing', () => {
    const config = normalizeConfig(undefined)
    assert.equal(config.enabled, true)
    assert.equal(config.mode, 'rewrite')
    assert.equal(config.guardWhenRtkMissing, true)
    assert.deepEqual(config.compactedTools, ['bash', 'read', 'grep'])
    assert.equal(config.outputCompaction.enabled, true)
    assert.equal(config.outputCompaction.stripAnsi, true)
    assert.equal(config.outputCompaction.truncate.enabled, true)
    assert.equal(config.outputCompaction.truncate.maxChars, 12000)

    // Documented in both READMEs; the notice would otherwise sit in the
    // model's context on every rewritten call.
    assert.equal(config.showRewriteNotifications, false)
    // On by default: a missing binary otherwise costs the user the whole
    // feature without a word. Emitted once per session, so the cost is bounded.
    assert.equal(config.notifyWhenRtkMissing, true)
  })

  it('keeps lossy read compaction off by default', () => {
    const config = normalizeConfig({})
    assert.equal(config.outputCompaction.readCompaction.enabled, false)
    assert.equal(config.outputCompaction.sourceCodeFilteringEnabled, false)
    assert.equal(config.outputCompaction.sourceCodeFiltering, 'none')
    assert.equal(config.outputCompaction.smartTruncate.enabled, false)
  })

  it('accepts a full configuration unchanged', () => {
    const config = normalizeConfig({
      enabled: false,
      mode: 'suggest',
      guardWhenRtkMissing: false,
      showRewriteNotifications: false,
      rtkExecutable: '/usr/bin/rtk',
      rewriteTimeoutMs: 900,
      compactedTools: ['bash'],
      outputCompaction: {
        enabled: false,
        stripAnsi: false,
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        preserveExactSkillReads: true,
        sourceCodeFiltering: 'aggressive',
        aggregateTestOutput: false,
        filterBuildOutput: false,
        compactGitOutput: false,
        aggregateLinterOutput: false,
        groupSearchOutput: false,
        trackSavings: false,
        smartTruncate: { enabled: true, maxLines: 500 },
        truncate: { enabled: true, maxChars: 2000 },
      },
    })
    assert.equal(config.mode, 'suggest')
    assert.equal(config.rtkExecutable, '/usr/bin/rtk')
    assert.deepEqual(config.compactedTools, ['bash'])
    assert.equal(config.outputCompaction.sourceCodeFiltering, 'aggressive')
    assert.equal(config.outputCompaction.smartTruncate.maxLines, 500)
  })

  it('clamps truncation budgets to their published bounds', () => {
    const tooSmall = normalizeConfig({ outputCompaction: { truncate: { maxChars: 1 }, smartTruncate: { maxLines: 1 } } })
    assert.equal(tooSmall.outputCompaction.truncate.maxChars, BOUNDS.maxChars.min)
    assert.equal(tooSmall.outputCompaction.smartTruncate.maxLines, BOUNDS.maxLines.min)

    const tooLarge = normalizeConfig({ outputCompaction: { truncate: { maxChars: 10_000_000 }, smartTruncate: { maxLines: 999_999 } } })
    assert.equal(tooLarge.outputCompaction.truncate.maxChars, BOUNDS.maxChars.max)
    assert.equal(tooLarge.outputCompaction.smartTruncate.maxLines, BOUNDS.maxLines.max)
  })

  it('falls back for values of the wrong type rather than trusting them', () => {
    const config = normalizeConfig({
      enabled: 'yes',
      mode: 'rewrite-everything',
      compactedTools: [1, 2, 3],
      outputCompaction: { sourceCodeFiltering: 'extreme' },
    })
    assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
    assert.equal(config.mode, 'rewrite')
    assert.deepEqual(config.compactedTools, DEFAULT_CONFIG.compactedTools)
    assert.equal(config.outputCompaction.sourceCodeFiltering, 'none')
  })

  it('keeps an explicitly empty tool list out of the pipeline', () => {
    // An empty list would silently disable compaction, so the fallback keeps
    // the defaults instead of materializing a no-op pipeline.
    const config = normalizeConfig({ compactedTools: [] })
    assert.deepEqual(config.compactedTools, DEFAULT_CONFIG.compactedTools)
  })
})
