import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { createSettingsBridge } from '../lib/settings-compat.js'

/**
 * The settings bridge, one track at a time.
 *
 * The integration suite proves `apply()` survives every settings generation;
 * this file pins each track's own contract — what it registers, what it reads,
 * what a reset means — so a harness API change is localized to one function
 * here and the rest of the plugin stays out of it.
 */

const WRITE = Symbol.for('cosmokit.volatile.write')

/** A Volatile-shaped reference, as schemastery wraps marked fields in. */
function ref(initial: unknown): { get(): unknown } {
  let current = initial
  return {
    get: () => current,
    [WRITE]: (next: unknown) => {
      current = next
    },
  } as { get(): unknown }
}

interface FakeContext {
  get(name: string): unknown
  on(event: string, listener: (...args: never[]) => void): unknown
  fiber?: unknown
}

function fakeContext(services: Record<string, unknown>, options: { fiber?: unknown } = {}): {
  ctx: FakeContext
  listeners: Map<string, Array<(...args: never[]) => void>>
  emit(event: string, ...args: unknown[]): void
} {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  const ctx: FakeContext = {
    fiber: options.fiber,
    get: (name) => services[name],
    on: (event, listener) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => {}
    },
  }
  return {
    ctx,
    listeners,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]))
    },
  }
}

describe('legacy settings provider (dsh 0.1.5)', () => {
  function fakeProvider() {
    const calls = {
      registered: [] as Array<{ ns: string; base: unknown }>,
      watched: 0,
      replaced: [] as object[],
    }
    let value: unknown = { enabled: true }
    const provider = {
      register(ns: string, _schema: unknown, options?: { base?: unknown }) {
        calls.registered.push({ ns, base: options?.base })
        return {
          get: () => value,
          watch: (callback: (next: unknown) => void) => {
            calls.watched += 1
            callback(value)
            return () => {}
          },
          replace: async (section: object) => {
            calls.replaced.push(section)
            value = {}
          },
        }
      },
    }
    return { provider, calls, set: (next: unknown) => (value = next) }
  }

  it('registers the dsh-rtk namespace with the composition as its base', () => {
    const { provider, calls } = fakeProvider()
    const bridge = createSettingsBridge(fakeContext({ settings: provider }).ctx, { mode: 'rewrite' })
    assert.deepEqual(calls.registered.map((entry) => entry.ns), ['dsh-rtk'])
    assert.deepEqual(calls.registered[0]?.base, { mode: 'rewrite' })
    assert.match(bridge.note, /`dsh-rtk` namespace/)
  })

  it('reads the provider value and reports a reset that replaces the user layer', async () => {
    const { provider, calls, set } = fakeProvider()
    const bridge = createSettingsBridge(fakeContext({ settings: provider }).ctx, {})
    set({ mode: 'off' })
    assert.equal(bridge.read().mode, 'off')
    const result = await bridge.reset()
    assert.deepEqual(calls.replaced, [{}])
    assert.equal(result.ok, true)
    assert.match(result.text, /values it inherits from the composition/)
  })

  it('follows a namespace owned by another instance instead of failing', async () => {
    const registered: string[] = []
    const provider = {
      register(ns: string) {
        registered.push(ns)
        throw new Error('namespace already registered')
      },
      get: (ns: string) => (ns === 'dsh-rtk' ? { mode: 'suggest' } : undefined),
    }
    const harness = fakeContext({ settings: provider })
    const bridge = createSettingsBridge(harness.ctx, {})

    assert.deepEqual(registered, ['dsh-rtk'], 'the plugin must try to own the namespace first')
    assert.equal(bridge.read().mode, 'suggest', 'the follower must read the winner’s value')

    let changes = 0
    bridge.onChange(() => (changes += 1))
    harness.emit('settings/updated', 'other-ns', {})
    assert.equal(changes, 0, 'another namespace is none of this plugin’s business')
    harness.emit('settings/updated', 'dsh-rtk', {})
    assert.equal(changes, 1)

    const result = await bridge.reset()
    assert.equal(result.ok, false)
    assert.match(result.text, /does not own the settings namespace/)
  })
})

