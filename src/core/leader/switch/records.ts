/**
 * The switch's files in a home, all under `local/leader-switch/` (this machine's, never
 * copied by the standby: home-manifest `local.leader-switch`):
 *
 *   switch-state.json the switch this home started: its steps, so a rerun resumes (state.ts shape)
 *   handed-over.json the marker: this home is being or was handed over; it never leads again
 *                    (written before the handover record, removed only by a cancel that stood)
 *   promoted.json    this home is a standby copy a switch made into the new leader's home:
 *                    'promoting' (written into the copy before its rename), 'promoted' (ready
 *                    for the trial), 'led' (the commit stood). Before 'led' only the switch's
 *                    own trial and commit starts boot it
 *   history.json     switches that made this home the leader (for `--back`)
 *   may-act.jsonl    every change of this server's permission and every outward door call
 *                    (rotated at 4 MB into may-act.1.jsonl, one kept)
 *   switch.lock      the source job running on this home (one at a time)
 *   source-job.log   its output (switch-command.ts)
 *   final-stop.json  what the server's switch stop did: its final batch and mark, or why not (final-stop.ts)
 *   cancel-request.json  a `--cancel` typed on this machine, for the running source job
 *   unresolved-ops.json  outward ops an earlier holder registered and never reported: never
 *                    sent again, for a person to check (`walnut leader status` lists them)
 *
 * And one file of leader data (it moves with the home): `cache/leader-op-outcomes.json`, the
 * outcomes of outward ops the witnesses reported (sent, not-sent). The witnesses keep an
 * outcome only `opRetainMs`; after that only this file says an op went out.
 *
 * Every write is durable when it returns (temp file, fsync, rename, directory fsync).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { OpEntry, PermitRecord } from '../permit/types.js'
import { LEADER_SWITCH_MARKER_REL } from '../../../lib/leader-home-gate.js'

export function switchDir(home: string): string {
  return path.join(home, 'local', 'leader-switch')
}

export function writeDurableJson(file: string, value: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  const dfd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
}

function readJson<T>(file: string): T | null {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  // A marker that cannot be read still marks: a torn file must never read as "not handed over".
  try { return JSON.parse(text) as T } catch { return { torn: true } as T }
}

export interface HandedOverMarker {
  switchId: string
  /** The machine the lead goes (or went) to. */
  to: string
  /** 'switching': a switch from this home is under way; 'handed-over': it committed. */
  state: 'switching' | 'handed-over'
  /** The handover record (number) once written, and the commit record once it stood. */
  handover?: number
  commit?: number
  /** Where the new leader is reached (leader_switch.machines[to].doors), for whoever asks this machine. */
  leaderDoors?: string[]
  at: string
  torn?: true
}

export function markerFile(home: string): string {
  // The same path every git writer asks for (lib/leader-home-gate.ts): a marked home takes no git write.
  return path.join(home, LEADER_SWITCH_MARKER_REL)
}

export function readMarker(home: string): HandedOverMarker | null {
  return readJson<HandedOverMarker>(markerFile(home))
}

export function writeMarker(home: string, m: HandedOverMarker): void {
  writeDurableJson(markerFile(home), m)
}

