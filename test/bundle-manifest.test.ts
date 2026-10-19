import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

/**
 * The bundle channel is a manifest contract, not code: the plugin manager only
 * reads `dsh.bundle.patch` from package.json, and the published tarball must
 * carry the file it names. Those two facts can drift silently — the CLI would
 * install the package as a plain dependency while `npm publish` drops the patch
 * — so they are pinned here.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}

describe('bundle manifest', () => {
  it('declares dsh.bundle.patch', () => {
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  })

  it('publishes the patch file it names', () => {
    // npm matches `files` entries by path prefix; the leading `./` used by the
    // manifest is not how the tarball list is written.
    assert.ok((manifest.files ?? []).includes('cordis.patch.yml'), 'cordis.patch.yml must be listed in package.json "files"')
  })

  it('inserts the plugin row under the package name', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /^- insert:/m, 'the patch must insert a row; other patch forms need an existing id and would be skipped')
    assert.match(patch, /^\s+- id: rtk$/m)
    assert.match(patch, new RegExp(`^\\s+name: '${manifest.name.replace(/[/.]/g, '\\$&')}'$`, 'm'))
  })

  it('keeps machine-specific paths out of the shipped patch', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    // An absolute rtkExecutable baked into the package would only be right on
    // the machine that wrote it; users override it in their profile patch.
    assert.doesNotMatch(patch, /rtkExecutable:\s*[A-Za-z]:\\/)
  })
})
