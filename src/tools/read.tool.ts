import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { PAGE_TEXT_REDACTION_DESCRIPTION, TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatSnapshot } from './tab-format.js'

const input = z.object({
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
  ref: z
    .number()
    .int()
    .optional()
    .describe(
      'Read only one part of the page, whole: the ref of a heading reads the section it titles, the ref of a dialog ' +
        'the dialog, the ref of a control what is inside it. Ignores scope.'
    ),
  scope: z
    .enum(['viewport', 'page'])
    .optional()
    .describe(
      'viewport reads only what is on screen now, as the user sees it; page reads the whole page. Defaults to viewport.'
    ),
})

export const createReadTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Read a page in the user's own browser as a compact outline instead of HTML: headings, visible text, and every " +
    'visible control on its own line with a ref, role, name and state, e.g. `[12] textbox "Email" value="" required` ' +
    'or `[13] button "Sign in"`. Open dialogs come first. Pass those refs to tab_click, tab_type, tab_fill, ' +
    'tab_select_option and tab_scroll; to find one control on a long page, tab_find is cheaper. Reading ' +
    'does not move the mouse or switch tabs. Defaults to what is on screen in the active tab; use scope "page" for ' +
    'the whole page, and tab_screenshot when the look of the page matters, or when the outline leaves you unsure what ' +
    `the user sees (a dialog, a canvas, a page that changed unexpectedly). ${PAGE_TEXT_REDACTION_DESCRIPTION}`,
  input,
  execute: async ({ tabId, ref, scope = 'viewport' }) => formatSnapshot(await browser.read(tabId, scope, ref)),
})
