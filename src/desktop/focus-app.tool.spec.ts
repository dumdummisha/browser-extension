import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { invokeTool, pretendPlatform } from '../module/testing.js'
import { focusAppTool } from './focus-app.tool.js'

const HOST_BUNDLE_ID_VARIABLE = '__CFBundleIdentifier'

describe('[desktop] App focus - off macOS', () => {
  let restorePlatform = (): void => undefined
  const hostBundleId = process.env[HOST_BUNDLE_ID_VARIABLE]

  afterEach(() => {
    restorePlatform()

    if (hostBundleId === undefined) {
      Reflect.deleteProperty(process.env, HOST_BUNDLE_ID_VARIABLE)
    } else {
      process.env[HOST_BUNDLE_ID_VARIABLE] = hostBundleId
    }
  })

  it('should say the tool is macOS-only before asking for the app the host does not report', async () => {
    // Arrange
    restorePlatform = pretendPlatform('linux')
    Reflect.deleteProperty(process.env, HOST_BUNDLE_ID_VARIABLE)

    // Act
    const attempt = invokeTool(focusAppTool, {})

    // Assert
    await assert.rejects(attempt, { name: 'PluginError', message: 'App focus is macOS-only. Current platform: linux.' })
  })

  it('should say the tool is macOS-only for a named app', async () => {
    // Arrange
    restorePlatform = pretendPlatform('linux')

    // Act
    const attempt = invokeTool(focusAppTool, { app: 'Terminal' })

    // Assert
    await assert.rejects(attempt, { name: 'PluginError', message: 'App focus is macOS-only. Current platform: linux.' })
  })
})
