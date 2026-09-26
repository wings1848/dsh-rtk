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
    const bridge = createSettingsBridge(fakeContext({ settings: provider }).ctx, { enabled: true })
    assert.deepEqual(calls.registered.map((entry) => entry.ns), ['dsh-rtk'])
    assert.deepEqual(calls.registered[0]?.base, { enabled: true })
    assert.match(bridge.note, /`dsh-rtk` namespace/)
  })

  it('reads the provider value and reports a reset that replaces the user layer', async () => {
    const { provider, calls, set } = fakeProvider()
    const bridge = createSettingsBridge(fakeContext({ settings: provider }).ctx, {})
    set({ enabled: false })
    assert.equal(bridge.read().enabled, false)
    const message = await bridge.reset()
    assert.deepEqual(calls.replaced, [{}])
    assert.match(message, /user overrides cleared/)
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

    assert.match(await bridge.reset(), /does not own the settings namespace/)
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
    const enabled = ref(true)
    const bridge = createSettingsBridge(fakeContext({ settings: forms }).ctx, { enabled })
    assert.equal(bridge.read().enabled, true)
    ;(enabled as unknown as { [WRITE]: (next: unknown) => void })[WRITE](false)
    assert.equal(bridge.read().enabled, false, 'the committed edit must be visible without a remount')
  })

  it('refreshes on loader/volatile-update and resets its own entry', async () => {
    const { forms, calls } = fakeForms()
    const harness = fakeContext({ settings: forms }, { fiber: { entry: { options: { id: 'rtk' } } } })
    const bridge = createSettingsBridge(harness.ctx, {})

    let changes = 0
    bridge.onChange(() => (changes += 1))
    harness.emit('loader/volatile-update', [['enabled']])
    assert.equal(changes, 1)

    assert.match(await bridge.reset(), /user overrides cleared/)
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
    const message = await bridge.reset()
    assert.match(message, /reset was refused \(Plugin entry "rtk" has no volatile fields\)/)
    assert.match(message, /composition `config:` block/, 'the way out must stay visible')
  })

  it('survives a modern surface without replace at all', async () => {
    const harness = fakeContext({ settings: { describe: () => [] } }, { fiber: { entry: { options: { id: 'rtk' } } } })
    const bridge = createSettingsBridge(harness.ctx, {})
    assert.match(await bridge.reset(), /reset was refused/)
  })

  it('never resets a different entry when its own id cannot be resolved', async () => {
    const { forms, calls } = fakeForms()
    const bridge = createSettingsBridge(fakeContext({ settings: forms }).ctx, {})
    assert.match(await bridge.reset(), /composition `config:` block/)
    assert.deepEqual(calls.replaced, [], 'a blind reset could wipe a sibling plugin’s settings')
  })
})

describe('unknown settings generations', () => {
  it('degrades to composition-only configuration, without throwing', async () => {
    for (const settings of [{}, { describe: 42 }, Object.create(null)]) {
      const harness = fakeContext({ settings })
      const bridge = createSettingsBridge(harness.ctx, { enabled: true })
      assert.equal(bridge.read().enabled, true)
      assert.match(bridge.note, /composition only/)
      assert.match(await bridge.reset(), /composition `config:` block/)
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
    assert.equal(bridge.read().enabled, true)
  })
})

describe('Volatile values in normalizeConfig', () => {
  it('reads references at any depth, including one holding a subtree', () => {
    const config = normalizeConfig({
      enabled: ref(false),
      outputCompaction: ref({
        truncate: { enabled: true, maxChars: ref(5000) },
      }),
    })
    assert.equal(config.enabled, false)
    assert.equal(config.outputCompaction.truncate.enabled, true)
    assert.equal(config.outputCompaction.truncate.maxChars, 5000, 'nested references are read through too')
    assert.equal(config.outputCompaction.stripAnsi, true, 'unlisted subtree fields fall back to defaults')
  })

  it('leaves plain values alone', () => {
    const config = normalizeConfig({ rewriteTimeoutMs: 1234 })
    assert.equal(config.rewriteTimeoutMs, 1234)
  })
})
