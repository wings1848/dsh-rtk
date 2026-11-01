import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Display metadata is read by the Plugin Manager *without activating the
 * plugin*: a missing `locale/en.json` or icon leaves the row showing a bare
 * package id and default artwork even though everything works. Those files are
 * not code, so nothing breaks when they go missing — these cases are the only
 * guard.
 */
describe('display metadata', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    files?: string[]
  }

  for (const language of ['en', 'zh']) {
    it(`ships locale/${language}.json with a title and a description`, () => {
      const file = join(root, 'locale', `${language}.json`)
      assert.ok(existsSync(file), `${file} must exist`)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
      assert.equal(typeof parsed.meta?.title, 'string')
      assert.ok(String(parsed.meta?.title).trim().length > 0, 'meta.title must not be empty')
      assert.equal(typeof parsed.meta?.description, 'string')
      assert.ok(String(parsed.meta?.description).trim().length > 0, 'meta.description must not be empty')
    })
  }

  it('exports the locale dictionary and the icon', () => {
    const exports = manifest.exports ?? {}
    assert.ok(Object.hasOwn(exports, './locale/*.json'), 'exports must expose ./locale/*.json')
    assert.ok(Object.hasOwn(exports, './icon'), 'exports must expose ./icon')
  })

  it('exports an icon file that is inside the package and under 256 KiB', () => {
    const icon = join(root, 'icon.svg')
    assert.ok(existsSync(icon), 'icon.svg must exist at the package root')
    assert.ok(statSync(icon).size <= 256 * 1024, 'the icon must stay under 256 KiB')
    const exports = manifest.exports ?? {}
    assert.equal(exports['./icon'], './icon.svg')
  })

  it('ships the metadata and every runtime file', () => {
    const files = manifest.files ?? []
    for (const required of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml']) {
      assert.ok(files.includes(required), `files must include ${required}`)
    }
  })
})
