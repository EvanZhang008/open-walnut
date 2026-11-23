/**
 * The cloud companion's end of a host's listener link (listener-wire.ts; the socket is
 * listener-door.ts's): what a host that runs and judges its own sessions tells the companion, kept
 * in memory and nowhere else, so the phone sees those sessions while the leader (the Mac) is away.
 *
 *   rows    the host's own rows (judge 'host', host = the link's alias; any other row is dropped),
 *           joined into the phone's session list and detail beside the copy's rows
 *           (companion-host-ops.ts). A host-judged row the copy also has: this one is newer while
 *           the Mac is away
 *   facts   `row` patches, renames and drops change those rows; `live` is the session's state now
 *           (its turn, its prompts); every session event a fact carries is said on the phone's
 *           stream of that session (session-event-sse.ts), as the Mac's stream says its own
 *   flow    the text deltas, said on the same stream
 *
 * Applied to the phone's streams and these maps only: never to the companion's stores and never to
 * its bus (no second judge: nothing here acts on a session). The companion never confirms anything
 * (it sends `listen`, never `ack`), so the host's log is trimmed by its leader alone.
 *
 * Calls: the companion's call frames to the host (send, interrupt, a prompt's answer; the host
 * takes no other from this link), each with a deadline, answered by the host's reply frame.
 */
import crypto from 'node:crypto'
import { log } from '../../logging/index.js'
import { isChannelFrame } from './channel.js'
import { channelClassOf } from './event-classes.js'
import { isListenerFrame, LISTEN_CLOSE, type ListenerFrame } from './listener-wire.js'
import { judgedByHost, mergeHostFacts } from '../sessions/session-row-owner.js'
import type { LiveState } from './host-api.js'
import type { SessionRecord } from '../types.js'

/** What the listener door hands this module: the welcomed socket. */
export interface ListenerSocket {
  send(text: string): void
  close(code: number, why: string): void
}

interface Pending { resolve(v: { status: number; body: unknown }): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }

interface HostView {
  alias: string
  walnutId: string
  /** The link now; null while the host is not linked (its rows stay, as last told). */
  sock: ListenerSocket | null
  rows: Map<string, SessionRecord>
  live: Map<string, LiveState>
  pending: Map<string, Pending>
}

const views = new Map<string, HostView>()
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** A call to a host whose listener link is not up (nothing was sent). */
export class ListenerNotLinked extends Error {
  constructor(alias: string) { super(`the host ${alias} is not linked to this companion`); this.name = 'ListenerNotLinked' }
}

/** Is `row` one this host may tell: its own, judged by it, with a plain id. */
function ownRowOf(alias: string, row: unknown): row is SessionRecord {
  const r = row as SessionRecord | null
  return !!r && typeof r === 'object' && typeof r.claudeSessionId === 'string' && SID_RE.test(r.claudeSessionId) && judgedByHost(r) && r.host === alias
}

function rejectAll(v: HostView, why: string): void {
  for (const [, p] of v.pending) { clearTimeout(p.timer); p.reject(new Error(why)) }
  v.pending.clear()
}

/** A row changed (or appeared): the phone's list hears it, and its stream hears a turn that starts. */
async function told(v: HostView, row: SessionRecord, before: SessionRecord | undefined): Promise<void> {
  const [{ projectSession }, { handleBridgeMobileEvent }, { emitSse, sseConnCount }, { sessionChannelKey }] = await Promise.all([
    import('../session-projection.js'), import('../../web/routes/events-v1.js'), import('../../web/sse-channels.js'), import('../../web/session-event-sse.js'),
  ])
  const key = sessionChannelKey(row.claudeSessionId)
  if (row.process_status === 'running' && before?.process_status !== 'running' && sseConnCount(key) > 0) emitSse(key, 'turn-start', {}, { reset: true })
  // The feed's session-upsert also says the status on the session's own stream (events-v1.ts).
  handleBridgeMobileEvent('session-upsert', projectSession(row, undefined))
}

async function sayOnStream(sid: string, name: string, data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return
  const [{ sseConnCount }, { emitSessionEventSse, sessionChannelKey }] = await Promise.all([import('../../web/sse-channels.js'), import('../../web/session-event-sse.js')])
  if (sseConnCount(sessionChannelKey(sid)) === 0) return
  await emitSessionEventSse(sid, name, { ...(data as Record<string, unknown>), sessionId: sid }, 'host-channel')
}

async function applyRecord(v: HostView, rec: { sid?: unknown; name?: unknown; data?: unknown }): Promise<void> {
  const sid = typeof rec.sid === 'string' ? rec.sid : ''
  const name = typeof rec.name === 'string' ? rec.name : ''
  if (!SID_RE.test(sid) || !name) return
  const data = (rec.data ?? null) as Record<string, unknown> | null
  if (name === 'row') {
    const patch = data?.patch
    if (!patch || typeof patch !== 'object') return
    const before = v.rows.get(sid)
    const whole = data?.born === true || data?.resync === true
    // A patch of a row this companion was never told whole: not one it can stand for.
    if (!before && !whole) return
    const row = mergeHostFacts(before ?? null, patch as Record<string, unknown>, whole)
    if (!ownRowOf(v.alias, row) || row.claudeSessionId !== sid) return
    v.rows.set(sid, row)
    await told(v, row, before)
    return
  }
  if (name === 'live') {
    const state = data?.state
    if (state && typeof state === 'object' && v.rows.has(sid)) v.live.set(sid, state as LiveState)
    return
  }
  if (name === 'rename') {
    const from = typeof data?.from === 'string' ? data.from : ''
    const row = v.rows.get(from)
    if (!row || data?.to !== sid) return
    v.rows.delete(from)
    v.live.delete(from)
    v.rows.set(sid, { ...row, claudeSessionId: sid })
    return
  }
  if (name === 'drop') {
    v.rows.delete(sid)
    v.live.delete(sid)
    return
  }
  if (channelClassOf(name) === 'fact' && v.rows.has(sid)) await sayOnStream(sid, name, data)
}

