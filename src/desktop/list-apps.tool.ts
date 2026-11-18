import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import type { IToolDefinition } from '../module/tool.js'
import { hostAppBundleId, listRunningApps } from './app-focus.js'
import type { RunningApp } from './app-focus.js'

const input = z.object({})

export const listAppsTool: IToolDefinition<typeof input> = {
  description:
    'macOS only. List the running apps that have windows (name, bundle id, process id), marking the frontmost one ' +
    'and the host, the terminal or app this agent runs in, when macOS reports it. Use it to find the name or bundle ' +
    'id macos_focus_app takes. Needs no macOS permission.',
  input,
  execute: async (_args, { signal }) => {
    const apps = await listRunningApps(signal)
    const host = hostAppBundleId()

    return MarkdownBuilder.create()
      .heading('Running apps', 2)
      .table(
        ['Name', 'Bundle ID', 'PID', 'State'],
        apps.map((app) => [app.name, app.bundleId, String(app.pid), appState(app, host)])
      )
      .build()
  },
}

const appState = (app: RunningApp, host: string | undefined): string =>
  [
    ...(app.isFrontmost ? ['frontmost'] : []),
    ...(app.bundleId === host ? ['host'] : []),
    ...(app.isHidden ? ['hidden'] : []),
  ].join(', ')
