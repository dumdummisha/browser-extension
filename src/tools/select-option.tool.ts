import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { REF_ARG_DESCRIPTION, TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatAction } from './tab-format.js'

const input = z.object({
  ref: z.number().int().describe(REF_ARG_DESCRIPTION),
  option: z.string().describe('Visible label (case-insensitive) or value of the option to choose.'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createSelectOptionTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Choose an option in a native <select> dropdown of a page in the user's browser; tab_read lists its options. " +
    'The macOS popup of a native select cannot be driven reliably by the mouse, so this sets the option the way the ' +
    'page would and fires its input and change events. Custom dropdowns built from other elements are not native ' +
    'selects: open them with tab_click and click the option. Returns what changed on screen.',
  input,
  execute: async ({ ref, option, tabId }) => {
    const { label, action } = await browser.selectOption(tabId, ref, option)

    return `[PASS] Selected "${label}" in element ${ref}.\n${formatAction(action)}`
  },
})