/** Take a welcomed listener link of `alias` (one per host: a newer one replaces the one before). */
export function attachHostListener(alias: string, walnutId: string, sock: ListenerSocket): { onText(text: string): void; onClose(): void; idle(): Promise<void> } {
  let v = views.get(alias)
  if (v?.sock) {
    try { v.sock.close(LISTEN_CLOSE.replaced, 'replaced') } catch { /* gone */ }
    rejectAll(v, 'the listener link was replaced before the host answered')
  }
  if (!v || v.walnutId !== walnutId) {
    v = { alias, walnutId, sock: null, rows: new Map(), live: new Map(), pending: new Map() }
    views.set(alias, v)
  }
  const view = v
  view.sock = sock
  let open = true
  // One frame at a time, in order: a row patch lands before the fact after it.
  let chain: Promise<void> = Promise.resolve()
  const serial = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((err: unknown) => log.web.warn('companion listener: applying a host frame failed', { host: alias, error: err instanceof Error ? err.message : String(err) }))
  }
  log.web.info('companion listener: a host linked', { host: alias })
  return {
    onText(text) {
      if (!open) return
      let frame: unknown
      try { frame = JSON.parse(text) } catch { return }
      if (isListenerFrame(frame)) {
        if (frame.op !== 'reply') return
        const p = view.pending.get(String(frame.id))
        if (!p) return
        view.pending.delete(String(frame.id))
        clearTimeout(p.timer)
        p.resolve({ status: Number(frame.status) || 0, body: frame.body })
        return
      }
      if (!isChannelFrame(frame)) return
      if (frame.op === 'hello') {
        if (frame.walnutId !== walnutId) { sock.close(LISTEN_CLOSE.mismatch, 'walnut_mismatch'); return }
        sock.send(JSON.stringify({ ch: 'sf', op: 'listen', walnutId }))
      } else if (frame.op === 'rows') {
        const rows = Array.isArray(frame.rows) ? frame.rows : []
        serial(async () => {
          const before = new Map(view.rows)
          view.rows = new Map(rows.filter((r) => ownRowOf(alias, r)).map((r) => [r.claudeSessionId, r]))
          for (const sid of [...view.live.keys()]) if (!view.rows.has(sid)) view.live.delete(sid)
          for (const row of view.rows.values()) await told(view, row, before.get(row.claudeSessionId))
        })
      } else if (frame.op === 'facts') {
        const recs = Array.isArray(frame.recs) ? frame.recs : []
        serial(async () => { for (const r of recs) await applyRecord(view, r) })
      } else if (frame.op === 'flow') {
        const { sid, name, data } = frame
        if (typeof sid === 'string' && channelClassOf(String(name)) === 'flow') serial(async () => { if (view.rows.has(sid)) await sayOnStream(sid, String(name), data) })
      } else if (frame.op === 'refuse') {
        log.web.warn('companion listener: the host refused this companion', { host: alias, why: frame.why })
      }
    },
    onClose() {
      open = false
      if (view.sock === sock) view.sock = null
      rejectAll(view, 'the listener link closed before the host answered')
      log.web.info('companion listener: a host\'s link closed', { host: alias })
    },
    /** Tests: the frames taken so far are applied. */
    idle: () => chain,
  }
}

/** The host-judged row this companion was told of `sid`, its host and its live state, or null. */
export function listenedRow(sid: string): { alias: string; row: SessionRecord; live: LiveState | null } | null {
  for (const v of views.values()) {
    const row = v.rows.get(sid)
    if (row) return { alias: v.alias, row, live: v.live.get(sid) ?? null }
  }
  return null
}

/** Every host-judged row this companion was told of, with its host. */
export function listenedRows(): Array<{ alias: string; row: SessionRecord }> {
  return [...views.values()].flatMap((v) => [...v.rows.values()].map((row) => ({ alias: v.alias, row })))
}

/** Is `alias`'s listener link up now? */
export function listenerLinked(alias: string): boolean {
  return !!views.get(alias)?.sock
}

/** One call frame to `alias` (LISTENER_CALLS): the host's answer, or a throw (not linked, closed, no answer in time). */
export function callListenedHost(alias: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const v = views.get(alias)
  const sock = v?.sock
  if (!v || !sock) return Promise.reject(new ListenerNotLinked(alias))
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(9).toString('hex')
    const timer = setTimeout(() => { v.pending.delete(id); reject(new Error(`the host ${alias} did not answer ${path} in ${timeoutMs} ms`)) }, Math.max(1, timeoutMs))
    timer.unref?.()
    v.pending.set(id, { resolve, reject, timer })
    const call: ListenerFrame = { ch: 'door', op: 'call', id, method: 'POST', path, body }
    try { sock.send(JSON.stringify(call)) } catch (err) {
      v.pending.delete(id)
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Tests only. */
export function _resetCompanionListenerForTesting(): void {
  for (const v of views.values()) rejectAll(v, 'reset')
  views.clear()
}
