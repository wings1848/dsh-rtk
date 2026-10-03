import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The harness peer range is a *declaration of support*, and it drifts silently:
 * a new harness rc train (0.1.7-rc.*, 0.2.0-rc.*) always needs a one-line bump,
 * and nothing fails when it is forgotten — the plugin still typechecks and tests
 * green against whatever the devDependency pinned, while `dsh plugin add`
 * reports an unsatisfied peer on the new host. 0.1.1 shipped exactly that way
 * (devDependencies on 0.1.7-rc.2, peers not covering 0.2.0-rc.1).
 *
 * So the guard is: every `@deepseek-ai/dsh-*` devDependency must be matched by
 * the corresponding peer range. Matching is done on the `[major,minor,patch]`
 * tuple, which is the semver rule that matters here — a prerelease range only
 * matches prereleases of its own tuple, so `^0.2.0-rc.1` covers 0.2.0-rc.1,
 * 0.2.0-rc.2 and 0.2.0, while `^0.1.7-rc.2` covers none of them.
 */

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/** `0.2.0-rc.2` -> `0.2.0`; `^4.0.4` -> `4.0.4`. */
function tupleOf(spec: string): string {
  const version = spec.replace(/^[\^~>=<\s=]+/, '').split('-')[0]
  const parts = version.split('.')
  assert.ok(parts.length === 3, `not a plain x.y.z version: ${spec}`)
  return version
}

/** The `[major,minor,patch]` tuples a range's clauses mention. */
function tuplesOf(range: string): string[] {
  return range.split('||').map((clause) => tupleOf(clause.trim()))
}

describe('harness peer range', () => {
  it('covers every dsh package version we build and test against', () => {
    const gaps: string[] = []
    for (const [name, devSpec] of Object.entries(manifest.devDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      const peerRange = manifest.peerDependencies[name]
      assert.ok(peerRange !== undefined, `${name} is a devDependency but not a peerDependency`)
      const wanted = tupleOf(devSpec)
      if (!tuplesOf(peerRange).includes(wanted)) {
        gaps.push(`${name}: devDependency is ${devSpec} but the peer range "${peerRange}" has no ${wanted} clause`)
      }
    }
    assert.deepEqual(gaps, [], gaps.join('\n'))
  })

  it('keeps one shared range across the dsh packages', () => {
    const ranges = new Set(
      Object.entries(manifest.peerDependencies)
        .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
        .map(([, range]) => range),
    )
    assert.equal(ranges.size, 1, `peer ranges drifted apart: ${[...ranges].join(' vs ')}`)
  })
})
