import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({})

export const createMouseCurrentPositionTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    "macOS only. Read the mouse cursor's current absolute position in logical coordinates (macOS points, top-left " +
    'origin) without moving it. Use this to confirm a prior macos_mouse_move landed where expected before clicking ' +
    'or dragging. Requires Accessibility permission because it reuses the shared input session.',
  input,
  execute: async () => {
    const { x, y } = await inputControl.currentMousePosition()

    return MarkdownBuilder.create()
      .heading('Current mouse position', 2)
      .field('Logical point', `(${Math.round(x)}, ${Math.round(y)})`)
      .build()
  },
})
