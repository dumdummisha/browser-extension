import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionIdFromKey } from './extension-id.js'
import { nativeHostManifest } from './launcher.js'

const INSTALLER = fileURLToPath(new URL('install.js', import.meta.url))
// The id of this package's own extension, as the README states it: the installer must not name it for another folder.
const PACKAGE_EXTENSION_ID = 'lkibgdfhoikfdbkhdlnoiajfelcmohjj'
// A public key of the spec's own, so the id the installer prints can only come from the folder it was given.
const FIXTURE_KEY = Buffer.from('misha installer spec public key').toString('base64')
const USAGE = "Usage: install.js <extension folder>, the unpacked extension's folder the user loads into the browser"

interface IScratch {
  // The real path, as the installer's working directory reports it (macOS's temporary folder is behind a symlink).
  readonly root: string
  // A home holding a Chrome profile root, so the installer registers the host there.
  readonly home: string
}

const scratch = async (context: TestContext): Promise<IScratch> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'misha-install-')))
  context.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(join(home, 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true })

  return { root, home }
}

// Runs the installer as a caller does, in the scratch home, with almost no environment.
const runInstaller = (home: string, args: readonly string[], cwd: string): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [INSTALLER, ...args], { cwd, env: { HOME: home }, encoding: 'utf8' })

describe('[host] Installer - extension folder', () => {
  it('should refuse to run without the extension folder, before it writes anything', async (context) => {
    // Arrange
    const { root, home } = await scratch(context)

    // Act
    const run = runInstaller(home, [], root)

    // Assert
    assert.equal(run.status, 1)
    assert.ok(run.stderr.includes(`Error: ${USAGE}`), run.stderr)
    assert.equal(run.stdout, '')
    assert.equal(existsSync(join(home, '.misha')), false)
  })

  it('should refuse a folder that is not an extension, before it writes anything', async (context) => {
    // Arrange
    const { root, home } = await scratch(context)
    const missing = join(root, 'missing')
    const file = join(root, 'file')
    const empty = join(root, 'empty')
    await writeFile(file, '')
    await mkdir(empty)
    const cases = [
      { folder: missing, message: `The extension folder ${missing} is not a directory` },
      { folder: file, message: `The extension folder ${file} is not a directory` },
      { folder: empty, message: `The extension folder ${empty} holds no manifest.json` },
    ]

    // Act
    const runs = cases.map(({ folder }) => runInstaller(home, [folder], root))

    // Assert
    runs.forEach((run, index) => {
      assert.equal(run.status, 1)
      assert.ok(run.stderr.includes(`Error: ${cases[index]?.message}`), run.stderr)
      assert.equal(run.stdout, '')
    })
    assert.equal(existsSync(join(home, '.misha')), false)
  })

  it('should print the folder it was given and register and print the id of that folder', async (context) => {
    // Arrange - the folder named relative to the caller's working directory, as the install-host script names it
    const { root, home } = await scratch(context)
    const folder = join(root, 'shipped', 'extension')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }))
    const id = extensionIdFromKey(FIXTURE_KEY)

    // Act
    const run = runInstaller(home, ['shipped/extension'], root)

    // Assert
    assert.equal(run.status, 0, run.stderr)
    assert.notEqual(id, PACKAGE_EXTENSION_ID)
    assert.ok(run.stdout.includes(`press Return and click Select:\n  ${folder}\n`), run.stdout)
    assert.ok(run.stdout.includes(`Its id must be ${id}.`), run.stdout)
    const hostsDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
    const registered: unknown = JSON.parse(await readFile(join(hostsDir, `${NATIVE_HOST_NAME}.json`), 'utf8'))
    assert.deepEqual(registered, nativeHostManifest(join(home, '.misha', 'browser-bridge', 'native-host'), id))
  })
})
