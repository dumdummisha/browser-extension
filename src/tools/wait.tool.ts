import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import {
  PAGE_TEXT_REDACTION_DESCRIPTION,
  TAB_ID_ARG_DESCRIPTION,
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
} from './config.js'

const input = z.object({
  text: z
    .string()
    .min(1)
    .describe('Text to wait for, case-insensitive, as tab_find matches it: part of a label, a button name, a heading.'),
  gone: z
    .boolean()
    .optional()
    .describe('Wait until the text no longer shows, such as a "Loading" message. Defaults to false.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(WAIT_MAX_SECONDS)
    .optional()
    .describe(`How long to wait. Defaults to ${WAIT_DEFAULT_SECONDS}.`),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createWaitTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Wait until a text shows on a page in the user's browser, or with gone until it no longer does: a result that " +
    'loads after a delay, a loading message going away, or the user finishing a step you asked them to do, such as ' +
    `logging in. Returns the lines that mention the text, with refs, as tab_find does. Does not touch the page. ${PAGE_TEXT_REDACTION_DESCRIPTION}`,
  input,
  execute: async ({ text, gone: isGone = false, timeoutSeconds = WAIT_DEFAULT_SECONDS, tabId }) => {
    const matches = await browser.waitFor(tabId, { text, isGone, timeoutMs: timeoutSeconds * 1000 })

    return isGone ? `[PASS] "${text}" no longer shows.` : `[PASS] "${text}" shows:\n${matches.join('\n')}`
  },
})
