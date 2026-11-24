/**
 * The session channel between a host's service and its Walnut's leader
 * (docs/plan/one-service-every-host.md, phase 2): the host sends what its sessions did, the leader
 * confirms. The same frames run on any link, whoever dialed it (the leader over ssh, or the host
 * into the leader's door), so a host that moves to another leader resumes there from that
 * leader's own confirmed position.
 *
 *   host -> any   hello  {walnutId, hostId, logId, floor, head, now}
 *   leader -> host resume {walnutId, hostId, permitNumber, epoch, logId, after, reads}
 *                         after: the last seq of this log the leader applied (0: none; -1: the
 *                         leader knew this host under another log, so it always gets the rows
 *                         first); a log that still holds every record after `after`
 *                         replays them, one that trimmed some sends its rows first. The leader's
 *                         standing is the pair (permitNumber, epoch), compared in that order
 *                         (comparePermit): permitNumber the write permission's record number (0
 *                         while the permit system is off), epoch the leader's claim on this host;
 *                         a resume without `epoch` (an older leader) reads as (0, permitNumber).
 *                         reads: the marks on records this leader's build reads (LEADER_READS;
 *                         absent: an older leader that reads none), so a host says a record again
 *                         only to a leader that waits for it (stand-down-held.ts)
 *                         The host refuses a pair lower than the highest it has seen (a leader
 *                         that lost its permit replays nothing and trims nothing)
 *   listener -> host listen {walnutId}        a reader that never confirms (the cloud companion):
 *                         it gets this host's own rows as they are now, then everything live
 *   host -> reader  rows  {rows, upTo, rowsAt} the host's own rows as of record `rowsAt`, standing for
 *                         every record up to `upTo`: for a leader below what the log keeps, `upTo` is
 *                         the last record the log no longer has, and the records after it still come
 *                         as facts (their row patches up to `rowsAt` are already in the rows, so the
 *                         leader skips those); for a listener both are the head. `gone`: the
 *                         rows this host removed (gone-rows.ts), the only rows of this host a
 *                         leader deletes for not being named (rows-snapshot.ts); `rowsAt` is the
 *                         frame's position, so a frame of a replaced link is skipped whole
 *   host -> reader  facts {recs, replay?, sentAt} records in seq order; `replay`: read back from the
 *                         log, not live; `now`/`sentAt`: the host's clock, so the leader can tell
 *                         how old a record is on its own clock (late facts, below)
 *   host -> reader  flow  {sid, name, data}   a text delta: only to a reader that is caught up
 *   leader -> host  ack   {logId, upTo}       the leader applied everything up to `upTo`
 *   leader -> host  resync {sids}             rows the leader could not apply as sent (no base row, a
 *                         refused write): the host appends each one's whole row again (a `row`
 *                         record marked `resync`: applied whole, a repair, never a start)
 *   host -> reader  refuse {why}              and the host closes the link
 *
 * Only the leader confirms, and only it decides what the host may trim. A listener holds no
 * position anywhere.
 *
 * Late: a record is late when it happened more than `lateMs` before the leader applies it, as the
 * leader's clock reads it: read back after a reconnect, or live frames that waited in a link
 * while the leader was stopped. The host's clock is mapped onto the leader's by the smallest
 * (leader now - host send time) the link has seen (the transit plus the clocks' difference; a
 * frame that waited only makes it larger, so the smallest is the best), so a host whose clock is
 * off reads neither late nor fresh by mistake.
 */
import type { FactLog, FactRecord } from './fact-log.js'
import { FlowMerger } from './flow-merge.js'
import type { SessionRecord } from '../types.js'

export type ChannelFrame =
  | { ch: 'sf'; op: 'hello'; walnutId: string; hostId: string; logId: string; floor: number; head: number; now?: number }
  | { ch: 'sf'; op: 'resume'; walnutId: string; hostId: string; permitNumber: number; epoch?: number; logId: string; after: number; reads?: string[] }
  | { ch: 'sf'; op: 'listen'; walnutId: string }
  | { ch: 'sf'; op: 'rows'; rows: SessionRecord[]; upTo: number; rowsAt: number; logId: string; gone?: string[] }
  | { ch: 'sf'; op: 'facts'; recs: FactRecord[]; replay?: true; sentAt?: number }
  | { ch: 'sf'; op: 'flow'; sid: string; name: string; data: unknown; to?: string[] }
  | { ch: 'sf'; op: 'ack'; logId: string; upTo: number }
  | { ch: 'sf'; op: 'resync'; sids: string[] }
  | { ch: 'sf'; op: 'refuse'; why: string }

