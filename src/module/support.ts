import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from './tool.js'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
const TEMP_DIR_NAME = 'misha-browser'

// stderr only: an MCP server speaks JSON-RPC on stdout.
export const logWarning = (context: string, message: string): void => {
  process.stderr.write(`WARN  [${context}] ${message}\n`)
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return '0 B'
  }

  const index = Math.floor(Math.log(bytes) / Math.log(1024))

  return `${(bytes / Math.pow(1024, index)).toFixed(1)} ${BYTE_UNITS[index]}`
}

export const tempPath = (prefix: string, extension: string): string => {
  const dir = join(tmpdir(), TEMP_DIR_NAME)
  mkdirSync(dir, { recursive: true })

  return join(dir, `${prefix}-${randomUUID()}${extension}`)
}

export const hasContent = (path: string): boolean => existsSync(path) && statSync(path).size > 0

// A file only this process made; a failed delete is reported and does not fail the call that made the file.
export const removeTempFile = (path: string): void => {
  try {
    rmSync(path, { force: true })
  } catch (error) {
    logWarning('TempFile', `Failed to delete temp file "${path}": ${errorMessage(error)}`)
  }
}

export interface ILoadOnce<TValue> {
  // Starts the load on the first call; later calls, concurrent ones included, share it.
  readonly load: () => Promise<TValue>
}

// One load shared by every caller. A failed attempt is not kept, so the next call tries again.
export const loadOnce = <TValue>(load: () => Promise<TValue>): ILoadOnce<TValue> => {
  let loading: Promise<TValue> | null = null

  return {
    load: () => {
      if (loading === null) {
        const attempt: Promise<TValue> = load().catch((error: unknown) => {
          if (loading === attempt) {
            loading = null
          }

          throw error
        })

        loading = attempt
      }

      return loading
    },
  }
}
