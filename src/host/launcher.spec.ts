import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { temporaryDirectory } from '../module/testing.js'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionId, HOST_SCRIPT, launcherText, nativeHostManifest, runtimeOf } from './launcher.js'

// The id Chrome derives from the public key in the extension's manifest, as the README states it.
const CURRENT_EXTENSION_ID = 'lkibgdfhoikfdbkhdlnoiajfelcmohjj'
// This package's built extension, beside the compiled spec.
const BUILT_EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url))

// A folder whose name needs quoting in a shell, with a stand-in runtime in it that prints the ELECTRON_RUN_AS_NODE it
// was given and the script it was asked to run.
const standInRuntime = async (context: TestContext): Promise<{ dir: string; executable: string }> => {
  const dir = await temporaryDirectory(context, "misha-launcher-it's here ")
  const executable = join(dir, 'runtime')
  await writeFile(executable, '#!/bin/sh\nprintf \'%s|%s\\n\' "$ELECTRON_RUN_AS_NODE" "$1"\n')
  await chmod(executable, 0o755)

  return { dir, executable }
}

// Runs a launcher with almost no environment, as the browser starts the host.
const runLauncher = async (dir: string, text: string): Promise<string> => {
  const launcher = join(dir, 'native-host')
  await writeFile(launcher, text)
  await chmod(launcher, 0o755)

  return execFileSync(launcher, { encoding: 'utf8', env: {} })
}

describe('[host] Launcher - runtime', () => {
  it('should run the host script with Electron as Node for a packaged app', async (context) => {
    // Arrange
    const { dir, executable } = await standInRuntime(context)

    // Act
    const text = launcherText({ kind: 'electron', executable })
    const ran = await runLauncher(dir, text)

    // Assert
    const quoted = executable.replaceAll("'", "'\\''")
    assert.equal(text, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec '${quoted}' '${HOST_SCRIPT}'\n`)
    assert.equal(ran, `1|${HOST_SCRIPT}\n`)
  })

  it('should run the host script with the Node that ran the installer for a development checkout', async (context) => {
    // Arrange
    const { dir, executable } = await standInRuntime(context)

    // Act
    const text = launcherText({ kind: 'node', executable })
    const ran = await runLauncher(dir, text)

    // Assert
    const quoted = executable.replaceAll("'", "'\\''")
    assert.equal(text, `#!/bin/sh\nexec '${quoted}' '${HOST_SCRIPT}'\n`)
    assert.equal(ran, `|${HOST_SCRIPT}\n`)
  })

  it('should refuse a runtime not named by an absolute path', () => {
    // Act + Assert
    assert.throws(() => launcherText({ kind: 'node', executable: 'node' }), {
      message: "The native host's runtime must be named by an absolute path, not node",
    })
  })

  it('should tell Electron, also running as Node, from Node by the versions it names', () => {
    // Act
    const runtimes = [
      runtimeOf({ ...process.versions, electron: '38.0.0' }, '/Applications/Example.app/Contents/MacOS/Example'),
      runtimeOf({ ...process.versions, electron: undefined }, '/opt/example/bin/node'),
    ]

    // Assert
    assert.deepEqual(runtimes, [
      { kind: 'electron', executable: '/Applications/Example.app/Contents/MacOS/Example' },
      { kind: 'node', executable: '/opt/example/bin/node' },
    ])
  })
})

describe('[host] Launcher - identity', () => {
  it("should derive the current extension's id from the built manifest's key", () => {
    // Act
    const id = extensionId(BUILT_EXTENSION_DIR)

    // Assert
    assert.equal(id, CURRENT_EXTENSION_ID)
  })

  it('should refuse an extension whose manifest has no public key', async (context) => {
    // Arrange - a manifest like the store archive's, which leaves the key out
    const dir = await temporaryDirectory(context, 'misha-extension-')
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Example' }))

    // Act + Assert
    assert.throws(() => extensionId(dir), {
      message: `${join(dir, 'manifest.json')} has no public key, so the extension's id would depend on where it is loaded from`,
    })
  })

  it('should register the launcher for exactly the extension with the given id', () => {
    // Act
    const manifest = nativeHostManifest('/tmp/example-home/.misha/browser-bridge/native-host', CURRENT_EXTENSION_ID)

    // Assert
    assert.deepEqual(manifest, {
      name: NATIVE_HOST_NAME,
      description: 'Misha browser bridge',
      path: '/tmp/example-home/.misha/browser-bridge/native-host',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CURRENT_EXTENSION_ID}/`],
    })
  })
})
