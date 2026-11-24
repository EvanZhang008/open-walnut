/**
 * The host's side of what its sessions did (docs/plan/one-service-every-host.md, phase 2): one bus
 * subscriber and one row listener turn the sessions this host owns (session-row-owner.ts
 * rowOwnedHere) into channel records.
 *
 *   bus `fact` event   -> FactLog.append(sid, name, data, {line}) (event-classes.ts)
 *   bus `flow` event   -> HostChannel.flow (only to a caught-up reader, never kept)
 *   `leader`/`command` -> nothing (the leader makes those from its own data)
 *   own row written    -> `row` {born:true, hand?, patch: whole row} the first time (`hand`: the
 *                         leader's hand of the start in flight for its task, host-port.ts handFor), then {patch} with
 *                         the fields that changed since the last row kept (null: cleared); a
 *                         leader field never rides a patch (the host does not write them)
 *   start, resync ask  -> `row` {resync:true, patch: whole row} for each own row (each at start,
 *                         the ones the leader names on its `resync` frame): applied whole, never a start
 *   rename / drop      -> `rename` {from, to} (the new id continues the old id's sseq), `drop` {sid}
 *   any event or row   -> `live` {state}: the mirrored state (host-live.ts), at most every
 *                         `liveMs` per session, and only when it changed; `{gone: true}` once the
 *                         session holds no live object here any more (it ended, it left the runner)
 *   each leader link   -> `live` again for every own session (relive): a leader keeps it only in
 *                         memory, so one that restarted, or a host that restarted, gets it whole
 *   a rename           -> the port says it before the store writes it (expectRename), so the new
 *                         id's first row write is a patch after the `rename` record, never a
 *                         `born` row a leader would read as a new start
 *
 * An event of a session whose row is not known here yet (the CLI's first lines can beat the
 * record) waits up to `pendingMs` for its row: once the row is this host's own the events go after
 * its `born` record, in order; else they are dropped (a session that is not this host's never
 * reaches the log). Events re-emitted by the channel itself (`source: 'host-channel'`) are skipped.
 */
import type { FactLog } from './fact-log.js'
import type { HostChannel } from './channel.js'
import type { LiveState } from './host-api.js'
import { channelClassOf, sessionIdOf } from './event-classes.js'
import { setOwnLiveListener, setOwnRowListener } from './row-hook.js'
import { rowOwnedHere, sessionFieldOwner } from '../sessions/session-row-owner.js'
import type { SessionRecord } from '../types.js'
import type { BusEvent, SubscribeOptions, SubscriberHandler } from '../event-bus.js'

export const HOST_EMITTER_SUBSCRIBER = 'host-session-channel'
const CHANNEL_SOURCE = 'host-channel'
/** Fields that change with every output line: they ride a `live` record, they do not make one. */
const RESTLESS: ReadonlySet<string> = new Set(['consumedOffset', 'timestamps'])
const RESTLESS_EVERY_MS = 1_000
const PENDING_MAX = 500

export interface EmitterBus {
  subscribe(name: string, handler: SubscriberHandler, opts?: SubscribeOptions): void
  unsubscribe(name: string): void
}

