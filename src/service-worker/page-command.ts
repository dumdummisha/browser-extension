import type {
  ClientPoint,
  FieldContent,
  FieldState,
  PageCommand,
  PageOutcome,
  PageSnapshot,
  PointerState,
  SnapshotScope,
  TargetPoint,
} from '../protocol/tab.js'

interface IPageState {
  documentId: string
  nextRef: number
  refs: WeakMap<Element, number>
  elements: Map<number, WeakRef<Element>>
  isTrackingPointer: boolean
  pointerSeq: number
  pointer: ClientPoint | null
  maskedReads: WeakMap<Element, IMaskedRead>
}

// The value a masked field held when it was last read, and the revision that read answered.
interface IMaskedRead {
  value: string
  revision: number
}

interface IFieldValue {
  value: string
  isMasked: boolean
}

// chrome.scripting.executeScript runs this function in the page from its source text, so it must not reference
// anything outside its own body. Its state lives on the extension's isolated-world globalThis, which lasts as long as
// the document and is invisible to the page's own scripts, so a ref stays valid until the element leaves the page.
export const runPageCommand = (command: PageCommand): PageOutcome => {
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[contenteditable]:not([contenteditable="false"])',
    ...[
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'combobox',
      'textbox',
      'searchbox',
      'slider',
      'spinbutton',
      'treeitem',
    ].map((role) => `[role="${role}"]`),
  ].join(', ')
  // Pages also make whole regions focusable for keyboard scrolling, so tabindex alone marks a control only when the
  // element holds no real controls and is not a container by its tag or role (a tab panel, a scrollable code block).
  const FOCUSABLE_SELECTOR = '[tabindex]:not([tabindex="-1"])'
  const CONTAINER_SELECTOR = [
    'pre',
    'code',
    'section',
    'article',
    'main',
    'aside',
    'nav',
    'table',
    'ul',
    'ol',
    'form',
    'dialog',
    ...['tabpanel', 'region', 'document', 'article', 'list', 'table', 'grid', 'log', 'dialog', 'group'].map(
      (role) => `[role="${role}"]`
    ),
  ].join(', ')
  const REGION_SELECTOR =
    'section, article, form, main, nav, aside, dialog, [role="region"], [role="dialog"], [role="form"], [role="main"]'
  const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
  // Frames other extensions inject (a password manager's menu) are their UI, not the page's.
  const EXTENSION_FRAME_PREFIXES = ['chrome-extension:', 'moz-extension:']
  const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'canvas'])
  const INPUT_ROLES: Record<string, string> = {
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    file: 'file',
  }
  const VALUELESS_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'])
  const TAG_ROLES = new Map([
    ['a', 'link'],
    ['button', 'button'],
    ['select', 'combobox'],
    ['textarea', 'textbox'],
    ['summary', 'button'],
  ])
  const ARIA_STATES = ['aria-checked', 'aria-selected', 'aria-pressed', 'aria-expanded']
  // Where a click may land inside an element, as fractions of its visible box, best first. Off-center points get
  // past what pages and extensions draw inside fields: a password manager's icon, a clear button, a search icon.
  const CLICK_POINT_FRACTIONS = [
    { x: 0.5, y: 0.5 },
    { x: 0.25, y: 0.5 },
    { x: 0.1, y: 0.5 },
    { x: 0.75, y: 0.5 },
    { x: 0.5, y: 0.25 },
    { x: 0.5, y: 0.75 },
  ]
  const NAME_MAX_CHARS = 100
  const VALUE_MAX_CHARS = 80
  const HEADING_MAX_CHARS = 200
  const BRIEF_MAX_CHARS = 40
  const LISTED_OPTIONS = 15

  const host = globalThis as typeof globalThis & { mishaTabState?: IPageState }
  host.mishaTabState ??= {
    documentId: crypto.randomUUID(),
    nextRef: 1,
    refs: new WeakMap(),
    elements: new Map(),
    isTrackingPointer: false,
    pointerSeq: 0,
    pointer: null,
    maskedReads: new WeakMap(),
  }
  const state = host.mishaTabState

  // Icon fonts draw their icons as Private Use Area characters, which carry no meaning as text.
  const collapse = (text: string): string =>
    text
      .replace(/\p{Co}/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()

  const clip = (text: string, maxChars: number): string =>
    text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text

  const textOf = (element: Element): string =>
    collapse(element instanceof HTMLElement ? element.innerText : element.textContent)

  const isInViewport = (rect: DOMRect): boolean =>
    rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth

  const hasArea = (rect: DOMRect): boolean => rect.width > 0 && rect.height > 0

  const isVisible = (element: Element): boolean =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true })

  // Pages keep text and native inputs for screen readers in a box of at most one pixel that clips its content away (a
  // styled radio group's real inputs, a live region); a person never sees it. A zero-size wrapper that lets its content
  // overflow is not clipped and still counts.
  const isScreenReaderOnly = (element: Element): boolean => {
    const { width, height } = element.getBoundingClientRect()
    if (width > 1 || height > 1) {
      return false
    }

    const style = getComputedStyle(element)

    return style.overflow !== 'visible' || style.clip !== 'auto' || style.clipPath !== 'none'
  }

  const refFor = (element: Element): number => {
    const known = state.refs.get(element)
    if (known !== undefined) {
      return known
    }

    const ref = state.nextRef
    state.nextRef += 1
    state.refs.set(element, ref)
    state.elements.set(ref, new WeakRef(element))

    return ref
  }

  const elementFor = (ref: number): Element => {
    const element = state.elements.get(ref)?.deref()
    if (element?.isConnected !== true) {
      throw new Error(`Element ${ref} is not on the page any more. Call tab_read for fresh refs.`)
    }

    return element
  }

  // Walks up through shadow roots to their hosts, which parentNode alone does not.
  const isWithin = (node: Node, ancestor: Node): boolean => {
    for (let current: Node | null = node; current !== null;) {
      if (current === ancestor) {
        return true
      }
      current = current instanceof ShadowRoot ? current.host : current.parentNode
    }

    return false
  }

  const elementAt = (clientX: number, clientY: number): Element | null => {
    let hit = document.elementFromPoint(clientX, clientY)
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(clientX, clientY)
      if (inner === null || inner === hit) {
        break
      }
      hit = inner
    }

    return hit
  }

  const activeElement = (): Element | null => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement
    }

    return active
  }

  // A click on a label lands on its control, so a hit on the label counts as a hit on the control.
  const isHitOn = (hit: Element, element: Element): boolean =>
    isWithin(hit, element) || hit.closest('label')?.control === element

  const brief = (element: Element): string => {
    const id = element.id === '' ? '' : `#${element.id}`
    const text = clip(textOf(element), BRIEF_MAX_CHARS)

    return `<${element.localName}${id}>${text === '' ? '' : ` "${text}"`}`
  }

  // Leaves out the text of the control a label wraps, so a select is not named after its own options.
  const labelText = (label: HTMLLabelElement): string => {
    const { control } = label
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (control === null || !isWithin(node, control)) {
        parts.push(node.textContent ?? '')
      }
    }

    return collapse(parts.join(''))
  }

  const labelOf = (element: Element): string => {
    const isLabelable =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement

    return isLabelable && element.labels !== null ? [...element.labels].map(labelText).join(' ') : ''
  }

  const accessibleName = (element: Element): string => {
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/u)
      .map((id) => document.getElementById(id))
      .filter((label) => label !== null)
      .map(textOf)
      .join(' ')
    const isEntryField =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    const candidates = [
      labelledBy,
      element.getAttribute('aria-label'),
      labelOf(element),
      element instanceof HTMLInputElement && INPUT_ROLES[element.type] === 'button' ? element.value : null,
      element instanceof HTMLImageElement ? element.alt : null,
      isEntryField ? null : textOf(element),
      element.getAttribute('placeholder'),
      element.getAttribute('title'),
      element.querySelector('img[alt]')?.getAttribute('alt'),
      element.querySelector('svg title')?.textContent,
    ]
    const name = candidates.map((candidate) => collapse(candidate ?? '')).find((candidate) => candidate !== '')

    return clip(name ?? '', NAME_MAX_CHARS)
  }

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/u)[0]
    if (explicit !== undefined && explicit !== '') {
      return explicit
    }
    if (element instanceof HTMLInputElement) {
      return INPUT_ROLES[element.type] ?? 'textbox'
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return 'textbox'
    }

    return TAG_ROLES.get(element.localName) ?? element.localName
  }

  // Rich text editors keep a <br> in an empty line so the caret has a place, which innerText reports as a newline (an
  // empty editor reads "\n"), and innerText puts a blank line between paragraphs. An editor made of blocks therefore
  // reads as each block's own text, one per line, as a person sees it.
  const editableText = (element: HTMLElement): string => {
    const isBlockList =
      element.children.length > 0 &&
      [...element.childNodes].every((node) =>
        node instanceof HTMLElement
          ? !getComputedStyle(node).display.startsWith('inline')
          : node instanceof Text && node.data.trim() === ''
      )
    if (isBlockList) {
      return [...element.children]
        .filter((block) => block instanceof HTMLElement)
        .map(editableText)
        .join('\n')
    }

    return element.innerText.replace(/\n+$/u, '')
  }

  const valueOf = (element: Element): IFieldValue | null => {
    if (element instanceof HTMLInputElement) {
      return VALUELESS_INPUT_TYPES.has(element.type)
        ? null
        : { value: element.value, isMasked: element.type === 'password' }
    }
    if (element instanceof HTMLTextAreaElement) {
      return { value: element.value, isMasked: false }
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return { value: editableText(element), isMasked: false }
    }

    return null
  }

  const fieldContent = (element: Element, { value, isMasked }: IFieldValue): FieldContent => {
    if (!isMasked) {
      return { isMasked, value }
    }

    const last = state.maskedReads.get(element)
    const revision = last === undefined ? 0 : last.revision + Number(last.value !== value)
    state.maskedReads.set(element, { value, revision })

    return { isMasked, length: value.length, revision }
  }

  const valueState = ({ value, isMasked }: IFieldValue): string => {
    if (!isMasked) {
      return `value="${clip(collapse(value), VALUE_MAX_CHARS)}"`
    }

    return value === '' ? 'empty' : 'filled'
  }

  const selectStates = (select: HTMLSelectElement): string[] => {
    const labels = [...select.options].map((option) => collapse(option.label))
    const more = labels.length > LISTED_OPTIONS ? ` (+${labels.length - LISTED_OPTIONS} more)` : ''

    return [
      `selected="${collapse(select.selectedOptions[0]?.label ?? '')}"`,
      `options: ${labels.slice(0, LISTED_OPTIONS).join(' | ')}${more}`,
    ]
  }

  const statesOf = (element: Element): string[] => {
    const field = valueOf(element)
    const isToggle = element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
    const states = [
      ...(field === null ? [] : [valueState(field)]),
      ...(isToggle ? [element.checked ? 'checked' : 'unchecked'] : []),
      ...(element instanceof HTMLSelectElement ? selectStates(element) : []),
      ...ARIA_STATES.filter((attribute) => !isToggle || attribute !== 'aria-checked').flatMap((attribute) => {
        const value = element.getAttribute(attribute)

        return value === null ? [] : [`${attribute.slice('aria-'.length)}=${value}`]
      }),
    ]

    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
      states.push('disabled')
    }
    if (element.matches(':required')) {
      states.push('required')
    }
    if (element === activeElement()) {
      states.push('focused')
    }

    return states
  }

  // A label standing in for a control the page hides (a styled checkbox) shows that control's role, name and state,
  // and keeps its own ref, since a click on the label is what toggles the control.
  const describe = (element: Element): string => {
    const subject = element instanceof HTMLLabelElement && element.control !== null ? element.control : element
    const name = accessibleName(subject)

    return [`[${refFor(element)}] ${roleOf(subject)}`, name === '' ? '' : `"${name}"`, ...statesOf(subject)]
      .filter((part) => part !== '')
      .join(' ')
  }

  const isFocusableControl = (element: Element): boolean =>
    element.matches(FOCUSABLE_SELECTOR) && !element.matches(CONTAINER_SELECTOR)

  // cursor is inherited, so only the outermost pointer element of a subtree counts, and a container that holds real
  // controls is walked into instead, so its controls get refs of their own.
  const isInteractive = (element: Element): boolean => {
    if (element.matches(INTERACTIVE_SELECTOR)) {
      return true
    }
    if (element instanceof HTMLLabelElement) {
      return element.control !== null && (!isVisible(element.control) || isScreenReaderOnly(element.control))
    }
    if (isFocusableControl(element)) {
      return element.querySelector(INTERACTIVE_SELECTOR) === null
    }

    const { parentElement } = element
    const isOutermostPointer =
      getComputedStyle(element).cursor === 'pointer' &&
      (parentElement === null || getComputedStyle(parentElement).cursor !== 'pointer')

    return (
      (element.hasAttribute('onclick') || isOutermostPointer) && element.querySelector(INTERACTIVE_SELECTOR) === null
    )
  }

  // The outermost open dialogs, which the outline puts first, since a modal one is all a person can use.
  const openDialogs = (): Element[] => {
    const dialogs = [...document.querySelectorAll(DIALOG_SELECTOR)].filter(
      (dialog) => isVisible(dialog) && hasArea(dialog.getBoundingClientRect())
    )

    return dialogs.filter((dialog) => !dialogs.some((other) => other !== dialog && isWithin(dialog, other)))
  }

  // A dialog is named by its label, or else by its first heading: its whole text, which names a control, is not a name.
  const dialogName = (dialog: Element): string => {
    if (dialog.hasAttribute('aria-label') || dialog.hasAttribute('aria-labelledby')) {
      return accessibleName(dialog)
    }

    const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')

    return heading === null ? '(untitled)' : clip(textOf(heading), NAME_MAX_CHARS)
  }

  const headingLevel = (node: Node): number | null => {
    const level = node instanceof Element ? /^h(?<level>[1-6])$/u.exec(node.localName)?.groups?.level : undefined

    return level === undefined ? null : Number(level)
  }

  const holdsHeadingUpTo = (node: Node, level: number): boolean => {
    if (!(node instanceof Element)) {
      return false
    }

    return [node, ...node.querySelectorAll('h1, h2, h3, h4, h5, h6')].some((candidate) => {
      const candidateLevel = headingLevel(candidate)

      return candidateLevel !== null && candidateLevel <= level
    })
  }

  // A heading stands for the part of the page it titles: the section it is the first heading of, or else the heading
  // and what follows it up to the next heading of the same or a higher level.
  const regionOf = (element: Element): Node[] => {
    const level = headingLevel(element)
    if (level === null) {
      return [element]
    }

    const section = element.closest(REGION_SELECTOR)
    if (section?.querySelector('h1, h2, h3, h4, h5, h6') === element) {
      return [section]
    }

    // Pages often wrap a heading alone in a container, so the section follows the outermost wrapper it ends.
    let anchor: Element = element
    while (anchor.nextElementSibling === null && anchor.parentElement !== null && anchor.parentElement !== section) {
      anchor = anchor.parentElement
    }

    const nodes: Node[] = [anchor]
    for (let next = anchor.nextSibling; next !== null && !holdsHeadingUpTo(next, level); next = next.nextSibling) {
      nodes.push(next)
    }

    return nodes
  }

  // With a ref, only that element's part of the page is read, and dialogs are not listed separately.
  const snapshot = (scope: SnapshotScope, maxChars: number, ref?: number): PageSnapshot => {
    const dialogs = ref === undefined ? openDialogs() : []
    const skipped = new Set(dialogs)
    const lines: string[] = []
    let pending = ''
    let length = 0
    let isTruncated = false

    const push = (line: string): void => {
      if (isTruncated) {
        return
      }
      if (length + line.length > maxChars) {
        isTruncated = true
        return
      }

      lines.push(line)
      length += line.length + 1
    }

    const flush = (): void => {
      const text = collapse(pending)
      pending = ''
      if (text !== '') {
        push(text)
      }
    }

    const isInScope = (rect: DOMRect): boolean => scope === 'page' || isInViewport(rect)

    const isTextInScope = (node: Text): boolean => {
      if (scope === 'page') {
        return true
      }

      const range = document.createRange()
      range.selectNodeContents(node)

      return isInViewport(range.getBoundingClientRect())
    }

    const walkChildren = (element: Element, isTextSuppressed: boolean): void => {
      const children =
        element instanceof HTMLSlotElement
          ? element.assignedNodes({ flatten: true })
          : [...(element.shadowRoot ?? element).childNodes]
      for (const child of children) {
        walk(child, isTextSuppressed)
      }
    }

    // A heading prints as one line, and only the controls inside it are walked, so its text is not repeated.
    const visitHeading = (heading: Element, level: number, rect: DOMRect): void => {
      if (!isInScope(rect)) {
        return
      }

      flush()
      push(`${'#'.repeat(level)} [${refFor(heading)}] ${clip(textOf(heading), HEADING_MAX_CHARS)}`)
      walkChildren(heading, true)
    }

    const visitEmbedded = (element: HTMLIFrameElement | HTMLImageElement, isTextSuppressed: boolean): void => {
      const rect = element.getBoundingClientRect()
      if (!hasArea(rect) || !isInScope(rect)) {
        return
      }

      if (element instanceof HTMLIFrameElement) {
        if (!EXTENSION_FRAME_PREFIXES.some((prefix) => element.src.startsWith(prefix))) {
          flush()
          push(`[frame] ${element.title || element.src}`)
        }
      } else if (!isTextSuppressed && element.alt.trim() !== '') {
        pending += ` (image: ${collapse(element.alt)})`
      }
    }

    // Block boxes break lines and table cells are separated by bars. A label's text already names its control, so it
    // is not repeated as text.
    const visitContainer = (element: Element, isTextSuppressed: boolean): void => {
      if (element.localName === 'br') {
        flush()
        return
      }

      const { display } = getComputedStyle(element)
      const isBlock = !display.startsWith('inline') && display !== 'contents' && display !== 'table-cell'
      const isLabelOfControl = element instanceof HTMLLabelElement && element.control !== null
      if (isBlock) {
        flush()
      }

      walkChildren(element, isTextSuppressed || isLabelOfControl)

      if (display === 'table-cell' && collapse(pending) !== '') {
        pending += ' | '
      }
      if (isBlock) {
        flush()
      }
    }

    // A control that holds other controls (a card link around a button) is listed, and so are the controls inside it.
    const visitElement = (element: Element, isTextSuppressed: boolean): void => {
      if (isInteractive(element)) {
        const rect = element.getBoundingClientRect()
        if (hasArea(rect) && isInScope(rect)) {
          flush()
          push(describe(element))
        }
        if (element.querySelector(INTERACTIVE_SELECTOR) !== null) {
          walkChildren(element, true)
        }
        return
      }
      if (element instanceof HTMLIFrameElement || element instanceof HTMLImageElement) {
        visitEmbedded(element, isTextSuppressed)
        return
      }

      const level = /^h(?<level>[1-6])$/u.exec(element.localName)?.groups?.level
      if (level === undefined) {
        visitContainer(element, isTextSuppressed)
      } else {
        visitHeading(element, Number(level), element.getBoundingClientRect())
      }
    }

    // A display: contents wrapper has no box, so checkVisibility calls it hidden although its children render; it is
    // walked through, and each child's own check still hides what a hidden ancestor hides.
    const isShown = (element: Element): boolean =>
      !skipped.has(element) &&
      !SKIPPED_TAGS.has(element.localName) &&
      (isVisible(element) || getComputedStyle(element).display === 'contents') &&
      !isScreenReaderOnly(element)

    const walk = (node: Node, isTextSuppressed: boolean): void => {
      if (isTruncated) {
        return
      }
      if (node instanceof Text) {
        if (!isTextSuppressed && node.data.trim() !== '' && isTextInScope(node)) {
          pending += node.data
        }
        return
      }
      if (node instanceof Element && isShown(node)) {
        visitElement(node, isTextSuppressed)
      }
    }

    for (const dialog of dialogs) {
      push(`## Dialog [${refFor(dialog)}]: ${dialogName(dialog)}`)
      walkChildren(dialog, false)
      flush()
    }
    if (dialogs.length > 0) {
      push('## Page behind the dialog')
    }

    // A control read by its ref is listed and then read inside, which a page walk leaves to its line alone.
    for (const node of ref === undefined ? [document.body] : regionOf(elementFor(ref))) {
      if (ref !== undefined && node instanceof Element && isInteractive(node)) {
        push(describe(node))
        walkChildren(node, false)
      } else {
        walk(node, false)
      }
    }
    flush()

    return {
      documentId: state.documentId,
      title: document.title,
      url: location.href,
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      outline: lines.join('\n'),
      isTruncated,
    }
  }

  // Lines of the whole page's outline that mention the query, so one control can be found without reading the page. A
  // matching heading brings the first sectionLines lines of the section it titles, which usually hold the controls the
  // search was for.
  const find = (query: string, maxChars: number, sectionLines: number): { matches: string[]; isTruncated: boolean } => {
    const wanted = collapse(query).toLowerCase()
    const { outline, isTruncated } = snapshot('page', maxChars)
    // A match already shown in an earlier heading's section is not listed again.
    const shown = new Set<string>()
    const matches: string[] = []
    for (const line of outline.split('\n').filter((candidate) => candidate.toLowerCase().includes(wanted))) {
      if (shown.has(line)) {
        continue
      }

      matches.push(line)
      const headingRef = /^#+ \[(?<ref>\d+)\]/u.exec(line)?.groups?.ref
      if (headingRef !== undefined) {
        const section = snapshot('page', maxChars, Number(headingRef)).outline.split('\n').slice(1)
        for (const sectionLine of section.slice(0, sectionLines)) {
          shown.add(sectionLine)
          matches.push(`  ${sectionLine}`)
        }
        if (section.length > sectionLines) {
          matches.push(`  ... and ${section.length - sectionLines} more lines`)
        }
      }
    }

    return { matches, isTruncated }
  }

  const trackPointer = (): void => {
    if (state.isTrackingPointer) {
      return
    }

    window.addEventListener(
      'mousemove',
      (event) => {
        state.pointer = { clientX: event.clientX, clientY: event.clientY }
        state.pointerSeq += 1
      },
      { capture: true, passive: true }
    )
    state.isTrackingPointer = true
  }

  // Scrolls the element to the middle only when part of it is off screen, so a visible target does not jump.
  const pointOn = (ref: number): ClientPoint & { hasScrolled: boolean } => {
    const element = elementFor(ref)
    const { innerWidth, innerHeight } = window
    const rect = element.getBoundingClientRect()
    const hasScrolled = rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth
    if (hasScrolled) {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    }

    const box = [...element.getClientRects()].find((candidate) => hasArea(candidate) && isInViewport(candidate))
    if (box === undefined) {
      throw new Error(`Element ${ref} has no visible area on screen.`)
    }

    const left = Math.max(box.left, 0)
    const top = Math.max(box.top, 0)
    const width = Math.min(box.right, innerWidth) - left
    const height = Math.min(box.bottom, innerHeight) - top
    const points = CLICK_POINT_FRACTIONS.map(({ x, y }) => ({ clientX: left + width * x, clientY: top + height * y }))
    const clear = points.find(({ clientX, clientY }) => {
      const hit = elementAt(clientX, clientY)

      return hit !== null && isHitOn(hit, element)
    })
    if (clear === undefined) {
      const [center] = points
      const cover = center === undefined ? null : elementAt(center.clientX, center.clientY)
      throw new Error(
        `Element ${ref} is covered${cover === null ? '' : ` by ${brief(cover)}`}. Close or dismiss that first.`
      )
    }

    return { ...clear, hasScrolled }
  }

  // Without a ref, the target is the middle of the viewport.
  const locate = (ref: number | undefined): TargetPoint => {
    trackPointer()
    const point =
      ref === undefined
        ? { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, hasScrolled: false }
        : pointOn(ref)

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      ...point,
    }
  }

  const pointer = (ref: number | undefined): PointerState => {
    const { pointer: last, pointerSeq: seq } = state
    if (last === null) {
      return { seq, position: null, isOnTarget: false, under: 'nothing' }
    }

    const hit = elementAt(last.clientX, last.clientY)
    const isOnTarget = hit !== null && (ref === undefined || isHitOn(hit, elementFor(ref)))

    return { seq, position: last, isOnTarget, under: hit === null ? 'nothing' : brief(hit) }
  }

  // A ref on a wrapper of the real field counts as focused when the focus is inside it, and reads that field.
  const field = (ref: number): FieldState => {
    const element = elementFor(ref)
    const active = activeElement()
    const isFocused = active !== null && isWithin(active, element)
    const target = isFocused ? active : element
    const fieldValue = valueOf(target)

    return {
      isFocused,
      focusedElement: active === null ? 'nothing' : brief(active),
      content: fieldValue === null ? { isMasked: false, value: '' } : fieldContent(target, fieldValue),
      isMultiline: target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable),
    }
  }

  // Selects what the focused field inside the element holds, so a real Backspace clears it as a person would.
  // Select-all shortcuts differ between fields and apps; a selection made through the page does not.
  const selectContent = (ref: number): { length: number } => {
    const element = elementFor(ref)
    const active = activeElement()
    const target = active !== null && isWithin(active, element) ? active : null
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select()
      return { length: target.value.length }
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(target)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      return { length: editableText(target).length }
    }

    throw new Error(`Element ${ref} holds no focused text field to clear.`)
  }

  const selectOption = (ref: number, option: string): { label: string } => {
    const element = elementFor(ref)
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`Element ${ref} is a ${roleOf(element)}, not a native select. Click it, then click the option.`)
    }

    const options = [...element.options]
    const wanted = collapse(option).toLowerCase()
    const match = options.find(
      (candidate) => candidate.value === option || collapse(candidate.label).toLowerCase() === wanted
    )
    if (match === undefined) {
      const labels = options.map((candidate) => collapse(candidate.label)).join(' | ')
      throw new Error(`Element ${ref} has no option "${option}". Its options: ${labels}`)
    }

    match.selected = true
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))

    return { label: collapse(match.label) }
  }

  try {
    switch (command.method) {
      case 'snapshot':
        return { isOk: true, value: snapshot(command.params.scope, command.params.maxChars, command.params.ref) }
      case 'find':
        return {
          isOk: true,
          value: find(command.params.query, command.params.maxChars, command.params.sectionLines),
        }
      case 'locate':
        return { isOk: true, value: locate(command.params.ref) }
      case 'pointer':
        return { isOk: true, value: pointer(command.params.ref) }
      case 'field':
        return { isOk: true, value: field(command.params.ref) }
      case 'selectOption':
        return { isOk: true, value: selectOption(command.params.ref, command.params.option) }
      case 'selectContent':
        return { isOk: true, value: selectContent(command.params.ref) }
      case 'hasFocus':
        return { isOk: true, value: { hasFocus: document.hasFocus() } }
    }
  } catch (error) {
    return { isOk: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Resolves once the page has gone quietMs without a DOM change and with no finite animation running, or at timeoutMs.
// A menu or dialog fading in is still invisible at the start of its animation; endless animations (a spinner) are not
// waited for. Like runPageCommand, it runs in the page from its source text and must not reference anything outside
// its own body.
export const waitForQuietPage = (quietMs: number, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      observer.disconnect()
      clearTimeout(quietTimer)
      clearTimeout(timeoutTimer)
      resolve()
    }
    const isAnimating = (): boolean =>
      document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity
        )
    const onQuiet = (): void => {
      if (isAnimating()) {
        quietTimer = setTimeout(onQuiet, quietMs)
        return
      }

      finish()
    }
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(onQuiet, quietMs)
    })
    let quietTimer = setTimeout(onQuiet, quietMs)
    const timeoutTimer = setTimeout(finish, timeoutMs)

    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