export interface ChannelLink {
  send(frame: ChannelFrame): void
  close(why?: string): void
}

export function isChannelFrame(v: unknown): v is ChannelFrame {
  const f = v as { ch?: unknown; op?: unknown } | null
  return !!f && typeof f === 'object' && f.ch === 'sf' && typeof f.op === 'string'
}

/** Which leader a host trusts: the write permission's record number (0: no permit system), then the leader's claim epoch. */
export interface PermitPair { permitNumber: number; epoch: number }

/** Is `v` a pair of two safe non-negative integers? */
export function isPermitPair(v: unknown): v is PermitPair {
  const p = v as Partial<PermitPair> | null
  return !!p && typeof p === 'object' && Number.isSafeInteger(p.permitNumber) && Number.isSafeInteger(p.epoch) && p.permitNumber! >= 0 && p.epoch! >= 0
}

/**
 * The one comparison of two leaders' standing (resume and the door's welcome): by permitNumber,
 * then by epoch. Negative when `a` is lower, 0 when equal, positive when higher.
 */
export function comparePermit(a: PermitPair, b: PermitPair): number {
  if (a.permitNumber !== b.permitNumber) return a.permitNumber < b.permitNumber ? -1 : 1
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1
  return 0
}

/** A resume's pair: an older leader sends no epoch, and its permitNumber was the epoch (0, n). */
export function permitOfResume(f: { permitNumber?: unknown; epoch?: unknown }): PermitPair | null {
  const pair = f.epoch === undefined ? { permitNumber: 0, epoch: f.permitNumber as number } : { permitNumber: f.permitNumber as number, epoch: f.epoch as number }
  return isPermitPair(pair) ? pair : null
}

/** A leader reads the `standDownHeld` mark on a turn end: it says nothing of one and waits for the host to say it again (stand-down-held.ts). */
export const READS_HELD_TURN_ENDS = 'stand-down-held-v1'
/** What this build's leader names on its resume (`reads`). */
export const LEADER_READS: readonly string[] = [READS_HELD_TURN_ENDS]

/** Records per facts frame when the log is read back. */
const REPLAY_BATCH = 256

interface Reader { link: ChannelLink; leader: boolean; caughtUp: boolean; sentUpTo: number; alive: boolean; reads: ReadonlySet<string> }

export interface HostChannelOptions {
  log: FactLog
  walnutId: string
  hostId: string
  /** This host's own rows as they are now (rowOwnedHere), for a `rows` frame. */
  ownRows(): Promise<SessionRecord[]>
  /** The leader asked for these rows whole again (a `resync` frame): the emitter appends them. */
  onResync?(sids: string[]): void
  /** The rows this host removed lately (gone-rows.ts), sent with every rows frame. */
  goneRows?(): string[]
  /** A leader resumed on a link (each link): what the leader keeps only in memory goes again (host-emitter.ts relive). */
  onLeaderLinked?(): void
  /** How long text and thinking deltas merge into one flow frame (flow-merge.ts; 0: each goes at once). */
  flowMergeMs?: number
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** The host's end: one per Walnut this host's service runs sessions for. */
export class HostChannel {
  private readers = new Set<Reader>()
  private leaderReader: Reader | null = null
  private readonly flows: FlowMerger

  constructor(private readonly o: HostChannelOptions) {
    this.flows = new FlowMerger((sid, name, data, to) => this.sendFlow(sid, name, data, to), o.flowMergeMs)
    o.log.onDurable((recs) => this.live(recs))
  }

  /** A new link (either direction). Returns the frame handler and the close handler for it. */
  attach(link: ChannelLink): { onFrame(frame: ChannelFrame): void; onClose(): void } {
    const reader: Reader = { link, leader: false, caughtUp: false, sentUpTo: 0, alive: true, reads: new Set() }
    const log = this.o.log
    link.send({ ch: 'sf', op: 'hello', walnutId: this.o.walnutId, hostId: this.o.hostId, logId: log.logId, floor: log.floor, head: log.head, now: this.now() })
    const refuse = (why: string): void => {
      reader.alive = false
      try { link.send({ ch: 'sf', op: 'refuse', why }) } catch { /* closing anyway */ }
      link.close(why)
    }
    return {
      onFrame: (frame) => {
        if (!reader.alive) return
        if (frame.op === 'resume') void this.resume(reader, frame, refuse)
        else if (frame.op === 'listen') {
          if (frame.walnutId !== this.o.walnutId) return refuse('walnut_mismatch')
          this.readers.add(reader)
          void this.sendRows(reader, false).catch((err) => this.fail(reader, err))
        } else if (frame.op === 'ack') {
          if (reader !== this.leaderReader || frame.logId !== log.logId) return
          void log.ack(frame.upTo)
        } else if (frame.op === 'resync') {
          if (reader !== this.leaderReader || !Array.isArray(frame.sids)) return
          const sids = frame.sids.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 500)
          try { this.o.onResync?.(sids) } catch (err) { this.o.onLog?.('warn', 'session channel: a resync failed', { error: err instanceof Error ? err.message : String(err) }) }
        }
      },
      onClose: () => {
        reader.alive = false
        this.readers.delete(reader)
        if (this.leaderReader === reader) this.leaderReader = null
      },
    }
  }

