import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFrameReader, createLineReader, encodeFrame, encodeLine, HOST_MESSAGE_MAX_BYTES } from './framing.js'
import { FILE_CHUNK_BYTES, SLACK_BRIDGE_METHODS } from './slack.js'

describe('[protocol] Framing', () => {
  it('should read frames split across chunks and several frames in one chunk', () => {
    // Arrange
    const messages: unknown[] = []
    const read = createFrameReader((message) => messages.push(message))

    const stream = Buffer.concat([
      encodeFrame({ id: 1, text: 'žluťoučký' }),
      encodeFrame({ id: 2 }),
      encodeFrame({ id: 3 }),
    ])

    // Act
    read(stream.subarray(0, 3))
    read(stream.subarray(3, 20))
    read(stream.subarray(20))

    // Assert
    assert.deepEqual(messages, [{ id: 1, text: 'žluťoučký' }, { id: 2 }, { id: 3 }])
  })

  it('should read lines split across chunks', () => {
    // Arrange
    const messages: unknown[] = []
    const read = createLineReader((message) => messages.push(message))
    const stream = `${encodeLine({ id: 1, text: 'two\nlines' })}${encodeLine({ id: 2 })}`

    // Act
    read(stream.slice(0, 5))
    read(stream.slice(5))

    // Assert
    assert.deepEqual(messages, [{ id: 1, text: 'two\nlines' }, { id: 2 }])
  })

  it('should throw once an unfinished line runs past the line limit, before it ends', () => {
    // Arrange
    const messages: unknown[] = []
    const read = createLineReader((message) => messages.push(message), 16)
    read(encodeLine({ id: 1 }))

    // Act + Assert
    assert.throws(() => read('{"text":"far too long'), /A line runs past 16 characters/u)
    assert.deepEqual(messages, [{ id: 1 }])
  })

  it('should keep a full upload chunk request under the host message limit', () => {
    // Arrange
    const params = {
      uploadId: '6f1c2b0e-4d3a-4f5e-9a8b-7c6d5e4f3a2b',
      index: 9999,
      data: Buffer.alloc(FILE_CHUNK_BYTES, 0xff).toString('base64'),
    }

    // Act
    const frame = encodeFrame({
      type: 'request',
      id: Number.MAX_SAFE_INTEGER,
      method: 'slackUploadChunk',
      params: SLACK_BRIDGE_METHODS.slackUploadChunk.params.parse(params),
    })

    // Assert
    assert.ok(frame.length <= HOST_MESSAGE_MAX_BYTES, `${frame.length} bytes`)
  })
})
