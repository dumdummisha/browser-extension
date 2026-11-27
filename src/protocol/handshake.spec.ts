import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { incompatibilityMessage, readHello } from './handshake.js'
import { ClientHelloSchema, PROTOCOL_REVISION } from './messages.js'

const HOST = { role: 'host', componentVersion: '9.8.7' } as const
const CLIENT_HELLO = { type: 'hello', role: 'client', protocolRevision: PROTOCOL_REVISION, componentVersion: '1.2.3' }

describe('[protocol] Handshake - hello', () => {
  it('should agree on a hello of its revision, whatever its package version', () => {
    // Act
    const reading = readHello(CLIENT_HELLO, ClientHelloSchema, HOST, 'host-client')

    // Assert
    assert.deepEqual(reading, { kind: 'agreed', hello: CLIENT_HELLO })
  })

  it('should read the revision as an integer before anything else, and take a string or a fraction for malformed', () => {
    // Act
    const reasons = [
      { ...CLIENT_HELLO, protocolRevision: String(PROTOCOL_REVISION) },
      { ...CLIENT_HELLO, protocolRevision: PROTOCOL_REVISION + 0.5 },
      { ...CLIENT_HELLO, protocolRevision: PROTOCOL_REVISION + 1, role: 'someone else', extra: true },
    ].map((hello) => {
      const reading = readHello(hello, ClientHelloSchema, HOST, 'host-client')

      return reading.kind === 'incompatible' ? reading.diagnostic.reason : reading.kind
    })

    // Assert
    assert.deepEqual(reasons, ['malformed-hello', 'malformed-hello', 'revision-mismatch'])
  })

  it('should take a hello of its revision whose other fields do not read for malformed, naming only what read', () => {
    // Act
    const reading = readHello({ ...CLIENT_HELLO, role: 'stranger' }, ClientHelloSchema, HOST, 'host-client')

    // Assert
    assert.deepEqual(reading, {
      kind: 'incompatible',
      diagnostic: {
        type: 'bridge-incompatible',
        reason: 'malformed-hello',
        leg: 'host-client',
        local: { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: '9.8.7' },
        peer: { protocolRevision: PROTOCOL_REVISION, componentVersion: '1.2.3' },
        recovery: 'versions-unchecked',
      },
    })
  })

  it('should say which ends, why and what to do in one sentence', () => {
    // Arrange
    const reading = readHello(
      { ...CLIENT_HELLO, role: 'extension', protocolRevision: PROTOCOL_REVISION + 1 },
      ClientHelloSchema,
      HOST,
      'extension-host'
    )

    assert.ok(reading.kind === 'incompatible')

    // Act
    const message = incompatibilityMessage(reading.diagnostic)

    // Assert
    assert.equal(
      message,
      'The browser bridge between Misha Browser and its native host cannot be used: they speak different protocol ' +
        'revisions. Update Misha, then restart the browser to restart its native host.'
    )
  })
})
