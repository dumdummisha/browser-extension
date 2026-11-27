import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { NATIVE_HOST_NAME } from '../protocol/messages.js'
import { extensionId, launcherText, nativeHostManifest, runtimeOf } from './launcher.js'
import { BRIDGE_DIR, ensurePrivateDir, LAUNCHER_PATH } from './paths.js'

// Each browser reads native messaging host manifests from its own NativeMessagingHosts folder.
const BROWSER_PROFILE_ROOTS = ['Google/Chrome', 'BraveSoftware/Brave-Browser'].map((root) =>
  join(homedir(), 'Library', 'Application Support', root)
)

const USAGE = "Usage: install.js <extension folder>, the unpacked extension's folder the user loads into the browser"

// The unpacked extension's folder, named by the caller: only it knows where the folder is on disk (the Misha app runs
// this installer from inside its archive, while it ships the extension as a real folder beside it). The folder is
// what the user is told to load and what the host's one allowed origin is derived from.
const extensionFolderOf = (args: readonly string[]): string => {
  const [argument, ...rest] = args
  if (argument === undefined || rest.length > 0) {
    throw new Error(USAGE)
  }

  const folder = resolve(argument)
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`The extension folder ${folder} is not a directory`)
  }

  if (statSync(join(folder, 'manifest.json'), { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`The extension folder ${folder} holds no manifest.json`)
  }

  return folder
}

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

const registerHost = (id: string): void => {
  const roots = BROWSER_PROFILE_ROOTS.filter((candidate) => existsSync(candidate))
  if (roots.length === 0) {
    throw new Error(`Neither Chrome nor Brave keeps a profile here: ${BROWSER_PROFILE_ROOTS.join(', ')}`)
  }

  const manifest = `${JSON.stringify(nativeHostManifest(LAUNCHER_PATH, id), null, 2)}\n`

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

const extensionFolder = extensionFolderOf(process.argv.slice(2))
const id = extensionId(extensionFolder)

process.stdout.write('Installing the Misha browser bridge native host\n')
writeLauncher()
registerHost(id)

// The "Load unpacked" picker is an NSOpenPanel whose treatsFilePackagesAsDirectories Chromium leaves at its default,
// off (components/remote_cocoa/app_shim/select_file_dialog_bridge.mm), so the user cannot browse into an app there.
process.stdout.write(
  `\nLoad the extension once: open brave://extensions (or chrome://extensions), turn on Developer mode and click ` +
    `"Load unpacked". In the folder picker press Cmd+Shift+G, paste this folder, press Return and click Select:\n` +
    `  ${extensionFolder}\n` +
    `The picker shows an app as a single item it will not open, so for a folder inside an app use Cmd+Shift+G as ` +
    `above or drag the folder from Finder onto the picker. Its id must be ${id}. Reload any Slack tab that was open.\n`
)
