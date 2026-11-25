import { execFileSync } from 'node:child_process'
import { COMPONENT_VERSION } from './component-version.js'
import { SOCKET_PATH } from './paths.js'
import { startNativeHostRelay } from './relay.js'

// The browser launches this host itself, so the parent process is the browser, and its executable sits inside the .app
// bundle a client names to bring the browser to the front.
const detectBrowserApp = (): string | null => {
  const executable = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' })

  return /^(?<app>.+?\.app)\//u.exec(executable.trim())?.groups?.app ?? null
}

await startNativeHostRelay({
  input: process.stdin,
  output: process.stdout,
  socketPath: SOCKET_PATH,
  browserApp: detectBrowserApp(),
  componentVersion: COMPONENT_VERSION,
})
