import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where rtk writes its usage ledger.
 *
 * The plugin used to run every rewritten command under
 * `RTK_DB_PATH=<tmpdir>/dsh-rtk/history.db`. That kept rtk's history out of the
 * working tree, which was the point — but it also bought two side effects:
 *
 * - On most Linux distributions `/tmp` is tmpfs, so the ledger was emptied on
 *   every reboot and `/rtk stats` could only ever describe the current uptime.
 * - It is not the database the user's own `rtk gain` reads. rtk defaults to its
 *   per-platform data directory (`~/.local/share/rtk/history.db` on Linux), so
 *   the terminal reported "No tracking data yet" while the agent had been
 *   writing hundreds of rows into `/tmp`.
 *
 * So the default is now to inject nothing at all: rtk already answers the
 * question "which ledger" correctly, and a second implementation of that answer
 * can only disagree with it. A value is injected only when the user asks for
 * one, and `isolated` restores the old tmpdir behavior verbatim.
 */

/** Value of the `historyDbPath` setting that selects the old tmpdir location. */
export const ISOLATED_HISTORY_DB_PATH = 'isolated'

/** Values that mean "let rtk decide", beyond the empty string the default uses. */
const DEFAULT_SENTINELS = new Set(['default'])

/** The ledger location, plus why an unusable one was refused. */
export interface HistoryDbResolution {
  /** Absolute path to inject, or `undefined` to inject nothing and let rtk decide. */
  path?: string
  /** Set when the configured value could not be used; the command runs unscoped. */
  warning?: string
}

/** Inputs that resolution depends on; injected so tests never touch the real environment. */
export interface HistoryDbEnvironment {
  /**
   * Home directory. Omitting the key reads the real one; passing `undefined`
   * explicitly means "there is none", which is a state a container or a
   * service-managed process can genuinely be in.
   */
  home?: string | undefined
  tmpdir?: string
}

/**
 * Turn the configured value into a database path, or refuse it.
 *
 * Accepted forms:
 *
 * | value | result |
 * |---|---|
 * | `''` / `default` | nothing injected; rtk uses its own default |
 * | `isolated` | `<tmpdir>/dsh-rtk/history.db` — the pre-0.1.3 behavior |
 * | absolute path | used verbatim |
 * | `~/...` | `~` expanded to the home directory |
 *
 * A relative path is refused rather than resolved: resolving it against the
 * process cwd would drop the ledger into whichever project happens to be
 * running, which is exactly the leak the isolation existed to prevent. A
 * refusal is reported as a warning and leaves the command unscoped — it is
 * never a reason to fail a tool call.
 *
 * @param configured - the raw `historyDbPath` setting.
 * @param environment - home and temp directories, defaulted from the process.
 * @returns the path to inject, if any, and any warning explaining a refusal.
 */
export function resolveHistoryDbPath(
  configured: string | undefined,
  environment: HistoryDbEnvironment = {},
): HistoryDbResolution {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw === '' || DEFAULT_SENTINELS.has(raw.toLowerCase())) return {}

  const temporary = environment.tmpdir ?? tmpdir()

  if (raw.toLowerCase() === ISOLATED_HISTORY_DB_PATH) {
    return { path: join(temporary, 'dsh-rtk', 'history.db') }
  }

  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    // Key presence, not truthiness: an explicit `home: undefined` is a real
    // state (a container with no HOME), while an absent key means "ask the OS".
    const home = 'home' in environment ? environment.home : homedir()
    if (!home) {
      return {
        warning: `historyDbPath "${raw}" needs a home directory, and none could be determined; rtk's own database will be used`,
      }
    }
    const rest = raw.slice(1).replace(/^[/\\]/, '')
    return { path: rest === '' ? home : join(home, rest) }
  }

  if (raw.startsWith('~')) {
    // `~someuser/...` is a shell convention this plugin has no reliable way to
    // expand (it is not a filesystem path until a shell resolves it).
    return {
      warning: `historyDbPath "${raw}" uses a "~user" form that cannot be expanded; use an absolute path, or "~/" for your own home directory`,
    }
  }

  // Windows drive paths (`C:\...`) and POSIX absolute paths both reach here.
  if (!isAbsolutePath(raw)) {
    return {
      warning: `historyDbPath "${raw}" is not an absolute path; use an absolute path, a "~/" path, "isolated", or leave it empty to follow rtk's own database`,
    }
  }

  return { path: raw }
}

/** Whether a path is absolute on the platform that produced it. */
function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/')) return true
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}
