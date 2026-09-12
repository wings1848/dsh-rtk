import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'

/**
 * Integration coverage for `apply()` itself.
 *
 * The unit tests exercise the pipeline in isolation; this file exercises the
 * wiring — which events are subscribed, what the listeners do to the call and
 * to its result, and the degradation path when rtk is unavailable. The
 * listeners are driven through a stand-in context instead of a live harness so
 * the assertions describe the plugin's contract rather than the harness's.
 */

interface Listener {
  (first: any, second?: any, third?: any): Promise<any>
}

/** A context recording every listener the plugin registers. */
function fakeContext(services: Record<string, unknown> = {}): {
  ctx: any
  listeners: Map<string, Listener[]>
  emit(event: string, ...args: unknown[]): Promise<unknown>
  effects: number
} {
  const listeners = new Map<string, Listener[]>()
  const state = { effects: 0 }
  const ctx = {
    get: (name: string) => services[name],
    on: (event: string, listener: Listener) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => {}
    },
    effect: (callback: () => unknown) => {
      state.effects += 1
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return {
    ctx,
    listeners,
    effects: state.effects,
    async emit(event, ...args) {
      const registered = listeners.get(event) ?? []
      assert.ok(registered.length > 0, `no listener registered for ${event}`)
      // Waterfall: each listener wraps the next; the innermost is `next`.
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

const REWRITE_CONFIG = normalizeConfig({})

/** The `tools/execute` invocation shape the plugin consumes. */
function bashExecution(command: string): any {
  return { name: 'bash', callId: 'call-1', arguments: { command, description: 'test' }, signal: new AbortController().signal }
}

describe('apply() wiring', () => {
  it('registers a tools/execute and a tools/post-execute listener', () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)
    assert.ok(harness.listeners.has('tools/execute'), 'expected a tools/execute listener')
    assert.ok(harness.listeners.has('tools/post-execute'), 'expected a tools/post-execute listener')
  })

  it('rewrites a supported command and restores the original afterwards', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = bashExecution('git status')
    let seenByBody: unknown
    const result = await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
    })

    assert.equal(result.isError, false)
    assert.match(String(seenByBody), /\brtk git status$/, 'the body must see the rewritten command')
    assert.match(String(seenByBody), /RTK_DB_PATH=/, 'the rewritten command must scope the rtk history database')
    assert.equal((exec.arguments as { command: string }).command, 'git status', 'the original arguments must be restored')
  })

  it('leaves an unsupported command untouched', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = bashExecution('echo hello')
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [] }
    })
    assert.equal(seenByBody, 'echo hello')
  })

  it('leaves an already-rewritten command untouched', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = bashExecution('rtk git status')
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [] }
    })
    assert.equal(seenByBody, 'rtk git status')
  })

  it('leaves non-command tools untouched', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = { name: 'read', callId: 'call-2', arguments: { path: 'a.ts' }, signal: new AbortController().signal }
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = exec.arguments
      return { isError: false, value: 'ok', content: [] }
    })
    assert.deepEqual(seenByBody, { path: 'a.ts' })
  })

  it('does not rewrite in suggest mode', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({ mode: 'suggest' }) as never)

    const exec = bashExecution('git status')
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [] }
    })
    assert.equal(seenByBody, 'git status')
  })

  it('does nothing at all when disabled', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({ enabled: false }) as never)

    const exec = bashExecution('git status')
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [] }
    })
    assert.equal(seenByBody, 'git status')
  })

  it('degrades to the original command when rtk cannot be resolved', async () => {
    const harness = fakeContext()
    // A path that cannot exist: resolution is skipped and the --version probe
    // fails, so the guard must stand the rewrite down.
    apply(harness.ctx, normalizeConfig({ rtkExecutable: '/nonexistent/rtk-binary' }) as never)

    const exec = bashExecution('git status')
    let seenByBody: unknown
    await harness.emit('tools/execute', exec, async () => {
      seenByBody = (exec.arguments as { command: string }).command
      return { isError: false, value: 'ok', content: [] }
    })
    assert.equal(seenByBody, 'git status')
  })

  it('compacts a bash result and keeps the exit marker', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = { name: 'bash', callId: 'call-3', arguments: { command: 'git status' }, signal: new AbortController().signal }
    const body = Array.from({ length: 30 }, (_, index) => ` M src/file${index}.ts`).join('\n')
    const content = [{ type: 'text', text: `## main\n${body}\n[exit code: 0]` }]

    const decision = await harness.emit(
      'tools/post-execute',
      exec,
      { isError: false, value: 'ok', content },
      async () => ({ kind: 'accept' }),
    )

    assert.equal(decision.kind, 'accept')
    assert.match(decision.content[0].text, /Branch: main/)
    assert.match(decision.content[0].text, /\[exit code: 0\]$/)
  })

  it('accepts the result unchanged when nothing shrinks', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = { name: 'bash', callId: 'call-4', arguments: { command: 'echo hi' }, signal: new AbortController().signal }
    const result = { isError: false, value: 'ok', content: [{ type: 'text', text: 'hi\n[exit code: 0]' }] }
    const accepted = { kind: 'accept' }

    const decision = await harness.emit('tools/post-execute', exec, result, async () => accepted)
    assert.equal(decision, accepted, 'an unchanged result must be passed through by reference')
  })

  it('never breaks a tool call when compaction throws', async () => {
    const harness = fakeContext()
    apply(harness.ctx, REWRITE_CONFIG as never)

    const exec = { name: 'bash', callId: 'call-5', arguments: { command: 'git status' }, signal: new AbortController().signal }
    // `content` is not an array of blocks: the pipeline must fail closed.
    const result = { isError: false, value: 'ok', content: { not: 'an array' } }

    const decision = await harness.emit('tools/post-execute', exec, result, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
  })

  it('registers the /rtk command when the command registry is present', () => {
    const registered: Array<{ name: string }> = []
    const harness = fakeContext({
      commands: {
        register: (definition: { name: string }) => {
          registered.push(definition)
          return () => {}
        },
      },
    })
    apply(harness.ctx, REWRITE_CONFIG as never)
    assert.deepEqual(registered.map((entry) => entry.name), ['rtk'])
  })

  it('works without the optional command and settings services', () => {
    const harness = fakeContext()
    assert.doesNotThrow(() => apply(harness.ctx, REWRITE_CONFIG as never))
  })
})

