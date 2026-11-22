/**
 * The session channel between a host's service and its Walnut's leader
 * (docs/plan/one-service-every-host.md, phase 2): the host sends what its sessions did, the leader
 * confirms. The same frames run on any link, whoever dialed it (the leader over ssh, or the host
 * into the leader's door), so a host that moves to another leader resumes there from that
 * leader's own confirmed position.
 *
 *   host -> any   hello  {walnutId, hostId, logId, floor, head, now}
 *   leader -> host resume {walnutId, hostId, permitNumber, logId, after}
 *                         after: the last seq of this log the leader applied (0: none, or a log
 *                         it does not know); a log that still holds every record after `after`
 *                         replays them, one that trimmed some sends its rows first; the host refuses a permit number lower than the
 *                         highest it has seen (a leader that lost its permit replays nothing and
 *                         trims nothing)
 *   listener -> host listen {walnutId}        a reader that never confirms (the cloud companion):
 *                         it gets this host's own rows as they are now, then everything live
 *   host -> reader  rows  {rows, upTo, rowsAt} the host's own rows as of record `rowsAt`, standing for
 *                         every record up to `upTo`: for a leader below what the log keeps, `upTo` is
 *                         the last record the log no longer has, and the records after it still come
 *                         as facts (their row patches up to `rowsAt` are already in the rows, so the
 *                         leader skips those); for a listener both are the head
 *   host -> reader  facts {recs, replay?, sentAt} records in seq order; `replay`: read back from the
 *                         log, not live; `now`/`sentAt`: the host's clock, so the leader can tell
 *                         how old a record is on its own clock (late facts, below)
 *   host -> reader  flow  {sid, name, data}   a text delta: only to a reader that is caught up
 *   leader -> host  ack   {logId, upTo}       the leader applied everything up to `upTo`
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
import type { SessionRecord } from '../types.js'

export type ChannelFrame =
  | { ch: 'sf'; op: 'hello'; walnutId: string; hostId: string; logId: string; floor: number; head: number; now?: number }
  | { ch: 'sf'; op: 'resume'; walnutId: string; hostId: string; permitNumber: number; logId: string; after: number }
  | { ch: 'sf'; op: 'listen'; walnutId: string }
  | { ch: 'sf'; op: 'rows'; rows: SessionRecord[]; upTo: number; rowsAt: number; logId: string }
  | { ch: 'sf'; op: 'facts'; recs: FactRecord[]; replay?: true; sentAt?: number }
  | { ch: 'sf'; op: 'flow'; sid: string; name: string; data: unknown; to?: string[] }
  | { ch: 'sf'; op: 'ack'; logId: string; upTo: number }
  | { ch: 'sf'; op: 'refuse'; why: string }

export interface ChannelLink {
  send(frame: ChannelFrame): void
  close(why?: string): void
}

export function isChannelFrame(v: unknown): v is ChannelFrame {
  const f = v as { ch?: unknown; op?: unknown } | null
  return !!f && typeof f === 'object' && f.ch === 'sf' && typeof f.op === 'string'
}

/** Records per facts frame when the log is read back. */
const REPLAY_BATCH = 256

interface Reader { link: ChannelLink; leader: boolean; caughtUp: boolean; sentUpTo: number; alive: boolean }

export interface HostChannelOptions {
  log: FactLog
  walnutId: string
  hostId: string
  /** This host's own rows as they are now (rowOwnedHere), for a `rows` frame. */
  ownRows(): Promise<SessionRecord[]>
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** The host's end: one per Walnut this host's service runs sessions for. */
export class HostChannel {
  private readers = new Set<Reader>()
  private leaderReader: Reader | null = null

  constructor(private readonly o: HostChannelOptions) {
    o.log.onDurable((recs) => this.live(recs))
  }