export function removeMarker(home: string): void {
  try { fs.unlinkSync(markerFile(home)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const dfd = fs.openSync(switchDir(home), 'r')
  try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
}

/** The one line a refused boot prints. */
export function markerRefusal(m: HandedOverMarker): string {
  if (m.torn) return 'this data home holds a leader-switch marker that cannot be read (local/leader-switch/handed-over.json): it was being handed over or was handed over, so it does not lead'
  return m.state === 'handed-over'
    ? `this data home was handed over to machine ${m.to} (permit record ${m.commit ?? m.handover ?? '?'}, switch ${m.switchId}); it never leads again. Switch back with \`walnut leader switch --back\` from the leader`
    : `a leader switch from this data home to machine ${m.to} is under way (switch ${m.switchId}); finish or cancel it with \`walnut leader switch --resume\` or \`--cancel\``
}

export interface PromotedRecord {
  switchId: string
  state?: 'promoting' | 'promoted' | 'led'
  from?: string
  /**
   * Written by the switch before its commit start (moved-home.ts): the machine the lead goes to,
   * the handover it commits on, and the data dir the previous holder spoke from on its hosts with
   * the former homes its record kept, as that server spelled them.
   */
  to?: string
  handover?: number
  fromHomeOnHosts?: string
  fromFormerHomes?: string[]
  at: string
  torn?: true
}

export function promotedFile(home: string): string {
  return path.join(switchDir(home), 'promoted.json')
}

export function readPromoted(home: string): PromotedRecord | null {
  return readJson<PromotedRecord>(promotedFile(home))
}

export function writePromoted(home: string, r: PromotedRecord): void {
  writeDurableJson(promotedFile(home), r)
}

/**
 * A home a switch is still making into the new leader's (promoted.json before 'led') boots
 * only as that switch's trial or commit start: started by hand it would take writes into a
 * copy the switch may still put aside.
 */
export function promotionRefusal(home: string, as: { trial: boolean; commit: boolean }): string | null {
  const p = readPromoted(home)
  if (!p || p.state === 'led' || as.trial || as.commit) return null
  return `this data home is the standby copy that switch ${p.switchId ?? '?'} is making into the new leader's home (${p.torn ? 'its record cannot be read' : p.state ?? 'promoted'}); \`walnut leader switch --resume\` on the old leader's home finishes it`
}

/**
 * One switch job per home at a time: a second one (another terminal's --resume or --cancel while
 * the first still runs) is refused. Taken with O_EXCL; a lock whose process is gone is taken over.
 */
/** The source job's lock: one switch from a home at a time. */
export function switchLockFile(home: string): string {
  return path.join(switchDir(home), 'switch.lock')
}

export function takeSwitchLock(home: string): () => void {
  return takeJobLock(switchLockFile(home), 'another `walnut leader switch` runs on this home')
}

/** The pid a job lock names while that process lives, else null. */
export function lockHolder(file: string): number | null {
  let pid = 0
  try { pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) } catch { return null }
  return pid > 1 && pidAlive(pid) ? pid : null
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The lock of one job (`file`): see takeSwitchLock. `what` names it in the refusal. */
export function takeJobLock(file: string, what: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) } finally { fs.closeSync(fd) }
      return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file) } catch { /* gone */ } }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let pid = 0
      try { pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) } catch { /* torn: judge by age */ }
      const alive = pid > 1 && pidAlive(pid)
      const old = (() => { try { return Date.now() - fs.statSync(file).mtimeMs > 60_000 } catch { return true } })()
      if (alive || (!pid && !old)) throw new Error(`${what} (pid ${pid || '?'}): wait for it, or stop it first`)
      try { fs.unlinkSync(file) } catch { /* taken by another */ }
    }
  }
  throw new Error('could not take the switch lock')
}

/** What the old leader's server wrote of its switch stop (final-stop.ts): beside the home's other switch files, never in a batch. */
export interface FinalStopResult { switchId: string; ok: boolean; batch?: number; stoppedAt?: string; why?: string; at: string }

export function finalStopResultFile(home: string): string {
  return path.join(switchDir(home), 'final-stop.json')
}

export function readFinalStopResult(home: string, switchId: string): FinalStopResult | null {
  const r = readJson<FinalStopResult>(finalStopResultFile(home))
  return r && r.switchId === switchId ? r : null
}

export interface HistoryEntry {
  switchId: string
  from: string
  to: string
  committedAt: string
  record: number
}

export function historyFile(home: string): string {
  return path.join(switchDir(home), 'history.json')
}

export function readHistory(home: string): HistoryEntry[] {
  const h = readJson<HistoryEntry[]>(historyFile(home))
  return Array.isArray(h) ? h : []
}

export function appendHistory(home: string, e: HistoryEntry): void {
  const all = readHistory(home).filter((x) => x.switchId !== e.switchId)
  writeDurableJson(historyFile(home), [...all, e])
}

