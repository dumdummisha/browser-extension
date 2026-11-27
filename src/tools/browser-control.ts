import type { LogicalPoint, Modifier } from 'robot-ts'
import type { BridgeClient } from '../client/bridge-client.js'
import { DRAG_DWELL_DEFAULT_MS, DRAG_HOLD_DEFAULT_MS } from '../desktop/config.js'
import type { InputControlService } from '../desktop/input-control.js'
import { runSubprocess } from '../module/subprocess.js'
import { sleep } from '../module/support.js'
import { PluginError, requireMacOs } from '../module/tool.js'
import type {
  ClientPoint,
  Download,
  FieldContent,
  FieldState,
  NetworkRequest,
  PageChanges,
  PointerState,
  SnapshotScope,
  TabBridgeMethod,
  TabBridgeParams,
  TabBridgeResult,
  TabInfo,
  TabSnapshot,
  TargetPoint,
  WindowTabs,
} from '../protocol/tab.js'
import {
  ACTIVATE_TIMEOUT_MS,
  DOWNLOAD_POLL_INTERVAL_MS,
  DOWNLOAD_TIMEOUT_MS,
  FIELD_FOCUS_TIMEOUT_MS,
  FIELD_SETTLE_INTERVAL_MS,
  FIELD_SETTLE_TIMEOUT_MS,
  FIND_SECTION_LINES,
  FOCUS_POLL_INTERVAL_MS,
  LINE_BREAK,
  OPEN_BIN,
  OPEN_TIMEOUT_MS,
  PAGE_SCAN_MAX_CHARS,
  PAGE_SNAPSHOT_MAX_CHARS,
  POINT_LANDING_TOLERANCE_PX,
  POINTER_GLIDE_MS,
  POINTER_POLL_INTERVAL_MS,
  POINTER_TIMEOUT_MS,
  SAVE_DIALOG_DELAY_MS,
  SAVE_DIALOG_TIMEOUT_MS,
  SCROLL_SETTLE_MS,
  SCROLL_VIEWPORT_FRACTION,
  SETTLE_DELAY_MS,
  VIEWPORT_SNAPSHOT_MAX_CHARS,
  WAIT_POLL_INTERVAL_MS,
} from './config.js'
import { formatFieldContent } from './tab-format.js'
import {
  estimatedViewportOffset,
  type IViewportOffset,
  measuredViewportOffset,
  screenPoint,
} from './viewport-geometry.js'

// The extension's side the tools use: its tab commands and the browser app its native host reported.
export type TabBridge = Pick<BridgeClient, 'tab' | 'browserApp'>

type MouseButton = Parameters<InputControlService['click']>[0]

// An element by its ref, or a point of the viewport in CSS pixels for a page that draws on a canvas (a design tool,
// a map) and so has no element to name.
export type ClickTarget = { ref: number } | { point: ClientPoint }

interface IClickRequest {
  tabId?: number
  target: ClickTarget
  button: MouseButton
  isDoubleClick: boolean
  modifiers: readonly Modifier[]
  waitFor?: IWaitRequest
}

// holdMs is how long the button stays down before the pointer moves, dwellMs how long it rests on the target before
// the release; omitted, they take the desktop drag's defaults.
interface IDragRequest {
  tabId?: number
  from: ClickTarget
  to: ClickTarget
  button: MouseButton
  modifiers: readonly Modifier[]
  holdMs?: number
  dwellMs?: number
}

// Waits until the text shows anywhere on the page, or with isGone until it no longer does.
interface IWaitRequest {
  text: string
  isGone: boolean
  timeoutMs: number
}

// Without a ref the text goes to whatever has the focus in the tab, such as the text a canvas app is editing.
export interface ITypeRequest {
  tabId?: number
  ref?: number
  text: string
  isClearing: boolean
  isSubmitting: boolean
}

// What an action did on screen, so the caller needs no read to see a menu it opened or a page it navigated to, and the
// files it downloaded.
export interface IActionResult {
  tab: TabInfo
  changes: PageChanges
  downloads: Download[]
}

// field is null after a submit, whose effect is in action instead.
export interface ITypeResult {
  field: FieldState | null
  action: IActionResult | null
}

// Exactly one of text and option is set.
interface IFillField {
  ref: number
  text?: string
  option?: string
}

