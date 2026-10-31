import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

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
  /**
   * Platform whose path syntax the value must obey.
   *
   * Not a detail: `C:\data\history.db` looks absolute to a naive check but is
   * an ordinary *relative* filename on Linux, and rtk would create it in the
   * working directory — the exact leak the scoping exists to prevent. So the
   * dialect is matched, not merely sniffed.
   */
  platform?: NodeJS.Platform
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
 * | absolute path (of this platform) | used verbatim |
 * | `~/...` | `~` expanded to the home directory |
 *
 * Two refusals are deliberate and worth the words:
 *
 * - A **relative** path is never resolved. Resolving it against the process cwd
 *   would drop the ledger into whichever project happens to be running.
 * - A **directory** (`~`, `~/`, `/`, `~/.local/share/rtk`) is refused. rtk
 *   treats `RTK_DB_PATH` as a database *file*: handed a directory it exits 0
 *   and writes nowhere, then `rtk gain` reports "unable to open database file".
 *   The ledger is lost with no visible failure, which is worse than a warning.
 *
 * Both refusals are reported as a warning and leave the command unscoped — they
 * are never a reason to fail a tool call.
 *
 * @param configured - the raw `historyDbPath` setting.
 * @param environment - home, temp directory, and platform; defaulted from the process.
 * @returns the path to inject, if any, and the warning explaining a refusal.
 */
export function resolveHistoryDbPath(
  configured: string | undefined,
  environment: HistoryDbEnvironment = {},
): HistoryDbResolution {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw === '' || DEFAULT_SENTINELS.has(raw.toLowerCase())) return {}

  const temporary = environment.tmpdir ?? tmpdir()
  const platform = environment.platform ?? process.platform

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
    // A bare `~` or `~/` resolves to the home directory itself, not a file.
    if (rest === '') {
      return refuseAsDirectory(raw, join(home, 'history.db'))
    }
    return refuseTrailingSeparator(join(home, rest), raw, platform)
  }

  if (raw.startsWith('~')) {
    // `~someuser/...` is a shell convention this plugin has no reliable way to
    // expand (it is not a filesystem path until a shell resolves it).
    return {
      warning: `historyDbPath "${raw}" uses a "~user" form that cannot be expanded; use an absolute path, or "~/" for your own home directory`,
    }
  }

  if (!isAbsoluteForPlatform(raw, platform)) {
    // Windows-style paths are called out separately on POSIX, because "not
    // absolute" undersells the risk: this one would be *accepted by rtk* and
    // written into the working directory as a file literally named `C:\...`.
    const foreign = platform !== 'win32' && (WINDOWS_DRIVE.test(raw) || raw.startsWith('\\\\'))
    return {
      warning: foreign
        ? `historyDbPath "${raw}" is a Windows path, which is a relative filename on ${platform} — rtk would write the ledger into the working directory. Use an absolute ${platform} path.`
        : `historyDbPath "${raw}" is not an absolute path; use an absolute path, a "~/..." path, "isolated", or leave it empty to follow rtk's own database`,
    }
  }

  return refuseTrailingSeparator(raw, raw, platform)
}

/** `C:` drive prefix, which is only absolute on Windows. */
const WINDOWS_DRIVE = /^[A-Za-z]:/

/** Refuse a value that names a directory, suggesting the database file inside it. */
function refuseAsDirectory(raw: string, suggestion: string): HistoryDbResolution {
  return {
    warning: `historyDbPath "${raw}" is a directory, but rtk needs a database file. Use e.g. "${suggestion}".`,
  }
}

/**
 * Whether a path is absolute under a given platform's rules.
 *
 * Delegated to `node:path`'s per-platform implementations rather than a regex,
 * because the rules have corners worth not re-deriving: on Windows a leading
 * `/` *is* absolute (rooted on the current drive) and `C:x` is *not* (drive
 * relative), while on POSIX both are ordinary relative names.
 */
function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value)
}

/**
 * Reject a path that names a directory rather than a database file.
 *
 * A trailing separator is the reliable signal a user meant a directory, and the
 * one case worth catching by inspection: rtk handed a directory exits 0, writes
 * nowhere, and only fails later in `rtk gain` — the ledger silently vanishes.
 * A path that merely *looks* like one (`.../rtk`) is not second-guessed, because
 * creating that file is valid and stat-ing the filesystem on every rewritten
 * command would put I/O on the hot path to answer a question we cannot answer
 * for a path that does not exist yet.
 */
function refuseTrailingSeparator(path: string, raw: string, platform: NodeJS.Platform): HistoryDbResolution {
  const separator = platform === 'win32' ? /[/\\]$/ : /\/$/
  if (separator.test(raw)) return refuseAsDirectory(raw, `${path.replace(/[/\\]$/, '')}/history.db`)
  return { path }
}
