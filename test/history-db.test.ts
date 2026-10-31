import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ISOLATED_HISTORY_DB_PATH, resolveHistoryDbPath } from '../lib/history-db.js'

/**
 * The rtk usage ledger's location.
 *
 * The plugin used to hard-code `tmpdir()/dsh-rtk/history.db`. That value has
 * two properties nobody asked for: `/tmp` is tmpfs on most Linux distributions,
 * so the ledger resets on every reboot, and it is not the database the user's
 * own `rtk gain` reads (`~/.local/share/rtk/history.db`), so the terminal
 * reports "No tracking data yet" while the agent has been writing hundreds of
 * rows somewhere else. Both halves of that are what these cases pin down.
 */

const OPTIONS = { home: '/home/tester', tmpdir: '/tmp', platform: 'linux' as NodeJS.Platform }

describe('resolveHistoryDbPath', () => {
  it('follows rtk’s own default when nothing is configured', () => {
    // The default must be "do not inject RTK_DB_PATH": rtk already picks the
    // right per-platform location, and any value this plugin invents would only
    // be a second opinion about the same question.
    for (const configured of ['', '   ', 'default', 'DEFAULT']) {
      const resolution = resolveHistoryDbPath(configured, OPTIONS)
      assert.equal(resolution.path, undefined, `"${configured}" must mean "rtk decides"`)
      assert.equal(resolution.warning, undefined)
    }
  })

  it('expands a leading tilde to the home directory', () => {
    assert.equal(resolveHistoryDbPath('~/.local/share/rtk/history.db', OPTIONS).path, '/home/tester/.local/share/rtk/history.db')
    assert.equal(resolveHistoryDbPath('~/ledger.db', OPTIONS).path, '/home/tester/ledger.db')
    // A `~user` form is not this plugin's business to resolve; leave it be.
    assert.equal(resolveHistoryDbPath('~someone/ledger.db', OPTIONS).warning !== undefined, true)
  })

  it('accepts an absolute path verbatim', () => {
    assert.equal(resolveHistoryDbPath('/var/lib/dsh-rtk/history.db', OPTIONS).path, '/var/lib/dsh-rtk/history.db')
  })

  it('keeps the old isolated location available under an explicit name', () => {
    // Backwards compatibility for anyone who wants the ledger kept out of the
    // home directory: `isolated` is exactly the old hard-coded behavior.
    assert.equal(resolveHistoryDbPath('isolated', OPTIONS).path, '/tmp/dsh-rtk/history.db')
    assert.equal(resolveHistoryDbPath('ISOLATED', OPTIONS).path, '/tmp/dsh-rtk/history.db')
  })

  it('refuses a relative path instead of guessing a base directory', () => {
    // Resolving `ledger.db` against the process cwd would put the ledger inside
    // whatever project the user happens to be running in — the exact leak the
    // isolation was introduced to prevent.
    for (const configured of ['ledger.db', './ledger.db', 'data/ledger.db']) {
      const resolution = resolveHistoryDbPath(configured, OPTIONS)
      assert.equal(resolution.path, undefined, `"${configured}" must not be injected`)
      assert.match(String(resolution.warning), /absolute/, 'the refusal must say what a valid value looks like')
    }
  })

  it('treats an unset home directory as unresolvable rather than expanding to a bare path', () => {
    const resolution = resolveHistoryDbPath('~/ledger.db', { tmpdir: '/tmp', home: undefined })
    assert.equal(resolution.path, undefined)
    assert.match(String(resolution.warning), /home/i)
  })

  it('refuses a value that names a directory, because rtk loses the ledger silently', () => {
    // rtk treats RTK_DB_PATH as a database *file*. Handed a directory it exits 0
    // and writes nowhere; `rtk gain` only later says "unable to open database
    // file". Verified against rtk 1.1.0: `RTK_DB_PATH=/tmp/dir rtk ls /` exits 0
    // and leaves /tmp/dir empty. Losing the whole ledger without a visible
    // failure is worse than refusing the value, so these are all refused.
    for (const configured of ['~', '~/', '~\\', '/', '/var/lib/dsh-rtk/', '~/.local/share/rtk/']) {
      const resolution = resolveHistoryDbPath(configured, OPTIONS)
      assert.equal(resolution.path, undefined, `"${configured}" names a directory and must not be injected`)
      assert.match(String(resolution.warning), /directory/, 'the refusal must say the value is a directory')
      assert.match(String(resolution.warning), /history\.db/, 'the refusal must show a usable value')
    }
  })

  it('rejects Windows path syntax on a POSIX platform, where it is a relative filename', () => {
    // `C:\data\history.db` looks absolute to a naive check but is an ordinary
    // relative name on Linux, and rtk would create it in the working directory —
    // verified: cwd gained a file literally named `C:\data\history.db`. That is
    // the working-tree leak the scoping exists to prevent, so the dialect is
    // matched rather than sniffed.
    for (const configured of ['C:\\data\\history.db', '\\\\srv\\share\\history.db']) {
      const resolution = resolveHistoryDbPath(configured, OPTIONS)
      assert.equal(resolution.path, undefined, `"${configured}" must not be injected on Linux`)
      assert.match(String(resolution.warning), /Windows/)
      assert.match(String(resolution.warning), /working directory/, 'the warning must name the actual risk')
    }
  })

  it('accepts the same Windows paths on Windows', () => {
    const windows = { ...OPTIONS, platform: 'win32' as NodeJS.Platform }
    assert.equal(resolveHistoryDbPath('C:\\data\\history.db', windows).path, 'C:\\data\\history.db')
    assert.equal(resolveHistoryDbPath('\\\\srv\\share\\history.db', windows).path, '\\\\srv\\share\\history.db')
    // A drive-relative path is *not* absolute on Windows (`C:x` means "x under
    // the current directory of drive C"), so it is refused there.
    assert.equal(resolveHistoryDbPath('C:data\\history.db', windows).path, undefined)
    // A leading `/` *is* absolute on Windows (rooted on the current drive);
    // node:path's win32 rules say so, and re-deriving that by hand got it wrong.
    assert.equal(resolveHistoryDbPath('/data/history.db', windows).path, '/data/history.db')
  })

  it('refuses POSIX-relative values on Windows', () => {
    const windows = { ...OPTIONS, platform: 'win32' as NodeJS.Platform }
    for (const configured of ['data\\history.db', 'data/history.db']) {
      const resolution = resolveHistoryDbPath(configured, windows)
      assert.equal(resolution.path, undefined, `"${configured}" is relative on Windows`)
      assert.match(String(resolution.warning), /not an absolute path/)
    }
  })

  it('treats a trailing separator as a directory on either platform', () => {
    const windows = { ...OPTIONS, platform: 'win32' as NodeJS.Platform }
    assert.equal(resolveHistoryDbPath('C:\\data\\rtk\\', windows).path, undefined)
    assert.match(String(resolveHistoryDbPath('/var/lib/dsh-rtk/', OPTIONS).warning), /directory/)
  })

  it('publishes the isolated path as a constant so the docs cannot drift', () => {
    assert.equal(ISOLATED_HISTORY_DB_PATH, 'isolated')
  })
})
