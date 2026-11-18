import { z } from 'zod'
import { DRAG_DWELL_DEFAULT_MS, DRAG_HOLD_DEFAULT_MS, DRAG_PAUSE_MAX_MS } from '../desktop/config.js'
import { modifiersFromNames } from '../desktop/key-map.js'
import type { IToolDefinition } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatAction } from './tab-format.js'
import { clickTarget, describeTarget, MODIFIERS_ARG_DESCRIPTION, POINT_ARG_DESCRIPTION } from './target-args.js'

const coordinate = z.number().nonnegative().optional()

const input = z.object({
  fromRef: z.number().int().optional().describe('Ref of the element to drag, from tab_read.'),
  fromX: coordinate.describe(`Start point x. ${POINT_ARG_DESCRIPTION}`),
  fromY: coordinate.describe('Start point y, with fromX.'),
  toRef: z.number().int().optional().describe('Ref of the element to drop on, from tab_read.'),
  toX: coordinate.describe(`Target point x. ${POINT_ARG_DESCRIPTION}`),
  toY: coordinate.describe('Target point y, with toX.'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Defaults to left.'),
  modifiers: z.array(z.string()).optional().describe(MODIFIERS_ARG_DESCRIPTION),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(DRAG_PAUSE_MAX_MS)
    .optional()
    .describe(
      `Milliseconds the button stays down before the pointer moves. Defaults to ${DRAG_HOLD_DEFAULT_MS}; give 300 ` +
        'to 600 for a list that starts a drag only after a long press.'
    ),
  dwellMs: z
    .number()
    .int()
    .min(0)
    .max(DRAG_PAUSE_MAX_MS)
    .optional()
    .describe(
      `Milliseconds the pointer rests on the target before the release. Defaults to ${DRAG_DWELL_DEFAULT_MS}; give ` +
        '300 or more for a target that reacts to hovering (a sortable list making room).'
    ),
})

export const createDragTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Drag in a page of the user's browser with the real mouse: from an element or a point to an element or a " +
    'point, for drag and drop, sortable lists, sliders, and moving or resizing on a canvas. The tab is brought to the ' +
    'front and the page confirms the pointer is on the start before the button goes down. Both ends must be on ' +
    'screen together. Returns what changed on the page. Take refs from tab_read, points from tab_screenshot.',
  input,
  execute: async ({
    fromRef,
    fromX,
    fromY,
    toRef,
    toX,
    toY,
    tabId,
    button = 'left',
    modifiers = [],
    holdMs,
    dwellMs,
  }) => {
    const from = clickTarget(fromRef, fromX, fromY, 'drag start')
    const to = clickTarget(toRef, toX, toY, 'drag target')
    const action = await browser.drag({
      tabId,
      from,
      to,
      button,
      modifiers: modifiersFromNames(modifiers),
      holdMs,
      dwellMs,
    })
    const held = modifiers.length === 0 ? '' : ` with ${modifiers.join('+')} held`

    return `[PASS] Dragged ${describeTarget(from)} to ${describeTarget(to)}${held}.\n${formatAction(action)}`
  },
})
