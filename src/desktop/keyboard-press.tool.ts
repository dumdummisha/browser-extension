import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({
  key: z
    .string()
    .describe(
      'The key to press by name: Enter, Escape, Tab, Space, Backspace, Delete, ArrowUp/Down/Left/Right, ' +
        'Home, End, PageUp, PageDown, F1-F12, a letter (A-Z), or a digit (0-9).'
    ),
  modifiers: z
    .array(z.string())
    .optional()
    .describe(
      'Modifiers held around the key to form a shortcut: Control (ctrl), Shift, Alt (option), Meta (cmd/command). ' +
        'Example: key "S" with modifiers ["Meta"] is Cmd+S. On macOS, Meta is Command.'
    ),
})

export const createKeyboardPressTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Press a single named key, optionally as a shortcut chord with modifiers. Use for keys that ' +
    'are not text (Enter, Tab, Escape, arrows, function keys) and for shortcuts like Cmd+S or Cmd+Shift+P. To ' +
    'type words or symbols, use macos_keyboard_type instead. Requires Accessibility permission.',
  input,
  execute: async ({ key, modifiers = [] }) => {
    await inputControl.pressKey(key, modifiers)

    return `Pressed ${[...modifiers, key].join('+')}.`
  },
})
