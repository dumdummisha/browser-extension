import { z } from 'zod'
import type { IToolDefinition } from '../module/tool.js'
import { PluginError } from '../module/tool.js'
import type { BrowserControlService } from './browser-control.js'
import { REF_ARG_DESCRIPTION, TAB_ID_ARG_DESCRIPTION } from './config.js'
import { formatAction } from './tab-format.js'

const input = z.object({
  fields: z
    .array(
      z.object({
        ref: z.number().int().describe(REF_ARG_DESCRIPTION),
        text: z
          .string()
          .optional()
          .describe(
            'Text to type into a text field, replacing what it holds. A line break is typed as Shift+Enter, which a ' +
              'single-line field refuses.'
          ),
        option: z.string().optional().describe('Option label or value to choose in a native select.'),
      })
    )
    .min(1)
    .describe('The fields in the order to fill them; each takes exactly one of text and option.'),
  submitRef: z
    .number()
    .int()
    .optional()
    .describe('Ref of the button to click once every field is filled, such as "Save" or "Sign in".'),
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
})

export const createFillTool = (browser: BrowserControlService): IToolDefinition<typeof input> => ({
  description:
    "Fill several fields of a form in the user's browser in one call, the way tab_type and tab_select_option do one " +
    'each: text fields are clicked, cleared and typed into with the real keyboard, native selects are set. Then, ' +
    'with submitRef, the submit button is clicked with the real mouse. Returns what each field holds and what ' +
    'changed on screen after the submit. Stops at the first field that fails.',
  input,
  execute: async ({ fields, submitRef, tabId }) => {
    for (const { ref, text, option } of fields) {
      if ((text === undefined) === (option === undefined)) {
        throw new PluginError(`Field ${ref} needs exactly one of text and option.`, 'VALIDATION_ERROR')
      }
    }

    const result = await browser.fill(tabId, fields, submitRef)
    const filled = result.fields.map(({ ref, value }) => `- element ${ref}: "${value}"`)
    const submitted = result.action === null ? [] : [`Clicked element ${submitRef}.`, formatAction(result.action)]

    return ['[PASS] Filled the form.', ...filled, ...submitted].join('\n')
  },
})
