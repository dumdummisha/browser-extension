import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RunningApp } from './app-focus.js'
import { findRunningApp } from './app-focus.js'

const runningApp = (name: string, bundleId: string, pid: number): RunningApp => ({
  name,
  bundleId,
  pid,
  isFrontmost: false,
  isHidden: false,
})

const NOTES = runningApp('Notes', 'com.example.notes', 101)
const MAIL = runningApp('Mail', 'com.example.mail', 102)
const NAMED_LIKE_A_BUNDLE = runningApp('com.example.mail', 'com.example.other', 103)

describe('[desktop] App focus - finding a running app', () => {
  it('should find an app by its exact bundle id', () => {
    // Act
    const app = findRunningApp([NOTES, MAIL], 'com.example.mail')

    // Assert
    assert.deepEqual(app, MAIL)
  })

  it('should find an app by its name regardless of case', () => {
    // Act
    const app = findRunningApp([NOTES, MAIL], 'mAIL')

    // Assert
    assert.deepEqual(app, MAIL)
  })

  it('should prefer a bundle id match over a name match', () => {
    // Act
    const app = findRunningApp([NAMED_LIKE_A_BUNDLE, MAIL], 'com.example.mail')

    // Assert
    assert.deepEqual(app, MAIL)
  })

  it('should not match a bundle id that differs only in case', () => {
    // Act
    const app = findRunningApp([NOTES, MAIL], 'COM.EXAMPLE.NOTES')

    // Assert
    assert.equal(app, undefined)
  })

  it('should return undefined when no app matches', () => {
    // Act
    const app = findRunningApp([NOTES, MAIL], 'Calendar')

    // Assert
    assert.equal(app, undefined)
  })
})
