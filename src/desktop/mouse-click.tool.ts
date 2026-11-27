import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'
import { modifiersFromNames } from './key-map.js'

const input = z.object({
  button: z.enum(['left', 'right', 'middle']).optional().describe('Which button to click. Defaults to left.'),
  doubleClick: z
    .boolean()
    .optional()
    .describe('Deliver a double-click (reported to the OS as a real double-click). Defaults to false.'),
  modifiers: z
    .array(z.string())
    .optional()
    .describe(
      'Modifiers held during the click: Shift or Meta/Command to extend a selection, Alt/Option, Control. ' +
        'Example: ["Meta"] is a Cmd+click.'
    ),
})

export const createMouseClickTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Click the mouse at its current position. Covers left/right/middle click and double-click via ' +
    'arguments (button, doubleClick, modifiers), so this one tool handles regular click, right-click, double-click ' +
    'and modifier clicks. Move ' +
    'the cursor first with macos_mouse_move. Requires Accessibility permission.',
  input,
  execute: async ({ button = 'left', doubleClick: isDoubleClick = false, modifiers = [] }) => {
    await inputControl.click(button, isDoubleClick, modifiersFromNames(modifiers))

    const held = modifiers.length === 0 ? '' : ` with ${modifiers.join('+')} held`

    return `${isDoubleClick ? 'Double-click' : 'Click'} (${button}) delivered${held}.`
  },
})
