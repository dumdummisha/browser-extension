import { inflateSync } from 'node:zlib'

// The box of a PNG's pixels that are not fully transparent, in pixels from its top left corner, edges included.
interface IOpaqueBounds {
  readonly width: number
  readonly height: number
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

// The PNG specification's layout: the 8-byte signature, then chunks of a 4-byte length, a 4-byte type, the data and a
// 4-byte CRC. IHDR holds the width and height, the bit depth at byte 8, the colour type at 9 and the interlace method at
// 12. Each row of the inflated image data starts with its filter type byte.
const SIGNATURE_LENGTH = 8
const CHUNK_OVERHEAD = 12
const RGBA_COLOUR_TYPE = 6
const BYTES_PER_PIXEL = 4
const ALPHA_OFFSET = 3

// The PNG specification's Paeth predictor: whichever neighbour is nearest to left + up - upLeft.
const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left
  }

  return toUp <= toUpLeft ? up : upLeft
}

const unfiltered = (filter: number, raw: number, left: number, up: number, upLeft: number): number => {
  switch (filter) {
    case 0:
      return raw
    case 1:
      return raw + left
    case 2:
      return raw + up
    case 3:
      return raw + Math.floor((left + up) / 2)
    case 4:
      return raw + paeth(left, up, upLeft)
    default:
      throw new Error(`A PNG row has filter type ${filter}, which the PNG specification does not define`)
  }
}

// The pixels of an 8-bit RGBA PNG without interlacing, the form sips renders, one byte per channel, row after row.
const rgbaPixels = (png: Uint8Array): { readonly width: number; readonly height: number; readonly pixels: Buffer } => {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  const data: Buffer[] = []
  let header: Buffer | null = null

  for (let offset = SIGNATURE_LENGTH; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      header = body
    } else if (type === 'IDAT') {
      data.push(body)
    }

    offset += CHUNK_OVERHEAD + length
  }

  if (header?.[8] !== 8 || header[9] !== RGBA_COLOUR_TYPE || header[12] !== 0) {
    throw new Error('Only an 8-bit RGBA PNG without interlacing can be read')
  }

  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const stride = width * BYTES_PER_PIXEL
  const raw = inflateSync(Buffer.concat(data))
  const pixels = Buffer.alloc(height * stride)

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0

    for (let column = 0; column < stride; column += 1) {
      const at = row * stride + column
      const left = column >= BYTES_PER_PIXEL ? (pixels[at - BYTES_PER_PIXEL] ?? 0) : 0
      const up = row > 0 ? (pixels[at - stride] ?? 0) : 0
      const upLeft = column >= BYTES_PER_PIXEL && row > 0 ? (pixels[at - stride - BYTES_PER_PIXEL] ?? 0) : 0

      pixels[at] = unfiltered(filter, raw[row * (stride + 1) + 1 + column] ?? 0, left, up, upLeft) % 256
    }
  }

  return { width, height, pixels }
}

export const opaqueBounds = (png: Uint8Array): IOpaqueBounds => {
  const { width, height, pixels } = rgbaPixels(png)
  const bounds = { left: width, top: height, right: -1, bottom: -1 }

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if ((pixels[(row * width + column) * BYTES_PER_PIXEL + ALPHA_OFFSET] ?? 0) > 0) {
        bounds.left = Math.min(bounds.left, column)
        bounds.right = Math.max(bounds.right, column)
        bounds.top = Math.min(bounds.top, row)
        bounds.bottom = Math.max(bounds.bottom, row)
      }
    }
  }

  if (bounds.right < 0) {
    throw new Error('The PNG has no pixel that is not fully transparent')
  }

  return { width, height, ...bounds }
}
