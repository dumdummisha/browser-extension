import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FieldState, PageCommand, PageSnapshot } from '../protocol/tab.js'
import { runPageCommand } from './page-command.js'

const OPAQUE_PASSWORD = ['opaque', 'example', 'password'].join('-')
const OPAQUE_TOKEN = ['opaque', 'example', 'value'].join('-')

// The least of the DOM the page command reads for a page of plain, visible elements: every element has a box, no
// style hides it and no selector beyond its own tag matches it.
class FakeElement {
  public parentNode: FakeElement | null = null
  public readonly id = ''
  public readonly shadowRoot = null
  public readonly isConnected = true
  public readonly isContentEditable = false
  public readonly innerText = ''
  public readonly textContent = ''
  public readonly labels = []

  constructor(
    public readonly localName: string,
    private readonly attributes: Record<string, string> = {},
    public readonly childNodes: FakeElement[] = []
  ) {
    for (const child of childNodes) {
      child.parentNode = this
    }
  }

  public get parentElement(): FakeElement | null {
    return this.parentNode
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  public hasAttribute(name: string): boolean {
    return name in this.attributes
  }

  public matches(selector: string): boolean {
    return selector.split(', ').some((part) => part === this.localName || part.startsWith(`${this.localName}:`))
  }

  public querySelector(): null {
    return null
  }

  public checkVisibility(): boolean {
    return true
  }

  public getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 } as DOMRect
  }
}

class FakeInput extends FakeElement {
  public value = ''

  constructor(
    public readonly type: string,
    attributes: Record<string, string>
  ) {
    super('input', attributes)
  }
}

class FakeIFrame extends FakeElement {
  public readonly title = ''

  constructor(public readonly src: string) {
    super('iframe')
  }
}

class Unused extends FakeElement {}

const DOM_GLOBALS = {
  Element: FakeElement,
  HTMLElement: FakeElement,
  HTMLInputElement: FakeInput,
  HTMLIFrameElement: FakeIFrame,
  HTMLTextAreaElement: Unused,
  HTMLSelectElement: Unused,
  HTMLLabelElement: Unused,
  HTMLImageElement: Unused,
  HTMLSlotElement: Unused,
  ShadowRoot: Unused,
  Text: Unused,
  window: { innerWidth: 1000, innerHeight: 800, scrollY: 0 },
  location: { href: 'https://app.example.test/login' },
  getComputedStyle: () => ({ display: 'block', cursor: 'auto', overflow: 'visible', clip: 'auto', clipPath: 'none' }),
}

const showPage = (children: FakeElement[], focused: FakeElement | null): void => {
  Object.assign(globalThis, {
    ...DOM_GLOBALS,
    document: {
      title: 'Sign in',
      body: new FakeElement('body', {}, children),
      activeElement: focused,
      documentElement: { scrollHeight: 800 },
      querySelectorAll: () => [],
      getElementById: () => null,
    },
  })
}

const run = <TResult>(command: PageCommand): TResult => {
  const outcome = runPageCommand(command)
  if (!outcome.isOk) {
    throw new Error(outcome.error)
  }

  return outcome.value as TResult
}

const outline = (): string =>
  run<PageSnapshot>({ method: 'snapshot', params: { scope: 'page', maxChars: 10_000 } }).outline

const readField = (ref: number): FieldState => run<FieldState>({ method: 'field', params: { ref } })

beforeEach(() => {
  Reflect.deleteProperty(globalThis, 'mishaTabState')
})

afterEach(() => {
  for (const name of [...Object.keys(DOM_GLOBALS), 'document', 'mishaTabState']) {
    Reflect.deleteProperty(globalThis, name)
  }
})

describe('[service-worker] Page command - masked fields', () => {
  it('should answer a password field with its length and a revision, never its value', () => {
    // Arrange
    const password = new FakeInput('password', { 'aria-label': 'Password' })
    password.value = OPAQUE_PASSWORD
    showPage([password], password)
    assert.equal(outline(), '[1] textbox "Password" filled focused')

    // Act
    const first = readField(1)
    const unchanged = readField(1)
    password.value = `${OPAQUE_PASSWORD}x`
    const changed = readField(1)

    // Assert
    assert.deepEqual(first.content, { isMasked: true, length: OPAQUE_PASSWORD.length, revision: 0 })
    assert.deepEqual(unchanged.content, first.content)
    assert.deepEqual(changed.content, { isMasked: true, length: OPAQUE_PASSWORD.length + 1, revision: 1 })
    assert.doesNotMatch(JSON.stringify([first, unchanged, changed]), new RegExp(OPAQUE_PASSWORD, 'u'))
  })

  it('should answer a plain text field with its value', () => {
    // Arrange
    const email = new FakeInput('email', { 'aria-label': 'Email' })
    email.value = 'person@example.test'
    showPage([email], email)
    outline()

    // Act
    const field = readField(1)

    // Assert
    assert.deepEqual(field.content, { isMasked: false, value: 'person@example.test' })
  })
})

describe('[service-worker] Page command - frames', () => {
  it('should name an untitled frame by its origin alone in reads and searches', () => {
    // Arrange
    const src = `https://viewer:${OPAQUE_PASSWORD}@embed.example.test:8443/report/${OPAQUE_TOKEN}?access_token=${OPAQUE_TOKEN}#page`
    showPage([new FakeIFrame(src), new FakeIFrame('about:blank')], null)

    // Act
    const lines = outline()
    const byOrigin = run<{ matches: string[] }>({
      method: 'find',
      params: { query: 'embed.example', maxChars: 10_000, sectionLines: 5 },
    })
    const byToken = run<{ matches: string[] }>({
      method: 'find',
      params: { query: OPAQUE_TOKEN, maxChars: 10_000, sectionLines: 5 },
    })

    // Assert
    assert.equal(lines, '[frame] https://embed.example.test:8443\n[frame] about:')
    assert.deepEqual(byOrigin.matches, ['[frame] https://embed.example.test:8443'])
    assert.deepEqual(byToken.matches, [])
  })
})
