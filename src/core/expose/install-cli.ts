/**
 * A tunnel provider's `installCommand` (types.ts), run by the supervisor when its CLI
 * is not found. It runs under `sh -c` in its own process group, from the home dir (never
 * the server's working dir: on a host that is the replica's data dir). A timeout or a
 * stopping server ends the whole group (`curl ... | sh` forks), and the answer comes only
 * once its output closed: a Retry never starts a second install beside one still running.
 * A detached group outlives the server's own group stop, so the supervisor aborts it on
 * shutdown (ExposeSupervisor.shutdown).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { safeKillProcessGroup } from '../process-group-kill.js'

export interface InstallResult { ok: boolean; output: string }

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const KEEP_BYTES = 8_192
/** After SIGTERM, the group has this long before SIGKILL. */
const TERM_GRACE_MS = 3_000
/** After SIGKILL, the answer waits this long for the pipes to close (a child that left the group may hold them). */
const CLOSE_GRACE_MS = 5_000

/** One sentence for the person: the install's last line of output. */
export function installFailure(title: string, output: string): string {
  const last = output.trim().split('\n').map((l) => l.replace(ANSI, '').trim()).filter(Boolean).pop()?.slice(0, 200)
  if (!last) return `Installing ${title} failed.`
  return `Installing ${title} failed: ${last}${/[.!?]$/.test(last) ? '' : '.'}`
}

function workDir(env: Record<string, string>): string {
  for (const dir of [env.HOME, os.homedir()]) {
    try { if (dir && dir.startsWith('/') && fs.statSync(dir).isDirectory()) return dir } catch { /* next */ }
  }
  return os.tmpdir()
}

function duration(ms: number): string {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1_000)), 'second']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** The install shell's own group (it was spawned detached, so its pid is the group's id). */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  // Refuses a pid <= 1 (a broadcast); a group already gone is fine.
  if (pid !== undefined) safeKillProcessGroup(pid, signal)
}

/**
 * Run `command`, its output kept (the last 8 KB). After `timeoutMs`, or when `signal`
 * aborts, its whole group is stopped (SIGTERM, then SIGKILL).
 */
export function shellInstall(command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<InstallResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let stopReason = ''
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const child = spawn('/bin/sh', ['-c', command], { env, cwd: workDir(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const done = (ok: boolean, extra = '') => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok, output: (output + extra).slice(-KEEP_BYTES) })
    }
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-KEEP_BYTES) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const stop = (why: string) => {
      if (stopReason || settled) return
      stopReason = why
      signalGroup(child.pid, 'SIGTERM')
      const kill = setTimeout(() => {
        signalGroup(child.pid, 'SIGKILL')
        const giveUp = setTimeout(() => done(false, `\n${why}`), CLOSE_GRACE_MS)
        giveUp.unref?.()
        timers.push(giveUp)
      }, TERM_GRACE_MS)
      kill.unref?.()
      timers.push(kill)
    }
    function onAbort(): void { stop('stopped: the server is stopping') }
    const timer = setTimeout(() => { stop(`stopped after ${duration(timeoutMs)}`) }, timeoutMs)
    timer.unref?.()
    timers.push(timer)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null) => {
      if (stopReason) {
        // Stopped: what the shell left behind in its group goes with it.
        signalGroup(child.pid, 'SIGKILL')
        return done(false, `\n${stopReason}`)
      }
      // The exit code only when it printed nothing: its last line says more.
      done(code === 0, code === 0 || output.trim() ? '' : `exited with code ${code ?? 'unknown'}`)
    }
    child.on('error', (error) => done(false, `\n${error.message}`))
    // Done once its output is closed; a child it started that keeps a pipe open does not hold the answer.
    child.on('exit', (code) => {
      const t = setTimeout(() => finish(code), CLOSE_GRACE_MS)
      t.unref?.()
      timers.push(t)
    })
    child.on('close', (code) => finish(code))
  })
}
