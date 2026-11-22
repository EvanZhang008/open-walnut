/**
 * A host's log of session facts for one Walnut (docs/plan/one-service-every-host.md, phase 2):
 * every fact of every session this host's service judges, in order, kept until that Walnut's
 * leader confirmed it. While the leader is connected the log is the channel's send buffer; while
 * it is away the same records pile up here and go when it comes back (channel.ts): one set of
 * records for both.
 *
 * Records keep the offline journal's shape (`{v:2, seq, opId, rev, at, kind, ...}`,
 * providers/offline-journal-core.ts) so the leader dedups them the same way, plus `sid`, a
 * per-session `sseq`, the fact's event `name` and `data`. It is a file of its own, not the
 * journal: a fact is written by the service's main thread at the rate of a session's tools, so
 * appends are batched (one write and one fdatasync per batch, every `flushMs`), async, and never
 * take the journal's per-append lock.
 *
 * Files in `dir`:
 *   facts-<walnutId>.ndjson      one record per line, append-only; rewritten only by compaction
 *                                (tmp + rename)
 *   facts-<walnutId>.state.json  {v:1, logId, acked, permit, sseq: {sid: last}}
 *
 * Rules this file owns:
 *   - a record is durable (fsynced) before anyone hears of it (`onDurable`), so a leader never
 *     confirms what a crash could lose;
 *   - the CLI's output file already holds every line in full: a string field longer than
 *     `inlineCap` is cut on disk and named in `refs` with the line it came from; the record the
 *     live channel sends (`onDurable`) is the whole one, from memory;
 *   - compaction (when the file passes `compactBytes`) drops what the leader confirmed, and in
 *     what it has not, stands one `turn-summary` record for the tool facts of each finished turn
 *     and one merged `row` record for its row patches; facts of a turn still running are kept;
 *   - a torn last line (a crash in a write) is cut at open.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { TURN_DETAIL_FACTS, TURN_END_FACT } from './event-classes.js'

export interface FactRef { epoch?: string; v?: number; bytes: number }

export interface FactRecord {
  v: 2
  seq: number
  opId: string
  rev: 1
  at: number
  kind: 'session-fact'
  sid: string
  sseq: number
  /** A session event name (event-classes.ts) or a channel record kind ('row', 'rename', 'drop', 'turn-summary'). */
  name: string
  data: unknown
  /** The CLI output line the fact came from (its stream epoch and end offset). */
  line?: { epoch?: string; v: number }
  /** Fields cut to the inline cap on disk, by their path in `data` ('a.b.0'). */
  refs?: Record<string, FactRef>
}

export interface FactLogOptions {
  dir: string
  walnutId: string
  now?: () => number
  flushMs?: number
  durable?: boolean
  inlineCap?: number
  compactBytes?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

interface LogState { v: 1; logId: string; acked: number; permit: number; sseq: Record<string, number> }

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/

export class FactLog {
  private state: LogState
  private nextSeq: number
  private buffered: { full: FactRecord; line: string }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()
  private listeners = new Set<(recs: FactRecord[]) => void>()
  private bytes: number
  private firstSeq: number
  private closed = false
  private durableHead: number

  private constructor(private readonly o: Required<Omit<FactLogOptions, 'log'>> & Pick<FactLogOptions, 'log'>, state: LogState, head: number, first: number, bytes: number) {
    this.state = state
    this.nextSeq = head + 1
    this.durableHead = head
    this.firstSeq = first
    this.bytes = bytes
  }

