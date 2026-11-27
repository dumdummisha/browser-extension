import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'

const input = z.object({})

export const createListTabsTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "List every open tab in the user's own browser, grouped by window: tab id, title and URL, with the active tab " +
    'of each window and the focused window marked. Use it to find a tab before tab_switch or tab_read.',
  input,
  execute: async () => {
    const windows = await browser.listTabs()
    const md = MarkdownBuilder.create()

    for (const { windowId, isFocused, tabs } of windows) {
      md.heading(`Window ${windowId}${isFocused ? ' (focused)' : ''}`, 3)

      for (const { tabId, title, url, isActive } of tabs) {
        md.bullet(`[${tabId}]${isActive ? ' (active)' : ''} ${title === '' ? '(untitled)' : title} - ${url}`)
      }
    }

    return windows.length === 0 ? 'No browser windows are open.' : md.build()
  },
})
