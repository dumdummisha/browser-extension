import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The native host's socket and launcher, in a folder only this user can open, since whoever reaches the socket acts in
// the user's signed-in Slack. The browser starts the host with almost no environment, so the place is fixed.
export const BRIDGE_DIR = join(homedir(), '.misha', 'browser-bridge')
export const SOCKET_PATH = join(BRIDGE_DIR, 'bridge.sock')
export const LAUNCHER_PATH = join(BRIDGE_DIR, 'native-host')

const ROOT_UID = 0
const GROUP_WRITE_BIT = 0o020
const OTHER_WRITE_BIT = 0o002

// An ACL entry that allows something, as macOS's ls -le lists it below the file: " 0: group:everyone allow
// add_file,delete_child". An entry that denies only takes access away, like the one macOS puts on every home folder.
const ACL_ALLOW_ENTRY = /^ *\d+: .* allow /mu

const hasModeBit = (mode: number, bit: number): boolean => Math.floor(mode / bit) % 2 === 1

// chmod leaves a folder's ACL in place, so its mode bits alone do not make it owner-only. Any allow entry is refused,
// the owner's own too, since an owner-only folder needs none.
const refuseAclGrant = (path: string): void => {
  if (ACL_ALLOW_ENTRY.test(execFileSync('/bin/ls', ['-lde', '--', path], { encoding: 'utf8' }))) {
    throw new Error(`${path} has an ACL entry that allows access (ls -le lists it, and chmod -N removes it)`)
  }
}

// Makes dir, created when missing, a folder only this user can open, before anything goes in it. It fails when that
// cannot hold: dir is a symlink or another user's, or its ACL allows access, or its parent is a symlink, belongs to
// neither this user nor root, or lets anyone else write to it by its mode or its ACL, who could then swap dir for a
// folder of their own.
export const ensurePrivateDir = (dir: string): void => {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error(`${dir} needs a POSIX user to own it`)
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const parent = lstatSync(dirname(dir))

  const isParentTrusted =
    parent.isDirectory() &&
    [uid, ROOT_UID].includes(parent.uid) &&
    !hasModeBit(parent.mode, GROUP_WRITE_BIT) &&
    !hasModeBit(parent.mode, OTHER_WRITE_BIT)

  if (!isParentTrusted) {
    throw new Error(`${dirname(dir)} must be a folder of this user or root that nobody else may write to`)
  }

  refuseAclGrant(dirname(dir))

  const folder = lstatSync(dir)
  if (!folder.isDirectory() || folder.uid !== uid) {
    throw new Error(`${dir} must be a folder of this user, not a symlink`)
  }

  refuseAclGrant(dir)
  chmodSync(dir, 0o700)
}
