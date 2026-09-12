import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyRtkHistoryScope,
  isAlreadyRtkCommand,
  resolveRtkRewrite,
  splitLeadingEnvAssignments,
  type RtkRunner,
} from '../lib/rtk-rewrite.js'

/** A runner that answers with a fixed result and records its invocation. */
function stubRunner(result: { code: number; stdout?: string; stderr?: string }): { runner: RtkRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: RtkRunner = async (_command, args) => {
    calls.push([...args])
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { runner, calls }
}

describe('splitLeadingEnvAssignments', () => {
  it('splits a plain assignment run from the command', () => {
    assert.deepEqual(splitLeadingEnvAssignments('FOO=1 ls -la'), { envPrefix: 'FOO=1 ', command: 'ls -la' })
    assert.deepEqual(splitLeadingEnvAssignments('A=1 B=2 git status'), { envPrefix: 'A=1 B=2 ', command: 'git status' })
  })

  it('handles quoted values containing spaces', () => {
    assert.deepEqual(splitLeadingEnvAssignments('MSG="hello world" ls'), { envPrefix: 'MSG="hello world" ', command: 'ls' })
    assert.deepEqual(splitLeadingEnvAssignments("MSG='a b' ls"), { envPrefix: "MSG='a b' ", command: 'ls' })
  })

  it('leaves a command without assignments untouched', () => {
    assert.deepEqual(splitLeadingEnvAssignments('ls -la'), { envPrefix: '', command: 'ls -la' })
  })

  it('treats an unterminated quote as ordinary command text', () => {
    assert.deepEqual(splitLeadingEnvAssignments('FOO="unclosed ls'), { envPrefix: '', command: 'FOO="unclosed ls' })
  })
})

describe('isAlreadyRtkCommand', () => {
  it('recognizes a bare rtk invocation', () => {
    assert.equal(isAlreadyRtkCommand('rtk ls'), true)
    assert.equal(isAlreadyRtkCommand('rtk'), true)
  })

  it('recognizes rtk behind an assignment run', () => {
    assert.equal(isAlreadyRtkCommand('FOO=1 rtk ls'), true)
  })

  it('does not mistake a name that merely starts with rtk', () => {
    assert.equal(isAlreadyRtkCommand('rtkfoo ls'), false)
    assert.equal(isAlreadyRtkCommand('ls -la'), false)
  })
})

describe('applyRtkHistoryScope', () => {
  it('prefixes an isolated history database', () => {
    const scoped = applyRtkHistoryScope('rtk ls', '/tmp/dsh-rtk/history.db', undefined)
    assert.equal(scoped, "export RTK_DB_PATH='/tmp/dsh-rtk/history.db'; rtk ls")
  })

  it('leaves an ambient RTK_DB_PATH alone', () => {
    assert.equal(applyRtkHistoryScope('rtk ls', '/tmp/x.db', '/custom/history.db'), 'rtk ls')
  })

  it('leaves an explicit assignment in the command alone', () => {
    assert.equal(applyRtkHistoryScope('RTK_DB_PATH=/mine.db rtk ls', '/tmp/x.db', undefined), 'RTK_DB_PATH=/mine.db rtk ls')
  })

  it('quotes a path containing a single quote', () => {
    const scoped = applyRtkHistoryScope('rtk ls', "/tmp/it's here.db", undefined)
    assert.equal(scoped, "export RTK_DB_PATH='/tmp/it'\\''s here.db'; rtk ls")
  })
})

describe('resolveRtkRewrite', () => {
  const base = { executable: 'rtk', timeoutMs: 1000 }

  it('reports a rewrite for exit 0 and exit 3', async () => {
    for (const code of [0, 3]) {
      const { runner, calls } = stubRunner({ code, stdout: 'rtk git status\n' })
      const decision = await resolveRtkRewrite('git status', { ...base, runner })
      assert.equal(decision.changed, true)
      assert.equal(decision.rewrittenCommand, 'rtk git status')
      assert.deepEqual(calls[0], ['rewrite', 'git status'])
    }
  })

  it('reports no rewrite for exit 1', async () => {
    const { runner } = stubRunner({ code: 1 })
    const decision = await resolveRtkRewrite('echo hi', { ...base, runner })
    assert.equal(decision.changed, false)
    assert.equal(decision.rewrittenCommand, 'echo hi')
    assert.equal(decision.error, undefined)
  })

  it('surfaces the refusal reason for exit 2', async () => {
    const { runner } = stubRunner({ code: 2, stderr: 'command is denied\n' })
    const decision = await resolveRtkRewrite('rm -rf /', { ...base, runner })
    assert.equal(decision.changed, false)
    assert.equal(decision.error, 'command is denied')
  })

  it('treats empty stdout and an unchanged command as no rewrite', async () => {
    const empty = await resolveRtkRewrite('git status', { ...base, runner: stubRunner({ code: 3 }).runner })
    assert.equal(empty.changed, false)
    assert.equal(empty.error, 'rtk returned empty output')

    const same = await resolveRtkRewrite('rtk ls', { ...base, runner: stubRunner({ code: 3, stdout: 'rtk ls' }).runner })
    assert.equal(same.changed, false)
    assert.equal(same.exitCode, 1)
  })

  it('never spawns for an empty command or an rtk command', async () => {
    const { runner, calls } = stubRunner({ code: 3, stdout: 'rtk ls' })
    await resolveRtkRewrite('   ', { ...base, runner })
    await resolveRtkRewrite('rtk ls -la', { ...base, runner })
    assert.equal(calls.length, 0)
  })

  it('reports a runner failure as an ordinary no-rewrite outcome', async () => {
    const runner: RtkRunner = async () => {
      throw new Error('spawn rtk ENOENT')
    }
    const decision = await resolveRtkRewrite('git status', { ...base, runner })
    assert.equal(decision.changed, false)
    assert.equal(decision.rewrittenCommand, 'git status')
    assert.equal(decision.error, 'spawn rtk ENOENT')
  })
})
