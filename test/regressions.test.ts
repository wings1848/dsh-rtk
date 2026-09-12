import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { compactToolResult } from '../lib/compact/index.js'
import { applyRtkHistoryScope } from '../lib/rtk-rewrite.js'
import { apply } from '../lib/index.js'

/**
 * Regressions found by an independent review pass.
 *
 * Each case states the invariant it defends, so a future change that
 * reintroduces the bug fails here with a readable reason rather than a
 * mysterious off-by-a-few-hundred-chars.
 */

/** The text a tool result carries, for a single-block content array. */
function textOf(outcome: { content?: unknown[] }, fallback: string): string {
  const blocks = (outcome.content ?? [{ type: 'text', text: fallback }]) as Array<{ text?: string }>
  return blocks[0]?.text ?? fallback
}

describe('D1: read compaction must not inflate, banner included', () => {
  it('keeps the original when the banner would make the result longer', () => {
    // A source file over the exact-read threshold, containing exactly one
    // removable comment. Filtering drops ~26 characters; the compaction
    // banner is ~39. The guard must weigh the banner, or the "never inflates"
    // invariant is false on the read + source-filtering path.
    const lines: string[] = []
    for (let index = 0; index < 100; index += 1) lines.push(`const value${index} = ${index}`)
    lines.push('  // a removable comment')
    const source = lines.join('\n')

    const config = normalizeConfig({
      outputCompaction: {
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        sourceCodeFiltering: 'minimal',
      },
    })

    const outcome = compactToolResult({ toolName: 'read', args: { path: 'src/a.ts' }, content: [{ type: 'text', text: source }] }, config)
    if (outcome.changed) {
      const compacted = textOf(outcome, source)
      assert.ok(
        compacted.length < source.length,
        `compaction inflated the result: ${source.length} -> ${compacted.length} (${compacted.length - source.length} chars)`,
      )
    }
    if (outcome.metadata !== undefined) {
      assert.ok(
        outcome.metadata.compactedCharCount < outcome.metadata.originalCharCount,
        `metadata reports growth: ${outcome.metadata.originalCharCount} -> ${outcome.metadata.compactedCharCount}`,
      )
    }
  })

  it('still compacts a read result that genuinely shrinks', () => {
    const lines: string[] = []
    for (let index = 0; index < 200; index += 1) lines.push(`const value${index} = ${index}`)
    for (let index = 0; index < 40; index += 1) lines.push(`  // removable comment number ${index}`)
    const source = lines.join('\n')

    const config = normalizeConfig({
      outputCompaction: {
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        sourceCodeFiltering: 'minimal',
      },
    })

    const outcome = compactToolResult({ toolName: 'read', args: { path: 'src/b.ts' }, content: [{ type: 'text', text: source }] }, config)
    assert.equal(outcome.changed, true, 'a result that really shrinks must still be compacted')
    assert.ok(textOf(outcome, source).length < source.length)
  })
})

describe('D2: post-execute must not drop additionalContexts', () => {
  /** A context-carrying decision, as a sibling listener would return it. */
  const contexts = [{ role: 'user', content: [{ type: 'text', text: 'search results were capped; narrow the pattern' }] }]

  function fakeContext(): { ctx: any; emit(event: string, ...args: unknown[]): Promise<any> } {
    const listeners = new Map<string, Array<(...args: any[]) => any>>()
    return {
      ctx: {
        get: () => undefined,
        on: (event: string, listener: (...args: any[]) => any) => {
          const existing = listeners.get(event) ?? []
          existing.push(listener)
          listeners.set(event, existing)
          return () => {}
        },
        effect: (callback: () => unknown) => {
          const disposer = callback()
          return typeof disposer === 'function' ? disposer : () => {}
        },
      },
      async emit(event, ...args) {
        const registered = listeners.get(event) ?? []
        let index = -1
        const dispatch = async (position: number): Promise<unknown> => {
          if (position <= index) throw new Error('next() called twice')
          index = position
          const listener = registered[position]
          if (listener === undefined) return undefined
          return listener(...args, () => dispatch(position + 1))
        }
        return dispatch(0)
      },
    }
  }

  it('preserves contexts attached by an inner listener when it replaces content', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({}) as never)

    const matches = Array.from({ length: 40 }, (_, index) => `src/module${index % 4}.ts:${index + 1}:const value${index} = ${index}`).join('\n')
    const exec = { name: 'grep', callId: 'grep-1', arguments: { pattern: 'const' }, signal: new AbortController().signal }
    const result = { isError: false, value: 'ok', content: [{ type: 'text', text: matches }] }

    const decision = await harness.emit('tools/post-execute', exec, result, async () => ({ kind: 'accept', additionalContexts: contexts }))

    assert.equal(decision.kind, 'accept')
    assert.match(decision.content[0].text, /40 matches in 4 files/, 'compaction must still happen')
    assert.deepEqual(decision.additionalContexts, contexts, 'a sibling listener\u2019s contexts must survive compaction')
  })

  it('passes through untouched when nothing shrinks, contexts intact', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({}) as never)

    const exec = { name: 'grep', callId: 'grep-2', arguments: { pattern: 'x' }, signal: new AbortController().signal }
    const result = { isError: false, value: 'ok', content: [{ type: 'text', text: 'not a match list at all' }] }
    const accepted = { kind: 'accept', additionalContexts: contexts }

    const decision = await harness.emit('tools/post-execute', exec, result, async () => accepted)
    assert.equal(decision, accepted, 'an unchanged result must be passed through by reference')
  })
})

describe('D3: shell-specific environment syntax', () => {
  it('uses POSIX syntax for bash', () => {
    const scoped = applyRtkHistoryScope('rtk ls', '/tmp/x.db', undefined, 'posix')
    assert.match(scoped, /^export RTK_DB_PATH=/)
  })

  it('uses PowerShell syntax for pwsh', () => {
    const scoped = applyRtkHistoryScope('rtk ls', '/tmp/x.db', undefined, 'powershell')
    assert.match(scoped, /^\$env:RTK_DB_PATH = /, 'PowerShell has no `export`')
    assert.doesNotMatch(scoped, /^export /)
    assert.match(scoped, /; rtk ls$/)
  })

  it('escapes a quote the way each shell expects', () => {
    assert.equal(
      applyRtkHistoryScope('rtk ls', "/tmp/it's.db", undefined, 'powershell'),
      "$env:RTK_DB_PATH = '/tmp/it''s.db'; rtk ls",
    )
    assert.equal(
      applyRtkHistoryScope('rtk ls', "/tmp/it's.db", undefined, 'posix'),
      "export RTK_DB_PATH='/tmp/it'\\''s.db'; rtk ls",
    )
  })

  it('leaves an ambient or explicit value alone in both shells', () => {
    assert.equal(applyRtkHistoryScope('rtk ls', '/tmp/x.db', '/custom.db', 'powershell'), 'rtk ls')
    assert.equal(applyRtkHistoryScope('$env:RTK_DB_PATH = "/mine.db"; rtk ls', '/tmp/x.db', undefined, 'powershell'), '$env:RTK_DB_PATH = "/mine.db"; rtk ls')
  })
})
