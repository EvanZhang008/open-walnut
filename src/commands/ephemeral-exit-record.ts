/**
 * Why an ephemeral server ended, written where it outlives the server.
 *
 * An ephemeral server's own logs and exit trace live in its snapshot and runtime dirs, which its
 * exit removes, so a task whose server went away could not tell why (2026-11-09: a server held
 * for an iOS recording ended after 97 minutes with nothing left to read). Every exit now appends
 * one line to the machine's exit log (/tmp/open-walnut-exit.log, `exitTraceFileFor` of the
 * production daemon dir), naming the rule that ended it, and the reaper adds one for a server
 * that died without writing its own (a SIGKILL, a crash, the memory killer).
 *
 * tests/commands/ephemeral-exit-reason-guard.test.ts fails on an exit path of the child that
 * does not name its reason.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitTraceFileFor, localProductionDaemonDir } from '../lib/daemon-dir.js'

/** The rules that end an ephemeral server. */
export type EphemeralExitRule =
  | 'idle'            // no HTTP request for its idle time
  | 'owner-gone'      // the process it worked for ended
  | 'signal'          // SIGTERM / SIGINT from another process
  | 'forced'          // its shutdown did not finish in time
  | 'start-failed'    // it never served
  | 'crash'           // an uncaught error
  | 'died-unrecorded' // the reaper found it gone without its own line
  | 'reaped'          // the reaper removed the dirs of a server whose owner went and whose beat stopped

export interface EphemeralExitFacts {
  rule: EphemeralExitRule
  /** One line in a person's words: "idle 10 min (limit 10 min)", "owner pid 123 is gone". */
  detail: string
  pid: number
  port?: number
  snapshotDir?: string
  ownerPid?: number | null
  idleMinutes?: number
  idleLimitMinutes?: number
  uptimeSec?: number
  code?: number
}

/**
 * The file the line goes to: the machine's exit log, never one inside the server's own dirs.
 * WALNUT_EPHEMERAL_EXIT_LOG names another; the test runner gets one in its temp dir, so the
 * reaper's tests never write into the real exit log.
 */
export function ephemeralExitLogFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WALNUT_EPHEMERAL_EXIT_LOG) return env.WALNUT_EPHEMERAL_EXIT_LOG
  if (env.VITEST) return path.join(os.tmpdir(), 'walnut-test-ephemeral-exit.log')
  return exitTraceFileFor(localProductionDaemonDir())
}

/** The line, in the exit log's shape. Pure. */
export function ephemeralExitLine(f: EphemeralExitFacts, now: Date = new Date()): string {
  const parts = [
    `rule=${f.rule}`, `pid=${f.pid}`,
    f.port ? `port=${f.port}` : '',
    f.ownerPid !== undefined ? `owner=${f.ownerPid ?? 'none'}` : '',
    f.idleMinutes !== undefined ? `idle=${f.idleMinutes.toFixed(1)}min` : '',
    f.idleLimitMinutes !== undefined ? `idleLimit=${f.idleLimitMinutes}min` : '',
    f.uptimeSec !== undefined ? `uptime=${Math.round(f.uptimeSec)}s` : '',
    f.code !== undefined ? `code=${f.code}` : '',
    f.snapshotDir ? `dir=${f.snapshotDir}` : '',
  ].filter(Boolean)
  return `[${now.toISOString()}] EPHEMERAL EXIT: ${f.detail} (${parts.join(' ')})`
}

/** True when the exit log's last 256 KB already holds a line for `pid`. Never throws. */
export function exitLineRecorded(pid: number, file: string = ephemeralExitLogFile()): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, 256 * 1024)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      return new RegExp(`EPHEMERAL EXIT: .*\\(rule=[a-z-]+ pid=${pid}[ )]`).test(buf.toString('utf-8'))
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

/** Append the line (sync: it runs from the process 'exit' event). Never throws. */
export function recordEphemeralExit(f: EphemeralExitFacts, file: string = ephemeralExitLogFile()): void {
  try { fs.appendFileSync(file, ephemeralExitLine(f) + '\n') } catch { /* best-effort */ }
}