// value is what the field holds as the result shows it: quoted text, or a masked field's length.
interface IFilledField {
  ref: number
  value: string
}

interface IScrollRequest {
  tabId?: number
  ref?: number
  direction: 'up' | 'down'
  pages: number
}

type LandedPointer = PointerState & { position: ClientPoint; pointer: LogicalPoint }

// A measured viewport offset holds while the window keeps its size and the viewport its size and zoom; any of them
// changing means a toolbar, sidebar or developer tools panel moved, and the offset is measured again.
interface IRememberedOffset {
  layout: string
  offset: IViewportOffset
}

const assertInViewport = ({ clientX, clientY, innerWidth, innerHeight }: TargetPoint): void => {
  if (clientX < 0 || clientY < 0 || clientX >= innerWidth || clientY >= innerHeight) {
    throw new PluginError(
      `The point (${clientX}, ${clientY}) is outside the viewport, which is ${innerWidth}x${innerHeight} CSS pixels.`,
      'VALIDATION_ERROR'
    )
  }
}

const viewportLayout = (tab: TabInfo, target: TargetPoint): string =>
  `${tab.windowBounds.width}x${tab.windowBounds.height} ${target.innerWidth}x${target.innerHeight} ${tab.zoom}`

// A field has settled when two reads answer the same revision, which the page gives to one value of one element: the
// value cannot tell, since a password never leaves the page and two different tokens read the same once redacted.
const isSameContent = (first: FieldContent, second: FieldContent): boolean => first.revision === second.revision

const isEmpty = (content: FieldContent): boolean => (content.isMasked ? content.length === 0 : content.value === '')

// The page reports the pointer in whole CSS pixels while the system moves it in points, so a landing a pixel off is on
// the point.
const isAtPoint = (position: ClientPoint, target: ClientPoint): boolean =>
  Math.abs(position.clientX - target.clientX) <= POINT_LANDING_TOLERANCE_PX &&
  Math.abs(position.clientY - target.clientY) <= POINT_LANDING_TOLERANCE_PX

// Reads go through the extension alone. Clicks, typing, key presses and scrolling are real input: the tab is brought
// to the front and the system pointer and keyboard act on it, so the page sees the same trusted events a person makes.
export class BrowserControlService {
  private readonly viewportOffsets = new Map<number, IRememberedOffset>()

  constructor(
    private readonly bridge: TabBridge,
    private readonly input: InputControlService
  ) {}

  public readonly listTabs = (): Promise<WindowTabs[]> => this.call('listTabs', {})

  public readonly activate = async (tabId: number | undefined): Promise<TabInfo> => {
    const tab = await this.call('focusTab', { tabId })
    await this.bringToFront(tab.tabId)

    return tab
  }

  // The extension lets the tab settle first, so an app that renders after its document loads is on screen.
  public readonly openTab = async (
    url: string,
    isNewTab: boolean
  ): Promise<{ tab: TabInfo; snapshot: TabSnapshot }> => {
    const tab = await this.call('openTab', { url, isNewTab })

    return { tab, snapshot: await this.read(tab.tabId, 'viewport') }
  }

  public readonly closeTab = async (tabId: number): Promise<void> => {
    await this.call('closeTab', { tabId })
  }

  // A ref reads only that element's part of the page, the whole of it.
  public readonly read = (tabId: number | undefined, scope: SnapshotScope, ref?: number): Promise<TabSnapshot> =>
    this.call('snapshot', {
      tabId,
      scope: ref === undefined ? scope : 'page',
      ref,
      maxChars: scope === 'page' || ref !== undefined ? PAGE_SNAPSHOT_MAX_CHARS : VIEWPORT_SNAPSHOT_MAX_CHARS,
    })

  public readonly find = (tabId: number | undefined, query: string): Promise<TabBridgeResult<'find'>> =>
    this.call('find', { tabId, query, maxChars: PAGE_SCAN_MAX_CHARS, sectionLines: FIND_SECTION_LINES })

  // Returns the lines that mention the text once it shows, or none once it is gone.
  public readonly waitFor = async (
    tabId: number | undefined,
    { text, isGone, timeoutMs }: IWaitRequest
  ): Promise<string[]> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { matches } = await this.find(tabId, text)
      if ((matches.length === 0) === isGone) {
        return matches
      }
      if (Date.now() >= deadline) {
        throw new PluginError(
          `"${text}" ${isGone ? 'still shows' : 'did not show'} on the page after ${timeoutMs / 1000} seconds.`,
          'TIMEOUT'
        )
      }

