/**
 * The ONE way Rhythm starts a process: asynchronous, argument vector (never a shell),
 * a hard deadline, and a bounded output buffer. The server entry shares the Walnut
 * server's event loop, so nothing here may ever be synchronous.
 */
import { execFile } from 'node:child_process'

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not start, timed out, or exited non-zero. */
  error?: string
}

export type Runner = (command: string, args: readonly string[], options: { timeoutMs: number }) => Promise<RunResult>

const MAX_BUFFER = 1024 * 1024

export const runProcess: Runner = (command, args, options) => new Promise((resolve) => {
  execFile(command, [...args], { timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
    const out = String(stdout ?? '')
    const err = String(stderr ?? '')
    if (!error) {
      resolve({ ok: true, code: 0, stdout: out, stderr: err })
      return
    }
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
    const timedOut = failure.killed === true
    const message = timedOut
      ? `${command} timed out after ${Math.ceil(options.timeoutMs / 1000)}s`
      : failure.code === 'ENOENT'
        ? `${command} is not available on this machine`
        : (err.trim().split('\n')[0] || failure.message)
    resolve({ ok: false, code: typeof failure.code === 'number' ? failure.code : null, stdout: out, stderr: err, error: message })
  })
})