describe('modern settings host (dsh 0.1.7)', () => {
  function fakeForms() {
    const calls = { replaced: [] as Array<{ ns: string; section: object }> }
    const forms = {
      describe: () => [],
      replace: async (ns: string, section: object) => {
        calls.replaced.push({ ns, section })
      },
    }
    return { forms, calls }
  }

  it('reads live values through the running references', () => {
    const { forms } = fakeForms()
    const mode = ref('rewrite')
    const bridge = createSettingsBridge(fakeContext({ settings: forms }).ctx, { mode })
    assert.equal(bridge.read().mode, 'rewrite')
    ;(mode as unknown as { [WRITE]: (next: unknown) => void })[WRITE]('off')
    assert.equal(bridge.read().mode, 'off', 'the committed edit must be visible without a remount')
  })

  it('refreshes on loader/volatile-update and resets its own entry', async () => {
    const { forms, calls } = fakeForms()
    const harness = fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } })
    const bridge = createSettingsBridge(harness.ctx, {})

    let changes = 0
    bridge.onChange(() => (changes += 1))
    harness.emit('loader/volatile-update', [['enabled']])
    assert.equal(changes, 1)

    const reset = await bridge.reset()
    assert.equal(reset.ok, true)
    assert.match(reset.text, /values it inherits from the composition/)
    assert.deepEqual(calls.replaced, [{ ns: 'rtk', section: {} }], 'reset must name the entry the plugin runs as')
    assert.match(bridge.note, /`rtk` entry/)
  })

  it('reports a refused reset instead of claiming success', async () => {
    // The service validates writes: a stale revision, an entry with no
    // editable fields, or a read-only profile all make `replace` throw. A
    // refusal that reads as success is worse than no reset at all.
    const forms = {
      describe: () => [],
      replace: async () => {
        throw new Error('Plugin entry "rtk" has no volatile fields')
      },
    }
    const harness = fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } })
    const bridge = createSettingsBridge(harness.ctx, {})
    const result = await bridge.reset()
    assert.equal(result.ok, false, 'a refused reset must not read as a success')
    assert.match(result.text, /reset was refused \(Plugin entry "rtk" has no volatile fields\)/)
    assert.match(result.text, /composition `config:` block/, 'the way out must stay visible')
  })

  it('survives a modern surface without replace at all', async () => {
    const harness = fakeContext({ settings: { describe: () => [] } }, { fiber: { entry: { options: { id: 'rtk' } } } })
    const bridge = createSettingsBridge(harness.ctx, {})
    const result = await bridge.reset()
    assert.equal(result.ok, false)
    assert.match(result.text, /reset was refused/)
  })

  it('never resets a different entry when its own id cannot be resolved', async () => {
    const { forms, calls } = fakeForms()
    const bridge = createSettingsBridge(fakeContext({ settings: forms }).ctx, {})
    const result = await bridge.reset()
    assert.equal(result.ok, false)
    assert.match(result.text, /composition `config:` block/)
    assert.deepEqual(calls.replaced, [], 'a blind reset could wipe a sibling plugin’s settings')
  })
})

