#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { format } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { errorMessage } from '../module/tool.js'
import { browserModule, desktopModule } from '../modules.js'
import { createToolServer, type ICreatedModule } from './tool-server.js'

// misha-browser's standalone MCP server over stdio (package.json bin misha-browser-mcp): the tab_* and macos_* tools
// for any Claude Code or OpenCode, run for the folder it was started in. stdout carries only JSON-RPC, so its own lines
// and any a module prints go to stderr.

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

const log = (level: 'INFO' | 'ERROR', message: string): void => {
  process.stderr.write(`${level.padEnd(5, ' ')} [mcp] ${message}\n`)
}

// Replacing console's writers keeps a module's or a dependency's console output off the JSON-RPC stream.
const redirectConsoleToStderr = (): void => {
  const write = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`)
  }

  // Replacing console's writers is this guard's whole purpose; nothing here logs through console.
  // oxlint-disable-next-line no-console
  console.log = write
  // oxlint-disable-next-line no-console
  console.info = write
  // oxlint-disable-next-line no-console
  console.debug = write
}

// The client ends the server by closing its stdin, then by signalling it: either way every module is disposed first.
const exitWhenClientLeaves = (modules: readonly ICreatedModule[]): void => {
  let isShuttingDown = false
  const shutdown = (reason: string): void => {
    if (isShuttingDown) {
      return
    }

    isShuttingDown = true
    log('INFO', `Shutting down: ${reason}`)
    Promise.all(modules.flatMap(({ instance }) => instance.dispose?.() ?? [])).then(
      () => process.exit(0),
      (error: unknown) => {
        log('ERROR', `Disposing the modules failed: ${errorMessage(error)}`)
        process.exit(1)
      }
    )
  }

  process.stdin.once('end', () => shutdown('stdin closed'))
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => shutdown(signal))
  }
}

const main = async (): Promise<void> => {
  redirectConsoleToStderr()
  const directory = process.cwd()
  const modules = await Promise.all(
    [browserModule, desktopModule].map(async (definition) => ({
      definition,
      instance: await definition.create({ directory }),
    }))
  )
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')))

  await createToolServer(modules, directory, version).connect(new StdioServerTransport())
  exitWhenClientLeaves(modules)
  log('INFO', `Ready: ${modules.reduce((count, { instance }) => count + Object.keys(instance.tools).length, 0)} tools`)
}

main().catch((error: unknown) => {
  log(
    'ERROR',
    `misha-browser's MCP server failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  )
  process.exit(1)
})