  static async open(opts: FactLogOptions): Promise<FactLog> {
    if (!SAFE_ID.test(opts.walnutId)) throw new Error(`fact log: bad walnut id ${JSON.stringify(opts.walnutId)}`)
    const o = {
      now: Date.now, flushMs: 15, durable: true, inlineCap: 16 * 1024, compactBytes: 8 * 1024 * 1024, ...opts,
    }
    await fsp.mkdir(o.dir, { recursive: true, mode: 0o700 })
    const file = path.join(o.dir, `facts-${o.walnutId}.ndjson`)
    const stateFile = path.join(o.dir, `facts-${o.walnutId}.state.json`)
    let state: LogState | null = null
    try {
      const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8')) as Partial<LogState>
      if (raw?.v === 1 && typeof raw.logId === 'string') {
        state = { v: 1, logId: raw.logId, acked: Number(raw.acked) || 0, permit: Number(raw.permit) || 0, sseq: raw.sseq && typeof raw.sseq === 'object' ? raw.sseq : {} }
      }
    } catch { /* a new log */ }
    const { records, validBytes, totalBytes } = await readRecords(file)
    if (validBytes < totalBytes) {
      // A crash in a write left a torn line: cut it, so the next append starts on a line of its own.
      await fsp.truncate(file, validBytes)
      o.log?.('warn', 'fact log: cut a torn last line', { walnutId: o.walnutId, cut: totalBytes - validBytes })
    }
    if (!state) state = { v: 1, logId: crypto.randomBytes(8).toString('hex'), acked: 0, permit: 0, sseq: {} }
    let head = state.acked
    for (const r of records) {
      head = Math.max(head, r.seq)
      state.sseq[r.sid] = Math.max(state.sseq[r.sid] ?? 0, r.sseq)
    }
    const log = new FactLog(o, state, head, records[0]?.seq ?? head + 1, validBytes)
    await log.saveState()
    return log
  }

  get logId(): string { return this.state.logId }
  /** The last durable seq (0: none yet). */
  get head(): number { return this.durableHead }
  /** The lowest seq still in the file (head + 1 when it holds none). */
  get floor(): number { return this.firstSeq }
  get acked(): number { return this.state.acked }
  get permit(): number { return this.state.permit }
  get sizeBytes(): number { return this.bytes }
  private get file(): string { return path.join(this.o.dir, `facts-${this.o.walnutId}.ndjson`) }
  private get stateFile(): string { return path.join(this.o.dir, `facts-${this.o.walnutId}.state.json`) }

