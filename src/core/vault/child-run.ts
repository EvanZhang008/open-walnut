/**
 * Run a helper program (`security`, `bw`) for the vault: a child process with a deadline,
 * its output kept in memory only (it may be a password or a whole export) and never logged.
 * Never a sync call on the event loop. Tests swap the runner (setVaultRunnerForTest).
 */
import { spawn } from 'node:child_process'

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type VaultRunner = (cmd: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; maxBytes?: number }) => Promise<RunResult>

const DEFAULT_MAX = 64 * 1024 * 1024

const realRunner: VaultRunner = (cmd, args, opts) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env ?? process.env })
  } catch (err) {
    resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: (err as Error).message })
    return
  }
  const out: Buffer[] = []
  const err: Buffer[] = []
  let size = 0
  let timedOut = false
  let done = false
  const max = opts.maxBytes ?? DEFAULT_MAX
  const finish = (r: RunResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeoutMs)
  timer.unref?.()
  child.stdout?.on('data', (c: Buffer) => {
    size += c.length
    if (size > max) { child.kill('SIGKILL'); return }
    out.push(c)
  })
  child.stderr?.on('data', (c: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(c) })
  child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', timedOut, error: e.message }))
  child.on('close', (code) => finish({
    code: size > max ? null : code, stdout: size > max ? '' : Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8').slice(0, 2000), timedOut,
    ...(size > max ? { error: 'output too large' } : {}),
  }))
})

let runner: VaultRunner = realRunner

export function runVaultHelper(cmd: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; maxBytes?: number }): Promise<RunResult> {
  return runner(cmd, args, opts)
}

export function setVaultRunnerForTest(r: VaultRunner | null): void {
  runner = r ?? realRunner
}
