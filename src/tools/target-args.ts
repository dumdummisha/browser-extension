import { PluginError } from '../module/tool.js'
import type { ClickTarget } from './browser-control.js'

export const POINT_ARG_DESCRIPTION =
  'CSS pixels from the top-left corner of the viewport, for a page that draws on a canvas (a design tool, a map) and ' +
  'has no element to name: read the point off a tab_screenshot, scaling its pixels by the viewport width it reports ' +
  "divided by the image's width. Give x and y together, instead of a ref."

export const MODIFIERS_ARG_DESCRIPTION =
  'Modifiers held during the action: Shift, Alt (Option), Meta (Command), Control. E.g. ["Meta"] for a Cmd+click ' +
  'that adds to a selection, ["Alt"] for an Option-drag that duplicates in a design tool.'

// An element by its ref, or a point by x and y; naming both, or one coordinate alone, is refused.
export const clickTarget = (
  ref: number | undefined,
  x: number | undefined,
  y: number | undefined,
  name: string
): ClickTarget => {
  if (ref !== undefined && x === undefined && y === undefined) {
    return { ref }
  }

  if (ref === undefined && x !== undefined && y !== undefined) {
    return { point: { clientX: x, clientY: y } }
  }

  throw new PluginError(`Give the ${name} either as a ref, or as x and y together.`, 'VALIDATION_ERROR')
}

export const describeTarget = (target: ClickTarget): string =>
  'ref' in target ? `element ${target.ref}` : `point (${target.point.clientX}, ${target.point.clientY})`
