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

const OPTIONS = { home: '/home/tester', tmpdir: '/tmp' }

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

  it('publishes the isolated path as a constant so the docs cannot drift', () => {
    assert.equal(ISOLATED_HISTORY_DB_PATH, 'isolated')
  })
})
