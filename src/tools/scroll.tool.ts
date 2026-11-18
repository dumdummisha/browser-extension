import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatSnapshot } from './tab-format.js'

const input = z.object({
  direction: z.enum(['up', 'down']).describe('Which way to scroll.'),
  pages: z
    .number()
    .positive()
    .optional()
    .describe('How far, in screens; each is 80% of the viewport height, so some content stays. Defaults to 1.'),
  ref: z
    .number()
    .int()
    .optional()
    .describe('Ref of a scrollable area from tab_read to scroll inside it. Defaults to the middle of the page.'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createScrollTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Scroll a page in the user's browser with the real mouse wheel, over the middle of the page or over an element, " +
    'and return what is on screen afterwards, in the tab_read format.',
  input,
  execute: async ({ direction, pages = 1, ref, tabId }) =>
    formatSnapshot(await browser.scroll({ direction, pages, ref, tabId })),
})
