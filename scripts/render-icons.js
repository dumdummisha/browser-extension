import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { opaqueBounds } from '../dist/store/png-pixels.js'

const ICON_DIR = 'src/extension/icons'
const SOURCE = `${ICON_DIR}/misha.svg`
// The sizes Chrome's manifest documentation names for icons.
const SIZES = [16, 32, 48, 128]
// Chrome Web Store's image guidance for the 128-pixel icon, which the store lists and Chrome shows on install: the
// artwork fits a centred 96-pixel square with 16 transparent pixels on each side. The smaller toolbar sizes take the
// artwork on the whole canvas.
const PADDED_SIZE = 128
const PADDED_ARTWORK = 96
// The source's root element, its viewBox and its declared width, in which the artwork is measured.
const SVG_ROOT = /^<svg\b[^>]*>/u
const SVG_VIEW_BOX = /\bviewBox="(?<x>[\d.]+) (?<y>[\d.]+) (?<width>[\d.]+) (?<height>[\d.]+)"/u
const SVG_WIDTH = /\bwidth="(?<width>\d+)"/u
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

/**
 * Renders an SVG file to a square PNG with sips.
 *
 * @param {string} source
 * @param {number} size
 * @param {string} target
 */
const renderPng = (source, size, target) => {
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', `${size}`, `${size}`, source, '--out', target], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

/**
 * The source's artwork as an SVG of PADDED_SIZE pixels whose artwork fills the centred PADDED_ARTWORK square: the
 * artwork's bounds are measured on a render at the source's declared width, and the source's content is drawn into
 * that square through a viewBox around them, made square about their centre.
 *
 * @param {string} svg the source's text
 * @param {string} workDir
 * @returns {string}
 */
const paddedSvg = (svg, workDir) => {
  const root = SVG_ROOT.exec(svg)?.[0]
  const viewBox = root === undefined ? undefined : SVG_VIEW_BOX.exec(root)?.groups
  const declaredWidth = root === undefined ? undefined : SVG_WIDTH.exec(root)?.groups?.width
  if (root === undefined || viewBox === undefined || declaredWidth === undefined) {
    throw new Error(`${SOURCE} must open with an <svg> that declares its viewBox and width`)
  }

  const measureSize = Number(declaredWidth)
  /** @type {string} */
  const measured = join(workDir, 'measured.png')
  renderPng(SOURCE, measureSize, measured)
  /** @type {Uint8Array} */
  const measuredPng = readFileSync(measured)
  const bounds = opaqueBounds(measuredPng)
  const unit = Number(viewBox.width) / measureSize
  const left = Number(viewBox.x) + bounds.left * unit
  const top = Number(viewBox.y) + bounds.top * unit
  const width = (bounds.right + 1 - bounds.left) * unit
  const height = (bounds.bottom + 1 - bounds.top) * unit
  const side = Math.max(width, height)
  const square = [left + (width - side) / 2, top + (height - side) / 2, side, side].join(' ')
  const padding = (PADDED_SIZE - PADDED_ARTWORK) / 2
  const content = svg
    .trim()
    .slice(root.length)
    .replace(/<\/svg>$/u, '')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PADDED_SIZE}" height="${PADDED_SIZE}" ` +
    `viewBox="0 0 ${PADDED_SIZE} ${PADDED_SIZE}"><svg x="${padding}" y="${padding}" width="${PADDED_ARTWORK}" ` +
    `height="${PADDED_ARTWORK}" viewBox="${square}">${content}</svg></svg>`
  )
}

/** @type {string} */
const workDir = mkdtempSync(join(tmpdir(), 'misha-icons-'))
try {
  /** @type {string} */
  const padded = join(workDir, 'padded.svg')
  /** @type {string} */
  const source = readFileSync(SOURCE, 'utf8')
  writeFileSync(padded, paddedSvg(source, workDir))
  for (const size of SIZES) {
    const target = `${ICON_DIR}/misha-${size}.png`
    renderPng(size === PADDED_SIZE ? padded : SOURCE, size, target)
    /** @type {Uint8Array} */
    const rendered = readFileSync(target)
    writeFileSync(target, keepRenderChunks(rendered, target))
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

process.stdout.write(`Rendered ${SIZES.map((size) => `misha-${size}.png`).join(', ')} in ${ICON_DIR}/\n`)
