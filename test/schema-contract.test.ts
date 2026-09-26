import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, editable, normalizeConfig } from '../lib/config.js'

/**
 * The schema contract against the *real* schemastery.
 *
 * The other suites fake the settings service and the Volatile references,
 * which is fine for the plugin's own logic — but `editable()`'s marks are
 * validated by schemastery itself, with path rules of its own ("a fixed object
 * path without an enclosing volatile field"). A schema that trips them would
 * fail at plugin load on a modern host, and no fixture would notice. This
 * suite parses the actual `Config` through the actual library.
 */

const WRITE = Symbol.for('cosmokit.volatile.write')

function isVolatile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && WRITE in (value as object)
}

/** Parse raw config the way the loader does (standard-schema validation). */
function parse(raw: unknown): Record<string, unknown> {
  const result = (Config as unknown as { '~standard': { validate(value: unknown): unknown } })['~standard'].validate(raw)
  assert.ok(!('then' in (result as object)), 'config validation must stay synchronous')
  const validated = result as { issues?: unknown; value?: Record<string, unknown> }
  assert.equal(validated.issues, undefined, `schema rejected the config: ${JSON.stringify(validated.issues)}`)
  assert.ok(validated.value !== undefined)
  return validated.value
}

describe('Config schema on real schemastery', () => {
  it('loads, fills defaults, and wraps every top-level field in a live reference', () => {
    const value = parse({})
    for (const field of ['enabled', 'mode', 'rtkExecutable', 'outputCompaction']) {
      assert.ok(isVolatile(value[field]), `field ${field} must be live-editable (a Volatile reference)`)
    }
  })

  it('commits edits into the references that normalizeConfig reads', () => {
    const value = parse({ outputCompaction: { truncate: { maxChars: 7000 } } })
    assert.equal(normalizeConfig(value).outputCompaction.truncate.maxChars, 7000)

    const enabled = value['enabled'] as { get(): unknown }
    assert.equal(enabled.get(), true)
    ;(value['enabled'] as Record<symbol, (next: unknown) => void>)[WRITE](false)
    assert.equal(normalizeConfig(value).enabled, false, 'the committed edit must be visible through normalizeConfig')
  })

  it('keeps a whole subtree behind one reference, so nested fields inherit editability', () => {
    const value = parse({})
    const compaction = value['outputCompaction'] as { get(): unknown }
    assert.equal(isVolatile(compaction.get()), false, 'the subtree itself is plain data behind the reference')
    const subtree = compaction.get() as Record<string, unknown>
    assert.equal((subtree['truncate'] as { maxChars: number }).maxChars, 12000)
  })
})

describe('editable() across schemastery generations', () => {
  it('marks a schema whose library knows the volatile role', () => {
    let marked = 0
    const schema = { volatile: () => ((marked += 1), 'wrapped') }
    assert.equal(editable(schema), 'wrapped')
    assert.equal(marked, 1)
  })

  it('returns the schema untouched when the library predates the role', () => {
    // schemastery 3.18.2 (the 0.1.5 generation) has no `.volatile()`. A schema
    // that throws here would take the whole plugin down at load time on exactly
    // the harness generation the legacy track exists to serve.
    const schema = { default: () => schema }
    assert.equal(editable(schema), schema)
  })
})
