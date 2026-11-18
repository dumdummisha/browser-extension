import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatAction } from './tab-format.js'

const input = z.object({
  key: z
    .string()
    .describe(
      'Key name: Enter, Escape, Tab, Space, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, ' +
        'F1-F12, a letter or a digit.'
    ),
  modifiers: z
    .array(z.string())
    .optional()
    .describe('Modifiers held for a shortcut: Meta (Command), Control, Alt (Option), Shift. E.g. ["Meta"] with "L".'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createPressTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Press a key or shortcut in the user's browser with the real keyboard, after bringing the tab to the front. It " +
    'goes to whatever has focus there: Escape to close a dialog, Tab to move between fields, Enter to submit, ' +
    'arrows in a list. Returns what changed on screen, or the new screen after a navigation.',
  input,
  execute: async ({ key, modifiers = [], tabId }) => {
    const action = await browser.press(tabId, key, modifiers)

    return `[PASS] Pressed ${[...modifiers, key].join('+')}.\n${formatAction(action)}`
  },
})
