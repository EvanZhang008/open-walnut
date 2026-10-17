/**
 * The overlay of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * sections 4 "Hold after ack" and 5; WP10): the writes this host's journal
 * holds for the Mac, shown over the copies. The replica never writes a copy
 * itself (one local writer per home: the daemon's journal); a reader sees the
 * copy's row with every pending write folded over it, and a mark on it.
 *
 *   source   `follower.pending {sinceSeq: 0}` on the follower link (cap
 *            journal-v2, owner scoped): every record pending for this Walnut,
 *            a session's gateway writes included, folded by op id (the highest
 *            rev of a coalesced save wins)
 *   pending  the record is in the journal: the row is held (the copy keeps it
 *            from a manifest round, kind-follower.ts HeldSource), its overlay and
 *            its mark `pending` stay
 *   awaiting the record left the journal (the Mac acked it): its overlay and
 *            its mark `awaiting` stay until a manifest whose asOf is later than
 *            the ack stored the key (kind-follower.ts setCopyWatcher), or the
 *            copy already shows every value the record wrote, or 10 minutes
 *            pass. The asOf and the ack are compared on ONE clock: asOf is the
 *            Mac's Date.now(), so the ack's time here is moved by `leaderOffsetMs`
 *            (the Mac's clock minus this host's, as the daemon measured it at the
 *            Mac's last ack; an old Mac sends no clock and this host's time
 *            stands). The Mac's copy round follows its drain only after its 3 s
 *            debounce, and the Mac may sleep again in between (R4b).
 *
 * Kinds and keys: task-fields, task-create, task-move and the v1 gateway `op`
 * records key the task (`tasks`); board records key the Board's task
 * (`boards`); device-revoke keys the device (`devices`). Awaiting entries are
 * kept in `cache/replica-overlay.json` (0600), so a restart keeps the marks.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createdRow, madeByHuman, withValues } from './write-port.js'

/** How long an acked write keeps its overlay and mark when no copy round stored it. */
export const AWAIT_COPY_MS = 10 * 60_000
/** While only pending writes wait and the Mac does not answer (it sleeps, maybe for hours): how often the watch asks. */
export const SLOW_WATCH_MS = 20_000

/**
 * How stale the overlay may be on a watch tick (away-wiring.ts): null with nothing to
 * watch; 0 (ask now) while an acked write waits for its copy or the Mac answers (a drain
 * may be acking right now); else SLOW_WATCH_MS, so a long sleep of the Mac does not cost
 * the daemon a read of every pending record each second.
 */
export function watchMaxAgeMs(entries: ReadonlyArray<Pick<OverlayEntry, 'state'>>, macAnswers: boolean): number | null {
  if (!entries.length) return null
  return macAnswers || entries.some((e) => e.state === 'awaiting') ? 0 : SLOW_WATCH_MS
}

export type SyncMark = 'pending' | 'awaiting'
export type OverlayKind = 'tasks' | 'boards' | 'devices'

export interface OverlayEntry {
  opId: string
  seq: number
  rev: number
  kind: string
  at: number
  record: Record<string, unknown>
  state: SyncMark
  /** When this replica saw the record leave the journal (its ack), on this host's clock. */
  ackAt?: number
  /** The same moment on the Mac's clock (ackAt plus the measured offset), when the daemon knew it. */
  ackLeaderAt?: number
  /** The record is the daemon's own (follower.pending), not the port's note of one write. */
  fromJournal?: boolean
}

export interface PendingReply { records?: unknown; liveSeqs?: unknown; nextSeq?: unknown; leaderOffsetMs?: unknown }

