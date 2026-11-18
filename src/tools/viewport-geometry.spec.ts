import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TargetPoint } from '../protocol/tab.js'
import { estimatedViewportOffset, measuredViewportOffset, screenPoint } from './viewport-geometry.js'

// A 1200x800 window at (100, 50) at 125% zoom, whose 960x568 CSS pixel viewport fills 1200x710 points of it.
const TAB = { zoom: 1.25, windowBounds: { left: 100, top: 50, width: 1200, height: 800 } }
const TARGET: TargetPoint = { innerWidth: 960, innerHeight: 568, clientX: 200, clientY: 100, hasScrolled: false }

describe('[tools] Viewport geometry', () => {
  it('should estimate the viewport below the toolbar and scale the point by zoom', () => {
    // Act
    const point = screenPoint(TARGET, estimatedViewportOffset(TARGET, TAB), TAB)

    // Assert
    assert.deepEqual(point, { x: 100 + 0 + 250, y: 50 + 90 + 125 })
  })

  it('should put the extra window width to the left, where a sidebar sits', () => {
    // Arrange
    const narrower = { ...TARGET, innerWidth: 800 }

    // Act
    const point = screenPoint(narrower, estimatedViewportOffset(narrower, TAB), TAB)

    // Assert
    assert.deepEqual(point, { x: 100 + 200 + 250, y: 50 + 90 + 125 })
  })

  it('should measure the offset from where the page saw the resting pointer', () => {
    // Arrange - the pointer at (400, 300) landed at client (180, 120), so the viewport origin is (175, 150)
    const offset = measuredViewportOffset({ clientX: 180, clientY: 120 }, { x: 400, y: 300 }, TAB)

    // Act
    const point = screenPoint(TARGET, offset, TAB)

    // Assert
    assert.deepEqual({ offset, point }, { offset: { x: 75, y: 100 }, point: { x: 175 + 250, y: 150 + 125 } })
  })
})
