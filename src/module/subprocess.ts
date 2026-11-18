import { execFile, type ExecFileException } from 'node:child_process'
import { isErrnoCode, PluginError } from './tool.js'

export interface IRunSubprocessOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly label: string
  readonly signal?: AbortSignal
  readonly notFoundHint?: string
}

export interface ISubprocessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

// A command that exits with a code resolves with it; one that could not start, timed out or was aborted rejects.
export const runSubprocess = ({
  command,
  args,
  timeoutMs,
  label,
  signal,
  notFoundHint,
}: IRunSubprocessOptions): Promise<ISubprocessResult> => {
  if (signal?.aborted === true) {
    return Promise.reject(new PluginError(`${label} was aborted before it started.`, 'ABORTED'))
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', signal, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 })
        } else if (error.name === 'AbortError') {
          // Node aborts with SIGTERM, which a child may ignore.
          child.kill('SIGKILL')
          reject(new PluginError(`${label} was aborted.`, 'ABORTED'))
        } else if (error.killed === true) {
          reject(new PluginError(`${label} timed out after ${timeoutMs / 1000}s.`, 'TIMEOUT'))
        } else if (typeof error.code === 'string') {
          reject(spawnError(label, error, notFoundHint))
        } else {
          resolve({ stdout, stderr, exitCode: error.code ?? -1 })
        }
      }
    )

    // A child that exits before reading its input closes the pipe; its exit code reports that.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end()
  })
}

const spawnError = (label: string, error: ExecFileException, notFoundHint: string | undefined): PluginError =>
  isErrnoCode(error, 'ENOENT') && notFoundHint !== undefined
    ? new PluginError(`${label} is not installed or not on PATH. ${notFoundHint}`, 'INTERNAL_ERROR', error)
    : new PluginError(`Failed to spawn ${label}: ${error.message}`, 'INTERNAL_ERROR', error)