export interface HostEmitterOptions {
  log: FactLog
  channel: HostChannel | null
  /** This host's key (WALNUT_HOST_KEY): its own rows name it. */
  hostKey: string
  /** This host's own rows as they are now, read once at start (their next writes are patches). */
  ownRows(): Promise<SessionRecord[]>
  /** The mirrored state of a running session (host-live.ts liveStateOf), null when none runs here. */
  liveOf?(sid: string): LiveState | null
  /** How far the session's runner has read its CLI output (the fact's `line.v`), when known. */
  offsetOf?(sid: string): number | undefined
  bus?: EmitterBus
  /** Install the row listener (row-hook.ts); tests pass their own. */
  rowListener?(fn: ((row: SessionRecord) => void) | null): void
  /** Install the live listener (row-hook.ts noteSessionLiveChanged); tests pass their own. */
  liveListener?(fn: ((sid: string) => void) | null): void
  /**
   * What a fact keeps of its event's data: the data, or a copy with what only this host knows at the
   * event added (a turn end's `hostTakenBy`, turn-run-host.ts). Called in the event's own tick, after
   * the subscribers that subscribed before this one (the resend family) took it.
   */
  stamp?(name: string, data: unknown): unknown
  /**
   * Does the leader this host stood down for judge a turn that ends now (old-leader-watch.ts
   * oldLeaderJudgesNow)? A fact of such a moment is kept with `judgedBy: 'leader'` (fact-log.ts): read
   * in the event's own tick, so a fact held for a row that is not here yet keeps the answer of its time.
   * Only bus facts take the mark; rows, renames, drops and `live` records never do (leader-apply.ts).
   */
  judgedByLeaderNow?(): boolean
  /** An own row was written (the host has `sid` again: gone-rows.ts forgets it). */
  onOwnRow?(sid: string): void
  /** The leader's hand of the start in flight for this row's task (host-port.ts StartBundles.handFor). */
  handOf?(row: SessionRecord): string | undefined
  liveMs?: number
  pendingMs?: number
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface HostEmitter {
  start(): Promise<void>
  stop(): void
  /** The tracker replaced `from` by `to` (resume, fork): the port calls this once the rename is stored. */
  noteRename(from: string, to: string): void
  /**
   * The tracker is about to replace `from` by `to`: the port calls this before it writes, so the
   * new id's row write (which the store announces before the rename call returns) continues the
   * old row instead of reading as a session born here. `cancelRename` when the store did not.
   */
  expectRename(from: string, to: string): void
  cancelRename(from: string, to: string): void
  /** A leader linked: every own session's live state goes again (the leader keeps it in memory only). */
  relive(): void
  /** The tracker removed these rows: the port calls this. */
  /**
   * Own rows this host deleted: one `drop` record each. `answer`: the leader asked for these
   * (leader-drops.ts), so a session that is not (or no longer) this host's gets its `drop` record
   * too: it is the leader's proof that nothing of it is left here.
   */
  noteDrop(sids: Iterable<string>, opts?: { answer?: boolean }): void
  /** Is `sid` one of this host's own sessions? */
  owns(sid: string): boolean
  /**
   * A fact said again, its data as given (already stamped: stand-down-held.ts, the turn ends owed
   * after a stand-down), to the destinations its event named (`to`). Only for an own session; false
   * when `sid` is not one.
   */
  sayAgain(name: string, data: unknown, to?: string[]): boolean
  /** These rows are the leader's again (stranded-own-rows.ts): no longer own, and no record for them (the leader has its row). */
  disown(sids: Iterable<string>): void
  /** This host's own session of `taskId` (the newest row seen), or null. */
  ownSessionOfTask(taskId: string): string | null
  /** Write every pending `live` record now (tests, a stop). */
  flushLive(): void
  /** The leader asked for these rows whole (channel `resync`): each own one gets a `resync` record. */
  resync(sids: Iterable<string>): Promise<void>
}

interface Pending { events: { name: string; data: unknown; at: number; to: string[]; judgedBy?: 'leader' }[]; timer: ReturnType<typeof setTimeout> }

export { sessionIdOf } from './event-classes.js'

/** The fields of `after` that differ from `before`; a field `after` no longer has is null. */
export function rowPatch(before: SessionRecord, after: SessionRecord): Record<string, unknown> {
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (sessionFieldOwner(k) === 'leader') continue
    const av = a[k]
    if (av === undefined) { if (b[k] !== undefined) out[k] = null; continue }
    if (JSON.stringify(av) !== JSON.stringify(b[k])) out[k] = av
  }
  return out
}

function withoutRestless(s: LiveState): string {
  const o: Record<string, unknown> = { ...s }
  for (const k of RESTLESS) delete o[k]
  return JSON.stringify(o)
}

