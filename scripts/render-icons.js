import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'

const ICON_DIR = 'src/extension/icons'
const SOURCE = `${ICON_DIR}/misha.svg`
// The sizes Chrome's manifest documentation names for icons.
const SIZES = [16, 32, 48, 128]
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
// The chunks that hold only pixels and how to render them. sips also writes an eXIf chunk (the colour space and the
// image size) and has no option to leave it out; a public repository ships no metadata it does not need, so every chunk
// outside this set is dropped. Each chunk carries its own CRC, so dropping whole chunks leaves the rest valid.
const RENDER_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'bKGD', 'IDAT', 'IEND'])
// The PNG specification's chunk layout: a 4-byte data length and a 4-byte type, then the data and a 4-byte CRC computed
// over the type and the data. A chunk type is four ASCII letters. IHDR always carries 13 bytes of data and IEND none.
const CHUNK_HEADER_LENGTH = 8
const CHUNK_CRC_LENGTH = 4
const CHUNK_TYPE = /^[A-Za-z]{4}$/u
const CHUNK_DATA_LENGTHS = new Map([
  ['IHDR', 13],
  ['IEND', 0],
])

/**
 * Reads the chunk at the offset and rejects one that does not fit in the file, whose type is not four ASCII letters,
 * whose CRC does not match its type and data, or whose data length differs from the one its type requires.
 *
 * @param {Uint8Array} png
 * @param {DataView} view
 * @param {number} offset
 * @param {string} path
 * @returns {{ type: string, end: number }}
 */
const readChunk = (png, view, offset, path) => {
  if (offset === png.length) {
    throw new Error(`${path} is not a complete PNG: it ends without an IEND chunk`)
  }

  if (offset + CHUNK_HEADER_LENGTH > png.length) {
    throw new Error(`${path} is not a complete PNG: it ends inside the chunk header at byte ${offset}`)
  }

  const type = String.fromCharCode(...png.subarray(offset + 4, offset + CHUNK_HEADER_LENGTH))
  if (!CHUNK_TYPE.test(type)) {
    throw new Error(`${path} is not a valid PNG: the chunk type at byte ${offset} is not four ASCII letters`)
  }

  const length = view.getUint32(offset)
  const end = offset + CHUNK_HEADER_LENGTH + length + CHUNK_CRC_LENGTH
  if (end > png.length) {
    throw new Error(`${path} is not a complete PNG: its ${type} chunk at byte ${offset} runs past the end of the file`)
  }

  if (crc32(png.subarray(offset + 4, end - CHUNK_CRC_LENGTH)) !== view.getUint32(end - CHUNK_CRC_LENGTH)) {
    throw new Error(`${path} is not a valid PNG: its ${type} chunk at byte ${offset} fails its CRC check`)
  }

  const requiredLength = CHUNK_DATA_LENGTHS.get(type)
  if (requiredLength !== undefined && length !== requiredLength) {
    throw new Error(
      `${path} is not a valid PNG: its ${type} chunk has a data length of ${length}, not ${requiredLength}`
    )
  }

  return { type, end }
}

/**
 * Rejects a chunk out of the PNG specification's order: one IHDR first, consecutive IDAT chunks, and IEND only after
 * image data.
 *
 * @param {string} type
 * @param {string} previous the type of the chunk before it, or an empty string for the first chunk
 * @param {Set<string>} seen the types of every chunk before it
 * @param {string} path
 */
const checkChunkOrder = (type, previous, seen, path) => {
  if (previous === '' && type !== 'IHDR') {
    throw new Error(`${path} is not a valid PNG: its first chunk is ${type}, not IHDR`)
  }

  if (previous !== '' && type === 'IHDR') {
    throw new Error(`${path} is not a valid PNG: it has more than one IHDR chunk`)
  }

  if (type === 'IDAT' && seen.has('IDAT') && previous !== 'IDAT') {
    throw new Error(`${path} is not a valid PNG: its IDAT chunks are not consecutive`)
  }

  if (type === 'IEND' && !seen.has('IDAT')) {
    throw new Error(`${path} is not a valid PNG: it has no IDAT chunk`)
  }
}

/**
 * Returns the PNG with only its render chunks, and rejects anything that is not one complete PNG: the signature, then
 * whole chunks with valid types and CRCs in the specification's order, and a zero-length IEND as the last bytes of the
 * file.
 *
 * @param {Uint8Array} png
 * @param {string} path
 * @returns {Uint8Array}
 */
const keepRenderChunks = (png, path) => {
  if (png.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new Error(`${path} is not a PNG: it does not start with the PNG signature`)
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const kept = [PNG_SIGNATURE]
  /** @type {Set<string>} */
  const seen = new Set()
  let offset = PNG_SIGNATURE.length
  let previous = ''
  while (previous !== 'IEND') {
    const { type, end } = readChunk(png, view, offset, path)
    checkChunkOrder(type, previous, seen, path)
    if (RENDER_CHUNKS.has(type)) {
      kept.push(png.subarray(offset, end))
    }

    seen.add(type)
    previous = type
    offset = end
  }

  if (offset !== png.length) {
    throw new Error(`${path} is not a valid PNG: ${png.length - offset} bytes follow its IEND chunk`)
  }

  const result = new Uint8Array(kept.reduce((length, chunk) => length + chunk.length, 0))
  let written = 0
  for (const chunk of kept) {
    result.set(chunk, written)
    written += chunk.length
  }

  return result
}

for (const size of SIZES) {
  const target = `${ICON_DIR}/misha-${size}.png`
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', `${size}`, `${size}`, SOURCE, '--out', target], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  /** @type {Uint8Array} */
  const rendered = readFileSync(target)
  writeFileSync(target, keepRenderChunks(rendered, target))
}

process.stdout.write(`Rendered ${SIZES.map((size) => `misha-${size}.png`).join(', ')} in ${ICON_DIR}/\n`)
