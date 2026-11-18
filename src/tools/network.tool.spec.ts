import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { invokeTool } from '../module/testing.js'
import type { NetworkRequest } from '../protocol/tab.js'
import { createNetworkTool } from './network.tool.js'

const TAB_ID = 7

// A request as the extension answers it, already redacted.
const request = (overrides: Partial<NetworkRequest>): NetworkRequest => ({
  startedAt: Date.UTC(2026, 10, 4, 12, 0, 0),
  method: 'POST',
  url: 'https://app.example.com/api/items',
  body: null,
  isBodyTruncated: false,
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Cookie', value: '[redacted]' },
  ],
  statusCode: 200,
  error: null,
  ...overrides,
})

const networkToolFor = (requests: NetworkRequest[]): ReturnType<typeof createNetworkTool> =>
  createNetworkTool({ network: () => Promise.resolve({ tabId: TAB_ID, requests }) })

describe('[tools] Network log - tab_network', () => {
  it('should list the latest matching requests with their bodies and without headers', async () => {
    // Arrange
    const networkTool = networkToolFor([
      request({ method: 'GET', url: 'https://cdn.example.com/metrics' }),
      request({ method: 'PUT', url: 'https://app.example.com/api/entries', body: '{"date":"2026-11-04","hours":8}' }),
      request({ url: 'https://app.example.com/api/entries', body: null, statusCode: null }),
    ])

    // Act
    const output = await invokeTool(networkTool, { urlContains: '/api/', last: 1 })

    // Assert
    assert.equal(
      output,
      [
        'Tab 7: the last 1 of 2 matching requests.',
        '### POST https://app.example.com/api/entries',
        '',
        '**Sent:** 2026-11-04T12:00:00.000Z',
        '**Outcome:** still in flight',
      ].join('\n')
    )
  })

  it('should list the headers and a failed request when asked', async () => {
    // Arrange
    const networkTool = networkToolFor([
      request({ body: 'token=[redacted]', isBodyTruncated: true, statusCode: null, error: 'net::ERR_FAILED' }),
    ])

    // Act
    const output = await invokeTool(networkTool, { includeHeaders: true })

    // Assert
    assert.equal(
      output,
      [
        'Tab 7: the last 1 of 1 matching requests.',
        '### POST https://app.example.com/api/items',
        '',
        '**Sent:** 2026-11-04T12:00:00.000Z',
        '**Outcome:** failed (net::ERR_FAILED)',
        'Body (truncated):',
        '```',
        'token=[redacted]',
        '```',
        'Headers:',
        '```',
        'Content-Type: application/json',
        'Cookie: [redacted]',
        '```',
      ].join('\n')
    )
  })

  it('should say when no request matches', async () => {
    // Act
    const output = await invokeTool(networkToolFor([request({})]), { urlContains: '/graphql' })

    // Assert
    assert.equal(output, 'Tab 7 has no recorded requests whose URL contains "/graphql".')
  })

  it('should take no argument that writes the session headers anywhere', () => {
    // Act
    const argumentNames = Object.keys(networkToolFor([]).input.shape)

    // Assert
    assert.deepEqual(argumentNames, ['tabId', 'urlContains', 'includeHeaders', 'last'])
  })
})
