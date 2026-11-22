import { z } from 'zod'

// The tab half of the protocol: what the browser tools ask the extension to do in any tab of the browser, each method
// with its params and its result, as the Slack half declares its own (slack.ts). A page method runs a command inside
// the tab's page (service-worker/page-command.ts), the rest work through the browser's tab, window, download and
// network APIs. URLs and recorded requests leave the extension with their credentials redacted (the service worker's
// request-redaction.ts), and page text with the spans shaped like a known token or key redacted; text the shapes miss
// and screenshots leave as the page shows them.

const TabIdSchema = z.number().int()
const WindowIdSchema = z.number().int()
const RefSchema = z.number().int()
const CharCountSchema = z.number().int().positive()
const CountSchema = z.number().int().nonnegative()

export const SnapshotScopeSchema = z.enum(['viewport', 'page'])

export type SnapshotScope = z.infer<typeof SnapshotScopeSchema>

// In screen points, from the extension's windows API; the page's own window.screenX and outer sizes cannot be trusted,
// because Brave alters them against fingerprinting.
const WindowBoundsSchema = z.strictObject({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
})

export const TabInfoSchema = z.strictObject({
  tabId: TabIdSchema,
  windowId: WindowIdSchema,
  title: z.string(),
  url: z.string(),
  status: z.string(),
  zoom: z.number().positive(),
  windowBounds: WindowBoundsSchema,
})

export type TabInfo = z.infer<typeof TabInfoSchema>

const WindowTabsSchema = z.strictObject({
  windowId: WindowIdSchema,
  isFocused: z.boolean(),
  tabs: z.array(z.strictObject({ tabId: TabIdSchema, title: z.string(), url: z.string(), isActive: z.boolean() })),
})

export type WindowTabs = z.infer<typeof WindowTabsSchema>

// documentId is new with each document the tab loads, so a reload at the same URL still counts as a new page.
export const PageSnapshotSchema = z.strictObject({
  documentId: z.string().min(1),
  title: z.string(),
  url: z.string(),
  scrollY: z.number(),
  scrollHeight: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  outline: z.string(),
  isTruncated: z.boolean(),
})

export type PageSnapshot = z.infer<typeof PageSnapshotSchema>

const ClientPointSchema = z.strictObject({ clientX: z.number(), clientY: z.number() })

export type ClientPoint = z.infer<typeof ClientPointSchema>

// CSS pixels: screen points divided by the tab's zoom. hasScrolled tells that locating the element scrolled it into
// view, which moved everything else on the page.
const TargetPointSchema = z.strictObject({
  innerWidth: z.number(),
  innerHeight: z.number(),
  clientX: z.number(),
  clientY: z.number(),
  hasScrolled: z.boolean(),
})

export type TargetPoint = z.infer<typeof TargetPointSchema>

// seq counts the mousemove events the page has seen; position is the last one's.
const PointerStateSchema = z.strictObject({
  seq: CountSchema,
  position: ClientPointSchema.nullable(),
  isOnTarget: z.boolean(),
  under: z.string(),
})

export type PointerState = z.infer<typeof PointerStateSchema>

// A field's revision names the value the page read and the element it read it from: the same while that element holds
// that value, new for every other value or element in the document. A caller tells when typing has settled by it,
// since the value itself cannot tell: a masked field's value (a password) never leaves the page, only its length, and
// an ordinary value leaves the service worker with its known credential shapes redacted, so two different tokens, in
// one field or in two fields a wrapper's ref reads in turn, can read the same.
const FieldContentSchema = z.discriminatedUnion('isMasked', [
  z.strictObject({ isMasked: z.literal(false), value: z.string(), revision: CountSchema }),
  z.strictObject({ isMasked: z.literal(true), length: CountSchema, revision: CountSchema }),
])

export type FieldContent = z.infer<typeof FieldContentSchema>

// isMultiline: a text area or rich text editor, which takes line breaks; an input does not.
const FieldStateSchema = z.strictObject({
  isFocused: z.boolean(),
  focusedElement: z.string(),
  content: FieldContentSchema,
  isMultiline: z.boolean(),
})

export type FieldState = z.infer<typeof FieldStateSchema>

const PageMatchesSchema = z.strictObject({ matches: z.array(z.string()), isTruncated: z.boolean() })

