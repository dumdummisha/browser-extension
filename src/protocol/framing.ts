// Chrome native messaging frames each JSON message with its byte length as a 32-bit integer in native byte order,
// which is little-endian on every Mac. The relay's socket clients (the app, and any process that drives the browser)
// carry one JSON message per line instead. Node only: the extension's side of the pipe is Chrome's port.
const FRAME_HEADER_BYTES = 4

// Chrome refuses a message from the native host larger than this and closes the pipe; messages to the host may be far
// larger. So every frame the relay writes to the extension must fit, which is why files travel in chunks.
export const HOST_MESSAGE_MAX_BYTES = 1024 * 1024

export const encodeFrame = (message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt32LE(body.length, 0)

  return Buffer.concat([header, body])
}

export const createFrameReader = (onMessage: (message: unknown) => void): ((chunk: Buffer) => void) => {
  let buffer = Buffer.alloc(0)

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])

    while (buffer.length >= FRAME_HEADER_BYTES) {
      const end = FRAME_HEADER_BYTES + buffer.readUInt32LE(0)
      if (buffer.length < end) {
        return
      }

      const message: unknown = JSON.parse(buffer.subarray(FRAME_HEADER_BYTES, end).toString('utf8'))
      buffer = buffer.subarray(end)
      onMessage(message)
    }
  }
}

// JSON.stringify escapes the newlines inside strings, so a line always holds exactly one message.
export const encodeLine = (message: unknown): string => `${JSON.stringify(message)}\n`

export const createLineReader = (onMessage: (message: unknown) => void): ((chunk: string) => void) => {
  let buffer = ''

  return (chunk) => {
    const lines = `${buffer}${chunk}`.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const message: unknown = JSON.parse(line)
      onMessage(message)
    }
  }
}