      await sleep(WAIT_POLL_INTERVAL_MS)
    }
  }

  // The extension redacts every request as it records it, so none of them carries a credential here.
  public readonly network = (tabId: number | undefined): Promise<{ tabId: number; requests: NetworkRequest[] }> =>
    this.call('network', { tabId })

  // captureVisibleTab captures whichever tab is showing in the window, so the tab is switched to first.
  // The viewport's size in CSS pixels comes with the image, so a point read off the image can be clicked.
  public readonly screenshot = async (
    tabId: number | undefined
  ): Promise<{ tab: TabInfo; dataUrl: string; viewport: Pick<TargetPoint, 'innerWidth' | 'innerHeight'> }> => {
    const tab = await this.call('focusTab', { tabId })
    const { dataUrl } = await this.call('screenshot', { tabId: tab.tabId })
    const { innerWidth, innerHeight } = await this.call('locate', { tabId: tab.tabId })

    return { tab, dataUrl, viewport: { innerWidth, innerHeight } }
  }

  // The mark comes after the element scrolled into view, so the scroll is not reported as the click's doing, and before
  // the pointer moves, so a menu that opens on hover is.
  // With waitFor, what the click started loading is waited for before the changes are taken.
  public readonly click = async ({
    tabId,
    target,
    button,
    isDoubleClick,
    modifiers,
    waitFor,
  }: IClickRequest): Promise<IActionResult> => {
    const tab = await this.activate(tabId)
    const located = await this.locateTarget(tab.tabId, target)
    await this.mark(tab.tabId)
    await this.pointAtTarget(tab, target, located)
    await this.input.click(button, isDoubleClick, modifiers)

    if (waitFor !== undefined) {
      await this.waitFor(tab.tabId, waitFor)
    }

    return this.settle(tab.tabId)
  }

  // Both ends must show at once, in one geometry. Locating an element scrolls it into view only when it is off screen,
  // so the start may scroll into view, but a target that scrolls was off screen with the start showing, and a point
  // read off a screenshot means nothing once anything scrolled: both are refused before the button goes down. The
  // start is confirmed under the pointer by the page, which measures the viewport offset the target's screen point
  // is computed with. The page sees no pointer moves during a native drag and drop, so the landing on the target is
  // not confirmed: the changes the drop made are what the result reports.
  public readonly drag = async ({
    tabId,
    from,
    to,
    button,
    modifiers,
    holdMs = DRAG_HOLD_DEFAULT_MS,
    dwellMs = DRAG_DWELL_DEFAULT_MS,
  }: IDragRequest): Promise<IActionResult> => {
    const tab = await this.activate(tabId)
    const start = await this.locateTarget(tab.tabId, from)
    const end = await this.locateTarget(tab.tabId, to)
    const hasPoint = 'point' in from || 'point' in to
    if (end.hasScrolled || (hasPoint && start.hasScrolled)) {
      throw new PluginError(
        'The drag start and target are not on screen together: bringing one into view scrolled the page. Scroll ' +
          'so both show, or zoom the page out, then take a new tab_screenshot or tab_read and drag again.',
        'VALIDATION_ERROR'
      )
    }
    if (viewportLayout(tab, start) !== viewportLayout(tab, end)) {
      throw new PluginError(
        'The viewport changed size between locating the drag start and the target (a panel or developer tools ' +
          'opened). Drag again once the page is settled.',
        'VALIDATION_ERROR'
      )
    }
    assertInViewport(end)

    await this.mark(tab.tabId)
    // Correcting a missed landing locates the start again, which can scroll it into view after the checks above.
    const pointed = await this.pointAtTarget(tab, from, start)
    if (pointed.hasScrolled || viewportLayout(tab, pointed) !== viewportLayout(tab, end)) {
      throw new PluginError(
        'Pointing at the drag start scrolled the page or changed the viewport, so the target is no longer where it ' +
          'was located. Nothing was dragged; take a new tab_read or tab_screenshot and drag again.',
        'VALIDATION_ERROR'
      )
    }
    const destination = screenPoint(end, this.viewportOffset(tab, end), tab)
    await this.input.drag({ to: destination, button, path: [], modifiers, holdMs, dwellMs })

    return this.settle(tab.tabId)
  }

  public readonly typeInto = async ({
    tabId,
    ref,
    text,
    isClearing,
    isSubmitting,
  }: ITypeRequest): Promise<ITypeResult> => {
    if (ref === undefined) {
      return { field: null, action: await this.typeIntoFocus(tabId, text, isSubmitting) }
    }

    const tab = await this.enterText(tabId, ref, text, isClearing)
    if (isSubmitting) {
      await this.mark(tab.tabId)
      await this.input.pressKey('Enter', [])
      return { field: null, action: await this.settle(tab.tabId) }
    }

    return { field: await this.settledField(tab.tabId, ref), action: null }
  }

  public readonly selectOption = async (
    tabId: number | undefined,
    ref: number,
    option: string
  ): Promise<{ label: string; action: IActionResult }> => {
    const tab = await this.call('focusTab', { tabId })
    await this.mark(tab.tabId)
    const { label } = await this.call('selectOption', { tabId: tab.tabId, ref, option })

    return { label, action: await this.settle(tab.tabId) }
  }

  // Fills the fields in order, then clicks submitRef when one is given; a failing field stops the fill there.
  public readonly fill = async (
    tabId: number | undefined,
    fields: IFillField[],
    submitRef: number | undefined
  ): Promise<{ fields: IFilledField[]; action: IActionResult | null }> => {
    const filled: IFilledField[] = []
    for (const { ref, text, option } of fields) {
      filled.push({ ref, value: await this.fillField(tabId, ref, text, option) })
    }

    const action =
      submitRef === undefined
        ? null
        : await this.click({ tabId, target: { ref: submitRef }, button: 'left', isDoubleClick: false, modifiers: [] })

    return { fields: filled, action }
  }

  public readonly press = async (
    tabId: number | undefined,
    key: string,
    modifiers: string[]
  ): Promise<IActionResult> => {
    const tab = await this.activate(tabId)
    await this.mark(tab.tabId)
    await this.input.pressKey(key, modifiers)

    return this.settle(tab.tabId)
  }

  // The wheel turns over the element, or over the middle of the viewport, so it scrolls whatever a person's wheel
  // would scroll there, inner scroll containers included.
  public readonly scroll = async ({ tabId, ref, direction, pages }: IScrollRequest): Promise<TabSnapshot> => {
    const tab = await this.activate(tabId)
    const target = await this.pointAt(tab, ref, await this.call('locate', { tabId: tab.tabId, ref }))
    const distance = Math.round(target.innerHeight * tab.zoom * SCROLL_VIEWPORT_FRACTION * pages)

    await this.input.scroll(direction === 'down' ? -distance : distance, 'pixels', 0)
    await sleep(SCROLL_SETTLE_MS)

    return this.read(tab.tabId, 'viewport')
  }

  // The native host is registered only in the macOS browser folders, and the input is macOS's.
  private readonly call = <TMethod extends TabBridgeMethod>(
    method: TMethod,
    params: TabBridgeParams<TMethod>
  ): Promise<TabBridgeResult<TMethod>> => {
    requireMacOs('Browser control')

    return this.bridge.tab(method, params)
  }

  private readonly fillField = async (
    tabId: number | undefined,
    ref: number,
    text: string | undefined,
    option: string | undefined
  ): Promise<string> => {
    if (option !== undefined) {
      return `"${(await this.call('selectOption', { tabId, ref, option })).label}"`
    }

    const tab = await this.enterText(tabId, ref, text ?? '', true)

    return formatFieldContent((await this.settledField(tab.tabId, ref)).content)
  }

  // Nothing is clicked, so the focus the page already holds receives the text; line breaks go as Shift+Enter, as in a
  // field.
  private readonly typeIntoFocus = async (
    tabId: number | undefined,
    text: string,
    isSubmitting: boolean
  ): Promise<IActionResult> => {
    const tab = await this.activate(tabId)
    await this.mark(tab.tabId)
    await this.typeLines(text)
    if (isSubmitting) {
      await this.input.pressKey('Enter', [])
    }

    return this.settle(tab.tabId)
  }

  private readonly typeLines = async (text: string): Promise<void> => {
    for (const [index, line] of text.split(LINE_BREAK).entries()) {
      if (index > 0) {
        await this.input.pressKey('Enter', ['Shift'])
      }
      if (line !== '') {
        await this.input.typeText(line)
      }
    }
  }

  // An element is located by the page, which scrolls it into view; a point is a point of the viewport as it is.
  private readonly locateTarget = async (tabId: number, target: ClickTarget): Promise<TargetPoint> => {
    if ('ref' in target) {
      return this.call('locate', { tabId, ref: target.ref })
    }

    return { ...(await this.call('locate', { tabId })), ...target.point }
  }

  // Returns where the pointer ended up: an element's retarget when a missed landing was corrected, else the target.
  private readonly pointAtTarget = async (
    tab: TabInfo,
    target: ClickTarget,
    located: TargetPoint
  ): Promise<TargetPoint> => {
    if ('ref' in target) {
      return this.pointAt(tab, target.ref, located)
    }
    await this.pointAtClientPoint(tab, located)

    return located
  }

  // Clicks the field, waits for it to take the focus, clears it when asked, and types the text with the real keyboard.
  // A line break is typed as Shift+Enter: chat boxes send on Enter, and text areas and editors take Shift+Enter as a
  // new line too. A single-line field has no line breaks, and Enter there submits its form, so it refuses them.
  private readonly enterText = async (
    tabId: number | undefined,
    ref: number,
    text: string,
    isClearing: boolean
  ): Promise<TabInfo> => {
    const tab = await this.activate(tabId)
    await this.pointAt(tab, ref, await this.call('locate', { tabId: tab.tabId, ref }))
    await this.input.click('left', false)
    const field = await this.waitForFieldFocus(tab.tabId, ref)

    const lines = text.split(LINE_BREAK)
    if (lines.length > 1 && !field.isMultiline) {
      throw new PluginError(
        `Element ${ref} is a single-line field, which cannot hold line breaks, so nothing was typed. Type one line; ` +
          'submit=true presses Enter after it.',
        'VALIDATION_ERROR'
      )
    }

    if (isClearing) {
      await this.clearField(tab.tabId, ref)
    }
    await this.typeLines(text)

    return tab
  }

  // macOS lets an app in the background raise its own window only with the user's cooperation, so the browser's
  // window focus is backed by activating its app through Launch Services. Activating the app makes its last key
  // window key, which can be another window of the browser, so the tab's own window is raised again afterwards.
  private readonly bringToFront = async (tabId: number): Promise<void> => {
    if (await this.hasFocus(tabId)) {
      return
    }

    const app = await this.openBrowserApp()
    await this.call('focusTab', { tabId })
    const deadline = Date.now() + ACTIVATE_TIMEOUT_MS
    while (!(await this.hasFocus(tabId))) {
      if (Date.now() > deadline) {
        throw new PluginError(`Tab ${tabId} did not get keyboard focus after ${app} was activated.`, 'TIMEOUT')
      }
      await sleep(FOCUS_POLL_INTERVAL_MS)
    }
  }

  // Activates the browser's app through Launch Services and returns its name.
  private readonly openBrowserApp = async (): Promise<string> => {
    const app = await this.bridge.browserApp()
    if (app === null) {
      throw new PluginError(
        'The browser is not in front, and its native host could not tell which app it is, so it cannot be raised.',
        'INTERNAL_ERROR'
      )
    }

    const { exitCode, stderr } = await runSubprocess({
      command: OPEN_BIN,
      args: ['-a', app],
      timeoutMs: OPEN_TIMEOUT_MS,
      label: 'open',
    })
    if (exitCode !== 0) {
      throw new PluginError(`Could not bring ${app} to the front: ${stderr.trim()}`, 'EXTERNAL_API_ERROR')
    }

    return app
  }

  private readonly hasFocus = async (tabId: number): Promise<boolean> =>
    (await this.call('hasFocus', { tabId })).hasFocus

  // Moves the real pointer onto the element and proves it got there from the page's own mousemove. A miss is corrected
  // once: the observed position fixes an off estimate of where the viewport sits on screen, and the point is chosen
  // again, because some pages and extensions draw over a field only while the pointer hovers it (a password
  // manager's button).
  // The viewport offset measured on a window is reused there until its layout changes, so later moves are exact.
  // target is where locate put the element, which scrolls it into view.
  private readonly pointAt = async (
    tab: TabInfo,
    ref: number | undefined,
    target: TargetPoint
  ): Promise<TargetPoint> => {
    const landed = await this.moveAndRead(tab.tabId, ref, screenPoint(target, this.viewportOffset(tab, target), tab))
    const measured = this.rememberOffset(tab, target, landed)
    if (landed.isOnTarget) {
      return target
    }

    const retarget = await this.call('locate', { tabId: tab.tabId, ref })
    const corrected = await this.moveAndRead(tab.tabId, ref, screenPoint(retarget, measured, tab))
    if (!corrected.isOnTarget) {
      throw new PluginError(`The pointer landed on ${corrected.under} instead of element ${ref}.`, 'NOT_FOUND')
    }

    return retarget
  }

  // A point has no element to confirm the landing on, so the page's own reading of the pointer must be the point. A
  // miss is corrected once with the viewport offset the first landing measured.
  private readonly pointAtClientPoint = async (tab: TabInfo, target: TargetPoint): Promise<void> => {
    const { clientX, clientY } = target
    assertInViewport(target)

    const landed = await this.moveAndRead(
      tab.tabId,
      undefined,
      screenPoint(target, this.viewportOffset(tab, target), tab)
    )
    const measured = this.rememberOffset(tab, target, landed)
    if (isAtPoint(landed.position, target)) {
      return
    }

    const corrected = await this.moveAndRead(tab.tabId, undefined, screenPoint(target, measured, tab))
    if (!isAtPoint(corrected.position, target)) {
      const { position } = corrected
      throw new PluginError(
        `The pointer landed at (${position.clientX}, ${position.clientY}) instead of (${clientX}, ${clientY}).`,
        'NOT_FOUND'
      )
    }
  }

  private readonly viewportOffset = (tab: TabInfo, target: TargetPoint): IViewportOffset => {
    const remembered = this.viewportOffsets.get(tab.windowId)

    return remembered?.layout === viewportLayout(tab, target) ? remembered.offset : estimatedViewportOffset(target, tab)
  }

  private readonly rememberOffset = (tab: TabInfo, target: TargetPoint, landed: LandedPointer): IViewportOffset => {
    const offset = measuredViewportOffset(landed.position, landed.pointer, tab)
    this.viewportOffsets.set(tab.windowId, { layout: viewportLayout(tab, target), offset })

    return offset
  }

  // A smooth move fires mousemove events all along its path, so the reading comes from a one-point nudge once the
  // pointer rests: only events after the nudge show where it stopped, and none come when it stopped outside the page.
  private readonly moveAndRead = async (
    tabId: number,
    ref: number | undefined,
    point: LogicalPoint
  ): Promise<LandedPointer> => {
    await this.input.moveMouse(point, true, POINTER_GLIDE_MS)
    const { seq } = await this.call('pointer', { tabId, ref })
    await this.input.moveMouse({ x: point.x + 1, y: point.y }, false)
    await this.input.moveMouse(point, false)

    return { ...(await this.waitForPointer(tabId, ref, seq)), pointer: point }
  }

  // A smooth move fires many mousemove events; the pointer has arrived once a new one came and no newer one follows.
  private readonly waitForPointer = async (
    tabId: number,
    ref: number | undefined,
    afterSeq: number
  ): Promise<Omit<LandedPointer, 'pointer'>> => {
    const deadline = Date.now() + POINTER_TIMEOUT_MS
    let previousSeq = afterSeq

    while (Date.now() < deadline) {
      await sleep(POINTER_POLL_INTERVAL_MS)
      const state = await this.call('pointer', { tabId, ref })
      const { position } = state
      if (state.seq > afterSeq && state.seq === previousSeq && position !== null) {
        return { ...state, position }
      }
      previousSeq = state.seq
    }

    const { x, y } = await this.input.currentMousePosition()
    throw new PluginError(
      `The pointer at (${Math.round(x)}, ${Math.round(y)}) never reached the page in tab ${tabId}. Another window ` +
        'may cover the browser, or developer tools docked at the bottom or side may shift the page; close them and retry.',
      'NOT_FOUND'
    )
  }

  // Pages and autofill extensions move the focus a moment after a click lands, so it is given a short window.
  private readonly waitForFieldFocus = async (tabId: number, ref: number): Promise<FieldState> => {
    const deadline = Date.now() + FIELD_FOCUS_TIMEOUT_MS
    let field = await this.call('field', { tabId, ref })
    while (!field.isFocused && Date.now() < deadline) {
      await sleep(FOCUS_POLL_INTERVAL_MS)
      field = await this.call('field', { tabId, ref })
    }

    if (!field.isFocused) {
      throw new PluginError(
        `Clicking element ${ref} left the keyboard focus on ${field.focusedElement}, so nothing was typed. ` +
          'Pass the ref of the text field itself from tab_read, or close what took the focus.',
        'VALIDATION_ERROR'
      )
    }

    return field
  }

  private readonly clearField = async (tabId: number, ref: number): Promise<void> => {
    const { length } = await this.call('selectContent', { tabId, ref })
    if (length === 0) {
      return
    }

    await this.input.pressKey('Backspace', [])

    const { content } = await this.settledField(tabId, ref)
    if (!isEmpty(content)) {
      throw new PluginError(
        `Element ${ref} still holds ${formatFieldContent(content)} after selecting its content and pressing Backspace, so nothing was typed.`,
        'EXTERNAL_API_ERROR'
      )
    }
  }

  // The page handles injected keystrokes a moment after they are posted, so a field is read until it stops changing.
  private readonly settledField = async (tabId: number, ref: number): Promise<FieldState> => {
    const deadline = Date.now() + FIELD_SETTLE_TIMEOUT_MS
    let previous = await this.call('field', { tabId, ref })

    while (Date.now() < deadline) {
      await sleep(FIELD_SETTLE_INTERVAL_MS)
      const current = await this.call('field', { tabId, ref })
      if (isSameContent(current.content, previous.content)) {
        return current
      }
      previous = current
    }

    return previous
  }

  private readonly mark = async (tabId: number): Promise<void> => {
    await this.call('mark', { tabId, maxChars: PAGE_SCAN_MAX_CHARS })
  }

  private readonly settle = async (tabId: number): Promise<IActionResult> => {
    await sleep(SETTLE_DELAY_MS)
    const tab = await this.call('settle', { tabId })
    const changes = await this.call('changes', {
      tabId,
      maxChars: PAGE_SCAN_MAX_CHARS,
      viewportMaxChars: VIEWPORT_SNAPSHOT_MAX_CHARS,
    })

    return { tab, changes, downloads: await this.saveDownloads(tabId) }
  }

  // Brave asks where to save each download by default, in a sheet of the browser's own that no page tool reaches. A
  // download the action started that waits there is saved where the sheet proposes: the browser is brought to the
  // front, where the sheet holds the keyboard, and Return accepts it.
  private readonly saveDownloads = async (tabId: number): Promise<Download[]> => {
    const downloads = await this.call('downloads', { tabId, timeoutMs: DOWNLOAD_TIMEOUT_MS })
    if (!downloads.some(({ state }) => state === 'choosingLocation')) {
      return downloads
    }

    await this.openBrowserApp()
    await sleep(SAVE_DIALOG_DELAY_MS)
    await this.input.pressKey('Enter', [])

    // The browser records the chosen place a moment after the sheet closes.
    const deadline = Date.now() + SAVE_DIALOG_TIMEOUT_MS
    let saved = await this.call('downloads', { tabId, timeoutMs: DOWNLOAD_TIMEOUT_MS })
    while (saved.some(({ state }) => state === 'choosingLocation') && Date.now() < deadline) {
      await sleep(DOWNLOAD_POLL_INTERVAL_MS)
      saved = await this.call('downloads', { tabId, timeoutMs: DOWNLOAD_TIMEOUT_MS })
    }

    const unsaved = saved.find(({ state }) => state === 'choosingLocation')
    if (unsaved !== undefined) {
      throw new PluginError(
        `The download of ${unsaved.url} still waits for a place to save it after Return was pressed in the ` +
          "browser's save dialog. Ask the user to save or cancel it.",
        'EXTERNAL_API_ERROR'
      )
    }

    return saved
  }
}