// A line find answers: a line of the page's outline, a line of the section a matching heading titles (by its index
// among the sections and its line in that section's outline), or how many more lines that section has.
const PageFindMatchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('line'), line: CountSchema }),
  z.strictObject({ kind: z.literal('sectionLine'), section: CountSchema, line: CountSchema }),
  z.strictObject({ kind: z.literal('moreLines'), count: CountSchema }),
])

export type PageFindMatch = z.infer<typeof PageFindMatchSchema>

// What find reads in the page: the whole page's outline it searched and the outline of each section a matching heading
// titles, as lines, and its matches as places in them. The service worker answers the matching lines from the outlines
// redacted whole, so a line keeps the context a credential's shape spans (a private key's BEGIN line above a body line).
const PageFindSchema = z.strictObject({
  outline: z.array(z.string()),
  sections: z.array(z.array(z.string())),
  matches: z.array(PageFindMatchSchema),
  isTruncated: z.boolean(),
})

export type PageFind = z.infer<typeof PageFindSchema>

// What changed since mark: the lines of the page's outline that appeared and went, wherever they are on the page, so
// lines that only scrolled into view are not changes. A new document, or a new URL in the same one, counts as a
// navigation and carries the new on-screen outline instead, without the lines the previous page had too (a site's
// menu), which repeatedLineCount counts.
const PageChangesSchema = z.discriminatedUnion('isNavigated', [
  z.strictObject({ isNavigated: z.literal(true), snapshot: PageSnapshotSchema, repeatedLineCount: CountSchema }),
  z.strictObject({ isNavigated: z.literal(false), added: z.array(z.string()), removed: z.array(z.string()) }),
])

export type PageChanges = z.infer<typeof PageChangesSchema>

// A file the browser downloaded since an action began. choosingLocation: the browser waits for the user to choose where
// to save it, and filename is still empty. error says why an interrupted download stopped.
const DownloadSchema = z.strictObject({
  url: z.string(),
  filename: z.string(),
  state: z.enum(['choosingLocation', 'receiving', 'interrupted', 'complete']),
  bytesReceived: CountSchema,
  error: z.string().nullable(),
})

export type Download = z.infer<typeof DownloadSchema>

const RequestHeaderSchema = z.strictObject({ name: z.string(), value: z.string() })

// A fetch or XHR request a tab sent, as webRequest shows it to the extension, credentials redacted: what went out and
// the status that came back, never the response body. statusCode and error are both null while it is in flight.
export const NetworkRequestSchema = z.strictObject({
  startedAt: z.number(),
  method: z.string(),
  url: z.string(),
  body: z.string().nullable(),
  isBodyTruncated: z.boolean(),
  headers: z.array(RequestHeaderSchema),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
})

export type NetworkRequest = z.infer<typeof NetworkRequestSchema>

// A method's schemas typed by its name, so code generic in the method keeps that method's own params and result.
interface IMethodSchemas<TParams, TParamsInput, TResult> {
  readonly params: z.ZodType<TParams, TParamsInput>
  readonly result: z.ZodType<TResult>
}

type MethodSchemas<TMethods extends Record<string, { params: z.ZodType; result: z.ZodType }>> = {
  readonly [TMethod in keyof TMethods]: IMethodSchemas<
    z.output<TMethods[TMethod]['params']>,
    z.input<TMethods[TMethod]['params']>,
    z.output<TMethods[TMethod]['result']>
  >
}

const pageMethods = {
  snapshot: {
    params: z.strictObject({ scope: SnapshotScopeSchema, maxChars: CharCountSchema, ref: RefSchema.optional() }),
    result: PageSnapshotSchema,
  },
  find: {
    params: z.strictObject({ query: z.string().min(1), maxChars: CharCountSchema, sectionLines: CountSchema }),
    result: PageFindSchema,
  },
  locate: { params: z.strictObject({ ref: RefSchema.optional() }), result: TargetPointSchema },
  pointer: { params: z.strictObject({ ref: RefSchema.optional() }), result: PointerStateSchema },
  field: { params: z.strictObject({ ref: RefSchema }), result: FieldStateSchema },
  selectOption: {
    params: z.strictObject({ ref: RefSchema, option: z.string() }),
    result: z.strictObject({ label: z.string() }),
  },
  selectContent: { params: z.strictObject({ ref: RefSchema }), result: z.strictObject({ length: CountSchema }) },
  hasFocus: { params: z.strictObject({}), result: z.strictObject({ hasFocus: z.boolean() }) },
} as const

// The commands a page runs, each with its params and its result. The service worker hands a command to the page and
// checks what the page answers against the result.
export const PAGE_METHODS: MethodSchemas<typeof pageMethods> = pageMethods

