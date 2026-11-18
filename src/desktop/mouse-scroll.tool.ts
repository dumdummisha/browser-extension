import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({
  amount: z
    .number()
    .describe('Vertical scroll amount. Positive scrolls up, negative scrolls down (before OS natural-scroll).'),
  unit: z
    .enum(['lines', 'pixels'])
    .optional()
    .describe('Scroll unit. Defaults to lines (safe everywhere); pixels needs high-resolution scroll support.'),
  horizontal: z
    .number()
    .optional()
    .describe('Horizontal amount. Positive scrolls right, negative left. Defaults to 0.'),
})

export const createMouseScrollTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Scroll at the current cursor position. Vertical amount is required (positive up, negative ' +
    'down); horizontal is optional. Defaults to line units. Requires Accessibility permission.',
  input,
  execute: async ({ amount, unit = 'lines', horizontal = 0 }) => {
    await inputControl.scroll(amount, unit, horizontal)

    return `Scrolled ${amount} ${unit}${horizontal === 0 ? '' : ` and ${horizontal} horizontally`}.`
  },
})
