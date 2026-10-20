import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BOUNDS, Config, DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'

describe('normalizeConfig', () => {
  it('returns every default when given nothing', () => {
    const config = normalizeConfig(undefined)
    assert.equal(config.mode, 'rewrite')
    assert.equal(config.compact, true)
    assert.equal(config.maxChars, 12000)
    // Lossy reads stay off by default so code reads remain exact.
    assert.equal(config.readCompaction, 'none')
    assert.equal(config.rtkExecutable, 'rtk')
  })

  it('accepts the five fields unchanged', () => {
    const config = normalizeConfig({
      mode: 'suggest',
      compact: false,
      maxChars: 2000,
      readCompaction: 'aggressive',
      rtkExecutable: '/usr/bin/rtk',
    })
    assert.equal(config.mode, 'suggest')
    assert.equal(config.compact, false)
    assert.equal(config.maxChars, 2000)
    assert.equal(config.readCompaction, 'aggressive')
    assert.equal(config.rtkExecutable, '/usr/bin/rtk')
  })

  it('keeps an explicit empty executable as the auto-detect state', () => {
    // The plugin writes an empty value when no rtk was found, and the form has
    // to be able to show it; a missing field still falls back to the default.
    assert.equal(normalizeConfig({ rtkExecutable: '' }).rtkExecutable, '')
    assert.equal(normalizeConfig({ rtkExecutable: '   ' }).rtkExecutable, '')
    assert.equal(normalizeConfig({}).rtkExecutable, DEFAULT_CONFIG.rtkExecutable)
  })

  it('clamps the character budget when values arrive unvalidated', () => {
    // `apply` can be reached with objects that never went through the schema
    // (tests, a runtime patch), so normalization still clamps.
    assert.equal(normalizeConfig({ maxChars: 1 }).maxChars, BOUNDS.maxChars.min)
    assert.equal(normalizeConfig({ maxChars: 10_000_000 }).maxChars, BOUNDS.maxChars.max)
  })

  it('rejects an out-of-bounds character budget at load time', () => {
    // The loader validates the composition's config, and a bad value must fail
    // loudly there instead of being silently clamped into something the user
    // did not ask for.
    const schema = Config as unknown as { '~standard': { validate(value: unknown): { issues?: unknown[] } } }
    for (const maxChars of [1, 10_000_000, 0, -5]) {
      const result = schema['~standard'].validate({ maxChars })
      assert.ok((result.issues?.length ?? 0) > 0, `maxChars=${maxChars} must be rejected by the schema`)
    }
    for (const maxChars of [BOUNDS.maxChars.min, 12000, BOUNDS.maxChars.max]) {
      const result = schema['~standard'].validate({ maxChars })
      assert.equal(result.issues, undefined, `maxChars=${maxChars} must be accepted`)
    }
  })

  it('falls back for values of the wrong type rather than trusting them', () => {
    const config = normalizeConfig({
      mode: 5,
      compact: 'yes',
      maxChars: 'big',
      readCompaction: 'extreme',
      rtkExecutable: 42,
    })
    assert.equal(config.mode, DEFAULT_CONFIG.mode)
    assert.equal(config.compact, DEFAULT_CONFIG.compact)
    assert.equal(config.maxChars, DEFAULT_CONFIG.maxChars)
    assert.equal(config.readCompaction, DEFAULT_CONFIG.readCompaction)
    assert.equal(config.rtkExecutable, DEFAULT_CONFIG.rtkExecutable)
  })
})

describe('migration from the previous schema', () => {
  it('folds the retired enabled switch into mode', () => {
    // A patch or settings layer written before the switch merged keeps its
    // intent: an explicit false must not silently turn the plugin back on.
    assert.equal(normalizeConfig({ enabled: false }).mode, 'off')
    assert.equal(normalizeConfig({ enabled: false, mode: 'suggest' }).mode, 'off')
    assert.equal(normalizeConfig({ enabled: true }).mode, 'rewrite')
    assert.equal(normalizeConfig({ enabled: true, mode: 'suggest' }).mode, 'suggest')
  })

  it('folds outputCompaction.enabled and truncate.maxChars into top-level fields', () => {
    const config = normalizeConfig({ outputCompaction: { enabled: false, truncate: { enabled: false, maxChars: 2000 } } })
    assert.equal(config.compact, false)
    assert.equal(config.maxChars, 2000, 'the retired truncate.maxChars must still reach the budget')
    // truncate.enabled is gone: the budget is always applied.
    assert.equal(normalizeConfig({ outputCompaction: { truncate: { enabled: false } } }).maxChars, 12000)
  })

  it('folds the three retired read-compaction fields into one level', () => {
    // Off: the enable flag is what gated everything.
    assert.equal(normalizeConfig({ outputCompaction: { readCompaction: { enabled: false } } }).readCompaction, 'none')
    assert.equal(
      normalizeConfig({
        outputCompaction: { readCompaction: { enabled: true }, sourceCodeFilteringEnabled: true, sourceCodeFiltering: 'minimal' },
      }).readCompaction,
      'minimal',
    )
    assert.equal(
      normalizeConfig({
        outputCompaction: { readCompaction: { enabled: true }, sourceCodeFilteringEnabled: true, sourceCodeFiltering: 'aggressive' },
      }).readCompaction,
      'aggressive',
    )
    // Enabled but not filtering: the budget still applied, so budget is the
    // faithful mapping rather than none.
    assert.equal(
      normalizeConfig({ outputCompaction: { readCompaction: { enabled: true }, sourceCodeFiltering: 'minimal' } }).readCompaction,
      'budget',
    )
    assert.equal(
      normalizeConfig({ outputCompaction: { readCompaction: { enabled: true }, sourceCodeFilteringEnabled: true } }).readCompaction,
      'budget',
    )
  })

  it('migrates the retired fields through the schema the loader actually uses', () => {
    // Regression: validation runs first and fills every new field with its
    // schema default, so a naive "the new field is present" check made the whole
    // migration dead code in production. Validating here reproduces that path.
    const schema = Config as unknown as { '~standard': { validate(value: unknown): { value: unknown } } }
    const validated = schema['~standard'].validate({
      enabled: false,
      outputCompaction: {
        enabled: true,
        truncate: { maxChars: 2000 },
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        sourceCodeFiltering: 'aggressive',
      },
    }).value
    const config = normalizeConfig(validated)
    assert.equal(config.mode, 'off', 'enabled: false must still mean off')
    assert.equal(config.maxChars, 2000, 'the retired budget must beat the schema default')
    assert.equal(config.readCompaction, 'aggressive', 'the retired filter level must survive validation')
  })

  it('prefers the new fields when both shapes are present', () => {
    const config = normalizeConfig({
      mode: 'off',
      compact: false,
      maxChars: 4000,
      readCompaction: 'minimal',
      enabled: true,
      outputCompaction: {
        enabled: true,
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        sourceCodeFiltering: 'aggressive',
        truncate: { maxChars: 9000 },
      },
    })
    assert.equal(config.mode, 'off')
    assert.equal(config.compact, false)
    assert.equal(config.maxChars, 4000)
    assert.equal(config.readCompaction, 'minimal')
  })
})