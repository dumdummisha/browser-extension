import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { formatSnapshot, formatTab } from './tab-format.js'

const input = z.object({
  url: z.string().describe('Full URL to open, including the scheme, e.g. "https://example.com".'),
  newTab: z
    .boolean()
    .optional()
    .describe('Open in a new tab (true) or replace the page in the active tab (false). Defaults to true.'),
})

export const createOpenTabTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Open a URL in the user's own browser, in a new tab by default, wait up to 10 seconds for it to load and a " +
    'moment more for the page to finish rendering, and return the tab id with the outline of what is on screen, as ' +
    'tab_read gives it, so no read is needed before acting on the page.',
  input,
  execute: async ({ url, newTab: isNewTab = true }) => {
    const { tab, snapshot } = await browser.openTab(url, isNewTab)

    return `[PASS] Opened ${formatTab(tab)}\n\n${formatSnapshot(snapshot)}`
  },
})
