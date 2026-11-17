import { MESSAGE_FIELDS, NEW_MESSAGE_SUBTYPES } from '../protocol/slack-message-fields.js'
import { type SlackMessageFrame } from '../protocol/slack.js'

// A new message from Slack's socket, cut down to the fields the app reads before anything of it leaves the page. It runs
// in the page's observer (extension/observer.ts), and lives with the extension's modules the tests load, since the build
// replaces the compiled extension folder with its bundles.
//
// The page's own scripts share the observer's world and can replace any built-in once they run. So every built-in this
// uses is taken when the module loads, at document_start before them; it reads only properties the parsed frame owns,
// never one a page script put on a prototype; and it writes only into objects it made, where no setter a page script
// defined can run.
const { apply, get: valueAt } = Reflect
const { create, hasOwn } = Object
const { isArray } = Array
const parseJson = JSON.parse
const setHas = Set.prototype.has
const NEW_SUBTYPES: ReadonlySet<unknown> = new Set(NEW_MESSAGE_SUBTYPES)
const FILES_FIELD = 'files' satisfies keyof SlackMessageFrame
const FIELDS: ReadonlySet<string> = new Set([...MESSAGE_FIELDS, FILES_FIELD])

const ownValue = (record: object, key: string): unknown => (hasOwn(record, key) ? valueAt(record, key) : undefined)

const isIn = (set: ReadonlySet<unknown>, value: unknown): boolean => apply(setHas, set, [value])

// A field's value as it may leave the page: a JSON scalar as it is, and null in place of an object or an array, which
// no field but files holds, so the relay's check refuses the frame instead of receiving what was nested there.
const scalarOf = (value: unknown): unknown => (typeof value === 'object' ? null : value)

// The ids of the files a message shares, written over the array the frame was parsed into, which nothing else holds.
// Anything but an array of objects with ids gives a value the relay's check refuses.
const fileIdsOf = (files: unknown): unknown => {
  if (!isArray(files)) {
    return null
  }

  for (let index = 0; index < files.length; index += 1) {
    const file: unknown = files[index]
    files[index] = typeof file === 'object' && file !== null ? { id: scalarOf(ownValue(file, 'id')) } : null
  }

  return files
}

// A message with no subtype, or with one of NEW_MESSAGE_SUBTYPES; presence, typing, an edit or a deletion is not one.
const isNewMessage = (frame: unknown): frame is object =>
  typeof frame === 'object' &&
  frame !== null &&
  !isArray(frame) &&
  ownValue(frame, 'type') === 'message' &&
  (!hasOwn(frame, 'subtype') || isIn(NEW_SUBTYPES, ownValue(frame, 'subtype')))

// The new message a socket message carries, with only the fields the app reads, the ids of its files, and nothing
// else; null for every other frame. It checks no field's value: a frame whose fields Slack moved goes on as it is, for
// the relay's check to refuse loudly rather than lose the message unseen.
export const projectedMessageOf = (text: string): Record<string, unknown> | null => {
  const frame: unknown = parseJson(text)
  if (!isNewMessage(frame)) {
    return null
  }

  const projected = create(null) as Record<string, unknown>
  for (const field in frame) {
    if (hasOwn(frame, field) && isIn(FIELDS, field)) {
      const value = ownValue(frame, field)
      projected[field] = field === FILES_FIELD ? fileIdsOf(value) : scalarOf(value)
    }
  }

  return projected
}
