#!/usr/bin/env node
/**
 * Publish the browser half.
 *
 * `dsh-client-modules` serves the file package.json `exports["./client"]` names,
 * and it must already exist before the host boots. The client half is written
 * as a finished module-loader bundle (it has to be, because the host resolves
 * that wrapper itself), so this step only copies it into `lib/` after checking
 * the wrapper's id still matches the package name.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = await readFile(join(root, 'src', 'client', 'client.js'), 'utf8')

const expectedId = `id: '${manifest.name}',`
if (!source.includes(expectedId)) {
  throw new Error(`src/client/client.js must register under ${expectedId} (found in its ModuleLoader wrapper)`)
}
if (manifest.dsh?.client?.platform !== 'web') {
  throw new Error('package.json dsh.client.platform must be "web"')
}

await mkdir(join(root, 'lib', 'client'), { recursive: true })
await writeFile(join(root, 'lib', 'client.js'), source)
console.log('build-client: lib/client.js')
