/**
 * What a subagent on another host (on-host.ts) holds outside this server's memory while it
 * runs: its work copy on the target, its pack folder on the caller's host, its session there.
 * Each is written here before it exists and dropped once it is gone, so a run this server
 * never finished (a restart, a crash, a stop whose cleanup outlived the shutdown's budget)
 * is cleaned up by the next sweep (task-dir-sweep.ts runs it with every round): its session
 * stopped and archived, its transcript removed, its folders removed. An entry whose cleanup
 * fails stays for the next round.
 */
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'

export interface LeftRun {
  /** The run's id (sa-...). */
  id: string
  at: number
  /** Folders to remove, each on its host. */
  dirs: Array<{ host: string; dir: string }>
  /** Its session, once minted. */
  sessionId?: string
  /** The session's work folder: Claude Code's per-folder data for it goes too. */
  sessionCwd?: string
}

const FILE = () => path.join(WALNUT_HOME, 'subagent-runs.json')
let chain: Promise<unknown> = Promise.resolve()

function read(): LeftRun[] {
  let text: string
  try { text = fs.readFileSync(FILE(), 'utf8') } catch { return [] }
  try {
    const raw = JSON.parse(text) as unknown
    if (Array.isArray(raw)) return raw as LeftRun[]
    throw new Error('not a list')
  } catch (err) {
    // Never overwritten with fewer rows: kept aside for a person to read, and logged.
    const aside = `${FILE()}.unreadable-${Date.now()}`
    try { fs.renameSync(FILE(), aside) } catch { /* gone meanwhile */ }
    log.agent.warn('subagent left runs: the ledger could not be read; kept aside', { aside, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

function write(rows: LeftRun[]): void {
  const f = FILE()
  if (rows.length === 0) { fs.rmSync(f, { force: true }); return }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 1))
  fs.renameSync(tmp, f)
}

function change(fn: (rows: LeftRun[]) => LeftRun[]): Promise<void> {
  const next = chain.then(() => write(fn(read())))
  chain = next.catch(() => {})
  return next
}

/** Add to (or start) the run's entry. */
export function noteLeft(id: string, add: { dir?: { host: string; dir: string }; sessionId?: string; sessionCwd?: string }): Promise<void> {
  return change((rows) => {
    const row = rows.find((r) => r.id === id) ?? (rows.push({ id, at: Date.now(), dirs: [] }), rows[rows.length - 1]!)
    if (add.dir && !row.dirs.some((d) => d.host === add.dir!.host && d.dir === add.dir!.dir)) row.dirs.push(add.dir)
    if (add.sessionId) row.sessionId = add.sessionId
    if (add.sessionCwd) row.sessionCwd = add.sessionCwd
    return rows
  })
}

/** One folder of the run is gone. */
export function dropLeftDir(id: string, dir: { host: string; dir: string }): Promise<void> {
  return change((rows) => rows.map((r) => r.id === id ? { ...r, dirs: r.dirs.filter((d) => !(d.host === dir.host && d.dir === dir.dir)) } : r))
}

/** The run's folder named `name` on `host` is gone (the entry may name it as planned, ~/..., before its absolute path was known). */
export function dropLeftDirNamed(id: string, host: string, name: string): Promise<void> {
  return change((rows) => rows.map((r) => r.id === id ? { ...r, dirs: r.dirs.filter((d) => !(d.host === host && path.posix.basename(d.dir) === name)) } : r))
}

/** The run cleaned up after itself (whatever is still named stays for the sweep). */
export function settleLeft(id: string): Promise<void> {
  return change((rows) => rows.filter((r) => r.id !== id || r.dirs.length > 0 || !!r.sessionId))
}

/** The session part is retired. */
export function dropLeftSession(id: string): Promise<void> {
  return change((rows) => rows.map((r) => {
    if (r.id !== id) return r
    const { sessionId: _s, sessionCwd: _c, ...rest } = r
    return rest
  }).filter((r) => r.id !== id || r.dirs.length > 0))
}

export function listLeftRuns(): LeftRun[] { return read() }

/** Clean up every run this server holds no live run for. Returns how many entries it settled. */
export async function sweepLeftRuns(isLive: (id: string) => boolean): Promise<number> {
  const rows = read().filter((r) => !isLive(r.id))
  let settled = 0
  for (const row of rows) {
    try {
      if (row.sessionId) {
        const { retireSubagentSession } = await import('./on-host.js')
        await retireSubagentSession(row.sessionId, 'subagent_left', row.sessionCwd)
        await dropLeftSession(row.id)
      }
      const { removeRunDirOn } = await import('./work-copy.js')
      for (const d of row.dirs) if (await removeRunDirOn(d.host, d.dir)) await dropLeftDir(row.id, d)
      await settleLeft(row.id)
      if (!read().some((r) => r.id === row.id)) settled++
    } catch (err) {
      log.agent.info('subagent left runs: one stays for the next sweep', { id: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (settled) log.agent.info('subagent left runs: cleaned up', { settled })
  return settled
}

/** Swept soon after the server starts (a run a restart cut short), and again every few minutes while anything is left. */
const FIRST_SWEEP_MS = 60_000
const AGAIN_SWEEP_MS = 5 * 60_000
let timer: ReturnType<typeof setTimeout> | null = null
let liveCheck: ((id: string) => boolean) | null = null

/** A sweep in `ms` unless one is due already (a run whose cleanup left something calls it). */
export function scheduleLeftRunsSweep(ms = AGAIN_SWEEP_MS): void {
  if (timer || !liveCheck) return
  timer = setTimeout(() => {
    timer = null
    if (!liveCheck || read().length === 0) return
    void sweepLeftRuns(liveCheck).catch(() => 0).finally(() => { if (read().length > 0) scheduleLeftRunsSweep() })
  }, ms)
  timer.unref?.()
}

export function startLeftRunsSweep(isLive: (id: string) => boolean): { stop: () => void } {
  liveCheck = isLive
  scheduleLeftRunsSweep(FIRST_SWEEP_MS)
  return { stop: () => { liveCheck = null; if (timer) clearTimeout(timer); timer = null } }
}