describe('missing-rtk notice', () => {
  /** Drive one call through both stages, as the registry does. */
  async function callOnce(harness: ReturnType<typeof fakeContext>, callId: string, agent: { id: string }) {
    const exec = {
      name: 'bash',
      callId,
      arguments: { command: 'git status' },
      signal: new AbortController().signal,
      agent,
    }
    await harness.emit('tools/execute', exec, async () => ({ isError: false, value: 'ok', content: [] }))
    return harness.emit(
      'tools/post-execute',
      exec,
      { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] },
      async () => ({ kind: 'accept' }),
    )
  }

  it('tells a session once, and only once, that rtk is missing', async () => {
    const harness = fakeContext()
    // A path that cannot exist, so the guard stands every rewrite down.
    apply(harness.ctx, normalizeConfig({ rtkExecutable: '/nonexistent/rtk-binary' }) as never)
    const agent = { id: 'session-notice' }

    const first = await callOnce(harness, 'call-1', agent)
    assert.equal(first.kind, 'accept')
    const firstText = first.content.map((block: { text: string }) => block.text).join('\n')
    assert.match(firstText, /rtk not found/, 'the first call must say rewriting is off')
    assert.match(firstText, /\[exit code: 0\]$/, 'the notice must not disturb the exit marker')

    const second = await callOnce(harness, 'call-2', agent)
    const secondText = (second.content ?? []).map((block: { text: string }) => block.text).join('\n')
    assert.doesNotMatch(secondText, /rtk not found/, 'the notice must not repeat within a session')
  })

  it('tells a different session its own first time', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({ rtkExecutable: '/nonexistent/rtk-binary' }) as never)

    await callOnce(harness, 'call-a', { id: 'session-a' })
    const other = await callOnce(harness, 'call-b', { id: 'session-b' })
    const text = other.content.map((block: { text: string }) => block.text).join('\n')
    assert.match(text, /rtk not found/, 'each session gets told independently')
  })

  it('stays quiet when the notice is switched off', async () => {
    const harness = fakeContext()
    apply(
      harness.ctx,
      normalizeConfig({ rtkExecutable: '/nonexistent/rtk-binary', notifyWhenRtkMissing: false }) as never,
    )
    const decision = await callOnce(harness, 'call-1', { id: 'session-quiet' })
    const text = (decision.content ?? []).map((block: { text: string }) => block.text).join('\n')
    assert.doesNotMatch(text, /rtk not found/)
  })
})

