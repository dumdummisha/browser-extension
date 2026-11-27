import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  type ImageContent,
  ListToolsRequestSchema,
  McpError,
  type ServerNotification,
  type ServerRequest,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js'
import {
  errorMessage,
  type IModule,
  type IModuleDefinition,
  type IToolAttachment,
  type IToolContext,
  type IToolDefinition,
  type ToolOutput,
} from '../module/tool.js'

const SERVER_NAME = 'misha-browser'

export interface ICreatedModule {
  readonly definition: IModuleDefinition
  readonly instance: IModule
}

const BASE64_DATA_URL = /^data:[^;,]+;base64,/u

const reportWarning = (message: string): void => {
  process.stderr.write(`WARN  [mcp] ${message}\n`)
}

// An attachment as MCP content: an image as an image block, anything else as a line naming it. A URL that is not a
// base64 data: URL breaks the tool contract and is an error, never a guess at its content.
const attachmentContent = ({ mime, url, filename }: IToolAttachment): TextContent | ImageContent => {
  const prefix = BASE64_DATA_URL.exec(url)?.[0]
  if (prefix === undefined) {
    throw new Error(`An attachment must be a base64 data: URL, not one starting ${JSON.stringify(url.slice(0, 32))}`)
  }

  return mime.startsWith('image/')
    ? { type: 'image', data: url.slice(prefix.length), mimeType: mime }
    : { type: 'text', text: `Attachment: ${filename ?? 'file'} (${mime})` }
}

const toolContent = (output: ToolOutput): (TextContent | ImageContent)[] =>
  typeof output === 'string'
    ? [{ type: 'text', text: output }]
    : [{ type: 'text', text: output.text }, ...output.attachments.map(attachmentContent)]

// Claude Code aborts a call that stays silent past its idle timeout, so progress becomes MCP progress notifications
// whenever the client sent a progress token.
const toContext = (
  directory: string,
  { signal, _meta, sendNotification }: RequestHandlerExtra<ServerRequest, ServerNotification>
): IToolContext => {
  const progressToken = _meta?.progressToken
  let progress = 0

  return {
    directory,
    signal,
    progress: (message) => {
      if (progressToken === undefined) {
        return
      }

      progress += 1

      sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } }).catch(
        (error: unknown) => reportWarning(`A progress notification failed: ${errorMessage(error)}`)
      )
    },
  }
}

// The tools of every module, by name, in module order. Two modules serving one name is an error naming it, since a
// client would reach only one of them.
const toolsOf = (modules: readonly ICreatedModule[]): Map<string, IToolDefinition> => {
  const tools = new Map<string, IToolDefinition>()

  for (const [name, tool] of modules.flatMap(({ instance }) => Object.entries(instance.tools))) {
    if (tools.has(name)) {
      throw new Error(`Two modules serve the tool ${name}`)
    }

    tools.set(name, tool)
  }

  return tools
}

// An MCP server of the modules' tools for calls run for directory: each call's arguments are parsed by the tool's own
// schema, and a call that fails answers `<tool> failed: <message>` as an error result.
export const createToolServer = (modules: readonly ICreatedModule[], directory: string, version: string): Server => {
  const tools = toolsOf(modules)

  const listing = modules.flatMap(({ definition, instance }) =>
    Object.entries(instance.tools).map(([name, tool]) => {
      const { $schema: _draft, ...inputSchema } = definition.jsonSchema(tool.input, {
        io: 'input',
        target: 'draft-2020-12',
      })

      return { name, description: tool.description, inputSchema: { ...inputSchema, type: 'object' as const } }
    })
  )

  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listing }))

  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const tool = tools.get(params.name)
    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`)
    }

    try {
      const output = await tool.execute(tool.input.parse(params.arguments ?? {}), toContext(directory, extra))

      return { content: toolContent(output) }
    } catch (error) {
      return { content: [{ type: 'text', text: `${params.name} failed: ${errorMessage(error)}` }], isError: true }
    }
  })

  return server
}