export function createHostEmitter(o: HostEmitterOptions): HostEmitter {
  const now = o.now ?? Date.now
  const liveMs = o.liveMs ?? 50
  const pendingMs = o.pendingMs ?? 5_000
  const own = new Set<string>()
  const lastRows = new Map<string, SessionRecord>()
  const pending = new Map<string, Pending>()
  const liveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastLive = new Map<string, { key: string; full: string; at: number }>()
  /** Renames the port announced, new id -> old id, until the store wrote them. */
  const expected = new Map<string, string>()
  const GONE_KEY = '{"gone":true}'
  let started = false
  let busRef: EmitterBus | null = null
  let rowListener: ((fn: ((row: SessionRecord) => void) | null) => void) | null = null
  let liveListener: ((fn: ((sid: string) => void) | null) => void) | null = null

  const warn = (msg: string, data?: Record<string, unknown>): void => o.onLog?.('warn', msg, data)

  /** Keep one record; false when the log did not take it (the caller keeps what it would have sent). */
  function append(sid: string, name: string, data: unknown, opts: { at?: number; continueFrom?: string; to?: string[]; judgedBy?: 'leader' } = {}): boolean {
    const v = name === 'row' || name === 'live' || name === 'rename' || name === 'drop' ? undefined : o.offsetOf?.(sid)
    const epoch = lastRows.get(sid)?.streamEpoch
    try {
      o.log.append(sid, name, data, {
        ...(typeof v === 'number' ? { line: { ...(epoch ? { epoch } : {}), v } } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        ...(opts.continueFrom ? { continueFrom: opts.continueFrom } : {}),
        ...(opts.to ? { to: opts.to } : {}),
        ...(opts.judgedBy ? { judgedBy: opts.judgedBy } : {}),
      })
      return true
    } catch (err) {
      warn('session channel: a record was not kept', { sessionId: sid, name, error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  /**
   * The whole row again (a boot, the leader's ask): `resync`, which a leader applies whole and never
   * says as a start; an older leader reads it as a patch of every field (no `born`: no start either).
   */
  function appendWhole(row: SessionRecord): void {
    const sid = row.claudeSessionId
    const copy = JSON.parse(JSON.stringify(row)) as SessionRecord
    if (append(sid, 'row', { resync: true, patch: copy })) lastRows.set(sid, copy)
    own.add(sid)
  }

  function scheduleLive(sid: string): void {
    if (!o.liveOf || liveTimers.has(sid) || !own.has(sid)) return
    const t = setTimeout(() => { liveTimers.delete(sid); writeLive(sid) }, liveMs)
    t.unref?.()
    liveTimers.set(sid, t)
  }

  function writeLive(sid: string): void {
    if (!own.has(sid)) return
    const state = o.liveOf?.(sid)
    if (!state) {
      // The session left the runner: a leader that held its state says it no longer runs.
      const last = lastLive.get(sid)
      if (last && last.full !== GONE_KEY) {
        lastLive.set(sid, { key: GONE_KEY, full: GONE_KEY, at: now() })
        append(sid, 'live', { state: { gone: true } })
      }
      return
    }
    const key = withoutRestless(state)
    const full = JSON.stringify(state)
    const last = lastLive.get(sid)
    const at = now()
    if (last && last.full === full) return
    if (last && last.key === key && at - last.at < RESTLESS_EVERY_MS) return
    lastLive.set(sid, { key, full, at })
    append(sid, 'live', { state })
  }

  function takeOwn(sid: string): void {
    own.add(sid)
    const p = pending.get(sid)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(sid)
    for (const e of p.events) append(sid, e.name, e.data, { at: e.at, to: e.to, ...(e.judgedBy ? { judgedBy: e.judgedBy } : {}) })
  }

  function rename(from: string, to: string): void {
    expected.delete(to)
    if (!own.has(from) || from === to) return
    append(to, 'rename', { from, to }, { continueFrom: from })
    own.delete(from)
    own.add(to)
    const row = lastRows.get(from)
    lastRows.delete(from)
    if (row) lastRows.set(to, row)
    const l = lastLive.get(from)
    lastLive.delete(from)
    if (l) lastLive.set(to, l)
  }

  function onRow(row: SessionRecord): void {
    const sid = row?.claudeSessionId
    if (!sid) return
    if (!rowOwnedHere(row, o.hostKey)) return
    try { o.onOwnRow?.(sid) } catch { /* the list logs its own */ }
    // A rename the port announced: the record first, then this write as the old row's patch.
    const from = expected.get(sid)
    if (from !== undefined && !lastRows.has(sid)) rename(from, sid)
    const before = lastRows.get(sid)
    const copy = JSON.parse(JSON.stringify(row)) as SessionRecord
    // The row the leader has is the one the last kept record made: a record the log did not take
    // leaves it, so the next patch (diffed against it) still carries what this one missed.
    if (!before) {
      let hand: string | undefined
      try { hand = o.handOf?.(row) } catch { /* no echo: the leader waits for the start's answer */ }
      if (append(sid, 'row', { born: true, ...(hand ? { hand } : {}), patch: copy })) lastRows.set(sid, copy)
      takeOwn(sid)
    } else {
      own.add(sid)
      const patch = rowPatch(before, copy)
      if (Object.keys(patch).length === 0 || append(sid, 'row', { patch })) lastRows.set(sid, copy)
    }
    scheduleLive(sid)
  }

  function hold(sid: string, name: string, data: unknown, to: string[], judgedBy: 'leader' | undefined): void {
    let p = pending.get(sid)
    if (!p) {
      const timer = setTimeout(() => {
        const gone = pending.get(sid)
        pending.delete(sid)
        if (gone && gone.events.length) o.onLog?.('info', 'session channel: events of a session that is not this host\'s were not kept', { sessionId: sid, events: gone.events.length })
      }, pendingMs)
      timer.unref?.()
      p = { events: [], timer }
      pending.set(sid, p)
    }
    if (p.events.length < PENDING_MAX) p.events.push({ name, data, at: now(), to, ...(judgedBy ? { judgedBy } : {}) })
  }

  const onEvent = (event: BusEvent): void => {
    if (event.source === CHANNEL_SOURCE) return
    const cls = channelClassOf(event.name)
    if (!cls) return
    const sid = sessionIdOf(event.name, event.data)
    if (!sid) return
    if (cls === 'flow') {
      if (own.has(sid)) o.channel?.flow(sid, event.name, event.data, event.destinations)
      return
    }
    if (cls !== 'fact') {
      // A leader event (a status change) still moves what the leader reads of the session now.
      scheduleLive(sid)
      return
    }
    let data = event.data
    if (o.stamp) {
      try { data = o.stamp(event.name, event.data) } catch (err) { warn('session channel: a fact was kept without its stamp', { sessionId: sid, name: event.name, error: err instanceof Error ? err.message : String(err) }) }
    }
    const judgedBy = o.judgedByLeaderNow?.() ? 'leader' as const : undefined
    if (own.has(sid)) {
      append(sid, event.name, data, { to: event.destinations, ...(judgedBy ? { judgedBy } : {}) })
      scheduleLive(sid)
    } else {
      hold(sid, event.name, data, event.destinations, judgedBy)
    }
  }

  return {
    async start() {
      if (started) return
      started = true
      // The listener first, then the rows as they are: a write between the two is seen by the
      // listener, and each own row goes whole once (a `resync` record, applied idempotently), so a
      // write made before this start (boot, a record lost in the last flush window of a killed
      // process) reaches the leader too.
      rowListener = o.rowListener ?? setOwnRowListener
      rowListener(onRow)
      // A live change no row write or event shows (an ACP attach): its live record goes again.
      liveListener = o.liveListener ?? setOwnLiveListener
      liveListener(scheduleLive)
      for (const row of await o.ownRows()) {
        if (!rowOwnedHere(row, o.hostKey) || lastRows.has(row.claudeSessionId)) continue
        appendWhole(row)
      }
      if (o.bus !== undefined) busRef = o.bus
      else busRef = (await import('../event-bus.js')).bus
      busRef.subscribe(HOST_EMITTER_SUBSCRIBER, onEvent, { global: true, interest: ['session:', 'transfer:'] })
    },
    stop() {
      if (!started) return
      started = false
      busRef?.unsubscribe(HOST_EMITTER_SUBSCRIBER)
      rowListener?.(null)
      liveListener?.(null)
      for (const t of liveTimers.values()) clearTimeout(t)
      liveTimers.clear()
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
    },
    noteRename(from, to) { rename(from, to) },
    expectRename(from, to) {
      if (from && to && from !== to && own.has(from)) expected.set(to, from)
    },
    cancelRename(from, to) {
      if (expected.get(to) === from) expected.delete(to)
    },
    relive() {
      for (const sid of own) {
        const last = lastLive.get(sid)
        lastLive.delete(sid)
        const t = liveTimers.get(sid)
        if (t) { clearTimeout(t); liveTimers.delete(sid) }
        if (o.liveOf?.(sid)) { writeLive(sid); continue }
        // Nothing live here: said once to a leader that may still hold it running (its last word
        // here, or a row that reads live: a leader that kept it from before this host restarted).
        const status = String(lastRows.get(sid)?.process_status ?? '')
        if ((last && last.full !== GONE_KEY) || (!last && (status === 'running' || status === 'idle'))) {
          lastLive.set(sid, { key: GONE_KEY, full: GONE_KEY, at: now() })
          append(sid, 'live', { state: { gone: true } })
        } else if (last) lastLive.set(sid, last)
      }
    },
    disown(sids) {
      for (const sid of sids) {
        own.delete(sid)
        lastRows.delete(sid)
        lastLive.delete(sid)
        const t = liveTimers.get(sid)
        if (t) { clearTimeout(t); liveTimers.delete(sid) }
      }
    },
    noteDrop(sids, opts) {
      for (const sid of sids) {
        if (!own.has(sid) && !opts?.answer) continue
        append(sid, 'drop', { sid })
        own.delete(sid)
        lastRows.delete(sid)
        lastLive.delete(sid)
        const t = liveTimers.get(sid)
        if (t) { clearTimeout(t); liveTimers.delete(sid) }
      }
    },
    owns: (sid) => own.has(sid),
    sayAgain(name, data, to) {
      const sid = sessionIdOf(name, data)
      if (!sid || !own.has(sid) || channelClassOf(name) !== 'fact') return false
      append(sid, name, data, to ? { to } : {})
      scheduleLive(sid)
      return true
    },
    ownSessionOfTask(taskId) {
      let found: string | null = null
      for (const [sid, row] of lastRows) if (row.taskId === taskId && own.has(sid)) found = sid
      return found
    },
    flushLive() {
      for (const [sid, t] of [...liveTimers]) { clearTimeout(t); liveTimers.delete(sid); writeLive(sid) }
    },
    async resync(sids) {
      const want = new Set(sids)
      if (want.size === 0) return
      for (const row of await o.ownRows()) {
        if (want.has(row.claudeSessionId) && rowOwnedHere(row, o.hostKey)) appendWhole(row)
      }
    },
  }
}
