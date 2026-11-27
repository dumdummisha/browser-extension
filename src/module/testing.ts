import type { z } from 'zod'
import type { IToolContext, IToolDefinition } from './tool.js'

// Spec helpers: a tool called as a host calls it, and a platform a spec pretends to run on.

const createTestToolContext = (): IToolContext => ({
  directory: process.cwd(),
  signal: new AbortController().signal,
  progress: () => undefined,
})

// Calls a tool as a host does: its own schema parses the arguments first.
export const invokeTool = async <TInput extends z.ZodObject>(
  definition: IToolDefinition<TInput>,
  args: z.input<TInput>
): Promise<string> => {
  const output = await definition.execute(definition.input.parse(args), createTestToolContext())

  return typeof output === 'string' ? output : output.text
}

// Makes process.platform report another platform; the returned function restores the real one.
export const pretendPlatform = (platform: NodeJS.Platform): (() => void) => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })

  return () => {
    if (real !== undefined) {
      Object.defineProperty(process, 'platform', real)
    }
  }
}
