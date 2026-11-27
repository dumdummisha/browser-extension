import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionIdFromKey } from './extension-id.js'

// What the host installer writes, built in one place: the launcher the browser runs to start the native host, and the
// native messaging manifest that registers it. The Misha app imports this (misha-browser/native-host) to recognize
// exactly what the installer wrote for the extension folder it gave the installer, before it removes it, so the two
// never keep separate templates.

// The runtime that runs the native host: the one that ran the installer. A packaged Electron app runs it with its own
// executable as Node (ELECTRON_RUN_AS_NODE=1); a development checkout runs it with the Node that ran the installer.
// The executable is an absolute path, since the browser starts the host with almost no environment.
export type HostRuntime =
  | { readonly kind: 'electron'; readonly executable: string }
  | { readonly kind: 'node'; readonly executable: string }

export interface INativeHostManifest {
  readonly name: typeof NATIVE_HOST_NAME
  readonly description: string
  readonly path: string
  readonly type: 'stdio'
  readonly allowed_origins: readonly [string]
}

// The host's script beside this module, as the runtime that loaded this package resolves it (inside the app's packed
// resources for a packaged app).
export const HOST_SCRIPT = fileURLToPath(new URL('native-host.js', import.meta.url))

const HOST_DESCRIPTION = 'Misha browser bridge'
const ExtensionManifestSchema = z.object({ key: z.string() })

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// The runtime a process runs on, from its process.versions and process.execPath: Electron names its own version there,
// also while it runs as Node.
export const runtimeOf = (versions: NodeJS.ProcessVersions, executable: string): HostRuntime =>
  versions.electron === undefined ? { kind: 'node', executable } : { kind: 'electron', executable }

// The launcher's text for a runtime: a shell script that runs HOST_SCRIPT with it.
export const launcherText = (runtime: HostRuntime): string => {
  if (!isAbsolute(runtime.executable)) {
    throw new Error(`The native host's runtime must be named by an absolute path, not ${runtime.executable}`)
  }

  const command = `exec ${shellQuote(runtime.executable)} ${shellQuote(HOST_SCRIPT)}\n`

  return runtime.kind === 'electron' ? `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n${command}` : `#!/bin/sh\n${command}`
}

// The id of the unpacked extension in extensionDir, which Chrome derives from the public key in its manifest. The key
// is the extension's identity, not signing material. A manifest without one (the store archive's leaves it out) would
// get an id from the folder's path, which nothing here can name, so it is refused.
export const extensionId = (extensionDir: string): string => {
  const manifestPath = join(extensionDir, 'manifest.json')
  const manifest = ExtensionManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (!manifest.success) {
    throw new Error(`${manifestPath} has no public key, so the extension's id would depend on where it is loaded from`)
  }

  return extensionIdFromKey(manifest.data.key)
}

// The native messaging manifest for the launcher at launcherPath. allowed_origins names exactly the extension with
// this id, so no other extension can start the host.
export const nativeHostManifest = (launcherPath: string, id: string): INativeHostManifest => ({
  name: NATIVE_HOST_NAME,
  description: HOST_DESCRIPTION,
  path: launcherPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${id}/`],
})
