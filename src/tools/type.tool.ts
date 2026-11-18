import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import { PluginError } from '../module/tool.js'
import type { BrowserControlService, ITypeResult } from './browser-control.js'
import { REF_ARG_DESCRIPTION, TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatAction, formatFieldContent } from './tab-format.js'

const input = z.object({
  ref: z
    .number()
    .int()
    .optional()
    .describe(
      `${REF_ARG_DESCRIPTION} Omit it to type into whatever already has the focus in the tab, such as the text a ` +
        'canvas app (a design tool) is editing after a double-click: nothing is clicked, cleared or checked then, ' +
        'so a line break goes as Shift+Enter whatever has the focus, and the result reports what changed on the page ' +
        "instead of the field's value."
    ),
  text: z
    .string()
    .describe(
      'Text to type. Any characters work: capitals, symbols, accents, emoji. A line break (\\n) is typed as ' +
        'Shift+Enter, which starts a new line in a chat box or text area without sending; with a ref, a ' +
        'single-line field refuses line breaks.'
    ),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
  clear: z
    .boolean()
    .optional()
    .describe(
      'Select and delete what the field holds before typing. Defaults to true with a ref; without one nothing is ' +
        'cleared, and clear=true is refused.'
    ),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter after typing, which usually submits the form. Defaults to false.'),
})

export const createTypeTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Type into a text field of a page in the user's browser with the real mouse and keyboard, or without a ref into " +
    'whatever has the focus (a canvas app editing text). With a ref the field is clicked ' +
    'to focus it, its content is replaced (or appended to with clear=false), and the text is typed, so the page ' +
    'reacts as it would to the user. With a ref it returns the value the field holds afterwards (hidden for ' +
    'passwords), or with submit what changed on screen; without one it always returns what changed on screen. ' +
    "Take the field's ref from tab_read. For several fields at once use tab_fill; for a " +
    'native select dropdown use tab_select_option.',
  input,
  execute: async ({ ref, text, tabId, clear, submit: isSubmitting = false }) => {
    if (ref === undefined && clear === true) {
      throw new PluginError(
        'clear=true needs a ref: without one the text goes to whatever has the focus, and selecting everything there ' +
          'could select a whole canvas. Select the text to replace first (a double-click, or Cmd+A inside the edit).',
        'VALIDATION_ERROR'
      )
    }

    const isClearing = ref !== undefined && clear !== false

    return formatTyped(ref, isSubmitting, await browser.typeInto({ ref, text, tabId, isClearing, isSubmitting }))
  },
})

const formatTyped = (ref: number | undefined, isSubmitting: boolean, { field, action }: ITypeResult): string => {
  const changes = action === null ? '' : formatAction(action)
  if (ref === undefined) {
    return `[PASS] Typed into the focused element${isSubmitting ? ' and pressed Enter' : ''}.\n${changes}`
  }
  if (field === null) {
    return `[PASS] Typed into element ${ref} and pressed Enter.\n${changes}`
  }

  return `[PASS] Typed into element ${ref}, which now holds ${formatFieldContent(field.content)}.`
}
