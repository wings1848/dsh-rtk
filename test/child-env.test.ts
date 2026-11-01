import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scrubbedEnv } from '../lib/child-env.js'

/**
 * The scrub is the contract with the harness: a child process must not inherit
 * credential-shaped names or harness identity. These cases pin the policy, not
 * the implementation, so a change in the harness heuristic fails here first.
 */
describe('child environment', () => {
  it('drops credential-shaped names and harness identity', () => {
    const previous = { ...process.env }
    process.env['DEEPSEEK_API_KEY'] = 'secret-value'
    process.env['SOME_TOKEN'] = 'token-value'
    process.env['DB_PASSWORD'] = 'password-value'
    process.env['MY_SECRET'] = 'secret'
    process.env['DSH_HOME'] = 'C:/dsh'
    process.env['Dsh_Workspace'] = 'C:/work'
    try {
      const env = scrubbedEnv()
      for (const dropped of ['DEEPSEEK_API_KEY', 'SOME_TOKEN', 'DB_PASSWORD', 'MY_SECRET', 'DSH_HOME', 'Dsh_Workspace']) {
        assert.equal(Object.hasOwn(env, dropped), false, `${dropped} must not reach a child process`)
      }
      assert.equal(env['PATH'], process.env['PATH'], 'PATH must survive so the child CLI can run')
      assert.equal(Object.hasOwn(env, 'PATH'), true)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
      Object.assign(process.env, previous)
    }
  })

  it('keeps explicitly forwarded entries', () => {
    const env = scrubbedEnv({ RTK_DB_PATH: '/tmp/history.db' })
    assert.equal(env['RTK_DB_PATH'], '/tmp/history.db')
  })

  it('returns a fresh object, never process.env', () => {
    assert.notEqual(scrubbedEnv(), process.env)
  })
})