  /** A text delta: only to readers that are caught up, never kept; deltas merge for a moment (flow-merge.ts). */
  flow(sid: string, name: string, data: unknown, to?: string[]): void {
    if (!this.anyCaughtUp()) return
    this.flows.add(sid, name, data, to)
  }

  private anyCaughtUp(): boolean {
    for (const r of this.readers) if (r.caughtUp && r.alive) return true
    return false
  }

  private sendFlow(sid: string, name: string, data: unknown, to?: string[]): void {
    for (const r of this.readers) if (r.caughtUp && r.alive) r.link.send({ ch: 'sf', op: 'flow', sid, name, data, ...(to ? { to } : {}) })
  }

  private now(): number { return (this.o.now ?? Date.now)() }

  /** Is a leader connected and caught up now? */
  leaderLive(): boolean { return !!this.leaderReader?.caughtUp }

  /** Does the leader linked now read `mark` (its resume's `reads`)? */
  leaderReads(mark: string): boolean { return !!this.leaderReader?.reads.has(mark) }

  private async resume(reader: Reader, f: Extract<ChannelFrame, { op: 'resume' }>, refuse: (why: string) => void): Promise<void> {
    const log = this.o.log
    if (f.walnutId !== this.o.walnutId) return refuse('walnut_mismatch')
    if (f.hostId !== this.o.hostId) return refuse('host_mismatch')
    const pair = permitOfResume(f)
    if (!pair || comparePermit(pair, log.permitPair) < 0) return refuse('stale_permit')
    await log.notePermit(pair)
    // One leader at a time: a newer resume (same or higher permit) replaces the link before it.
    if (this.leaderReader && this.leaderReader !== reader) {
      const old = this.leaderReader
      old.alive = false
      try { old.link.send({ ch: 'sf', op: 'refuse', why: 'replaced' }) } catch { /* gone */ }
      old.link.close('replaced')
      this.readers.delete(old)
    }
    reader.leader = true
    reader.reads = new Set(Array.isArray(f.reads) ? f.reads.filter((x): x is string => typeof x === 'string') : [])
    this.leaderReader = reader
    this.readers.add(reader)
    try {
      // -1: a leader that does not know this log (a host set up again under a new log id): it
      // gets this host's rows first, whatever the log still holds, so nothing it missed stays missed.
      const after = f.logId === log.logId && Number.isSafeInteger(f.after) && f.after >= 0 ? f.after : -1
      if (after < 0 || after + 1 < log.floor) await this.sendRows(reader, true)
      else {
        reader.sentUpTo = after
        await this.replay(reader)
      }
      if (reader.alive && this.leaderReader === reader) {
        try { this.o.onLeaderLinked?.() } catch (err) { this.o.onLog?.('warn', 'session channel: resending the live state failed', { error: err instanceof Error ? err.message : String(err) }) }
      }
    } catch (err) {
      this.fail(reader, err)
    }
  }

  private async sendRows(reader: Reader, leader: boolean): Promise<void> {
    const log = this.o.log
    await log.flush()
    const rowsAt = log.head
    const rows = await this.o.ownRows()
    if (!reader.alive) return
    // A leader still gets every fact the log keeps; a listener starts at the head.
    const upTo = leader ? Math.min(rowsAt, Math.max(0, log.floor - 1)) : rowsAt
    const gone = leader ? (this.o.goneRows?.() ?? []) : []
    reader.link.send({ ch: 'sf', op: 'rows', rows, upTo, rowsAt, logId: log.logId, ...(gone.length ? { gone } : {}) })
    reader.sentUpTo = upTo
    await this.replay(reader)
  }