describe('auto-detected executable write-back', () => {
  /** A modern form surface that records path-addressed edits. */
  function mutableForms(options: { writable?: boolean; fail?: boolean } = {}) {
    const ops: Array<{ ns: string; ops: readonly object[] }> = []
    const forms = {
      describe: () => [],
      ...(options.writable === undefined ? {} : { writable: options.writable }),
      mutate: async (ns: string, next: readonly object[]) => {
        if (options.fail === true) throw new Error('Configuration for "rtk" is overridden by a home patch')
        ops.push({ ns, ops: next })
      },
      replace: async () => {},
    }
    return { forms, ops }
  }

  it('writes exactly one field through mutate', async () => {
    const { forms, ops } = mutableForms()
    const bridge = createSettingsBridge(
      fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } }).ctx,
      {},
    )
    assert.equal(bridge.writable, true)
    assert.equal(await bridge.persistRtkExecutable('C:\\tools\\rtk.exe'), true)
    assert.deepEqual(ops, [
      { ns: 'rtk', ops: [{ op: 'set', path: ['rtkExecutable'], value: 'C:\\tools\\rtk.exe' }] },
    ], 'a wholesale replace would pin every other field as a user override')
  })

  it('reports a refused write without throwing', async () => {
    const { forms } = mutableForms({ fail: true })
    const bridge = createSettingsBridge(
      fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } }).ctx,
      {},
    )
    assert.equal(await bridge.persistRtkExecutable(''), false)
  })

  it('respects a read-only profile', async () => {
    const { forms } = mutableForms({ writable: false })
    const bridge = createSettingsBridge(
      fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } }).ctx,
      {},
    )
    assert.equal(bridge.writable, false)
    assert.equal(await bridge.persistRtkExecutable('C:\\tools\\rtk.exe'), false)
  })

  it('stays runtime-only where the generation has no path-addressed write', async () => {
    const forms = { describe: () => [], replace: async () => {} }
    const modern = createSettingsBridge(
      fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } }).ctx,
      {},
    )
    assert.equal(modern.writable, false)
    assert.equal(await modern.persistRtkExecutable(''), false)

    const legacy = createSettingsBridge(fakeContext({ settings: { register: () => ({ get: () => ({}), watch: () => () => {}, replace: async () => {} }) } }).ctx, {})
    assert.equal(legacy.writable, false)
    assert.equal(await legacy.persistRtkExecutable(''), false)
  })
})

describe('unknown settings generations', () => {
  it('degrades to composition-only configuration, without throwing', async () => {
    for (const settings of [{}, { describe: 42 }, Object.create(null)]) {
      const harness = fakeContext({ settings })
      const bridge = createSettingsBridge(harness.ctx, { enabled: true })
      assert.equal(bridge.read().mode, 'rewrite')
      assert.match(bridge.note, /composition only/)
      const reset = await bridge.reset()
      assert.equal(reset.ok, false)
      assert.match(reset.text, /composition `config:` block/)
      let changes = 0
      assert.doesNotThrow(() => bridge.onChange(() => (changes += 1)))
      harness.emit('loader/volatile-update', [[]])
      assert.equal(changes, 0, 'a generation this plugin cannot speak to triggers nothing')
    }
  })

  it('degrades the same way when the integration itself fails', async () => {
    // Probing the service must not be able to kill the plugin either — a
    // service object is third-party territory, and property access on it can
    // explode before any shape check concludes.
    const settings = {
      get register(): never {
        throw new Error('boom')
      },
    }
    const bridge = createSettingsBridge(fakeContext({ settings }).ctx, {})
    assert.match(bridge.note, /integration unavailable \(boom\)/)
    assert.equal(bridge.read().mode, 'rewrite')
  })
})

describe('Volatile values in normalizeConfig', () => {
  it('reads references at any depth, including one holding a subtree', () => {
    const config = normalizeConfig({
      mode: ref('off'),
      maxChars: ref(5000),
      outputCompaction: ref({ truncate: { maxChars: ref(9000) } }),
    })
    assert.equal(config.mode, 'off')
    assert.equal(config.maxChars, 5000, 'top-level references are read through')
    assert.equal(config.compact, true, 'retired subtree values fall back to defaults')
  })

  it('leaves plain values alone', () => {
    const config = normalizeConfig({ rtkExecutable: 'custom-rtk' })
    assert.equal(config.rtkExecutable, 'custom-rtk')
  })
})