/**
 * The status file of an apply that runs as a background job on the standby host
 * (remote-apply.ts starts it with the daemon's `exec.run`, receive.ts writes it): the leader
 * polls this file instead of holding one command open for the whole apply, so an apply is not
 * bound by a command's time limit.
 *
 *   running   written when the apply starts, then again every HEARTBEAT_MS (its `at`)
 *   done      the apply's answer (ApplyAnswer)
 *   failed    the apply's error
 *
 * Every write is whole (writeDurable: a temp file renamed over it), so a reader sees one state.
 * While a running apply's process lives and its heartbeat is fresh, the other ops there (init,
 * verify, reported) say the target is busy at once instead of waiting on the target's lock.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { pidAlive } from '../self-update/install-lock.js'
import { writeDurable } from './target-files.js'

/** How often a running apply rewrites its status. */
export const HEARTBEAT_MS = 10_000
/** A running status not rewritten for this long is an apply that died (a kill, a power loss). */
export const HEARTBEAT_STALE_MS = 45_000

export type ApplyStatus =
  | { state: 'running'; pid: number; startedAt: string; at: string; batch?: number }
  | { state: 'done'; at: string; answer: unknown }
  | { state: 'failed'; at: string; error: string }

/** The status file of job `jobId` in the target's `.incoming/`. */
export const statusFileName = (jobId: string): string => `apply-${jobId}.status.json`
const STATUS_FILE = /^apply-[A-Za-z0-9_-]+\.status\.json$/

export async function writeStatus(file: string, status: ApplyStatus): Promise<void> {
  await writeDurable(file, JSON.stringify(status), 0o600)
}

export function parseStatus(raw: string): ApplyStatus | null {
  try {
    const s = JSON.parse(raw) as ApplyStatus
    return s && (s.state === 'running' || s.state === 'done' || s.state === 'failed') ? s : null
  } catch {
    return null
  }
}

/** Run `work` with its status kept in `file`: running (with a heartbeat), then done or failed. */
export async function withStatus<T>(file: string, work: (setBatch: (n: number) => void) => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString()
  let batch: number | undefined
  const running = () => writeStatus(file, { state: 'running', pid: process.pid, startedAt, at: new Date().toISOString(), ...(batch === undefined ? {} : { batch }) })
  await running()
  let writing: Promise<void> = Promise.resolve()
  const beat = setInterval(() => { writing = writing.then(running).catch(() => {}) }, HEARTBEAT_MS)
  try {
    const answer = await work((n) => { batch = n; writing = writing.then(running).catch(() => {}) })
    clearInterval(beat)
    await writing
    await writeStatus(file, { state: 'done', at: new Date().toISOString(), answer })
    return answer
  } catch (err) {
    clearInterval(beat)
    await writing
    await writeStatus(file, { state: 'failed', at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }).catch(() => {})
    throw err
  }
}

/** Running: its process lives on this machine and its heartbeat is fresh by this machine's clock. */
function isRunning(s: ApplyStatus | null, now: number): s is Extract<ApplyStatus, { state: 'running' }> {
  return s?.state === 'running' && now - Date.parse(s.at) < HEARTBEAT_STALE_MS && pidAlive(s.pid)
}

/** A running apply in `incoming`, or null. */
export async function runningApply(incoming: string, now = Date.now()): Promise<Extract<ApplyStatus, { state: 'running' }> | null> {
  for (const name of await fs.readdir(incoming).catch(() => [] as string[])) {
    if (!STATUS_FILE.test(name)) continue
    const s = parseStatus(await fs.readFile(path.join(incoming, name), 'utf8').catch(() => ''))
    if (isRunning(s, now)) return s
  }
  return null
}

/** One job's status file, and whether it still runs (`walnut standby receive job`). */
export async function probeJob(file: string, now = Date.now()): Promise<{ status: ApplyStatus | null; running: boolean }> {
  const status = parseStatus(await fs.readFile(file, 'utf8').catch(() => ''))
  return { status, running: isRunning(status, now) }
}

/** Refuse an op while an apply runs there (it would wait on the target's lock for the whole apply). */
export async function refuseWhileApplying(incoming: string): Promise<void> {
  const s = await runningApply(incoming)
  if (s) throw new Error(`the target is busy: an apply${s.batch === undefined ? '' : ` of batch ${s.batch}`} runs there since ${s.startedAt}`)
}
