import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  answerRequest,
  type BridgeRequest,
  type IAbandonment,
  type RequestHandler,
  throwIfAbandoned,
} from './bridge-requests.js'

// A caller's deadline that has not passed (2100-01-01) and one that has (2000-01-01).
const LATER = 4_102_444_800_000
const EARLIER = 946_684_800_000

const request = (id: number, method: string): BridgeRequest => ({
  type: 'request',
  id,
  method,
  params: {},
  deadline: LATER,
})

const { signal } = new AbortController()

describe('[service-worker] Bridge requests - answers', () => {
  it('should answer a failing tab command with its error and still answer the Slack call after it', async () => {
    // Arrange
    const handlers: Record<string, RequestHandler> = {
      slackCall: () => ({ ok: true }),
      locate: () => {
        throw new Error('Element 12 is not on the page any more. Call tab_read for fresh refs.')
      },
      settle: () => Promise.reject(new Error('No tab with id: 9.')),
    }

    // Act
    const replies = await Promise.all([
      answerRequest(handlers, request(1, 'locate'), signal),
      answerRequest(handlers, request(2, 'settle'), signal),
      answerRequest(handlers, request(3, 'slackCall'), signal),
    ])

    // Assert
    assert.deepEqual(replies, [
      { type: 'reply', id: 1, error: 'Element 12 is not on the page any more. Call tab_read for fresh refs.' },
      { type: 'reply', id: 2, error: 'No tab with id: 9.' },
      { type: 'reply', id: 3, result: { ok: true } },
    ])
  })

  it('should answer a method it does not know, an inherited name included, with an error', async () => {
    // Arrange
    const handlers: Record<string, RequestHandler> = { slackCall: () => ({ ok: true }) }

    // Act
    const replies = await Promise.all([
      answerRequest(handlers, request(1, 'reload'), signal),
      answerRequest(handlers, request(2, 'toString'), signal),
    ])

    // Assert
    assert.deepEqual(replies, [
      { type: 'reply', id: 1, error: 'This extension does not know reload; it is older than its client. Reload it.' },
      { type: 'reply', id: 2, error: 'This extension does not know toString; it is older than its client. Reload it.' },
    ])
  })
})

describe('[service-worker] Bridge requests - callers that gave up', () => {
  it("should hand a handler the request's deadline and the signal that aborts once its caller cancels", async () => {
    // Arrange
    const controller = new AbortController()
    const seen: IAbandonment[] = []
    const handlers: Record<string, RequestHandler> = {
      slackCall: (_params, abandonment) => {
        seen.push(abandonment)

        return { ok: true }
      },
    }

    // Act
    await answerRequest(handlers, request(1, 'slackCall'), controller.signal)
    controller.abort()

    // Assert
    assert.deepEqual(
      seen.map(({ deadline, signal: aborts }) => [deadline, aborts.aborted]),
      [[LATER, true]]
    )
  })

  it('should stop a request whose caller cancelled it or whose deadline passed, and let any other go on', () => {
    // Arrange
    const cancelled = new AbortController()
    cancelled.abort()
    const abandonments: IAbandonment[] = [
      { deadline: LATER, signal: cancelled.signal },
      { deadline: EARLIER, signal },
      { deadline: LATER, signal },
    ]

    // Act
    const stopped = abandonments.map((abandonment) => {
      try {
        throwIfAbandoned(abandonment)

        return false
      } catch {
        return true
      }
    })

    // Assert
    assert.deepEqual(stopped, [true, true, false])
  })
})