  /** A new link (either direction). Returns the frame handler and the close handler for it. */
  attach(link: ChannelLink): { onFrame(frame: ChannelFrame): void; onClose(): void } {
    const reader: Reader = { link, leader: false, caughtUp: false, sentUpTo: 0, alive: true }
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
        }
      },
      onClose: () => {
        reader.alive = false
        this.readers.delete(reader)
        if (this.leaderReader === reader) this.leaderReader = null
      },
    }
  }

  /** A text delta: only to readers that are caught up, never kept. */
  flow(sid: string, name: string, data: unknown, to?: string[]): void {
    for (const r of this.readers) if (r.caughtUp && r.alive) r.link.send({ ch: 'sf', op: 'flow', sid, name, data, ...(to ? { to } : {}) })
  }

  private now(): number { return (this.o.now ?? Date.now)() }

  /** Is a leader connected and caught up now? */
  leaderLive(): boolean { return !!this.leaderReader?.caughtUp }

  private async resume(reader: Reader, f: Extract<ChannelFrame, { op: 'resume' }>, refuse: (why: string) => void): Promise<void> {
    const log = this.o.log
    if (f.walnutId !== this.o.walnutId) return refuse('walnut_mismatch')
    if (f.hostId !== this.o.hostId) return refuse('host_mismatch')
    if (!Number.isSafeInteger(f.permitNumber) || f.permitNumber < log.permit) return refuse('stale_permit')
    await log.notePermit(f.permitNumber)
    // One leader at a time: a newer resume (same or higher permit) replaces the link before it.
    if (this.leaderReader && this.leaderReader !== reader) {
      const old = this.leaderReader
      old.alive = false
      try { old.link.send({ ch: 'sf', op: 'refuse', why: 'replaced' }) } catch { /* gone */ }
      old.link.close('replaced')
      this.readers.delete(old)
    }
    reader.leader = true
    this.leaderReader = reader
    this.readers.add(reader)
    try {
      const after = f.logId === log.logId && Number.isSafeInteger(f.after) ? Math.max(0, f.after) : 0
      if (after + 1 < log.floor) await this.sendRows(reader, true)
      else {
        reader.sentUpTo = after
        await this.replay(reader)
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
    reader.link.send({ ch: 'sf', op: 'rows', rows, upTo, rowsAt, logId: log.logId })
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
  permitNumber(): number
  loadCursor(hostId: string): Promise<ChannelCursor | null>
  /** Apply records in order and keep `next` as the new position, atomically with their effects. */
  apply(hostId: string, recs: AppliedFact[], next: ChannelCursor): Promise<void>
  /** The host's own rows, standing for every record up to `next.seq`: apply them and keep `next`. */
  applyRows(hostId: string, rows: SessionRecord[], next: ChannelCursor): Promise<void>
  onFlow?(hostId: string, sid: string, name: string, data: unknown, to?: string[]): void
  /** How old a record must be, on this leader's clock, when it is applied to read as late (default 60 s). */
  lateMs?: number
  ackEveryMs?: number
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** The leader's end of one link to one host. */
export function attachLeaderChannel(link: ChannelLink, o: LeaderChannelOptions): { onFrame(frame: ChannelFrame): void; onClose(): void; idle(): Promise<void> } {
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
  const serial = (fn: () => Promise<void>): void => {
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
          cursor = c && c.logId === logId ? c : { logId, seq: 0 }
          link.send({ ch: 'sf', op: 'resume', walnutId: o.walnutId, hostId, permitNumber: o.permitNumber(), logId, after: cursor.seq })
        })
      } else if (frame.op === 'rows') {
        serial(async () => {
          if (!cursor || frame.logId !== cursor.logId) return
          const next = { logId: cursor.logId, seq: frame.upTo }
          await o.applyRows(hostId, frame.rows, next)
          cursor = next
          rowsAt = Math.max(rowsAt, Number(frame.rowsAt) || 0)
          scheduleAck()
        })
      } else if (frame.op === 'facts') {
        noteHostClock(frame.sentAt)
        serial(async () => {
          if (!cursor) return
          const c = cursor
          const fresh = frame.recs.filter((r) => r.seq > c.seq)
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
        })
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
    idle: () => chain,
  }
}
