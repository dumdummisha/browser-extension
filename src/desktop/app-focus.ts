import { z } from 'zod'
import { runSubprocess } from '../module/subprocess.js'
import { sleep } from '../module/support.js'
import { PluginError, requireMacOs } from '../module/tool.js'
import {
  APP_FOCUS_POLL_INTERVAL_MS,
  APP_FOCUS_TIMEOUT_MS,
  APP_SUBPROCESS_TIMEOUT_MS,
  OPEN_BIN,
  OSASCRIPT_BIN,
} from './config.js'

const RunningAppSchema = z.object({
  name: z.string(),
  bundleId: z.string(),
  pid: z.number(),
  isFrontmost: z.boolean(),
  isHidden: z.boolean(),
})

export type RunningApp = z.infer<typeof RunningAppSchema>

interface IFocusResult {
  readonly app: RunningApp
  readonly previous: RunningApp | undefined
}

export const APP_FOCUS_FEATURE = 'App focus'

const HOST_BUNDLE_ID_VARIABLE = '__CFBundleIdentifier'

// Regular apps are the ones with a Dock icon and windows. NSWorkspace answers without an Accessibility or Automation
// grant. An app without a bundle id is left out, because Launch Services activates apps by bundle id.
const LIST_APPS_SCRIPT = `
ObjC.import('AppKit')
const workspace = $.NSWorkspace.sharedWorkspace
const frontmostPid = workspace.frontmostApplication.processIdentifier
JSON.stringify(
  workspace.runningApplications.js
    .filter((app) => app.activationPolicy === $.NSApplicationActivationPolicyRegular && app.bundleIdentifier.js)
    .map((app) => ({
      name: app.localizedName.js,
      bundleId: app.bundleIdentifier.js,
      pid: app.processIdentifier,
      isFrontmost: app.processIdentifier === frontmostPid,
      isHidden: app.hidden,
    }))
)`

// macOS sets this for every process an app bundle starts and children inherit it, so in a terminal it names the
// terminal app. A process launchd started (a background service, for example) may not have it.
export const hostAppBundleId = (): string | undefined => process.env[HOST_BUNDLE_ID_VARIABLE]

export const listRunningApps = async (signal?: AbortSignal): Promise<RunningApp[]> => {
  requireMacOs(APP_FOCUS_FEATURE)

  const { stdout, stderr, exitCode } = await runSubprocess({
    command: OSASCRIPT_BIN,
    args: ['-l', 'JavaScript', '-e', LIST_APPS_SCRIPT],
    timeoutMs: APP_SUBPROCESS_TIMEOUT_MS,
    label: 'osascript',
    signal,
  })

  if (exitCode !== 0) {
    throw new PluginError(`Could not list the running apps: ${stderr.trim()}`, 'EXTERNAL_API_ERROR')
  }

  return z.array(RunningAppSchema).parse(JSON.parse(stdout))
}

// A bundle id matches exactly; a name matches regardless of case.
export const findRunningApp = (apps: readonly RunningApp[], query: string): RunningApp | undefined => {
  const name = query.toLowerCase()

  return apps.find((app) => app.bundleId === query) ?? apps.find((app) => app.name.toLowerCase() === name)
}

// Activates through Launch Services, as the browser module raises its browser, because macOS lets a background
// process bring another app forward only that way. An app whose window is full screen gets its Space switched to.
export const focusApp = async (query: string, signal?: AbortSignal): Promise<IFocusResult> => {
  const apps = await listRunningApps(signal)
  const app = findRunningApp(apps, query)
  if (app === undefined) {
    throw new PluginError(
      `No running app is named "${query}" or has it as its bundle id. Running apps: ` +
        `${apps.map((running) => running.name).join(', ')}.`,
      'NOT_FOUND'
    )
  }

  const previous = apps.find((running) => running.isFrontmost)
  if (previous?.pid === app.pid) {
    return { app, previous }
  }

  const { exitCode, stderr } = await runSubprocess({
    command: OPEN_BIN,
    args: ['-b', app.bundleId],
    timeoutMs: APP_SUBPROCESS_TIMEOUT_MS,
    label: 'open',
    signal,
  })

  if (exitCode !== 0) {
    throw new PluginError(`Could not bring ${app.name} to the front: ${stderr.trim()}`, 'EXTERNAL_API_ERROR')
  }

  const deadline = Date.now() + APP_FOCUS_TIMEOUT_MS

  while ((await listRunningApps(signal)).find((running) => running.isFrontmost)?.pid !== app.pid) {
    if (Date.now() > deadline) {
      throw new PluginError(
        `${app.name} did not become the frontmost app within ${APP_FOCUS_TIMEOUT_MS / 1000}s of being activated.`,
        'TIMEOUT'
      )
    }

    await sleep(APP_FOCUS_POLL_INTERVAL_MS)
  }

  return { app, previous }
}
