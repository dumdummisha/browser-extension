import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PROTOCOL_REVISION } from '../protocol/messages.js'
import { HostHandshake } from './host-handshake.js'
import { HOST_END, HOST_HELLO } from './testing.js'

const EXTENSION_VERSION = '1.2.3'

const EXTENSION_END = { role: 'extension', protocolRevision: PROTOCOL_REVISION, componentVersion: EXTENSION_VERSION }
const ACK = { type: 'ack', id: 'T0EXAMPLE1:U0EXAMPLE1:D0EXAMPLE1:1700000000.000100' }

interface IRecorded {
  readonly handshake: HostHandshake
  readonly sent: unknown[]
  readonly readies: number[]
  readonly incompatibilities: unknown[]
}

const recordedHandshake = (): IRecorded => {
  const sent: unknown[] = []
  const readies: number[] = []
  const incompatibilities: unknown[] = []

  const handshake = new HostHandshake(
    { role: 'extension', componentVersion: EXTENSION_VERSION },
    {
      send: (frame) => sent.push(frame),
      onReady: () => readies.push(readies.length + 1),
      onIncompatible: (diagnostic) => incompatibilities.push(diagnostic),
    }
  )

  return { handshake, sent, readies, incompatibilities }
}

const ownDiagnostic = (
  reason: string,
  peer: Readonly<Record<string, unknown>>,
  recovery: string
): Readonly<Record<string, unknown>> => ({
  type: 'bridge-incompatible',
  reason,
  leg: 'extension-host',
  local: EXTENSION_END,
  peer,
  recovery,
})

describe('[service-worker] Host handshake', () => {
  it('should say hello as the extension of its manifest version', () => {
    // Arrange
    const { handshake, sent } = recordedHandshake()

    // Act
    handshake.start()

    // Assert
    assert.deepEqual(sent, [{ type: 'hello', ...EXTENSION_END }])
    assert.equal(handshake.state, 'awaiting-hello')
  })

  it("should become ready on the host's hello of its revision, and only then hand frames on", () => {
    // Arrange
    const { handshake, sent, readies } = recordedHandshake()
    handshake.start()

    // Act
    const greeting = handshake.receive(HOST_HELLO)
    const ack = handshake.receive(ACK)

    // Assert
    assert.deepEqual([greeting, ack, handshake.state, readies, sent.length], [null, ACK, 'ready', [1], 1])
  })

  for (const [revision, recovery] of [
    [PROTOCOL_REVISION - 1, 'update-app'],
    [PROTOCOL_REVISION + 1, 'update-extension'],
  ] as const) {
    it(`should tell a host of revision ${revision} to ${recovery}, and hand nothing on after`, () => {
      // Arrange
      const { handshake, sent, incompatibilities } = recordedHandshake()

      // Act
      handshake.receive({ ...HOST_HELLO, protocolRevision: revision })
      const ack = handshake.receive(ACK)

      // Assert
      const expected = ownDiagnostic('revision-mismatch', { ...HOST_END, protocolRevision: revision }, recovery)

      assert.deepEqual([sent, incompatibilities, ack, handshake.state], [[expected], [expected], null, 'incompatible'])
    })
  }

  it('should take the hello of a host from before versioned hellos for malformed, not for revision 1', () => {
    // Arrange
    const { handshake, sent } = recordedHandshake()

    // Act
    handshake.receive({ type: 'hello', browserApp: null })

    // Assert
    assert.deepEqual(sent, [ownDiagnostic('malformed-hello', {}, 'versions-unchecked')])
  })

  it('should refuse an ack or listener before the hello, so the pending queue keeps its events', () => {
    // Arrange
    const { handshake, sent } = recordedHandshake()

    // Act
    const handed = [handshake.receive(ACK), handshake.receive({ type: 'listener' })]

    // Assert
    assert.deepEqual(handed, [null, null])
    assert.deepEqual(sent, [ownDiagnostic('unexpected-frame', {}, 'versions-unchecked')])
  })

  it('should make the leg incompatible on a second hello, never renegotiating', () => {
    // Arrange
    const { handshake, sent } = recordedHandshake()
    handshake.receive(HOST_HELLO)

    // Act
    const repeated = handshake.receive(HOST_HELLO)
    const ack = handshake.receive(ACK)

    // Assert
    assert.deepEqual(
      [repeated, ack, sent],
      [null, null, [ownDiagnostic('unexpected-frame', HOST_END, 'versions-unchecked')]]
    )
  })

  it("should take the host's diagnostic without answering it", () => {
    // Arrange
    const { handshake, sent, incompatibilities } = recordedHandshake()

    const fromHost = {
      type: 'bridge-incompatible',
      reason: 'malformed-hello',
      leg: 'extension-host',
      local: HOST_END,
      peer: { role: 'extension' },
      recovery: 'versions-unchecked',
    }

    // Act
    handshake.receive(fromHost)

    // Assert
    assert.deepEqual([sent, incompatibilities, handshake.state], [[], [fromHost], 'incompatible'])
  })

  it('should hand nothing on once the port closed', () => {
    // Arrange
    const { handshake } = recordedHandshake()
    handshake.receive(HOST_HELLO)

    // Act
    handshake.close()

    // Assert
    assert.deepEqual([handshake.receive(ACK), handshake.state], [null, 'closed'])
  })
})
