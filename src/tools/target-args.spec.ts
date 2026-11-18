import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clickTarget, describeTarget } from './target-args.js'

describe('[tools] Tool arguments - click and drag targets', () => {
  it('should take a ref alone as an element target', () => {
    // Act
    const target = clickTarget(12, undefined, undefined, 'click target')

    // Assert
    assert.deepStrictEqual(target, { ref: 12 })
    assert.equal(describeTarget(target), 'element 12')
  })

  it('should take x and y together as a viewport point', () => {
    // Act
    const target = clickTarget(undefined, 640, 0, 'drag start')

    // Assert
    assert.deepStrictEqual(target, { point: { clientX: 640, clientY: 0 } })
    assert.equal(describeTarget(target), 'point (640, 0)')
  })

  for (const [label, ref, x, y] of [
    ['a ref with a point', 12, 1, 2],
    ['x without y', undefined, 1, undefined],
    ['y without x', undefined, undefined, 2],
    ['nothing at all', undefined, undefined, undefined],
  ] as const) {
    it(`should refuse ${label}`, () => {
      // Act + Assert
      assert.throws(() => clickTarget(ref, x, y, 'drag target'), {
        name: 'PluginError',
        message: 'Give the drag target either as a ref, or as x and y together.',
      })
    })
  }
})
