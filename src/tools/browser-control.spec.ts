import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InputControlService } from '../desktop/input-control.js'
import { pretendPlatform } from '../module/testing.js'
import type { FieldContent, FieldState, TabBridgeMethod, TabInfo } from '../protocol/tab.js'
import { BrowserControlService, type TabBridge } from './browser-control.js'

const TAB: TabInfo = {
  tabId: 7,
  windowId: 3,
  title: 'Settings',
  url: 'https://app.example.test/settings',
  status: 'complete',
  zoom: 1,
  windowBounds: { left: 0, top: 0, width: 1200, height: 900 },
}
const FIELD_REF = 4
const REDACTED_TOKEN: FieldContent = { isMasked: false, value: '[redacted]', revision: 0 }

const focusedField = (content: FieldContent): FieldState => ({
  isFocused: true,
  focusedElement: '<input#api-key>',
  content,
  isMultiline: false,
})

// The pointer's moves so far, which the page counts as the mousemove events it saw.
interface IPointerMoves {
  count: number
}

// The extension's side for typing into one field: the tab has the focus, the pointer lands on the field, and each read
// of the field answers the next of fieldReads, the last one again once they run out.
const scriptedBridge = (fieldReads: readonly FieldState[], answered: FieldState[], moves: IPointerMoves): TabBridge => {
  const answers: Partial<Record<TabBridgeMethod, () => unknown>> = {
    focusTab: () => TAB,
    hasFocus: () => ({ hasFocus: true }),
    locate: () => ({ innerWidth: 1000, innerHeight: 800, clientX: 100, clientY: 50, hasScrolled: false }),
    pointer: () => ({
      seq: moves.count,
      position: { clientX: 100, clientY: 50 },
      isOnTarget: true,
      under: '<input#api-key>',
    }),
    field: () => {
      const read = fieldReads[Math.min(answered.length, fieldReads.length - 1)]
      assert.ok(read !== undefined, 'The test reads no field')
      answered.push(read)

      return read
    },
  }

  return {
    tab: (method: TabBridgeMethod) => {
      const answer = answers[method]
      assert.ok(answer !== undefined, `The test does not answer ${method}`)

      return Promise.resolve(answer())
    },
    browserApp: () => Promise.resolve('Example Browser'),
  } as unknown as TabBridge
}

const quietInput = (moves: IPointerMoves): InputControlService =>
  ({
    moveMouse: () => {
      moves.count += 1

      return Promise.resolve()
    },
    click: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    pressKey: () => Promise.resolve(),
    currentMousePosition: () => Promise.resolve({ x: 0, y: 0 }),
  }) as unknown as InputControlService

const typingBrowser = (fieldReads: readonly FieldState[], answered: FieldState[]): BrowserControlService => {
  const moves = { count: 0 }

  return new BrowserControlService(scriptedBridge(fieldReads, answered, moves), quietInput(moves))
}

describe('[tools] Browser control - typing settles by revision', () => {
  it('should wait until the revision stops changing while successive tokens read redacted the same', async (context) => {
    // Arrange
    context.after(pretendPlatform('darwin'))
    const reads = [
      focusedField({ ...REDACTED_TOKEN, value: '' }),
      focusedField({ ...REDACTED_TOKEN, revision: 1 }),
      focusedField({ ...REDACTED_TOKEN, revision: 2 }),
      focusedField({ ...REDACTED_TOKEN, revision: 3 }),
    ]
    const answered: FieldState[] = []
    const browser = typingBrowser(reads, answered)

    // Act
    const result = await browser.typeInto({
      tabId: TAB.tabId,
      ref: FIELD_REF,
      text: 'a made-up key',
      isClearing: false,
      isSubmitting: false,
    })

    // Assert
    assert.deepEqual(result, { field: focusedField({ ...REDACTED_TOKEN, revision: 3 }), action: null })
    assert.deepEqual(
      answered.map(({ content }) => content.revision),
      [0, 1, 2, 3, 3]
    )
  })

  it('should keep a masked field settling by its revision alone', async (context) => {
    // Arrange
    context.after(pretendPlatform('darwin'))
    const masked = (length: number, revision: number): FieldState => focusedField({ isMasked: true, length, revision })
    const reads = [masked(0, 0), masked(12, 1), masked(13, 2), masked(13, 2)]
    const answered: FieldState[] = []
    const browser = typingBrowser(reads, answered)

    // Act
    const result = await browser.typeInto({
      tabId: TAB.tabId,
      ref: FIELD_REF,
      text: 'a made-up password',
      isClearing: false,
      isSubmitting: false,
    })

    // Assert
    assert.deepEqual(result, { field: masked(13, 2), action: null })
    assert.equal(answered.length, 4)
  })
})
