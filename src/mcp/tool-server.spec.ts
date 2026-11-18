import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { pretendPlatform } from '../module/testing.js'
import { type IModuleDefinition, type IToolDefinition, zodJsonSchema } from '../module/tool.js'
import { browserModule, desktopModule } from '../modules.js'
import { createToolServer, type ICreatedModule } from './tool-server.js'

const TAB_TOOLS = [
  'tab_list',
  'tab_switch',
  'tab_open',
  'tab_close',
  'tab_read',
  'tab_find',
  'tab_wait',
  'tab_screenshot',
  'tab_network',
  'tab_click',
  'tab_drag',
  'tab_type',
  'tab_fill',
  'tab_select_option',
  'tab_press',
  'tab_scroll',
]
const MACOS_TOOLS = [
  'macos_mouse_move',
  'macos_mouse_click',
  'macos_mouse_current_position',
  'macos_mouse_drag',
  'macos_mouse_scroll',
  'macos_keyboard_type',
  'macos_keyboard_press',
  'macos_screen_capture',
  'macos_list_apps',
  'macos_focus_app',
  'macos_convert_video',
]

const echoInput = z.object({ text: z.string().describe('What to echo.') })
const echoTool: IToolDefinition<typeof echoInput> = {
  description: 'Echo the text with a picture.',
  input: echoInput,
  execute: ({ text }) => ({
    text,
    attachments: [{ mime: 'image/png', url: 'data:image/png;base64,iVBORw0K', filename: 'echo.png' }],
  }),
}
const echoModule: IModuleDefinition = { create: () => ({ tools: { echo: echoTool } }), jsonSchema: zodJsonSchema }

const created = async (definitions: readonly IModuleDefinition[]): Promise<ICreatedModule[]> =>
  Promise.all(
    definitions.map(async (definition) => ({ definition, instance: await definition.create({ directory: '/' }) }))
  )

const connect = async (context: TestContext, modules: readonly ICreatedModule[]): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createToolServer(modules, '/', '0.0.0-test')
  const client = new Client({ name: 'spec', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  context.after(async () => {
    await client.close()
    await Promise.all(modules.flatMap(({ instance }) => instance.dispose?.() ?? []))
  })

  return client
}

describe('[mcp] Tool server', () => {
  it('should list every tab and macOS tool with its described input', async (context) => {
    // Arrange
    const client = await connect(context, await created([browserModule, desktopModule]))

    // Act
    const { tools } = await client.listTools()

    // Assert
    const network = tools.find(({ name }) => name === 'tab_network')
    assert.deepEqual(
      tools.map(({ name }) => name),
      [...TAB_TOOLS, ...MACOS_TOOLS]
    )
    assert.deepEqual(Object.keys(network?.inputSchema.properties ?? {}), [
      'tabId',
      'urlContains',
      'includeHeaders',
      'last',
    ])
    assert.ok(tools.every(({ description }) => description !== undefined && description.length > 0))
  })

  it('should answer a tool that fails with its message as an error result', async (context) => {
    // Arrange
    const client = await connect(context, await created([browserModule]))

    // Act
    const result = await client.callTool({ name: 'tab_type', arguments: { text: 'Hello', clear: true } })

    // Assert
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /tab_type failed: clear=true needs a ref/u)
  })

  it('should say a browser tool is macOS-only before it reaches for the browser', async (context) => {
    // Arrange
    const restorePlatform = pretendPlatform('linux')
    context.after(restorePlatform)
    const client = await connect(context, await created([browserModule]))

    // Act
    const result = await client.callTool({ name: 'tab_list', arguments: {} })

    // Assert
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'tab_list failed: Browser control is macOS-only. Current platform: linux.' }],
      isError: true,
    })
  })

  it('should answer an attachment as an image block beside the text', async (context) => {
    // Arrange
    const client = await connect(context, await created([echoModule]))

    // Act
    const result = await client.callTool({ name: 'echo', arguments: { text: 'Hello' } })

    // Assert
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Hello' },
      { type: 'image', data: 'iVBORw0K', mimeType: 'image/png' },
    ])
  })

  it('should refuse two modules that serve one tool name', async () => {
    // Arrange
    const modules = await created([echoModule, echoModule])

    // Act + Assert
    assert.throws(() => createToolServer(modules, '/', '0.0.0-test'), { message: 'Two modules serve the tool echo' })
  })
})