export type PageMethod = keyof typeof pageMethods
export type PageResult<TMethod extends PageMethod> = z.infer<(typeof pageMethods)[TMethod]['result']>

export type PageCommand = {
  [TMethod in PageMethod]: { method: TMethod; params: z.infer<(typeof pageMethods)[TMethod]['params']> }
}[PageMethod]

// What a page command answers: its result, or the message it failed with.
export const PageOutcomeSchema = z.discriminatedUnion('isOk', [
  z.strictObject({ isOk: z.literal(true), value: z.unknown() }),
  z.strictObject({ isOk: z.literal(false), error: z.string() }),
])

export type PageOutcome = z.infer<typeof PageOutcomeSchema>

// A page method's params as the tools send them: without a tabId it runs in the active tab of the last focused window.
const inTab = <TShape extends z.ZodRawShape>(
  params: z.ZodObject<TShape, z.core.$strict>
): z.ZodObject<TShape & { tabId: z.ZodOptional<z.ZodNumber> }, z.core.$strict> =>
  z.strictObject({ ...params.shape, tabId: TabIdSchema.optional() })

const tabBridgeMethods = {
  listTabs: { params: z.strictObject({}), result: z.array(WindowTabsSchema) },
  focusTab: { params: z.strictObject({ tabId: TabIdSchema.optional() }), result: TabInfoSchema },
  openTab: { params: z.strictObject({ url: z.string().min(1), isNewTab: z.boolean() }), result: TabInfoSchema },
  closeTab: { params: z.strictObject({ tabId: TabIdSchema }), result: z.strictObject({ tabId: TabIdSchema }) },
  mark: {
    params: z.strictObject({ tabId: TabIdSchema, maxChars: CharCountSchema }),
    result: z.strictObject({ lineCount: CountSchema }),
  },
  settle: { params: z.strictObject({ tabId: TabIdSchema }), result: TabInfoSchema },
  changes: {
    params: z.strictObject({ tabId: TabIdSchema, maxChars: CharCountSchema, viewportMaxChars: CharCountSchema }),
    result: PageChangesSchema,
  },
  downloads: {
    params: z.strictObject({ tabId: TabIdSchema, timeoutMs: CountSchema }),
    result: z.array(DownloadSchema),
  },
  screenshot: {
    params: z.strictObject({ tabId: TabIdSchema }),
    result: z.strictObject({ dataUrl: z.string().startsWith('data:image/jpeg;base64,') }),
  },
  network: {
    params: z.strictObject({ tabId: TabIdSchema.optional() }),
    result: z.strictObject({ tabId: TabIdSchema, requests: z.array(NetworkRequestSchema) }),
  },
  snapshot: {
    params: inTab(pageMethods.snapshot.params),
    result: z.strictObject({ ...PageSnapshotSchema.shape, tabId: TabIdSchema }),
  },
  find: { params: inTab(pageMethods.find.params), result: PageMatchesSchema },
  locate: { params: inTab(pageMethods.locate.params), result: pageMethods.locate.result },
  pointer: { params: inTab(pageMethods.pointer.params), result: pageMethods.pointer.result },
  field: { params: inTab(pageMethods.field.params), result: pageMethods.field.result },
  selectOption: { params: inTab(pageMethods.selectOption.params), result: pageMethods.selectOption.result },
  selectContent: { params: inTab(pageMethods.selectContent.params), result: pageMethods.selectContent.result },
  hasFocus: { params: inTab(pageMethods.hasFocus.params), result: pageMethods.hasFocus.result },
} as const

// The tab methods of the extension. mark notes the page's outline before an action and changes compares the page
// against it afterwards; settle waits for the requests the action started and for the page to stop changing; downloads
// waits up to timeoutMs while a download the action started is still receiving, and lists them all; network lists the
// requests the tab sent since the extension started, oldest first, up to the per-tab limit.
export const TAB_BRIDGE_METHODS: MethodSchemas<typeof tabBridgeMethods> = tabBridgeMethods

export type TabBridgeMethod = keyof typeof tabBridgeMethods
export type TabBridgeParams<TMethod extends TabBridgeMethod> = z.input<(typeof tabBridgeMethods)[TMethod]['params']>
export type TabBridgeResult<TMethod extends TabBridgeMethod> = z.infer<(typeof tabBridgeMethods)[TMethod]['result']>
export type TabSnapshot = TabBridgeResult<'snapshot'>
