import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import vm from 'node:vm'

/**
 * The browser half is a module-loader bundle, not an ordinary ESM module: the
 * host serves it under `exports["./client"]` and expects the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper. That shape and the
 * slot registration it performs are contracts the host enforces, so they are
 * pinned here without a browser: the wrapper runs in a VM, the factory receives
 * a stub `react`, and the fake context records what a real one would receive.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface Captured {
  id: string
  factory: (require: (name: string) => unknown) => Record<string, unknown>
}

interface Registration {
  options: { name: string; key: string; locale: string; inject?: () => Record<string, unknown> }
  component: (props: Record<string, unknown>) => unknown
}

function fakeReact(): Record<string, unknown> {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
      const resolved = props ?? {}
      // Flatten function components the way a renderer would, so assertions can
      // describe the real tree instead of the component reference.
      if (typeof type === 'function') {
        return (type as (input: Record<string, unknown>) => unknown)({ ...resolved, children })
      }
      return { type, props: resolved, children }
    },
    useState(initial: unknown): unknown[] {
      return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}]
    },
    useEffect(): void {},
  }
}

/** Load the built bundle and return its exports. */
function loadClient(globals: Record<string, unknown> = {}): {
  exports: Record<string, unknown>
  captured: Captured
  react: Record<string, unknown>
} {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let captured: Captured | undefined
  const sandbox = {
    URL,
    ...globals,
    window: { __ModuleLoader__: { load: (entry: Captured) => { captured = entry } } },
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.ok(captured !== undefined, 'the bundle must register itself with window.__ModuleLoader__')
  const react = fakeReact()
  const exports = captured.factory((name: string) => {
    assert.equal(name, 'react', 'only baseline react may be requested')
    return react
  })
  return { exports, captured, react }
}

/** Mount the browser half against a recording context. */
function mount(exports: Record<string, unknown>): { registrations: Registration[]; ctx: Record<string, unknown> } {
  const registrations: Registration[] = []
  const ctx = {
    locale: {
      bind: () => (key: string) => key,
      register: () => () => {},
      subscribe: () => () => {},
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: Registration['options'], component: Registration['component']) => {
        registrations.push({ options, component })
        return () => {}
      },
      subscribe: () => () => {},
    },
    effect: (callback: () => unknown) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  ;(exports['apply'] as (context: unknown) => void)(ctx)
  return { registrations, ctx }
}

/** Collect every element node in a rendered tree. */
function elements(node: unknown, found: ElementNode[] = []): ElementNode[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  const candidate = node as ElementNode
  if (!('type' in candidate) || !('props' in candidate)) return found
  found.push(candidate)
  for (const child of candidate.children) elements(child, found)
  return found
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  exports?: Record<string, { default?: string }>
  dsh?: { client?: { platform?: string; inject?: string[] } }
}

describe('client manifest', () => {
  it('exports the built browser half and declares it as the web client plugin', () => {
    assert.equal(manifest.exports?.['./client']?.default, './lib/client.js')
    assert.equal(manifest.dsh?.client?.platform, 'web')
    assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject must list the services the page needs')
    for (const required of [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-plugin-manager',
    ]) {
      assert.ok(manifest.dsh?.client?.inject?.includes(required), `dsh.client.inject must include ${required}`)
    }
  })
})

describe('client bundle', () => {
  it('registers under the package name with the documented services', () => {
    const { exports, captured } = loadClient()
    assert.equal(captured.id, manifest.name)
    assert.deepEqual(Array.from(exports['inject'] as string[]), ['slots', 'locale'])
    assert.equal(exports['ROW_KEY'], `${manifest.name}#rtk`)
  })

  it('registers into the row-config slot for the rtk row', () => {
    const { exports } = loadClient()
    const { registrations } = mount(exports)
    assert.equal(registrations.length, 1)
    const [registration] = registrations
    assert.equal(registration?.options.name, 'plugins.row.config')
    assert.equal(registration?.options.key, `${manifest.name}#rtk`)
    assert.equal(registration?.options.locale, exports['NS'])
  })

  it('hands the component its reader through the registration inject factory', () => {
    const { exports } = loadClient()
    const { registrations } = mount(exports)
    const inject = registrations[0]?.options.inject
    assert.equal(typeof inject, 'function', 'entry-private props belong in the registration inject factory')
    const injected = (inject as () => Record<string, unknown>)()
    assert.equal(typeof injected['gainReader'], 'function', 'the Gain panel reader must arrive through inject')
  })

  it('renders a summary line and an unavailable notice without a form', () => {
    const { exports } = loadClient()
    const { registrations } = mount(exports)
    const component = registrations[0]?.component
    assert.equal(component?.({ t: (key: string) => key, view: 'summary' }), 'summary')
    const unavailable = elements(component?.({ t: (key: string) => key, view: 'page' }))
    assert.deepEqual(unavailable.at(-1)?.children, ['unavailable'])
  })

  it('renders the five controls plus the gain ledger panel', () => {
    const { exports } = loadClient()
    const { registrations } = mount(exports)
    const component = registrations[0]?.component
    const tree = component?.({
      t: (key: string) => key,
      view: 'page',
      form: {
        state: {
          status: 'ready',
          value: { mode: 'rewrite', compact: true, maxChars: 12000, readCompaction: 'none', rtkExecutable: 'rtk' },
          base: {},
          user: {},
          revision: 7,
          writable: true,
        },
        mutate: async () => true,
      },
      gainReader: async () => ({ ok: true, value: { available: false } }),
    })
    const nodes = elements(tree)
    const byData = (key: string) => nodes.find((node) => node.props[key] !== undefined)
    assert.ok(byData('data-rtk-config'), 'the form root must be marked for styling and tests')
    assert.equal(
      nodes.filter((node) => node.type === 'select').length,
      3,
      'mode and readCompaction are selects, and the gain panel adds the workspace picker',
    )
    assert.equal(nodes.filter((node) => node.type === 'input').length, 3, 'compact, maxChars and rtkExecutable are inputs')
    const gain = byData('data-rtk-gain')
    assert.equal(gain?.props['data-rtk-gain'], 'loading', 'the panel fetches its ledger on mount')
    assert.ok(JSON.stringify(gain).includes('gainTitle'), 'the gain panel must be titled')
  })

  it('explains every field with a hint line and a detail line', () => {
    const { exports } = loadClient()
    const { registrations } = mount(exports)
    const component = registrations[0]?.component
    const tree = component?.({
      t: (key: string) => key,
      view: 'page',
      form: {
        state: { status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true },
        mutate: async () => true,
      },
    })
    const texts = elements(tree)
      .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
      .filter((text) => text !== '')
    for (const key of ['mode', 'compact', 'maxChars', 'readCompaction', 'rtkExecutable']) {
      assert.ok(texts.includes(`field.${key}.label`), `field ${key} needs a label`)
      assert.ok(texts.includes(`field.${key}.hint`), `field ${key} needs a one-line hint`)
      assert.ok(texts.includes(`field.${key}.detail`), `field ${key} needs a detail explanation`)
    }
    for (const option of ['modeValues.off', 'modeValues.rewrite', 'modeValues.suggest', 'readCompactionValues.none']) {
      assert.ok(texts.includes(option), `select option ${option} needs copy`)
    }
  })

  it('ships flat string dictionaries, one key per locale', () => {
    const { exports } = loadClient()
    const dictionaries = exports['dictionaries'] as Record<string, Record<string, unknown>>
    for (const locale of ['zh', 'en']) {
      for (const [key, value] of Object.entries(dictionaries[locale] ?? {})) {
        // A nested object never reaches the locale store: t() would echo the key
        // and the form would show "field.compact" instead of a label.
        assert.equal(typeof value, 'string', `${locale} key ${key} must be a flat string`)
      }
    }
    assert.deepEqual(Object.keys(dictionaries['zh'] ?? {}).sort(), Object.keys(dictionaries['en'] ?? {}).sort())
    for (const locale of ['zh', 'en']) {
      for (const key of ['mode', 'compact', 'maxChars', 'readCompaction', 'rtkExecutable']) {
        for (const part of ['label', 'hint', 'detail']) {
          assert.equal(typeof dictionaries[locale]?.[`field.${key}.${part}`], 'string', `${locale} needs field.${key}.${part}`)
        }
      }
    }
  })

  it('quotes the real defaults in the field copy', () => {
    const { exports } = loadClient()
    const dictionaries = exports['dictionaries'] as Record<string, Record<string, string>>
    // Copy that names a default drifts the moment DEFAULT_CONFIG changes, so the
    // hint has to contain the value the schema actually ships.
    const schema = readFileSync(join(root, 'src', 'config.ts'), 'utf8')
    const readCompaction = /readCompaction:\s*'(\w+)'/.exec(schema)?.[1]
    assert.ok(readCompaction !== undefined, 'DEFAULT_CONFIG.readCompaction must be a literal')
    assert.ok(
      dictionaries['zh']?.['field.readCompaction.hint']?.includes(readCompaction),
      `the zh hint must name the real default (${readCompaction})`,
    )
    const maxChars = /maxChars:\s*(\d+)/.exec(schema)?.[1]
    assert.ok(maxChars !== undefined, 'DEFAULT_CONFIG.maxChars must be a literal')
    assert.ok(dictionaries['zh']?.['field.maxChars.hint']?.includes(maxChars), `the zh hint must name ${maxChars}`)
  })

  it('offers the four time windows the host can slice', () => {
    const { exports } = loadClient()
    const ranges = exports['GAIN_RANGES'] as { key: string; label: string }[]
    assert.deepEqual(
      Array.from(ranges, (range) => range.key),
      ['today', 'week', 'month', 'all'],
    )
    for (const range of ranges) assert.match(range.label, /^gainRange/)
  })

  it('formats ledger figures compactly and clamps the meter', () => {
    const { exports } = loadClient()
    const compact = exports['formatCompact'] as (value: number) => string
    const percent = exports['formatPercent'] as (value: number) => string
    const cells = exports['meterCells'] as (value: number) => number
    assert.equal(compact(940), '940')
    assert.equal(compact(159_049), '159.0K')
    assert.equal(compact(8_479_844), '8.5M')
    assert.equal(percent(67.9), '67.9')
    assert.equal(percent(123.4), '100.0', 'a share above 100% is clamped')
    assert.equal(cells(0), 0)
    assert.equal(cells(67.9), 14, 'one cell per five percent, rounded')
    assert.equal(cells(100), 20)
    assert.equal(cells(-5), 0)
  })

  it('shortens workspace paths without losing the tail', () => {
    const { exports } = loadClient()
    const short = exports['shortPath'] as (path: string) => string
    assert.equal(short('G:\\GitWork\\dsh-rtk'), '…/GitWork/dsh-rtk')
    assert.equal(short('/home/me/projects/rtk'), '…/projects/rtk')
    assert.equal(short('C:'), 'C:')
  })

  it('resolves the ledger route against the document base URI', async () => {
    const { exports } = loadClient({ document: { baseURI: 'http://127.0.0.1:9/harness/' } })
    const fetchGain = exports['fetchGain'] as (
      payload: unknown,
      doFetch: (url: string) => Promise<unknown>,
    ) => Promise<unknown>
    let seen = ''
    await fetchGain({}, async (url: string) => {
      seen = url
      return { ok: true, json: async () => ({ ok: true, value: {} }) }
    })
    assert.equal(seen, 'http://127.0.0.1:9/harness/api/dsh-rtk/gain')
  })

  it('posts the ledger request to the host fetch route', async () => {
    const { exports } = loadClient()
    const fetchGain = exports['fetchGain'] as (
      payload: unknown,
      doFetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>,
    ) => Promise<unknown>
    // Document-relative on purpose: a root-absolute path breaks a deployment
    // mounted under a prefix.
    assert.equal(exports['GAIN_PATH'], 'api/dsh-rtk/gain')

    let seen: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } } = { url: '' }
    const result = (await fetchGain({ range: 'week' }, async (url, init) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ ok: true, value: { range: 'week' } }) }
    })) as { ok: boolean; value: { range: string } }
    assert.equal(seen.url, 'api/dsh-rtk/gain', 'without a document the route is used as written')
    assert.equal(seen.init?.method, 'POST')
    assert.equal(seen.init?.headers?.['content-type'], 'application/json')
    assert.equal(JSON.parse(String(seen.init?.body)).range, 'week')
    assert.equal(result.ok, true)
    assert.equal(result.value.range, 'week')

    await assert.rejects(
      fetchGain({}, async () => ({ ok: false, status: 401, json: async () => ({}) })),
      /HTTP 401/,
    )
  })

  it('renders the labelled breakdown with tooltips and a per-command view', () => {
    const { exports } = loadClient()
    const readout = exports['GainReadout'] as (props: Record<string, unknown>) => unknown
    const report = {
      summary: {
        commands: 4,
        inputTokens: 1000,
        outputTokens: 400,
        savedTokens: 600,
        savingsPercent: 60,
        totalTimeMs: 20,
        avgTimeMs: 5,
      },
      daily: [
        { date: '2026-10-20', commands: 4, inputTokens: 1000, outputTokens: 400, savedTokens: 600, savingsPercent: 60, totalTimeMs: 20, avgTimeMs: 5 },
      ],
      commands: [
        { command: 'rtk grep', calls: 3, inputTokens: 900, outputTokens: 300, savedTokens: 600, savingsPercent: 66.7 },
      ],
    }
    const t = (key: string) => key

    const dailyText = JSON.stringify(elements(readout({ t, report, view: 'daily', onView: () => {} })))
    assert.ok(dailyText.includes('gainBefore'), 'the ledger names the original output')
    assert.ok(dailyText.includes('gainAfter'), 'the ledger names what rtk let through')
    assert.ok(dailyText.includes('gainColDate'), 'daily rows carry a date header')
    assert.ok(dailyText.includes('gainColSavedDay'), 'daily rows carry a saved header')
    assert.ok(dailyText.includes('gainColCalls'), 'daily rows carry a command-count header')
    assert.ok(dailyText.includes('gainTipSavedDay'), 'daily cells explain themselves through title')
    assert.ok(dailyText.includes('gainTipCallsDay'))

    const commandTree = elements(readout({ t, report, view: 'command', onView: () => {} }))
    const commandText = JSON.stringify(commandTree)
    assert.ok(commandText.includes('rtk grep'), 'the command view lists rewritten commands')
    assert.ok(commandText.includes('gainColBefore'))
    assert.ok(commandText.includes('gainColAfter'))
    assert.ok(commandText.includes('gainColRatio'))
    assert.ok(commandText.includes('gainTipRatio'))
    assert.equal(commandTree.filter((node) => node.type === 'button').length, 2, 'the view switch has two buttons')

    const emptyCommands = JSON.stringify(
      elements(readout({ t, report: { ...report, commands: [] }, view: 'command', onView: () => {} })),
    )
    assert.ok(emptyCommands.includes('gainEmptyCommands'))
  })

  it('starts the ledger panel in the loading state once a reader exists', () => {
    const { exports } = loadClient()
    const panel = exports['GainPanel'] as (props: Record<string, unknown>) => unknown
    const rendered = elements(
      panel({ t: (key: string) => key, reader: async () => ({ ok: true, value: {} }) }),
    )
    const gain = rendered.find((node) => node.props['data-rtk-gain'] !== undefined)
    assert.equal(gain?.props['data-rtk-gain'], 'loading')
    assert.ok(JSON.stringify(rendered).includes('gainLoading'))
  })
})

