import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({
  text: z
    .string()
    .describe('The text to type. Injected as Unicode, so it is layout-independent and handles any characters.'),
})

export const createKeyboardTypeTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Type arbitrary text into the focused element. Injects Unicode directly, so it is layout-independent ' +
    'and correctly produces capitals, symbols, accented letters, and emoji. Use this for entering text; use ' +
    'macos_keyboard_press for named keys (Enter, Tab) and shortcuts. Requires Accessibility permission.',
  input,
  execute: async ({ text }) => {
    await inputControl.typeText(text)

    return `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`
  },
})
