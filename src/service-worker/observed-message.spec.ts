import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { captureHealthOf, ObserverMessageSchema } from './observed-message.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'C0EXAMPLE1', ts: '1700000000.000100', text: 'hello' }
const SAVED_STATE = '{"teams":{"T0EXAMPLE1":{"token":"xoxc-0000-example"}}}'

describe('[service-worker] Observed messages - from the observer', () => {
  it('should take a new message with its signed-in account and number, and a socket state that is a boolean', () => {
    // Arrange
    const messages = [
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0 },
      { kind: 'socket', isSocketOpen: true },
    ]

    // Act
    const results = messages.map((message) => ObserverMessageSchema.safeParse(message).success)

    // Assert
    assert.deepEqual(results, [true, true])
  })

  it('should refuse a socket state that is no boolean, a message without its user or number, and anything else', () => {
    // Arrange
    const messages = [
      { kind: 'socket' },
      { kind: 'socket', isSocketOpen: '{}' },
      { kind: 'socket', isSocketOpen: true, state: SAVED_STATE },
      { kind: 'frame', account: ACCOUNT, frame: SAVED_STATE, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: { ...FRAME, token: 'xoxc-0000-example' }, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0, state: SAVED_STATE },
      { kind: 'frame', teamId: ACCOUNT.teamId, frame: FRAME, seq: 0 },
      { kind: 'frame', account: { teamId: ACCOUNT.teamId }, frame: FRAME, seq: 0 },
      { kind: 'frame', frame: FRAME, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: -1 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0.5 },
      SAVED_STATE,
    ]

    // Act
    const results = messages.map((message) => ObserverMessageSchema.safeParse(message).success)

    // Assert
    assert.deepEqual(
      results,
      messages.map(() => false)
    )
  })
})

describe('[service-worker] Observed messages - capture health', () => {
  it('should report a relay answer that does not read as that tab failed, rather than throw', () => {
    // Arrange
    const answers = [{}, '{"isSocketOpen":true}', { isSocketOpen: 'yes', error: null }, null, undefined]

    // Act
    const captures = answers.map((answer) => captureHealthOf(7, answer))

    // Assert
    assert.deepEqual(
      captures,
      answers.map(() => ({ tabId: 7, state: 'failed', error: 'The relay in tab 7 answered no capture state' }))
    )
  })

  it('should report a tab detached until its observer reports, attached once it does, and failed with its error', () => {
    // Arrange
    const error = 'The observer sent what does not read'
    const answers = [
      { isSocketOpen: null, error: null },
      { isSocketOpen: false, error: null },
      { isSocketOpen: true, error },
    ]

    // Act
    const captures = answers.map((answer) => captureHealthOf(7, answer))

    // Assert
    assert.deepEqual(captures, [
      { tabId: 7, state: 'detached' },
      { tabId: 7, state: 'attached', isSocketOpen: false },
      { tabId: 7, state: 'failed', error },
    ])
  })
})