export interface MayActLine {
  at: string
  /** Wall-clock ms, for ordering lines of two homes. */
  t: number
  machine: string
  event: 'lease' | 'lost' | 'door' | 'boot'
  mayAct: boolean
  /** lease: until when (wall-clock ms, this machine's estimate). */
  until?: number
  record?: number
  kind?: string
  opId?: string
  why?: string
}

export function mayActLog(home: string): string {
  return path.join(switchDir(home), 'may-act.jsonl')
}

const MAY_ACT_ROTATE_BYTES = 4 * 1024 * 1024
let mayActBytes = new Map<string, number>()

export function appendMayAct(home: string, line: Omit<MayActLine, 'at' | 't'>): void {
  const t = Date.now()
  const file = mayActLog(home)
  try {
    fs.mkdirSync(switchDir(home), { recursive: true, mode: 0o700 })
    const text = `${JSON.stringify({ at: new Date(t).toISOString(), t, ...line })}\n`
    let size = mayActBytes.get(file)
    if (size === undefined) { try { size = fs.statSync(file).size } catch { size = 0 } }
    if (size + text.length > MAY_ACT_ROTATE_BYTES) {
      fs.renameSync(file, path.join(switchDir(home), 'may-act.1.jsonl'))
      size = 0
    }
    fs.appendFileSync(file, text, { mode: 0o600 })
    mayActBytes.set(file, size + text.length)
  } catch { /* a log line never stops a door or a renew */ }
}

/** Tests only: forget the sizes this process counted. */
export function _resetMayActSizes(): void { mayActBytes = new Map() }

export function readMayAct(home: string): MayActLine[] {
  const lines: MayActLine[] = []
  for (const f of [path.join(switchDir(home), 'may-act.1.jsonl'), mayActLog(home)]) {
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const l of text.split('\n')) { if (l) try { lines.push(JSON.parse(l) as MayActLine) } catch { /* torn tail */ } }
  }
  return lines
}

export type RecordSummary = Pick<PermitRecord, 'number' | 'kind' | 'holder' | 'by' | 'from' | 'to'>

export function summarize(r: PermitRecord | null | undefined): RecordSummary | null {
  return r ? { number: r.number, kind: r.kind, holder: r.holder, by: r.by, ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) } : null
}

export interface OpOutcome { id: string; state: string; by: string; at: string }

const OUTCOME_KEEP_MS = 30 * 24 * 3_600_000

export function opOutcomesFile(home: string): string {
  return path.join(home, 'cache', 'leader-op-outcomes.json')
}

export function readOpOutcomes(home: string): Map<string, OpOutcome> {
  const list = readJson<OpOutcome[]>(opOutcomesFile(home))
  return new Map((Array.isArray(list) ? list : []).map((o) => [o.id, o]))
}

/** Add what the witnesses reported; true when the file changed. Kept 30 days. */
export function recordOpOutcomes(home: string, entries: OpEntry[]): boolean {
  const known = readOpOutcomes(home)
  let changed = false
  for (const e of entries) {
    if (e.state !== 'sent' && e.state !== 'not-sent') continue
    if (known.get(e.id)?.state === e.state) continue
    known.set(e.id, { id: e.id, state: e.state, by: e.by, at: new Date().toISOString() })
    changed = true
  }
  const cutoff = Date.now() - OUTCOME_KEEP_MS
  for (const [id, o] of known) if (Date.parse(o.at) < cutoff) { known.delete(id); changed = true }
  if (changed) writeDurableJson(opOutcomesFile(home), [...known.values()])
  return changed
}

export function unresolvedOpsFile(home: string): string {
  return path.join(switchDir(home), 'unresolved-ops.json')
}

export function writeUnresolvedOps(home: string, ops: OpEntry[]): void {
  writeDurableJson(unresolvedOpsFile(home), { at: new Date().toISOString(), ops })
}

export function readUnresolvedOps(home: string): OpEntry[] {
  const r = readJson<{ ops?: OpEntry[] }>(unresolvedOpsFile(home))
  return Array.isArray(r?.ops) ? r!.ops : []
}
