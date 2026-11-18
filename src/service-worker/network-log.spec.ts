import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NETWORK_BODY_MAX_CHARS, NETWORK_LOG_LIMIT, NetworkLog } from './network-log.js'

const TAB_ID = 7
const STARTED_AT = Date.UTC(2026, 10, 4, 12, 0, 0)
// Assembled at run time, so the repository holds nothing a secret scanner would flag.
const SLACK_SESSION_TOKEN = ['xoxc', '2048', '4096', 'aBcDeFgHiJkLmNoP'].join('-')

describe('[service-worker] Network log - recording', () => {
  it('should hold a request redacted as it was recorded, with its headers and outcome', () => {
    // Arrange
    const log = new NetworkLog()

    // Act
    log.started(TAB_ID, 'req-1', {
      startedAt: STARTED_AT,
      method: 'POST',
      url: `https://app.example.com/api/chat?token=${SLACK_SESSION_TOKEN}`,
      body: `token=${SLACK_SESSION_TOKEN}&channel=C0123`,
    })
    log.sentHeaders(TAB_ID, 'req-1', [
      { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
      { name: 'Cookie', value: `d=${SLACK_SESSION_TOKEN}` },
    ])
    log.ended(TAB_ID, 'req-1', { statusCode: 200 })

    // Assert
    assert.deepEqual(log.requests(TAB_ID), [
      {
        startedAt: STARTED_AT,
        method: 'POST',
        url: 'https://app.example.com/api/chat?token=[redacted]',
        body: 'token=[redacted]&channel=C0123',
        isBodyTruncated: false,
        headers: [
          { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
          { name: 'Cookie', value: '[redacted]' },
        ],
        statusCode: 200,
        error: null,
      },
    ])
  })

  it('should cut a long body before redacting it and say it was cut', () => {
    // Arrange
    const log = new NetworkLog()
    const body = JSON.stringify({ password: 'x'.repeat(NETWORK_BODY_MAX_CHARS) })

    // Act
    log.started(TAB_ID, 'req-1', { startedAt: STARTED_AT, method: 'POST', url: 'https://app.example.com/', body })
    log.ended(TAB_ID, 'req-1', { error: 'net::ERR_FAILED' })

    // Assert
    const [request] = log.requests(TAB_ID)
    assert.deepEqual(
      { body: request?.body, isBodyTruncated: request?.isBodyTruncated, error: request?.error },
      { body: '{"password":"[redacted]"', isBodyTruncated: true, error: 'net::ERR_FAILED' }
    )
  })

  it('should keep only the latest requests of a tab, and forget a tab that closed', () => {
    // Arrange
    const log = new NetworkLog()
    for (let index = 0; index <= NETWORK_LOG_LIMIT; index += 1) {
      log.started(TAB_ID, `req-${index}`, {
        startedAt: STARTED_AT + index,
        method: 'GET',
        url: `https://app.example.com/items/${index}`,
        body: null,
      })
    }
    log.started(TAB_ID + 1, 'req-0', { startedAt: STARTED_AT, method: 'GET', url: 'https://example.com/', body: null })

    // Act
    const kept = log.requests(TAB_ID)
    log.forget(TAB_ID)

    // Assert
    assert.deepEqual(
      {
        count: kept.length,
        oldest: kept[0]?.url,
        forgotten: log.requests(TAB_ID).length,
        other: log.requests(TAB_ID + 1).length,
      },
      { count: NETWORK_LOG_LIMIT, oldest: 'https://app.example.com/items/1', forgotten: 0, other: 1 }
    )
  })

  it('should ignore headers and outcomes of a request it never saw start', () => {
    // Arrange
    const log = new NetworkLog()

    // Act
    log.sentHeaders(TAB_ID, 'req-1', [{ name: 'Accept', value: '*/*' }])
    log.ended(TAB_ID, 'req-1', { statusCode: 204 })

    // Assert
    assert.deepEqual(log.requests(TAB_ID), [])
  })
})
