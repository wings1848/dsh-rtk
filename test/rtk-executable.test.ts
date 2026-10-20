import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decideExecutableSetting,
  parseExecutablePath,
  resolveRtkExecutable,
  windowsRtkCandidates,
} from '../lib/rtk-executable.js'

/**
 * The executable resolver's contract.
 *
 * The Windows fallbacks exist because a harness started from a desktop
 * shortcut can carry a PATH that predates the rtk install: WinGet, cargo and
 * Scoop add their shim directory to the *user* PATH, so the process that was
 * already running never sees it. The tests inject the platform, the environment
 * and the existence/verification probes, so they describe that behavior on any
 * host and never depend on an installed rtk.
 */

const NEVER = 'definitely-not-a-resolver-command-xyz'

describe('windowsRtkCandidates', () => {
  it('builds the WinGet, cargo and Scoop locations from the environment', () => {
    const candidates = windowsRtkCandidates({
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    })
    assert.deepEqual(candidates, [
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe',
      'C:\\Users\\me\\.cargo\\bin\\rtk.exe',
      'C:\\Users\\me\\scoop\\shims\\rtk.exe',
    ])
  })

  it('skips the directories the environment does not name', () => {
    assert.deepEqual(windowsRtkCandidates({ USERPROFILE: 'C:\\Users\\me' }), [
      'C:\\Users\\me\\.cargo\\bin\\rtk.exe',
      'C:\\Users\\me\\scoop\\shims\\rtk.exe',
    ])
    assert.deepEqual(windowsRtkCandidates({}), [])
  })
})

describe('parseExecutablePath', () => {
  it('takes the first non-empty line and drops surrounding quotes', () => {
    assert.equal(parseExecutablePath('\r\n"C:\\tools\\rtk.exe"\r\n'), 'C:\\tools\\rtk.exe')
    assert.equal(parseExecutablePath("'/usr/local/bin/rtk'\n"), '/usr/local/bin/rtk')
    assert.equal(parseExecutablePath(''), undefined)
  })
})

describe('resolveRtkExecutable', () => {
  it('uses an existing configured path verbatim', async () => {
    const result = await resolveRtkExecutable({
      configured: 'C:\\tools\\rtk.exe',
      platform: 'win32',
      exists: async () => true,
      verify: async () => assert.fail('a configured path must not be re-verified'),
    })
    assert.equal(result.resolver, 'configured')
    assert.equal(result.command, 'C:\\tools\\rtk.exe')
    assert.equal(result.resolvedPath, 'C:\\tools\\rtk.exe')
  })

  it('falls through a configured path that no longer exists', async () => {
    // An upgrade or uninstall leaves the stored path dangling; the lookup must
    // heal instead of leaving rewriting switched off forever.
    const result = await resolveRtkExecutable({
      configured: 'C:\\gone\\rtk.exe',
      platform: 'win32',
      resolverCommand: NEVER,
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: async (path) => path.endsWith('WinGet\\Links\\rtk.exe'),
      verify: async () => true,
    })
    assert.equal(result.resolver, 'candidate')
    assert.equal(result.resolvedPath, 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe')
    assert.equal(result.warning, undefined)
  })

  it('walks every Windows candidate until one runs', async () => {
    const checked: string[] = []
    const result = await resolveRtkExecutable({
      configured: 'rtk',
      platform: 'win32',
      resolverCommand: NEVER,
      env: { USERPROFILE: 'C:\\Users\\me' },
      exists: async () => true,
      verify: async (path) => {
        checked.push(path)
        return path.includes('.cargo')
      },
    })
    assert.equal(result.resolver, 'candidate')
    assert.equal(result.resolvedPath, 'C:\\Users\\me\\.cargo\\bin\\rtk.exe')
    assert.deepEqual(checked, ['C:\\Users\\me\\.cargo\\bin\\rtk.exe'])
  })

  it('reports a warning when no Windows candidate exists', async () => {
    const result = await resolveRtkExecutable({
      configured: 'rtk',
      platform: 'win32',
      resolverCommand: NEVER,
      env: { USERPROFILE: 'C:\\Users\\me' },
      exists: async () => false,
    })
    assert.equal(result.resolver, 'where')
    assert.equal(result.command, 'rtk')
    assert.equal(result.resolvedPath, undefined)
    assert.match(result.warning ?? '', /could not resolve rtk via where/)
  })

  it('never probes the Windows locations on another platform', async () => {
    const probed: string[] = []
    const result = await resolveRtkExecutable({
      configured: 'rtk',
      platform: 'linux',
      resolverCommand: NEVER,
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: async (path) => {
        probed.push(path)
        return true
      },
      verify: async () => true,
    })
    assert.deepEqual(probed, [], 'a POSIX host has no WinGet directory to inspect')
    assert.equal(result.resolver, 'which')
    assert.equal(result.command, 'rtk')
  })

  it('probes the bare name when the setting is empty', async () => {
    const result = await resolveRtkExecutable({
      configured: '',
      platform: 'linux',
      resolverCommand: NEVER,
    })
    assert.equal(result.command, 'rtk')
    assert.match(result.warning ?? '', /could not resolve rtk/)
  })
})

describe('decideExecutableSetting', () => {
  const DETECTED = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe'

  it('fills a detected path into an empty setting', () => {
    assert.equal(decideExecutableSetting({ current: '', detected: DETECTED, currentMissing: false }), DETECTED)
  })

  it('fills a detected path over the shipped default name', () => {
    assert.equal(decideExecutableSetting({ current: 'rtk', detected: DETECTED, currentMissing: false }), DETECTED)
  })

  it('clears the setting when detection found nothing', () => {
    assert.equal(decideExecutableSetting({ current: 'rtk', currentMissing: false }), '')
  })

  it('leaves an empty setting empty when detection found nothing', () => {
    assert.equal(decideExecutableSetting({ current: '', currentMissing: false }), undefined)
  })

  it('keeps its own earlier write when detection agrees', () => {
    assert.equal(
      decideExecutableSetting({ current: DETECTED, detected: DETECTED, autoWritten: DETECTED, currentMissing: false }),
      undefined,
    )
  })

  it('replaces its own earlier write when the path disappeared', () => {
    assert.equal(
      decideExecutableSetting({ current: DETECTED, autoWritten: DETECTED, currentMissing: true }),
      '',
    )
  })

  it('never overwrites a hand-typed value', () => {
    assert.equal(
      decideExecutableSetting({ current: 'D:\\bin\\rtk.exe', detected: DETECTED, currentMissing: false }),
      undefined,
    )
    assert.equal(decideExecutableSetting({ current: 'rtk-dev', detected: DETECTED, currentMissing: false }), undefined)
  })

  it('heals a hand-typed path that no longer exists', () => {
    assert.equal(
      decideExecutableSetting({ current: 'D:\\gone\\rtk.exe', detected: DETECTED, currentMissing: true }),
      DETECTED,
    )
  })
})
