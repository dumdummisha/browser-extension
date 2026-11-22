import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { LISTED_MATCHES, PAGE_TEXT_REDACTION_DESCRIPTION, TAB_ID_ARG_DESCRIPTION } from './config.js'

const input = z.object({
  text: z.string().min(1).describe('Text to look for, case-insensitive: part of a label, a button name, a heading.'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createFindTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Find controls and text on a page in the user's browser without reading all of it: returns the lines of the whole " +
    'page\'s outline that contain the text, controls with their refs, for example `[80] button "Create"` for "create". ' +
    'A matching heading comes with the start of the section it titles, indented, so searching for a row or section ' +
    `title gives its controls. Cheaper than tab_read on long pages when you know what you are looking for. ${PAGE_TEXT_REDACTION_DESCRIPTION}`,
  input,
  execute: async ({ text, tabId }) => {
    const { matches, isTruncated } = await browser.find(tabId, text)
    if (matches.length === 0) {
      return `Nothing on the page mentions "${text}".`
    }

    const md = MarkdownBuilder.create().text(matches.slice(0, LISTED_MATCHES).join('\n'))
    if (matches.length > LISTED_MATCHES) {
      md.italic(`... and ${matches.length - LISTED_MATCHES} more matches; search for something more specific.`)
    }
    if (isTruncated) {
      md.italic('The page is longer than find scans; the rest was not searched.')
    }

    return md.build()
  },
})
