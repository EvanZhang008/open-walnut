/**
 * The host's side of what its sessions did (docs/plan/one-service-every-host.md, phase 2): one bus
 * subscriber and one row listener turn the sessions this host owns (session-row-owner.ts
 * rowOwnedHere) into channel records.
 *
 *   bus `fact` event   -> FactLog.append(sid, name, data, {line}) (event-classes.ts)
 *   bus `flow` event   -> HostChannel.flow (only to a caught-up reader, never kept)
 *   `leader`/`command` -> nothing (the leader makes those from its own data)
 *   own row written    -> `row` {born:true, patch: whole row} the first time, then {patch} with
 *                         the fields that changed since the last row seen (null: cleared); a
 *                         leader field never rides a patch (the host does not write them)
 *   rename / drop      -> `rename` {from, to} (the new id continues the old id's sseq), `drop` {sid}
 *   any event or row   -> `live` {state}: the mirrored state (host-live.ts), at most every
 *                         `liveMs` per session, and only when it changed
 *
 * An event of a session whose row is not known here yet (the CLI's first lines can beat the
 * record) waits up to `pendingMs` for its row: once the row is this host's own the events go after
 * its `born` record, in order; else they are dropped (a session that is not this host's never
 * reaches the log). Events re-emitted by the channel itself (`source: 'host-channel'`) are skipped.
 */
import type { FactLog } from './fact-log.js'
import type { HostChannel } from './channel.js'
import type { LiveState } from './host-api.js'
import { channelClassOf } from './event-classes.js'
import { setOwnRowListener } from './row-hook.js'
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
  /**
   * What a fact keeps of its event's data: the data, or a copy with what only this host knows at the
   * event added (a turn end's `hostTakenBy`, turn-run-host.ts). Called in the event's own tick, after
   * the subscribers that subscribed before this one (the resend family) took it.
   */
  stamp?(name: string, data: unknown): unknown
  liveMs?: number
  pendingMs?: number
  now?: () => number
  onLog?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface HostEmitter {
  start(): Promise<void>
  stop(): void
  /** The tracker replaced `from` by `to` (resume, fork): the port calls this. */
  noteRename(from: string, to: string): void
  /** The tracker removed these rows: the port calls this. */
  /**
   * Own rows this host deleted: one `drop` record each. `answer`: the leader asked for these
   * (leader-drops.ts), so a session that is not (or no longer) this host's gets its `drop` record
   * too: it is the leader's proof that nothing of it is left here.
   */
  noteDrop(sids: Iterable<string>, opts?: { answer?: boolean }): void
  /** Is `sid` one of this host's own sessions? */
  owns(sid: string): boolean
  /** This host's own session of `taskId` (the newest row seen), or null. */
  ownSessionOfTask(taskId: string): string | null
  /** Write every pending `live` record now (tests, a stop). */
  flushLive(): void
}

interface Pending { events: { name: string; data: unknown; at: number; to: string[] }[]; timer: ReturnType<typeof setTimeout> }

/** The session id an event names. */
export function sessionIdOf(name: string, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (name === 'transfer:fork-init') return typeof d.actualId === 'string' && d.actualId ? d.actualId : null
  for (const k of ['sessionId', 'claudeSessionId']) {
    const v = d[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

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
  let started = false
  let busRef: EmitterBus | null = null
  let rowListener: ((fn: ((row: SessionRecord) => void) | null) => void) | null = null

  const warn = (msg: string, data?: Record<string, unknown>): void => o.onLog?.('warn', msg, data)

  function append(sid: string, name: string, data: unknown, opts: { at?: number; continueFrom?: string; to?: string[] } = {}): void {
    const v = name === 'row' || name === 'live' || name === 'rename' || name === 'drop' ? undefined : o.offsetOf?.(sid)
    const epoch = lastRows.get(sid)?.streamEpoch
    try {
      o.log.append(sid, name, data, {
        ...(typeof v === 'number' ? { line: { ...(epoch ? { epoch } : {}), v } } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        ...(opts.continueFrom ? { continueFrom: opts.continueFrom } : {}),
        ...(opts.to ? { to: opts.to } : {}),
      })
    } catch (err) {
      warn('session channel: a record was not kept', { sessionId: sid, name, error: err instanceof Error ? err.message : String(err) })
    }
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
    if (!state) return
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
    for (const e of p.events) append(sid, e.name, e.data, { at: e.at, to: e.to })
  }

  function onRow(row: SessionRecord): void {
    const sid = row?.claudeSessionId
    if (!sid) return
    if (!rowOwnedHere(row, o.hostKey)) return
    const before = lastRows.get(sid)
    const copy = JSON.parse(JSON.stringify(row)) as SessionRecord
    lastRows.set(sid, copy)
    if (!before) {
      append(sid, 'row', { born: true, patch: copy })
      takeOwn(sid)
    } else {
      own.add(sid)
      const patch = rowPatch(before, copy)
      if (Object.keys(patch).length > 0) append(sid, 'row', { patch })
    }
    scheduleLive(sid)
  }

  function hold(sid: string, name: string, data: unknown, to: string[]): void {
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
    if (p.events.length < PENDING_MAX) p.events.push({ name, data, at: now(), to })
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
    if (own.has(sid)) {
      append(sid, event.name, data, { to: event.destinations })
      scheduleLive(sid)
    } else {
      hold(sid, event.name, data, event.destinations)
    }
  }

  return {
    async start() {
      if (started) return
      started = true
      for (const row of await o.ownRows()) {
        if (!rowOwnedHere(row, o.hostKey)) continue
        own.add(row.claudeSessionId)
        lastRows.set(row.claudeSessionId, JSON.parse(JSON.stringify(row)) as SessionRecord)
      }
      rowListener = o.rowListener ?? setOwnRowListener
      rowListener(onRow)
      if (o.bus !== undefined) busRef = o.bus
      else busRef = (await import('../event-bus.js')).bus
      busRef.subscribe(HOST_EMITTER_SUBSCRIBER, onEvent, { global: true, interest: ['session:', 'transfer:'] })
    },
    stop() {
      if (!started) return
      started = false
      busRef?.unsubscribe(HOST_EMITTER_SUBSCRIBER)
      rowListener?.(null)
      for (const t of liveTimers.values()) clearTimeout(t)
      liveTimers.clear()
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
    },
    noteRename(from, to) {
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
    ownSessionOfTask(taskId) {
      let found: string | null = null
      for (const [sid, row] of lastRows) if (row.taskId === taskId && own.has(sid)) found = sid
      return found
    },
    flushLive() {
      for (const [sid, t] of [...liveTimers]) { clearTimeout(t); liveTimers.delete(sid); writeLive(sid) }
    },
  }
}
