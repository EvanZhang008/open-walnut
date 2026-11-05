/**
 * Who a `web --ephemeral` server works for, so it ends when that process does.
 *
 * The launcher exits as soon as the server is up, so its own pid says nothing. The
 * owner is the first ancestor that is not a shell or a script runner: the agent CLI
 * whose Bash tool asked for the server, a test runner, a terminal. 2026-11-04: a test
 * server outlived the work that started it for hours, holding a 6.15 GB copy of the
 * data dir until the Mac's disk was full. The server checks its owner every
 * OWNER_CHECK_MS and shuts down (removing its snapshot) once the owner is gone; the
 * reaper removes a snapshot whose owner and heartbeat are both gone.
 *
 * WALNUT_EPHEMERAL_OWNER_PID names the owner explicitly; `0` means none (the server
 * then ends only on its idle timer, as before).
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type EphemeralOwner = {
  pid: number
  start: string
  command: string
  /** The owner's own ancestors (nearest first, pass-throughs left out): who takes over when it was a wrapper. */
  above?: { pid: number; start: string; command: string }[]
}
export type ProcessRow = { pid: number; ppid: number; start: string; args: string }

/** How often the server looks at its owner (and touches its heartbeat). */
export const OWNER_CHECK_MS = 30_000

/**
 * An owner gone this soon after the server started was a wrapper that only waited for
 * the launcher (`/usr/bin/time`, `bun <script>`, a sandbox): the next live ancestor
 * takes over instead of the server ending under the agent that asked for it.
 */
export const WRAPPER_GRACE_MS = 2 * 60_000

/** Programs that only pass a command on: their exit says nothing about who needs the server. */
const PASS_THROUGH = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'env', 'timeout', 'gtimeout', 'nohup',
  'nice', 'taskpolicy', 'caffeinate', 'setsid', 'flock', 'stdbuf', 'script', 'xargs', 'make',
  'npm', 'npx', 'pnpm', 'yarn', 'bunx', 'time', 'sudo', 'doas', 'uv', 'just',
])

function programOf(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? ''
  return path.basename(first).replace(/^-/, '') // a login shell shows as "-zsh"
}

/**
 * `bun run x`, `bun x y`, `bun <package script>` and `node .../npm-cli.js run` pass a
 * script on; `bun dist/cli.js` and `node vitest.mjs` run a program of their own.
 */
function isPassThrough(args: string): boolean {
  const prog = programOf(args)
  if (PASS_THROUGH.has(prog)) return true
  if (prog === 'bun' || prog === 'node') {
    const rest = args.trim().split(/\s+/).slice(1)
    const sub = rest.find((a) => !a.startsWith('-')) ?? ''
    if (sub === 'run' || sub === 'x' || /npm-cli\.js$|npx-cli\.js$/.test(sub)) return true
    // A bare name is a package.json script for bun (`bun dev:ephemeral`); a file has a slash or an extension.
    return prog === 'bun' && sub !== '' && !sub.includes('/') && !/\.[cm]?[jt]sx?$/.test(sub)
  }
  return false
}

/**
 * Pure: walk up from `fromPid` (the launcher's parent) to the first process that is
 * not a pass-through. Stops at pid 1 and on a loop; null when nothing qualifies.
 */
export function pickOwner(rows: readonly ProcessRow[], fromPid: number): EphemeralOwner | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const seen = new Set<number>()
  const found: { pid: number; start: string; command: string }[] = []
  let pid = fromPid
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid)
    const row = byPid.get(pid)
    if (!row) break
    if (!isPassThrough(row.args)) found.push({ pid: row.pid, start: row.start, command: row.args.slice(0, 200) })
    pid = row.ppid
  }
  const [owner, ...above] = found
  return owner ? { ...owner, above: above.slice(0, 8) } : null
}

/** `ps -o pid=,ppid=,lstart=,args=` lines: lstart is five words ("Wed Nov  4 20:57:01 2026"). */
export function parsePsRows(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!.replace(/\s+/g, ' '), args: m[4]! })
  }
  return rows
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** The owner for this launcher, or null (none named, or `ps` could not be read). */
export async function resolveEphemeralOwner(env: NodeJS.ProcessEnv = process.env, fromPid: number = process.ppid): Promise<EphemeralOwner | null> {
  const named = env.WALNUT_EPHEMERAL_OWNER_PID?.trim()
  if (named === '0') return null
  const out = await ps(['-A', '-o', 'pid=,ppid=,lstart=,args='])
  if (out == null) return null
  const rows = parsePsRows(out)
  if (named && /^\d+$/.test(named)) {
    const row = rows.find((r) => r.pid === Number(named))
    return row && row.pid > 1 ? { pid: row.pid, start: row.start, command: row.args.slice(0, 200), above: [] } : null
  }
  return pickOwner(rows, fromPid)
}

/**
 * True only when the owner is surely gone: no such pid, or the pid now belongs to a
 * process that started at another time. Any doubt (ps failed) reads as alive, so a
 * server is never ended on a guess.
 */
export async function ownerGone(owner: { pid: number; start: string }): Promise<boolean> {
  try {
    process.kill(owner.pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true
    // EPERM: the pid lives, maybe as another user's process; its start time tells.
  }
  const out = await ps(['-o', 'lstart=', '-p', String(owner.pid)])
  if (out == null) return false
  const start = out.trim().replace(/\s+/g, ' ')
  return start !== '' && !sameStart(start, owner.start)
}

/** Linux derives lstart from the boot time, which a clock step moves by a little. */
function sameStart(a: string, b: string): boolean {
  if (a === b) return true
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= 5_000
}

/**
 * The server's watch: every `everyMs`, touch `controlFile` (the heartbeat the reaper
 * reads) and call `onGone` once the owner is surely gone. Returns the stop function.
 */
export function startOwnerWatch(controlFile: string, owner: EphemeralOwner | null, onGone: (reason: string) => void, everyMs: number = OWNER_CHECK_MS, graceMs: number = WRAPPER_GRACE_MS): () => void {
  let busy = false
  let done = false
  const started = Date.now()
  let current: { pid: number; start: string } | null = owner
  const above = [...(owner?.above ?? [])]
  const timer = setInterval(() => {
    if (busy || done) return
    busy = true
    void (async () => {
      try {
        const now = new Date()
        await fs.promises.utimes(controlFile, now, now).catch(() => {})
        while (current && !done && await ownerGone(current)) {
          const next = Date.now() - started < graceMs ? above.shift() : undefined
          if (!next) {
            done = true
            onGone(`owner pid ${current.pid} is gone`)
            return
          }
          current = next // the gone one only wrapped the launcher
        }
      } finally { busy = false }
    })()
  }, everyMs)
  timer.unref()
  return () => { done = true; clearInterval(timer) }
}
