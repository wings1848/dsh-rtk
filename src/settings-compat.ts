import type { Context } from '@deepseek-ai/cordis'

import { Config, normalizeConfig, type RtkConfig } from './config.js'

/**
 * One seam over two generations of the harness's settings service.
 *
 * dsh 0.1.7 rewrote the settings surface: the old `SettingsProvider`
 * (`register`/`scope.watch`/`settings/updated`) is gone, replaced by
 * `SettingsForms`, where a plugin simply marks schema fields editable and the
 * loader commits edits into the running config references, announcing them on
 * `loader/volatile-update`. Rather than pin this plugin to one generation, the
 * service is consumed *by shape* and adapted behind this interface — which is
 * also why nothing here imports a type from `@deepseek-ai/dsh-settings`: that
 * package is the one that changed, and structural typing costs nothing when it
 * changes again.
 *
 * The one non-negotiable property: an unrecognized settings service degrades
 * to composition-only configuration. It must never take the plugin down with
 * it — the rewriting and compaction halves have nothing to do with settings.
 */
export interface SettingsBridge {
  /** One line telling `/rtk show` where this plugin's configuration is edited. */
  readonly note: string
  /** The effective configuration right now, normalized and clamped. */
  read(): RtkConfig
  /** Observe committed configuration changes; returns a disposer. */
  onChange(callback: () => void): () => void
  /** Restore the user layer to the composition's values; returns the report line. */
  reset(): Promise<string>
}

/** How the report line reads when configuration lives in the composition only. */
function compositionOnlyNote(detail: string): string {
  return `settings ${detail} — configuration comes from the composition only`
}

/** Message for a reset when no writable settings layer backs this instance. */
const COMPOSITION_RESET = 'dsh-rtk: there is no writable settings layer here — edit the composition `config:` block instead.'

/** What a successful reset says — the user layer is cleared, not "defaults" set. */
const RESET_DONE = "dsh-rtk: user overrides cleared — configuration is back to the composition's values."

/** What a refused reset says; the refusal must never look like a success. */
function resetFailed(error: unknown): string {
  return `dsh-rtk: reset was refused (${error instanceof Error ? error.message : String(error)}) — edit the composition \`config:\` block instead.`
}

/**
 * Pick the settings integration this harness generation offers.
 *
 * Detection is by shape, in generation order: the legacy provider registers
 * namespaces, the modern service projects forms. Anything else — including a
 * future third generation — falls through to composition-only configuration,
 * and so does any integration that fails to construct.
 */
export function createSettingsBridge(ctx: Context, rawConfig: unknown): SettingsBridge {
  try {
    const settings = ctx.get('settings') as unknown as Record<string, unknown> | undefined
    if (settings !== undefined) {
      if (typeof settings['register'] === 'function') return createLegacyBridge(ctx, rawConfig, settings)
      if (typeof settings['describe'] === 'function') return createModernBridge(ctx, rawConfig, settings)
    }
  } catch (error) {
    // The probe itself exploded. Whatever the settings object is, it is not
    // worth the plugin's life.
    return createCompositionBridge(rawConfig, compositionOnlyNote(`integration unavailable (${error instanceof Error ? error.message : String(error)})`))
  }
  return createCompositionBridge(rawConfig, compositionOnlyNote('service unavailable'))
}

/** Listen on an event whose type differs between harness generations. */
function listen(ctx: Context, event: string, handler: (...args: never[]) => void): () => void {
  const emitter = ctx as unknown as { on(name: string, listener: (...args: never[]) => void): unknown }
  return emitter.on(event, handler) as () => void
}

/** No settings service worth talking to: configuration is whatever the composition passed in. */
function createCompositionBridge(rawConfig: unknown, note: string): SettingsBridge {
  return {
    note,
    read: () => normalizeConfig(rawConfig),
    onChange: () => () => {},
    reset: async () => COMPOSITION_RESET,
  }
}

// ── modern harness: SettingsForms + loader/volatile-update ──────────────────