/**
 * The browser half is reviewable only against the host's UI rules: no literal
 * palette values, no off-scale radii, no DOM side effects, and no second
 * application mounted on the page. These are source-level rules, so they are
 * pinned at the source level rather than through the VM.
 */
describe('browser half source rules', () => {
  const source = readFileSync(join(root, 'src', 'client', 'client.js'), 'utf8')

  it('uses no literal colors', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'colors must come from --dsw-alias-* tokens')
    assert.doesNotMatch(source, /\brgba?\(/, 'colors must come from --dsw-alias-* tokens')
  })

  it('uses the documented radius tokens instead of pixel values', () => {
    assert.doesNotMatch(source, /borderRadius: '\d/, 'radii must come from --dsw-radius-* tokens')
  })

  it('never writes outside its slot', () => {
    for (const banned of ['document.body', 'createPortal', 'innerHTML', 'localStorage', 'iframe']) {
      assert.equal(source.includes(banned), false, `${banned} is not allowed in a slot component`)
    }
  })

  it('requests nothing but baseline react', () => {
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
    assert.deepEqual(requires, ['react'])
  })

  it('keeps the built bundle identical to its source', () => {
    assert.equal(
      readFileSync(join(root, 'lib', 'client.js'), 'utf8'),
      source,
      'scripts/build-client.mjs must copy src/client/client.js verbatim',
    )
  })
})
