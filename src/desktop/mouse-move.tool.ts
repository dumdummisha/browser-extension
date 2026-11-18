import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({
  x: z.number().describe('Absolute X coordinate in logical points (top-left origin).'),
  y: z.number().describe('Absolute Y coordinate in logical points (top-left origin).'),
  smooth: z
    .boolean()
    .optional()
    .describe('Interpolate the movement over ~300ms instead of teleporting. Defaults to true.'),
})

export const createMouseMoveTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Move the mouse cursor to an absolute position in logical coordinates (macOS points, ' +
    'top-left origin), read off macos_screen_capture or macos_mouse_current_position. Inside the browser, ' +
    'tab_click targets page elements exactly instead. Requires Accessibility permission.',
  input,
  execute: async ({ x, y, smooth: isSmooth = true }) => {
    await inputControl.moveMouse({ x, y }, isSmooth)

    return `Moved mouse to (${x}, ${y}).`
  },
})
