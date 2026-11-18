import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatTab } from './tab-format.js'

const input = z.object({
  tabId: z.number().int().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createSwitchTabTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Show a tab in the user's browser: make it the active tab of its window and bring that window to the front. " +
    'Take the tab id from tab_list.',
  input,
  execute: async ({ tabId }) => `[PASS] Switched to ${formatTab(await browser.activate(tabId))}`,
})
