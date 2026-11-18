import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'

const input = z.object({
  tabId: z.number().int().describe('Id of the tab to close, from tab_list.'),
})

export const createCloseTabTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Close a tab in the user's browser by its id from tab_list. Close only tabs you opened or were asked to.",
  input,
  execute: async ({ tabId }) => {
    await browser.closeTab(tabId)

    return `[PASS] Closed tab ${tabId}.`
  },
})
