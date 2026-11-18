import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import { DRAG_DWELL_DEFAULT_MS, DRAG_HOLD_DEFAULT_MS, DRAG_PATH_MAX_POINTS, DRAG_PAUSE_MAX_MS } from './config.js'
import type { InputControlService } from './input-control.js'
import { modifiersFromNames } from './key-map.js'

const point = z.object({
  x: z.number().describe('X in logical points (top-left origin).'),
  y: z.number().describe('Y in logical points (top-left origin).'),
})

const input = z.object({
  x: z.number().describe('Absolute target X in logical points (top-left origin).'),
  y: z.number().describe('Absolute target Y in logical points (top-left origin).'),
  button: z
    .enum(['left', 'right', 'middle'])
    .optional()
    .describe('Which button to hold during the drag. Defaults to left.'),
  path: z
    .array(point)
    .max(DRAG_PATH_MAX_POINTS)
    .optional()
    .describe(
      'Points the pointer passes through, in order, between the start and the target, without stopping: draw a ' +
        'stroke or go around an obstacle. A pause on the way (hovering over a folder until it springs open) is ' +
        'not supported; dwellMs pauses on the final target, then releases. Defaults to a straight line.'
    ),
  modifiers: z
    .array(z.string())
    .optional()
    .describe(
      'Modifiers held for the whole drag: Shift (constrain), Alt/Option (duplicate in design tools), Meta/Command, ' +
        'Control. They go down before the button and come up after it.'
    ),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(DRAG_PAUSE_MAX_MS)
    .optional()
    .describe(
      `Milliseconds the button stays down before the pointer moves. Defaults to ${DRAG_HOLD_DEFAULT_MS}; give 300 ` +
        'to 600 for a list or app that starts a drag only after a long press.'
    ),
  dwellMs: z
    .number()
    .int()
    .min(0)
    .max(DRAG_PAUSE_MAX_MS)
    .optional()
    .describe(
      `Milliseconds the pointer rests on the target before the release. Defaults to ${DRAG_DWELL_DEFAULT_MS}; give ` +
        '300 or more for a target that reacts to hovering (a sortable list making room, a folder springing open).'
    ),
})

export const createMouseDragTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Press the mouse button at the current cursor position, drag to an absolute target in logical ' +
    'coordinates, and release. Use for sliders, selections, resizing, drawing and drag-and-drop, optionally through ' +
    'waypoints, with modifiers held, and with pauses after the press and before the release. Position the cursor at ' +
    'the drag start first (macos_mouse_move). Inside a browser tab, tab_drag targets page elements exactly instead. ' +
    'Requires Accessibility permission.',
  input,
  execute: async ({ x, y, button = 'left', path = [], modifiers = [], holdMs, dwellMs }) => {
    await inputControl.drag({
      to: { x, y },
      button,
      path,
      modifiers: modifiersFromNames(modifiers),
      holdMs: holdMs ?? DRAG_HOLD_DEFAULT_MS,
      dwellMs: dwellMs ?? DRAG_DWELL_DEFAULT_MS,
    })
    const held = modifiers.length === 0 ? '' : ` with ${modifiers.join('+')} held`
    const via = path.length === 0 ? '' : ` through ${path.length} point${path.length === 1 ? '' : 's'}`

    return `Dragged (${button}) to (${x}, ${y})${via}${held}.`
  },
})
