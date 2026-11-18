import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import { type IToolDefinition, PluginError, requireMacOs } from '../module/tool.js'
import { APP_FOCUS_FEATURE, focusApp, hostAppBundleId } from './app-focus.js'

const input = z.object({
  app: z
    .string()
    .optional()
    .describe(
      'The app to bring to the front: its bundle id (com.apple.Terminal) or its name as macos_list_apps shows it ' +
        '(Terminal, Mail, Brave Browser), matched regardless of case. Omit it to return to the host, the terminal ' +
        'or app this agent runs in.'
    ),
})

export const focusAppTool: IToolDefinition<typeof input> = {
  description:
    'macOS only. Bring a running app to the front, switching to the Space its window is on (a full-screen window ' +
    'has a Space of its own), and wait until it is the frontmost app. Omit app to return to the terminal this ' +
    'agent runs in: do that when a stretch of work that brought another app forward (the tab_* browser tools, ' +
    'another macos_focus_app) is done, and before asking the user anything, so the conversation is back on their ' +
    'screen. Reports the app that was frontmost before, to pass back later. Needs no macOS permission.',
  input,
  execute: async ({ app = hostAppBundleId() }, { signal }) => {
    requireMacOs(APP_FOCUS_FEATURE)
    if (app === undefined) {
      throw new PluginError(
        'macOS did not report which app this agent runs in (its environment has no __CFBundleIdentifier), so pass ' +
          'app; macos_list_apps lists the running apps.',
        'VALIDATION_ERROR'
      )
    }

    const { app: focused, previous } = await focusApp(app, signal)
    if (previous?.pid === focused.pid) {
      return `[PASS] ${focused.name} was already the frontmost app.`
    }

    return MarkdownBuilder.create()
      .text(`[PASS] Focused ${focused.name}`)
      .field('Bundle ID', focused.bundleId)
      .field('Previously frontmost', previous === undefined ? '(none)' : `${previous.name} (${previous.bundleId})`)
      .build()
  },
}
