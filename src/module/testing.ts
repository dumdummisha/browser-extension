import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { z } from 'zod'
import type { IToolContext, IToolDefinition } from './tool.js'

// Spec helpers: a tool called as a host calls it, a platform a spec pretends to run on, and a folder of the test's own.

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

// A folder of the test's own in the system's temporary folder, removed with what it holds once the test ends.
export const temporaryDirectory = async (context: TestContext, prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  context.after(() => rm(dir, { recursive: true, force: true }))

  return dir
}
