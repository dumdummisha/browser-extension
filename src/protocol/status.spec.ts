import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeStatusSchema } from './status.js'

describe('[protocol] Status', () => {
  it('should state in every snapshot whether the queue commits, with the stored count when it does', () => {
    // Arrange
    const silent = { type: 'status', identities: [], captures: [], parity: [], whatsapp: [] }
    const committing = { ...silent, queue: { state: 'committing', droppedEvents: 2 } }
    const uncounted = { ...silent, queue: { state: 'committing', droppedEvents: null } }
    const unstated = { ...silent, queue: { state: 'committing' } }

    // Act
    const parsed = [committing, uncounted, unstated, silent].map(
      (status) => BridgeStatusSchema.safeParse(status).success
    )

    // Assert
    assert.deepEqual(parsed, [true, false, false, false])
  })

  it('should let a failing queue report its stored count as last known or explicitly unavailable, never as null', () => {
    // Arrange
    const failingWith = (loss: unknown): unknown => ({
      type: 'status',
      identities: [],
      captures: [],
      queue: { state: 'failing', error: 'QuotaExceededError', unstoredEvents: 2, uncountedEvents: 1, loss },
      parity: [],
      whatsapp: [],
    })

    const losses = [
      { kind: 'last-known', droppedEvents: 7 },
      { kind: 'unavailable' },
      { kind: 'unavailable', droppedEvents: 0 },
      { kind: 'last-known', droppedEvents: null },
      null,
    ]

    // Act
    const parsed = losses.map((loss) => BridgeStatusSchema.safeParse(failingWith(loss)).success)

    // Assert
    assert.deepEqual(parsed, [true, true, false, false, false])
  })

  it('should report the transport check per operation by names only, refusing a value or an operation it does not know', () => {
    // Arrange
    const withParity = (parity: unknown): unknown => ({
      type: 'status',
      identities: [],
      captures: [],
      queue: { state: 'committing', droppedEvents: 0 },
      parity,
      whatsapp: [],
    })

    const reports = [
      [
        { operation: 'chat.postMessage', state: 'matches' },
        { operation: 'upload', state: 'unchecked' },
        {
          operation: 'files.getUploadURLExternal',
          state: 'differs',
          differences: [{ part: 'header', name: 'priority', kind: 'missing' }],
        },
      ],
      [{ operation: 'download', state: 'differs', differences: [] }],
      [
        {
          operation: 'download',
          state: 'differs',
          differences: [{ part: 'header', name: 'user-agent', kind: 'value', value: 'Example/1.0' }],
        },
      ],
      [{ operation: 'chat.delete', state: 'matches' }],
    ]

    // Act
    const parsed = reports.map((parity) => BridgeStatusSchema.safeParse(withParity(parity)).success)

    // Assert
    assert.deepEqual(parsed, [true, false, false, false])
  })

  it("should report each WhatsApp tab's state, and refuse a tab whose state does not read", () => {
    // Arrange
    const withWhatsApp = (whatsapp: unknown): unknown => ({
      type: 'status',
      identities: [],
      captures: [],
      queue: { state: 'committing', droppedEvents: 0 },
      parity: [],
      whatsapp,
    })

    const reports = [
      [
        { tabId: 41, state: 'ready', account: { wid: '100000000000001@lid' }, isConnected: true, hasSynced: false },
        { tabId: 42, state: 'signed-out' },
        { tabId: 43, state: 'loading' },
        { tabId: 44, state: 'broken', drift: 'send' },
        { tabId: 45, state: 'detached' },
        { tabId: 46, state: 'failed', error: 'The observer sent a message that does not read' },
      ],
      [{ tabId: 41, state: 'broken', drift: 'unheard-of' }],
      [{ tabId: 41, state: 'ready', account: { wid: '100000000000001@c.us' }, isConnected: true, hasSynced: true }],
      [{ state: 'detached' }],
      undefined,
    ]

    // Act
    const parsed = reports.map((whatsapp) => BridgeStatusSchema.safeParse(withWhatsApp(whatsapp)).success)

    // Assert
    assert.deepEqual(parsed, [true, false, false, false, false])
  })
})