export interface OverlayDeps {
  /** `follower.pending {sinceSeq: 0}`; rejects when the daemon cannot be asked. */
  fetchPending(): Promise<PendingReply>
  now?(): number
  /** Where awaiting entries are kept across a restart; absent: memory only (tests). */
  file?: string
  /** The keys whose overlay or mark changed (browsers are told). */
  changed?(keys: Array<{ kind: OverlayKind; id: string }>): void
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

/** The kind and key a record overlays, or null (a record no reader shows: settle, delivery, ...). */
export function keyOfRecord(r: Record<string, unknown>): { kind: OverlayKind; id: string } | null {
  const kind = String(r.kind ?? '')
  if (kind === 'task-fields' || kind === 'task-create' || kind === 'task-move') {
    return typeof r.taskId === 'string' && r.taskId ? { kind: 'tasks', id: r.taskId } : null
  }
  if (kind === 'board') {
    const task = (r.args as Record<string, unknown> | undefined)?.task
    return typeof task === 'string' && task ? { kind: 'boards', id: task } : null
  }
  if (kind === 'device-revoke') return typeof r.deviceId === 'string' && r.deviceId ? { kind: 'devices', id: r.deviceId } : null
  if (kind === 'op') {
    // A v1 gateway write (a session's task_update / task_complete while the Mac was away).
    const op = String(r.op ?? '')
    const id = (r.args as Record<string, unknown> | undefined)?.id
    if ((op === 'task_update' || op === 'task_complete') && typeof id === 'string' && id) return { kind: 'tasks', id }
    if (op.startsWith('board_')) {
      const task = (r.args as Record<string, unknown> | undefined)?.task
      return typeof task === 'string' && task ? { kind: 'boards', id: task } : null
    }
  }
  return null
}

/** An op id for a record that has none (a v1 record): its seq, unique within one journal. */
function opIdOf(r: Record<string, unknown>): string {
  return typeof r.opId === 'string' && r.opId ? r.opId : `seq-${String(r.seq)}`
}

/** Where an acked entry waits when its op id was journaled again (its own seq keeps it apart). */
function asideKey(e: Pick<OverlayEntry, 'opId' | 'seq'>): string {
  return `${e.opId}@${e.seq}`
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

export interface Overlay {
  /** Ask the daemon again (at most once per `maxAgeMs`; a failed ask keeps what is known). */
  refresh(maxAgeMs?: number): Promise<void>
  /** A write the daemon just took (write-port.ts): held and shown at once. */
  noteWritten(e: { opId: string; seq: number; rev: number; kind: string; at: number; record: Record<string, unknown>; actor?: unknown }): void
  /** Entries of every state, in seq order (tests, the report). */
  entries(): OverlayEntry[]
  /** The mark of a key now, or null. */
  markOf(kind: OverlayKind, id: string): SyncMark | null
  /** Keys a copy round must not replace now: the pending ones. */
  heldKeys(kind: OverlayKind): Set<string>
  /** The copy watcher (kind-follower.ts setCopyWatcher). */
  watching(kind: string): string[]
  stored(kind: string, keys: string[], asOf: number): void
  /** A task row with every entry folded over it (null row: a task made here, or null). */
  task(id: string, copyRow: Record<string, unknown> | null): Record<string, unknown> | null
  /** The tasks made here that the copy does not hold yet. */
  createdTaskIds(): string[]
  /** The moves to apply to a list, in seq order. */
  moves(): Array<{ taskId: string; anchor: { after?: string; before?: string } | null; tier?: string }>
  /** Board records of a task, in seq order (applied by the caller with the board kit). */
  boardRecords(taskId: string): Array<Record<string, unknown> & { seq: number; at: number }>
  /** Device ids revoked here and not yet gone from the copy. */
  revokedDevices(): string[]
  /** Stop the timers; drop the state (tests). */
  close(): void
}

export function createOverlay(deps: OverlayDeps): Overlay {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const byOp = new Map<string, OverlayEntry>()
  let fetchedAt = 0
  let inflight: Promise<void> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function load(): void {
    if (!deps.file) return
    try {
      const raw = JSON.parse(fs.readFileSync(deps.file, 'utf8')) as { entries?: OverlayEntry[] }
      for (const e of raw.entries ?? []) {
        if (!e || typeof e.opId !== 'string' || e.state !== 'awaiting' || typeof e.ackAt !== 'number') continue
        if (now() - e.ackAt > AWAIT_COPY_MS) continue
        byOp.set(byOp.has(e.opId) ? asideKey(e) : e.opId, e)
      }
    } catch { /* none yet, or unreadable: nothing awaits */ }
  }

  function save(): void {
    if (!deps.file || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      const file = deps.file!
      const awaiting = [...byOp.values()].filter((e) => e.state === 'awaiting')
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: awaiting }), { mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch (err) {
        log('warn', 'replica overlay: could not keep the awaiting writes', { error: (err as Error).message })
      }
    }, 200)
    saveTimer.unref?.()
  }