describe('spill coordination', () => {
  /** A result far larger than the plugin's own 12 000-character budget. */
  const huge = 'x'.repeat(30000)

  async function postExecute(harness: ReturnType<typeof fakeContext>) {
    const exec = { name: 'bash', callId: 'big-1', arguments: { command: 'cat huge' }, signal: new AbortController().signal }
    return harness.emit(
      'tools/post-execute',
      exec,
      { isError: false, value: 'ok', content: [{ type: 'text', text: huge }] },
      async () => ({ kind: 'accept' }),
    )
  }

  it('steps aside when the harness bounds oversized output itself', async () => {
    // `spillStore` present == dsh-spill-policy is mounted, so the recoverable
    // spill path owns large results and this plugin must not pre-empt it.
    const harness = fakeContext({ spillStore: {} })
    apply(harness.ctx, normalizeConfig({}) as never)

    const decision = await postExecute(harness)
    const text = (decision.content ?? []).map((block: { text: string }) => block.text).join('')
    assert.ok(
      text.length === 0 || text.length > 12000,
      `spill should own this result, but it was truncated to ${text.length} chars`,
    )
  })

  it('still truncates when spill is not mounted', async () => {
    const harness = fakeContext()
    apply(harness.ctx, normalizeConfig({}) as never)

    const decision = await postExecute(harness)
    const text = (decision.content ?? []).map((block: { text: string }) => block.text).join('')
    assert.ok(text.length > 0 && text.length <= 13000, `expected a bounded result, got ${text.length} chars`)
  })

  it('keeps its own bound when a row opts out of deferring', async () => {
    const harness = fakeContext({ spillStore: {} })
    apply(
      harness.ctx,
      normalizeConfig({
        outputCompaction: { deferToHarnessSpill: false, truncate: { enabled: true, maxChars: 2000 } },
      }) as never,
    )

    const decision = await postExecute(harness)
    const text = (decision.content ?? []).map((block: { text: string }) => block.text).join('')
    assert.ok(text.length > 0 && text.length <= 2100, `an opted-out row must keep its budget, got ${text.length} chars`)
  })
})

describe('settings integration', () => {
  it('registers its namespace when the settings service is available', () => {
    const registered: Array<{ ns: string; base: unknown }> = []
    const watched: number[] = []
    const settings = {
      register: (ns: string, _schema: unknown, options?: { base?: unknown }) => {
        registered.push({ ns, base: options?.base })
        return {
          get: () => ({}),
          watch: () => {
            watched.push(1)
            return () => {}
          },
          update: async () => {},
          replace: async () => {},
        }
      },
      get: () => undefined,
    }

    const harness = fakeContext({ settings })
    apply(harness.ctx, normalizeConfig({ enabled: true, mode: 'rewrite' }) as never)

    assert.deepEqual(registered.map((entry) => entry.ns), ['dsh-rtk'])
    assert.equal(watched.length, 1, 'the plugin must observe later settings edits')
  })

  it('still works when the service never shows up', () => {
    const harness = fakeContext()
    assert.doesNotThrow(() => apply(harness.ctx, normalizeConfig({}) as never))
    assert.ok(harness.listeners.has('tools/execute'), 'the rewriting half must still register')
  })
})