  /** Hear each batch once it is durable, the whole records, in seq order. */
  onDurable(cb: (recs: FactRecord[]) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** The next sseq this session's next fact takes, without taking it. */
  nextSseq(sid: string): number { return (this.state.sseq[sid] ?? 0) + 1 }

  /**
   * Append one fact. Seq and sseq are taken now (so order is the caller's); it is durable after
   * the next flush. `continueFrom`: a session id that replaced another (a rename) continues the
   * old id's sseq instead of starting from 1.
   */
  append(sid: string, name: string, data: unknown, opts: { line?: { epoch?: string; v: number }; at?: number; continueFrom?: string } = {}): FactRecord {
    if (this.closed) throw new Error('fact log closed')
    if (!SAFE_ID.test(sid)) throw new Error(`fact log: bad session id ${JSON.stringify(sid)}`)
    if (opts.continueFrom && this.state.sseq[opts.continueFrom] && !this.state.sseq[sid]) this.state.sseq[sid] = this.state.sseq[opts.continueFrom]
    const seq = this.nextSeq++
    const sseq = (this.state.sseq[sid] ?? 0) + 1
    this.state.sseq[sid] = sseq
    const full: FactRecord = {
      v: 2, seq, opId: `sf-${this.state.logId}-${seq}`, rev: 1, at: opts.at ?? this.o.now(), kind: 'session-fact', sid, sseq, name, data,
      ...(opts.line ? { line: opts.line } : {}),
    }
    const disk = capRecord(full, this.o.inlineCap)
    this.buffered.push({ full, line: JSON.stringify(disk) + '\n' })
    this.schedule()
    return full
  }

  /** Write what is buffered now (and wait for any write in progress). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    return this.serial(() => this.writeBuffered())
  }

  /** The leader confirmed everything up to `upTo`. Trims the file when enough of it is confirmed. */
  async ack(upTo: number): Promise<void> {
    if (!Number.isSafeInteger(upTo) || upTo <= this.state.acked) return
    this.state.acked = Math.min(upTo, this.durableHead)
    await this.serial(async () => {
      await this.saveState()
      if (this.firstSeq <= this.state.acked && this.bytes > this.o.compactBytes / 2) await this.compactNow()
    })
  }

  /** A leader with this permit number spoke: remember the highest. */
  async notePermit(n: number): Promise<void> {
    if (!Number.isSafeInteger(n) || n <= this.state.permit) return
    this.state.permit = n
    await this.serial(() => this.saveState())
  }

  /** The durable records after `after`, as kept on disk (cut fields, summaries), in seq order. */
  async read(after: number, limit = Number.MAX_SAFE_INTEGER): Promise<FactRecord[]> {
    // Read between writes, so a compaction's rename never races the read.
    let out: FactRecord[] = []
    await this.serial(async () => {
      const { records } = await readRecords(this.file)
      out = records.filter((r) => r.seq > after && r.seq <= this.durableHead)
    })
    return out.length > limit ? out.slice(0, limit) : out
  }

  /** Rewrite the file now (tests; the size and ack triggers call it themselves). */
  compact(): Promise<void> { return this.serial(() => this.compactNow()) }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    this.listeners.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.serial(() => this.writeBuffered()) }, this.o.flushMs)
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn)
    this.chain = run.catch((err: unknown) => {
      this.o.log?.('warn', 'fact log: a write failed', { walnutId: this.o.walnutId, error: err instanceof Error ? err.message : String(err) })
    })
    return run
  }

  private async writeBuffered(): Promise<void> {
    if (this.buffered.length === 0) return
    const batch = this.buffered
    this.buffered = []
    const text = batch.map((b) => b.line).join('')
    const fh = await fsp.open(this.file, 'a', 0o600)
    try {
      await fh.write(text)
      if (this.o.durable) await fh.datasync()
    } catch (err) {
      // Not written: put the batch back in front, so order holds and the next flush tries again.
      this.buffered = [...batch, ...this.buffered]
      throw err
    } finally {
      await fh.close()
    }
    this.bytes += Buffer.byteLength(text)
    if (this.firstSeq > this.durableHead) this.firstSeq = batch[0].full.seq
    this.durableHead = batch[batch.length - 1].full.seq
    const recs = batch.map((b) => b.full)
    for (const cb of this.listeners) {
      try { cb(recs) } catch (err) {
        this.o.log?.('warn', 'fact log: a listener threw', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (this.bytes > this.o.compactBytes) await this.compactNow()
  }

  private async compactNow(): Promise<void> {
    const { records } = await readRecords(this.file)
    const kept = compactRecords(records.filter((r) => r.seq > this.state.acked))
    const tmp = `${this.file}.tmp`
    const text = kept.map((r) => JSON.stringify(r) + '\n').join('')
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.write(text)
      if (this.o.durable) await fh.datasync()
    } finally {
      await fh.close()
    }
    await this.saveState()
    await fsp.rename(tmp, this.file)
    const before = this.bytes
    this.bytes = Buffer.byteLength(text)
    this.firstSeq = kept[0]?.seq ?? this.durableHead + 1
    this.o.log?.('info', 'fact log: compacted', { walnutId: this.o.walnutId, records: records.length, kept: kept.length, before, after: this.bytes })
  }

  private async saveState(): Promise<void> {
    const tmp = `${this.stateFile}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 })
    await fsp.rename(tmp, this.stateFile)
  }
}

async function readRecords(file: string): Promise<{ records: FactRecord[]; validBytes: number; totalBytes: number }> {
  let buf: Buffer
  try { buf = await fsp.readFile(file) } catch { return { records: [], validBytes: 0, totalBytes: 0 } }
  const records: FactRecord[] = []
  let start = 0
  let valid = 0
  while (start < buf.length) {
    const nl = buf.indexOf(10, start)
    if (nl < 0) break // a torn last line
    try {
      const r = JSON.parse(buf.subarray(start, nl).toString('utf8')) as FactRecord
      if (r && r.kind === 'session-fact' && Number.isSafeInteger(r.seq)) records.push(r)
    } catch { break }
    start = nl + 1
    valid = start
  }
  return { records, validBytes: valid, totalBytes: buf.length }
}

/** The record as kept on disk: every string over `cap` bytes cut, and named in `refs`. */
export function capRecord(rec: FactRecord, cap: number): FactRecord {
  const refs: Record<string, FactRef> = {}
  const walk = (v: unknown, at: string, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length <= cap) return v
      refs[at || '.'] = { ...(rec.line?.epoch ? { epoch: rec.line.epoch } : {}), ...(rec.line ? { v: rec.line.v } : {}), bytes: Buffer.byteLength(v) }
      return v.slice(0, cap)
    }
    if (depth > 8 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((x, i) => walk(x, at ? `${at}.${i}` : String(i), depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, at ? `${at}.${k}` : k, depth + 1)
    return out
  }
  const data = walk(rec.data, '', 0)
  return Object.keys(refs).length ? { ...rec, data, refs } : rec
}

/**
 * Stand one summary for the detail facts of each finished turn of each session, and one merged
 * row patch for its row patches. A turn is a session's records after its last `session:result`
 * up to and including the next one; the records of a turn still running stay as they are.
 */
export function compactRecords(records: readonly FactRecord[]): FactRecord[] {
  const bySid = new Map<string, FactRecord[]>()
  for (const r of records) { const list = bySid.get(r.sid) ?? []; list.push(r); bySid.set(r.sid, list) }
  const replace = new Map<number, FactRecord | null>() // seq -> its stand-in (null: dropped)
  for (const list of bySid.values()) {
    let turn: FactRecord[] = []
    for (const r of list) {
      turn.push(r)
      if (r.name !== TURN_END_FACT) continue
      const detail = turn.filter((x) => TURN_DETAIL_FACTS.has(x.name) || x.name === 'turn-summary')
      if (detail.length > 1) {
        const tools: Record<string, number> = {}
        let toolUses = 0
        let lastUsage: unknown
        for (const d of detail) {
          if (d.name === 'turn-summary') {
            const s = d.data as { toolUses?: number; tools?: Record<string, number>; usage?: unknown }
            toolUses += s.toolUses ?? 0
            for (const [k, n] of Object.entries(s.tools ?? {})) tools[k] = (tools[k] ?? 0) + n
            if (s.usage !== undefined) lastUsage = s.usage
          } else if (d.name === 'session:tool-use') {
            toolUses++
            const name = String((d.data as { name?: unknown })?.name ?? (d.data as { toolName?: unknown })?.toolName ?? 'tool')
            tools[name] = (tools[name] ?? 0) + 1
          } else if (d.name === 'session:usage-update') lastUsage = d.data
        }
        const lines = detail.map((d) => d.line?.v).filter((v): v is number => typeof v === 'number')
        const first = detail[0]
        replace.set(first.seq, {
          ...first, name: 'turn-summary', refs: undefined, line: undefined,
          data: { facts: detail.length, toolUses, tools, ...(lastUsage !== undefined ? { usage: lastUsage } : {}), ...(lines.length ? { vFrom: Math.min(...lines), vTo: Math.max(...lines) } : {}) },
        })
        for (const d of detail.slice(1)) replace.set(d.seq, null)
      }
      const rows = turn.filter((x) => x.name === 'row')
      if (rows.length > 1) {
        const merged: Record<string, unknown> = {}
        for (const x of rows) Object.assign(merged, (x.data as { patch?: Record<string, unknown> })?.patch ?? {})
        const last = rows[rows.length - 1]
        const born = rows.some((x) => (x.data as { born?: boolean })?.born)
        replace.set(last.seq, { ...last, refs: undefined, data: { ...(born ? { born: true } : {}), patch: merged } })
        for (const x of rows.slice(0, -1)) replace.set(x.seq, null)
      }
      turn = []
    }
  }
  // A session's newest `live` record stands for every earlier one.
  const newestLive = new Map<string, number>()
  for (const r of records) if (r.name === 'live') newestLive.set(r.sid, r.seq)
  for (const r of records) if (r.name === 'live' && newestLive.get(r.sid) !== r.seq) replace.set(r.seq, null)
  const out: FactRecord[] = []
  for (const r of records) {
    if (!replace.has(r.seq)) { out.push(r); continue }
    const s = replace.get(r.seq)
    if (s) out.push(stripUndefined(s))
  }
  return out
}

function stripUndefined(r: FactRecord): FactRecord {
  const out = { ...r } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as unknown as FactRecord
}