  /** Read the log back from `sentUpTo` until this reader holds the durable head, then go live. */
  private async replay(reader: Reader): Promise<void> {
    const log = this.o.log
    reader.caughtUp = false
    while (reader.alive && reader.sentUpTo < log.head) {
      const recs = await log.read(reader.sentUpTo, REPLAY_BATCH)
      if (!reader.alive) return
      if (recs.length === 0) break
      reader.link.send({ ch: 'sf', op: 'facts', recs, replay: true, sentAt: this.now() })
      reader.sentUpTo = recs[recs.length - 1].seq
    }
    // Same tick as the head check: any batch made durable from here on reaches live().
    if (reader.alive && reader.sentUpTo >= log.head) reader.caughtUp = true
  }

  private live(recs: FactRecord[]): void {
    // A session's deltas said before these facts go before them.
    for (const sid of new Set(recs.map((x) => x.sid))) this.flows.flush(sid)
    for (const r of this.readers) {
      if (!r.alive || !r.caughtUp) continue
      const fresh = recs.filter((x) => x.seq > r.sentUpTo)
      if (fresh.length === 0) continue
      r.link.send({ ch: 'sf', op: 'facts', recs: fresh, sentAt: this.now() })
      r.sentUpTo = fresh[fresh.length - 1].seq
    }
  }

  private fail(reader: Reader, err: unknown): void {
    this.o.onLog?.('warn', 'session channel: a reader failed', { error: err instanceof Error ? err.message : String(err) })
    reader.alive = false
    this.readers.delete(reader)
    if (this.leaderReader === reader) this.leaderReader = null
    reader.link.close('error')
  }
}

export interface ChannelCursor { logId: string; seq: number }

/**
 * One applied record, as the leader's handler gets it. `happenedAt`: when it happened, on this
 * leader's clock (the host's `at` moved by the link's offset), the time a late fact is counted by.
 */
export interface AppliedFact extends FactRecord { late: boolean; happenedAt: number }

