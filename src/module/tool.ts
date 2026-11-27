import { z } from 'zod'

// The harness-neutral tool contract the browser and desktop modules implement, structurally the one Misha's extension
// modules implement, so a Misha extension serves them through a one-line entry without either package importing the
// other. One module is served unchanged by misha-browser's own MCP server and by any host that reads the contract.
// Neither host's types appear in module code.

// The per-call context. directory is the folder the call runs for; a tool never reads process.cwd() itself. progress
// is a long call's keep-alive: an MCP server sends a progress notification when the client asked for progress.
export interface IToolContext {
  readonly directory: string
  readonly signal: AbortSignal
  readonly progress: (title: string) => void
}

// A file a tool hands back beside its text, as a base64 data: URL (data:<mime>;base64,<data>).
export interface IToolAttachment {
  readonly mime: string
  readonly url: string
  readonly filename?: string
}

export type ToolOutput = string | { readonly text: string; readonly attachments: readonly IToolAttachment[] }

export interface IToolDefinition<TInput extends z.ZodObject = z.ZodObject> {
  readonly description: string
  // A zod 4 object, the input's only declaration. A host validates a call with its parse and shows its JSON Schema,
  // which the module's own definition converts (IModuleDefinition.jsonSchema).
  readonly input: TInput
  // Method syntax makes the parameter bivariant, so one tool map holds every input shape.
  execute(args: z.output<TInput>, context: IToolContext): ToolOutput | Promise<ToolOutput>
}

// What a module's factory is given: the folder its tools run for.
export interface IModuleEnv {
  readonly directory: string
}

// A module's tools, keyed by tool name in the order hosts list them, and what to stop when its host lets it go.
export interface IModule {
  readonly tools: Readonly<Record<string, IToolDefinition>>
  readonly dispose?: () => Promise<void>
}

// The JSON Schema a host asks for, in the draft the host reads, named as zod 4 names them.
export interface IJsonSchemaRequest {
  readonly io: 'input' | 'output'
  readonly target: 'draft-2020-12' | 'draft-7' | 'openapi-3.0'
}

// A module as a host loads it. create builds the services and tools and must not throw on a missing grant or browser:
// the tools that need what is missing fail at call time. jsonSchema converts a tool's input with this package's zod,
// which keeps the .describe() texts the model reads in its own registry, so a host converting with another zod copy
// would drop them.
export interface IModuleDefinition {
  readonly create: (env: IModuleEnv) => IModule | Promise<IModule>
  readonly jsonSchema: (input: z.ZodObject, request: IJsonSchemaRequest) => Record<string, unknown>
}

// A field zod cannot represent in JSON Schema becomes any.
export const zodJsonSchema = (input: z.ZodObject, { io, target }: IJsonSchemaRequest): Record<string, unknown> =>
  z.toJSONSchema(input, { io, target, unrepresentable: 'any' })

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'EXTERNAL_API_ERROR'
  | 'INTERNAL_ERROR'

// An expected failure of a tool. A host turns a thrown error into the call's error with its message (an MCP server as
// `<tool> failed: <message>`); the code is for the module's own code to read.
export class PluginError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code

// Checked when a tool runs, never when its module loads, so the tools stay listed and say why they cannot run.
export const requireMacOs = (feature: string): void => {
  if (process.platform !== 'darwin') {
    throw new PluginError(`${feature} is macOS-only. Current platform: ${process.platform}.`, 'VALIDATION_ERROR')
  }
}