  function tell(keys: Array<{ kind: OverlayKind; id: string }>): void {
    if (!keys.length || !deps.changed) return
    const seen = new Set<string>()
    const out = keys.filter((k) => { const s = `${k.kind}:${k.id}`; if (seen.has(s)) return false; seen.add(s); return true })
    try { deps.changed(out) } catch { /* a listener's failure is its own */ }
  }

  function keyed(e: OverlayEntry): { kind: OverlayKind; id: string } | null {
    return keyOfRecord({ ...e.record, kind: e.kind })
  }

  /** Expired awaiting entries go; returns the keys they held. */
  function expire(): Array<{ kind: OverlayKind; id: string }> {
    const gone: Array<{ kind: OverlayKind; id: string }> = []
    for (const [op, e] of byOp) {
      if (e.state === 'awaiting' && e.ackAt !== undefined && now() - e.ackAt > AWAIT_COPY_MS) {
        byOp.delete(op)
        const k = keyed(e)
        if (k) gone.push(k)
        log('info', 'replica overlay: an acked write stopped waiting for its copy', { opId: op, seq: e.seq, kind: e.kind, key: k?.id })
      }
    }
    return gone
  }

  function release(op: string, why: string): { kind: OverlayKind; id: string } | null {
    const e = byOp.get(op)
    if (!e) return null
    byOp.delete(op)
    save()
    const k = keyed(e)
    log('info', 'replica overlay: a write is back from the Mac', { opId: op, seq: e.seq, kind: e.kind, key: k?.id, why })
    return k
  }

  /** The daemon's pending records now: new ones held, folded ones replaced, gone ones awaiting their copy. */
  function take(reply: PendingReply): void {
    const records = Array.isArray(reply.records) ? reply.records as Array<Record<string, unknown>> : []
    const live = new Map<string, Record<string, unknown>>()
    for (const r of records) {
      if (!r || typeof r !== 'object' || typeof r.seq !== 'number' || !keyOfRecord(r)) continue
      const op = opIdOf(r)
      const prev = live.get(op)
      const rev = typeof r.rev === 'number' ? r.rev : 1
      if (!prev || rev > (typeof prev.rev === 'number' ? prev.rev : 1) || (rev === (prev.rev ?? 1) && (r.seq as number) > (prev.seq as number))) live.set(op, r)
    }
    const changed: Array<{ kind: OverlayKind; id: string }> = []
    const t = now()
    const offset = typeof reply.leaderOffsetMs === 'number' && Number.isFinite(reply.leaderOffsetMs) ? reply.leaderOffsetMs : undefined
    for (const [op, r] of live) {
      let e = byOp.get(op)
      const rev = typeof r.rev === 'number' ? r.rev : 1
      // An acked write whose op id was journaled again (a client's retry after the ack, W11):
      // a NEW record (its own seq, a task id of its own); the first keeps waiting for its copy.
      if (e && e.state === 'awaiting' && e.seq !== r.seq) { byOp.delete(op); byOp.set(asideKey(e), e); e = undefined }
      // The daemon's record is the truth: a write noted by the port holds only its own
      // fields, while a coalesced save folds an earlier edit of the same task into it.
      // A journal line never changes in place (a fold is a new line), so the daemon's
      // record at the same seq and rev is the one already held: nothing to compare.
      if (e && e.state === 'pending' && e.rev === rev && e.seq === r.seq && e.fromJournal) continue
      byOp.set(op, { opId: op, seq: r.seq as number, rev, kind: String(r.kind), at: typeof r.at === 'number' ? r.at : t, record: r, state: 'pending', fromJournal: true })
      const k = keyOfRecord(r)
      if (k) changed.push(k)
    }
    for (const [op, e] of byOp) {
      if (e.state !== 'pending' || live.has(op)) continue
      // A record written after this ask began is not in its answer: it waits for the next one.
      if (e.seq >= nextSeqAsked) continue
      e.state = 'awaiting'
      e.ackAt = t
      if (offset !== undefined) e.ackLeaderAt = t + offset
      const k = keyed(e)
      if (k) changed.push(k)
      log('info', 'replica overlay: a write was taken by the Mac, waiting for its copy', { opId: op, seq: e.seq, kind: e.kind, key: k?.id })
    }
    changed.push(...expire())
    if (changed.length) { save(); tell(changed) }
  }

