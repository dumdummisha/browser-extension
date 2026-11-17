import { homedir } from 'node:os'
import { join } from 'node:path'

// The native host's socket and launcher, in a folder only this user can open, since whoever reaches the socket acts in
// the user's signed-in Slack. The browser starts the host with almost no environment, so the place is fixed.
export const BRIDGE_DIR = join(homedir(), '.misha', 'browser-bridge')
export const SOCKET_PATH = join(BRIDGE_DIR, 'bridge.sock')
export const LAUNCHER_PATH = join(BRIDGE_DIR, 'native-host')
