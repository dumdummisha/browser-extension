import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatTab } from './tab-format.js'

const input = z.object({
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createScreenshotTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Take a screenshot of the visible part of a tab in the user's browser, returned as an image attachment. The tab " +
    'is made active in its window first. Use it when the visual layout matters (charts, images, styling, canvas ' +
    'apps); for text and controls, tab_read is cheaper and gives refs to act on. On a canvas page, click what it ' +
    'shows with tab_click x and y: the result gives the viewport size in CSS pixels to scale image pixels by.',
  input,
  execute: async ({ tabId }) => {
    const { tab, dataUrl, viewport } = await browser.screenshot(tabId)
    const { innerWidth, innerHeight } = viewport

    return {
      text:
        `Screenshot of ${formatTab(tab)} is attached. The viewport is ${innerWidth}x${innerHeight} CSS pixels: a ` +
        `point of the image is at x = image x * ${innerWidth} / image width, y = image y * ${innerHeight} / image ` +
        'height for tab_click.',
      attachments: [{ mime: 'image/jpeg', url: dataUrl, filename: `tab-${tab.tabId}.jpg` }],
    }
  },
})
