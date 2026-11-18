import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { invokeTool } from '../module/testing.js'
import type { BrowserControlService, ITypeRequest } from './browser-control.js'
import { createTypeTool } from './type.tool.js'

const recordingBrowser = (requests: ITypeRequest[]): BrowserControlService =>
  ({
    typeInto: (request: ITypeRequest) => {
      requests.push(request)

      return Promise.resolve({ field: null, action: null })
    },
  }) as unknown as BrowserControlService

describe('[tools] Typing - into the focused element', () => {
  it('should refuse clear=true without a ref and type nothing', async () => {
    // Arrange
    const requests: ITypeRequest[] = []

    // Act
    const attempt = invokeTool(createTypeTool(recordingBrowser(requests)), { text: 'Hello', clear: true })

    // Assert
    await assert.rejects(attempt, { name: 'PluginError', message: /^clear=true needs a ref/u })
    assert.deepStrictEqual(requests, [])
  })

  it('should type into the focus without clearing when no ref is given', async () => {
    // Arrange
    const requests: ITypeRequest[] = []

    // Act
    const output = await invokeTool(createTypeTool(recordingBrowser(requests)), { text: 'Hello' })

    // Assert
    assert.deepStrictEqual(requests, [
      { ref: undefined, text: 'Hello', tabId: undefined, isClearing: false, isSubmitting: false },
    ])
    assert.equal(output, '[PASS] Typed into the focused element.\n')
  })

  it('should still clear a field named by ref by default', async () => {
    // Arrange
    const requests: ITypeRequest[] = []

    // Act
    await invokeTool(createTypeTool(recordingBrowser(requests)), { ref: 4, text: 'Hello' })

    // Assert
    assert.deepStrictEqual(requests, [
      { ref: 4, text: 'Hello', tabId: undefined, isClearing: true, isSubmitting: false },
    ])
  })
})

describe('[tools] Typing - into a field by ref', () => {
  it('should report a masked field by its length alone', async () => {
    // Arrange
    const browser = {
      typeInto: () =>
        Promise.resolve({
          field: {
            isFocused: true,
            focusedElement: '<input#password>',
            content: { isMasked: true, length: 12, revision: 3 },
            isMultiline: false,
          },
          action: null,
        }),
    } as unknown as BrowserControlService

    // Act
    const output = await invokeTool(createTypeTool(browser), { ref: 4, text: 'example-text' })

    // Assert
    assert.equal(output, '[PASS] Typed into element 4, which now holds 12 hidden characters.')
  })
})
