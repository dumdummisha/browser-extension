import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerRequest, type RequestHandler } from './bridge-requests.js'

const request = (id: number, method: string): { type: 'request'; id: number; method: string; params: unknown } => ({
  type: 'request',
  id,
  method,
  params: {},
})

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
      answerRequest(handlers, request(1, 'locate')),
      answerRequest(handlers, request(2, 'settle')),
      answerRequest(handlers, request(3, 'slackCall')),
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
      answerRequest(handlers, request(1, 'reload')),
      answerRequest(handlers, request(2, 'toString')),
    ])

    // Assert
    assert.deepEqual(replies, [
      { type: 'reply', id: 1, error: 'This extension does not know reload; it is older than its client. Reload it.' },
      { type: 'reply', id: 2, error: 'This extension does not know toString; it is older than its client. Reload it.' },
    ])
  })
})
