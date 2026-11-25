import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionId, launcherText, nativeHostManifest, runtimeOf } from './launcher.js'
import { BRIDGE_DIR, ensurePrivateDir, LAUNCHER_PATH } from './paths.js'

// Each browser reads native messaging host manifests from its own NativeMessagingHosts folder.
const BROWSER_PROFILE_ROOTS = ['Google/Chrome', 'BraveSoftware/Brave-Browser'].map((root) =>
  join(homedir(), 'Library', 'Application Support', root)
)

const extensionDir = fileURLToPath(new URL('../extension', import.meta.url))

// The launcher runs the host with the runtime that runs this installer (launcher.ts): the Misha app's Electron
// executable as Node, or the Node of a development checkout, named by absolute path. Rerun the installer after an
// upgrade moves it. A launcher already there is removed and written anew, never written through, since a symlink left
// there before the folder was private could point anywhere.
const writeLauncher = (): void => {
  ensurePrivateDir(BRIDGE_DIR)
  rmSync(LAUNCHER_PATH, { force: true })
  writeFileSync(LAUNCHER_PATH, launcherText(runtimeOf(process.versions, process.execPath)), {
    mode: 0o755,
    flag: 'wx',
  })
  process.stdout.write(`  launcher ${LAUNCHER_PATH}\n`)
}

const registerHost = (): void => {
  const roots = BROWSER_PROFILE_ROOTS.filter((candidate) => existsSync(candidate))
  if (roots.length === 0) {
    throw new Error(`Neither Chrome nor Brave keeps a profile here: ${BROWSER_PROFILE_ROOTS.join(', ')}`)
  }

  const manifest = `${JSON.stringify(nativeHostManifest(LAUNCHER_PATH), null, 2)}\n`
  for (const root of roots) {
    const hostsDir = join(root, 'NativeMessagingHosts')
    mkdirSync(hostsDir, { recursive: true })
    writeFileSync(join(hostsDir, `${NATIVE_HOST_NAME}.json`), manifest)
    process.stdout.write(`  host     ${hostsDir}\n`)
  }
}

if (process.platform !== 'darwin') {
  throw new Error(`The native host installer is for macOS, not ${process.platform}`)
}

process.stdout.write('Installing the Misha browser bridge native host\n')
writeLauncher()
registerHost()
process.stdout.write(
  `\nLoad the extension once: open brave://extensions (or chrome://extensions), turn on Developer mode, click ` +
    `"Load unpacked" and pick ${extensionDir}. Its id must be ${extensionId()}. Reload any Slack tab that was open.\n`
)
