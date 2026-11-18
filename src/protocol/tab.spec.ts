import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SLACK_BRIDGE_METHODS } from './slack.js'
import { TAB_BRIDGE_METHODS } from './tab.js'

describe('[protocol] Tab methods', () => {
  it('should name no method the Slack half names, so a tab command never stands in for a Slack call', () => {
    // Act
    const shared = Object.keys(TAB_BRIDGE_METHODS).filter((method) => Object.hasOwn(SLACK_BRIDGE_METHODS, method))

    // Assert
    assert.deepEqual(shared, [])
  })

  it('should take a page method in a named tab or in the active one', () => {
    // Act
    const inTab = TAB_BRIDGE_METHODS.locate.params.parse({ tabId: 3, ref: 12 })
    const inActiveTab = TAB_BRIDGE_METHODS.locate.params.parse({})

    // Assert
    assert.deepEqual([inTab, inActiveTab], [{ tabId: 3, ref: 12 }, {}])
  })

  it('should refuse params a method does not declare', () => {
    // Act
    const parsed = TAB_BRIDGE_METHODS.closeTab.params.safeParse({ tabId: 3, credentialsFile: 'session.headers' })

    // Assert
    assert.equal(parsed.success, false)
  })

  it('should take only a JPEG data URL as a screenshot', () => {
    // Act
    const jpeg = TAB_BRIDGE_METHODS.screenshot.result.safeParse({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    const remote = TAB_BRIDGE_METHODS.screenshot.result.safeParse({ dataUrl: 'https://example.com/shot.jpg' })

    // Assert
    assert.deepEqual([jpeg.success, remote.success], [true, false])
  })
})
