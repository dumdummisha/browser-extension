import { z } from 'zod'
import { modifiersFromNames } from '../desktop/key-map.js'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { REF_ARG_DESCRIPTION, TAB_ID_ARG_DESCRIPTION, WAIT_DEFAULT_SECONDS } from './config.js'
import { formatAction } from './tab-format.js'
import { clickTarget, describeTarget, MODIFIERS_ARG_DESCRIPTION, POINT_ARG_DESCRIPTION } from './target-args.js'

const input = z.object({
  ref: z.number().int().optional().describe(REF_ARG_DESCRIPTION),
  x: z.number().nonnegative().optional().describe(POINT_ARG_DESCRIPTION),
  y: z.number().nonnegative().optional().describe(POINT_ARG_DESCRIPTION),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Defaults to left.'),
  doubleClick: z.boolean().optional().describe('Double-click instead of a single click. Defaults to false.'),
  modifiers: z.array(z.string()).optional().describe(MODIFIERS_ARG_DESCRIPTION),
  waitFor: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Text the click makes appear after a load the page shows as loading, such as the button of an export being ` +
        `prepared: the result waits up to ${WAIT_DEFAULT_SECONDS} seconds for it before reporting what changed.`
    ),
})

export const createClickTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Click an element of a page in the user's browser with the real mouse. The tab is brought to the front, the " +
    'element is scrolled into view if needed, and the pointer moves onto it and clicks once the page confirms the ' +
    'pointer is over it, so the browser window may sit anywhere on screen. Fails without clicking when something ' +
    'covers the element. Take the ref from tab_read. On a canvas page, click a point instead with x and y, read off ' +
    'tab_screenshot: the page confirms the pointer reached that point before the click. Returns what changed on the ' +
    'page (lines that appeared with +, went with -), or the new screen after a navigation, so a menu or dialog the ' +
    'click opened needs no tab_read; take a tab_screenshot when that leaves you unsure what happened. A download the ' +
    "click starts is saved where the browser's save dialog proposes, and the result names the file.",
  input,
  execute: async ({
    ref,
    x,
    y,
    tabId,
    button = 'left',
    doubleClick: isDoubleClick = false,
    modifiers = [],
    waitFor,
  }) => {
    const target = clickTarget(ref, x, y, 'click target')

    const action = await browser.click({
      target,
      tabId,
      button,
      isDoubleClick,
      modifiers: modifiersFromNames(modifiers),
      waitFor:
        waitFor === undefined ? undefined : { text: waitFor, isGone: false, timeoutMs: WAIT_DEFAULT_SECONDS * 1000 },
    })

    return `[PASS] Clicked ${describeTarget(target)}.\n${formatAction(action)}`
  },
})
