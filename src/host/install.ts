import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionIdFromKey } from './extension-id.js'
import { BRIDGE_DIR, LAUNCHER_PATH } from './paths.js'

const ManifestSchema = z.object({ key: z.string() })

// Each browser reads native messaging host manifests from its own NativeMessagingHosts folder.
const BROWSER_PROFILE_ROOTS = ['Google/Chrome', 'BraveSoftware/Brave-Browser'].map((root) =>
  join(homedir(), 'Library', 'Application Support', root)
)

const extensionDir = fileURLToPath(new URL('../extension', import.meta.url))
const hostScript = fileURLToPath(new URL('native-host.js', import.meta.url))

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// The browser starts the host with almost no environment, so the launcher names this Node binary by absolute path.
// Rerun the installer after a Node upgrade moves it.
const writeLauncher = (): void => {
  mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(LAUNCHER_PATH, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}\n`, {
    mode: 0o755,
  })
  process.stdout.write(`  launcher ${LAUNCHER_PATH}\n`)
}

// allowed_origins names only this extension, so no other extension can start the host.
const registerHost = (extensionId: string): void => {
  const hostManifest = {
    name: NATIVE_HOST_NAME,
    description: 'Misha browser bridge',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
  const roots = BROWSER_PROFILE_ROOTS.filter((candidate) => existsSync(candidate))
  if (roots.length === 0) {
    throw new Error(`Neither Chrome nor Brave keeps a profile here: ${BROWSER_PROFILE_ROOTS.join(', ')}`)
  }

  for (const root of roots) {
    const hostsDir = join(root, 'NativeMessagingHosts')
    mkdirSync(hostsDir, { recursive: true })
    writeFileSync(join(hostsDir, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify(hostManifest, null, 2)}\n`)
    process.stdout.write(`  host     ${hostsDir}\n`)
  }
}

if (process.platform !== 'darwin') {
  throw new Error(`The native host installer is for macOS, not ${process.platform}`)
}

const { key } = ManifestSchema.parse(JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')))
const extensionId = extensionIdFromKey(key)

process.stdout.write('Installing the Misha browser bridge native host\n')
writeLauncher()
registerHost(extensionId)
process.stdout.write(
  `\nLoad the extension once: open brave://extensions (or chrome://extensions), turn on Developer mode, click ` +
    `"Load unpacked" and pick ${extensionDir}. Its id must be ${extensionId}. Reload any Slack tab that was open.\n`
)
