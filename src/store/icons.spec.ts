import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { opaqueBounds } from './png-pixels.js'

const ICON_DIR = fileURLToPath(new URL('../../src/extension/icons', import.meta.url))
// Chrome Web Store's image guidance for the 128-pixel icon: artwork within a centred 96-pixel square, 16 transparent
// pixels on each side.
const STORE_ICON_ARTWORK = 96
const STORE_ICON_PADDING = 16

describe('[store] Icons', () => {
  it("should draw the 128-pixel icon's artwork within a centred 96-pixel square with 16 transparent pixels each side", () => {
    // Act
    const bounds = opaqueBounds(readFileSync(join(ICON_DIR, 'misha-128.png')))

    // Assert
    const artwork = Math.max(bounds.right - bounds.left + 1, bounds.bottom - bounds.top + 1)
    const padding = Math.min(
      bounds.left,
      bounds.top,
      bounds.width - 1 - bounds.right,
      bounds.height - 1 - bounds.bottom
    )
    assert.deepEqual([bounds.width, bounds.height, artwork], [128, 128, STORE_ICON_ARTWORK])
    assert.ok(padding >= STORE_ICON_PADDING)
  })

  it('should render each runtime icon at the size its name gives', () => {
    // Act
    const sizes = [16, 32, 48].map((size) => {
      const { width, height } = opaqueBounds(readFileSync(join(ICON_DIR, `misha-${size}.png`)))

      return [width, height]
    })

    // Assert
    assert.deepEqual(sizes, [
      [16, 16],
      [32, 32],
      [48, 48],
    ])
  })
})