export interface LeaderChannelOptions {
  walnutId: string
  /** The host this link should be ('' accepts the host the hello names: tests, a door that already authenticated it). */
  hostId: string
  /** This leader's standing now (comparePermit), sent in each resume. */
  permit(): PermitPair
  loadCursor(hostId: string): Promise<ChannelCursor | null>
  /** Apply records in order and keep `next` as the new position, atomically with their effects. */
  apply(hostId: string, recs: AppliedFact[], next: ChannelCursor): Promise<void>
  /**
   * The host's own rows as of record `at`, standing for every record up to `next.seq`: apply them
   * and keep `next`. `gone`: the rows the host says it removed (rows-snapshot.ts).
   */
  applyRows(hostId: string, rows: SessionRecord[], next: ChannelCursor, frame: { at: number; gone: string[] }): Promise<void>
  onFlow?(hostId: string, sid: string, name: string, data: unknown, to?: string[]): void
  /**
   * Once per link: what the host's log held at its hello is applied here (the position reached its
   * head), so the leader's rows of that host are current. Called inside the apply chain, after the
   * apply that got there.
   */
  onCaughtUp?(hostId: string): void
  /** How old a record must be, on this leader's clock, when it is applied to read as late (default 60 s). */
  lateMs?: number
  ackEveryMs?: number
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** At most this many facts frames apply in one call on the leader (a bound on one transaction). */
const COALESCE_MAX_FRAMES = 64

/** The leader's end of one link to one host. */
export function attachLeaderChannel(link: ChannelLink, o: LeaderChannelOptions): { onFrame(frame: ChannelFrame): void; onClose(): void; resync(sids: string[]): void; idle(): Promise<void> } {
  const now = o.now ?? Date.now
  const lateMs = o.lateMs ?? 60_000
  let hostId = ''
  let cursor: ChannelCursor | null = null
  /** The record the last rows frame was taken at: row patches up to it are already applied. */
  let rowsAt = 0
  /** Leader clock minus host clock, the smallest seen on this link (null: no host clock yet). */
  let offset: number | null = null
  const noteHostClock = (hostNow: unknown): void => {
    if (typeof hostNow !== 'number' || !Number.isFinite(hostNow)) return
    const d = now() - hostNow
    offset = offset === null ? d : Math.min(offset, d)
  }
  let chain: Promise<void> = Promise.resolve()
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  let open = true
  /** The host log's head its hello named, until the position reaches it (then null: said once). */
  let helloHead: number | null = null
  const noteCaughtUp = (): void => {
    if (helloHead === null || !cursor || cursor.seq < helloHead) return
    helloHead = null
    try { o.onCaughtUp?.(hostId) } catch (err) { o.onLog?.('warn', 'session channel: the caught-up handler failed', { hostId, error: err instanceof Error ? err.message : String(err) }) }
  }
  /**
   * The facts frames queued behind the apply that runs now, not started yet: a facts frame that
   * arrives while they wait joins them, so they apply in one call (one transaction on the leader),
   * in order, the position the last one's. Any other frame queued after them closes the batch.
   */
  let waiting: Array<Extract<ChannelFrame, { op: 'facts' }>> | null = null
  const serial = (fn: () => Promise<void>): void => {
    if (waiting) waiting = null
    chain = chain.then(() => (open ? fn() : undefined)).catch((err: unknown) => {
      o.onLog?.('warn', 'session channel: applying failed; the link is closed and resumes from the last applied record', { hostId, error: err instanceof Error ? err.message : String(err) })
      open = false
      link.close('apply_failed')
    })
  }
  const scheduleAck = (): void => {
    if (ackTimer || !cursor) return
    ackTimer = setTimeout(() => {
      ackTimer = null
      if (open && cursor) link.send({ ch: 'sf', op: 'ack', logId: cursor.logId, upTo: cursor.seq })
    }, o.ackEveryMs ?? 100)
  }
  return {
    onFrame(frame) {
      if (!open) return
      if (frame.op === 'hello') {
        if (frame.walnutId !== o.walnutId || (o.hostId && frame.hostId !== o.hostId)) { open = false; link.close('mismatch'); return }
        hostId = frame.hostId
        noteHostClock(frame.now)
        const logId = frame.logId
        serial(async () => {
          const c = await o.loadCursor(hostId)
          const known = !!c && c.logId === logId
          cursor = known ? c! : { logId, seq: 0 }
          // A host this leader knew under another log (set up again, its log lost): -1, so it sends
          // its rows first (channel header). A host it never heard of replays its log from the start.
          const p = o.permit()
          const after = known || !c ? cursor.seq : -1
          link.send({ ch: 'sf', op: 'resume', walnutId: o.walnutId, hostId, permitNumber: p.permitNumber, epoch: p.epoch, logId, after, reads: [...LEADER_READS] })
          helloHead = Number.isFinite(frame.head) ? frame.head : 0
          // A rows frame comes first when the leader asked for them (-1), whatever the position.
          if (after >= 0) noteCaughtUp()
        })
      } else if (frame.op === 'rows') {
        serial(async () => {
          if (!cursor || frame.logId !== cursor.logId) return
          const next = { logId: cursor.logId, seq: frame.upTo }
          const gone = Array.isArray(frame.gone) ? frame.gone.filter((x): x is string => typeof x === 'string' && x !== '') : []
          await o.applyRows(hostId, frame.rows, next, { at: Number(frame.rowsAt) || frame.upTo, gone })
          cursor = next
          rowsAt = Math.max(rowsAt, Number(frame.rowsAt) || 0)
          scheduleAck()
          noteCaughtUp()
        })
      } else if (frame.op === 'facts') {
        noteHostClock(frame.sentAt)
        if (waiting && waiting.length < COALESCE_MAX_FRAMES) { waiting.push(frame); return }
        const batch = [frame]
        serial(async () => {
          if (waiting === batch) waiting = null
          if (!cursor) return
          const c = cursor
          let upTo = c.seq
          const fresh = batch.flatMap((f) => f.recs).filter((r) => (r.seq > upTo ? (upTo = r.seq, true) : false))
          if (fresh.length === 0) return
          const at = now()
          // Late: older than lateMs on this leader's clock (a leader that was away or stopped).
          const off = offset ?? 0
          const recs = fresh
            .filter((r) => !(r.name === 'row' && r.seq <= rowsAt))
            .map((r) => {
              // Never after now: a host clock read on a fast link may round past it.
              const happenedAt = Math.min(at, r.at + off)
              return { ...r, late: at - happenedAt > lateMs, happenedAt }
            })
          const next = { logId: c.logId, seq: fresh[fresh.length - 1].seq }
          await o.apply(hostId, recs, next)
          cursor = next
          scheduleAck()
          noteCaughtUp()
        })
        waiting = batch
      } else if (frame.op === 'flow') {
        o.onFlow?.(hostId, frame.sid, frame.name, frame.data, frame.to)
      } else if (frame.op === 'refuse') {
        o.onLog?.('warn', 'session channel: the host refused this leader', { hostId, why: frame.why })
        open = false
      }
    },
    onClose() {
      open = false
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
    },
    resync(sids: string[]) {
      if (open && sids.length > 0) link.send({ ch: 'sf', op: 'resync', sids })
    },
    idle: () => chain,
  }
}