interface ModernForms {
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

/**
 * The id of the profile entry this plugin runs as — the modern namespace.
 *
 * Note the consequence for users coming from the old world: the namespace is
 * no longer the plugin's hardcoded `dsh-rtk`, but the composition row's own id
 * (`- id: rtk` is `rtk`). Only `options.id` counts, because that is the one
 * the settings service itself matches writes against — `Entry.id` is a
 * tree-qualified id and would address a different key. Unresolvable ids (a
 * context outside the loader) fall back to composition-only behavior for
 * reset, never to a guessed entry.
 */
function ownEntryId(ctx: Context): string | undefined {
  const entry = (ctx as unknown as { fiber?: { entry?: { options?: { id?: unknown } } } }).fiber?.entry
  const id = entry?.options?.id
  return typeof id === 'string' ? id : undefined
}

function createModernBridge(ctx: Context, rawConfig: unknown, settings: Record<string, unknown>): SettingsBridge {
  const forms = settings as unknown as ModernForms
  const ns = ownEntryId(ctx)
  return {
    note:
      ns === undefined
        ? compositionOnlyNote('entry is live but its id could not be resolved')
        : `the \`${ns}\` entry in the harness settings document`,
    // The loader commits volatile edits into the very references `rawConfig`
    // holds, so re-reading it is always current — the notification only drives
    // the cached copy and the prompt note.
    read: () => normalizeConfig(rawConfig),
    onChange: (callback) => listen(ctx, 'loader/volatile-update', () => callback()),
    reset: async () => {
      if (ns === undefined) return COMPOSITION_RESET
      try {
        await forms.replace(ns, {})
      } catch (error) {
        // The service validates writes (a stale revision, an entry with no
        // editable fields, a read-only profile). A refused reset must report
        // the refusal, not a success the user will trust.
        return resetFailed(error)
      }
      return RESET_DONE
    },
  }
}

// ── legacy harness: SettingsProvider + scope.watch ──────────────────────────

interface LegacyScope {
  get(): unknown
  watch(callback: (next: unknown) => void): () => void
  replace(section: object): Promise<void>
}

interface LegacyProvider {
  register(ns: string, schema: unknown, options?: { base?: unknown }): LegacyScope
  get?(ns: string): unknown
}

function createLegacyBridge(ctx: Context, rawConfig: unknown, provider: Record<string, unknown>): SettingsBridge {
  const legacy = provider as unknown as LegacyProvider
  try {
    const scope = legacy.register('dsh-rtk', Config, { base: rawConfig })
    return {
      note: 'the `dsh-rtk` namespace in the harness settings document',
      read: () => normalizeConfig(scope.get()),
      onChange: (callback) => scope.watch(() => callback()),
      reset: async () => {
        try {
          await scope.replace({})
        } catch (error) {
          return resetFailed(error)
        }
        return RESET_DONE
      },
    }
  } catch (error) {
    // Registration failed. The usual reason is another instance of this plugin
    // owning the process-global namespace (a host row and a preset row both
    // mounted) — a configuration convenience must never be the reason a whole
    // preset refuses to activate, so the loser follows the winner's value
    // instead. The reason still rides in the note: any *other* registration
    // failure (an incompatible schema, a broken settings document) deserves a
    // diagnosis that says what happened, not a guess.
    return createFollowingBridge(ctx, rawConfig, legacy, error)
  }
}

function createFollowingBridge(ctx: Context, rawConfig: unknown, provider: LegacyProvider, error: unknown): SettingsBridge {
  const read = (): RtkConfig => {
    try {
      return normalizeConfig(provider.get?.('dsh-rtk') ?? rawConfig)
    } catch {
      return normalizeConfig(rawConfig)
    }
  }
  return {
    note: `the \`dsh-rtk\` namespace in the harness settings document (this instance follows it; registration failed: ${error instanceof Error ? error.message : String(error)})`,
    read,
    onChange: (callback) =>
      listen(ctx, 'settings/updated', ((ns: string) => {
        if (ns === 'dsh-rtk') callback()
      }) as (...args: never[]) => void),
    reset: async () => 'dsh-rtk: this instance does not own the settings namespace — reset it from the instance that does.',
  }
}