  /** The journal's next seq when the last ask was answered (its liveSeqs cover every seq below it). */
  let nextSeqAsked = 0

  async function refresh(maxAgeMs = 0): Promise<void> {
    if (inflight) return inflight
    if (maxAgeMs > 0 && now() - fetchedAt < maxAgeMs) return
    inflight = (async () => {
      try {
        const reply = await deps.fetchPending() as PendingReply & { nextSeq?: unknown }
        nextSeqAsked = typeof reply.nextSeq === 'number' ? reply.nextSeq : Number.MAX_SAFE_INTEGER
        take(reply)
        fetchedAt = now()
      } catch (err) {
        log('warn', 'replica overlay: follower.pending failed, keeping what is known', { error: (err as Error).message })
        const gone = expire()
        if (gone.length) { save(); tell(gone) }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  function markOf(kind: OverlayKind, id: string): SyncMark | null {
    let mark: SyncMark | null = null
    for (const e of byOp.values()) {
      const k = keyed(e)
      if (!k || k.kind !== kind || k.id !== id) continue
      if (e.state === 'pending') return 'pending'
      mark = 'awaiting'
    }
    return mark
  }

  load()

  return {
    refresh,
    noteWritten(e) {
      let prev = byOp.get(e.opId)
      if (prev && prev.state === 'pending' && prev.rev >= e.rev) return
      if (prev && prev.state === 'awaiting' && prev.seq !== e.seq) { byOp.delete(e.opId); byOp.set(asideKey(prev), prev); prev = undefined }
      // The actor rides on the record as it does on the journal's (a post reads as its writer's).
      const actor = e.actor ?? e.record.actor
      // A coalesced save (the same op id, a higher rev) is the earlier fields plus these:
      // the daemon folded both into one record (offline-journal-core.ts coalesceInto).
      const fields = prev && prev.state === 'pending' && e.kind === 'task-fields' && prev.kind === 'task-fields'
        ? { fields: { ...(prev.record.fields as Record<string, unknown> ?? {}), ...(e.record.fields as Record<string, unknown> ?? {}) } }
        : {}
      byOp.set(e.opId, { opId: e.opId, seq: e.seq, rev: e.rev, kind: e.kind, at: e.at, record: { ...e.record, ...fields, ...(actor ? { actor } : {}), seq: e.seq, opId: e.opId, at: e.at }, state: 'pending' })
      const k = keyOfRecord({ ...e.record, kind: e.kind })
      if (k) tell([k])
    },
    entries: () => [...byOp.values()].sort((a, b) => a.seq - b.seq),
    markOf,
    heldKeys(kind) {
      const out = new Set<string>()
      for (const e of byOp.values()) {
        const k = keyed(e)
        if (k && k.kind === kind && e.state === 'pending') out.add(k.id)
      }
      return out
    },
    watching(kind) {
      const out: string[] = []
      for (const e of byOp.values()) {
        const k = keyed(e)
        if (k && k.kind === kind && e.state === 'awaiting') out.push(k.id)
      }
      return out
    },
    stored(kind, keys, asOf) {
      const set = new Set(keys)
      const changed: Array<{ kind: OverlayKind; id: string }> = []
      for (const [op, e] of [...byOp]) {
        const k = keyed(e)
        if (!k || k.kind !== kind || !set.has(k.id) || e.state !== 'awaiting' || e.ackAt === undefined) continue
        // asOf is on the Mac's clock: compare it with the ack on that clock when it is known.
        if (!(asOf > (e.ackLeaderAt ?? e.ackAt))) continue
        const r = release(op, 'copy')
        if (r) changed.push(r)
      }
      tell(changed)
    },
    task(id, copyRow) {
      const list = [...byOp].filter(([, e]) => { const k = keyed(e); return k?.kind === 'tasks' && k.id === id }).sort((a, b) => a[1].seq - b[1].seq)
      if (!list.length) return copyRow
      let row: Record<string, unknown> | null = copyRow ? { ...copyRow } : null
      const released: Array<{ kind: OverlayKind; id: string }> = []
      for (const [mapKey, e] of list) {
        if (e.state === 'awaiting' && copyRow && shows(copyRow, e)) {
          const r = release(mapKey, 'values')
          if (r) released.push(r)
          continue
        }
        const r = e.record
        if (e.kind === 'task-create') {
          if (!row) {
            const placement = (r.placement ?? {}) as { parentTaskId?: string; project?: string; groupId?: string; tier?: string }
            row = createdRow(id, (r.fields ?? {}) as Record<string, unknown>, placement, e.at, madeByHuman(r.actor))
          }
          continue
        }
        if (!row) continue
        if (e.kind === 'task-fields') {
          const values: Record<string, unknown> = {}
          for (const [k, w] of Object.entries((r.fields ?? {}) as Record<string, { value?: unknown }>)) values[k] = w?.value
          row = withValues(row, values, new Date(e.at).toISOString())
        } else if (e.kind === 'task-move') {
          if (typeof r.tier === 'string') row.focus_tier = r.tier
        } else if (e.kind === 'op') {
          const args = (r.args ?? {}) as Record<string, unknown>
          if (r.op === 'task_complete') row.phase = 'COMPLETE'
          else for (const [k, v] of Object.entries(args)) if (k !== 'id') row[k] = v
        }
      }
      if (released.length) tell(released)
      if (!row) return null
      const mark = markOf('tasks', id)
      return mark ? { ...row, replica_sync: mark } : row
    },
    createdTaskIds() {
      const out: string[] = []
      for (const e of [...byOp.values()].sort((a, b) => a.seq - b.seq)) {
        if (e.kind === 'task-create' && typeof e.record.taskId === 'string') out.push(e.record.taskId)
      }
      return out
    },
    moves() {
      return [...byOp.values()].filter((e) => e.kind === 'task-move' && typeof e.record.taskId === 'string').sort((a, b) => a.seq - b.seq)
        .map((e) => ({
          taskId: e.record.taskId as string,
          anchor: (e.record.anchor ?? null) as { after?: string; before?: string } | null,
          ...(typeof e.record.tier === 'string' ? { tier: e.record.tier } : {}),
        }))
    },
    boardRecords(taskId) {
      return [...byOp.values()].filter((e) => { const k = keyed(e); return k?.kind === 'boards' && k.id === taskId }).sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e.record, kind: e.kind, seq: e.seq, at: e.at }))
    },
    revokedDevices() {
      return [...byOp.values()].filter((e) => e.kind === 'device-revoke' && typeof e.record.deviceId === 'string').map((e) => e.record.deviceId as string)
    },
    close() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      byOp.clear()
    },
  }
}

/** Whether a copy row already shows every value an acked record wrote (its write is back). */
function shows(row: Record<string, unknown>, e: OverlayEntry): boolean {
  const r = e.record
  if (e.kind === 'task-create') return true
  if (e.kind === 'task-fields') {
    const fields = Object.entries((r.fields ?? {}) as Record<string, { value?: unknown }>)
    return fields.length > 0 && fields.every(([k, w]) => same(row[k] ?? null, w?.value ?? null))
  }
  if (e.kind === 'op') {
    if (r.op === 'task_complete') return row.phase === 'COMPLETE'
    const args = Object.entries((r.args ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'id')
    return args.length > 0 && args.every(([k, v]) => same(row[k] ?? null, v ?? null))
  }
  // A move's order cannot be read off one row: its copy round or the clock releases it.
  return false
}
