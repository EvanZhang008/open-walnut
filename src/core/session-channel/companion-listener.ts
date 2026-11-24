/**
 * The cloud companion's end of a host's listener link (listener-wire.ts; the socket is
 * listener-door.ts's): what a host that runs and judges its own sessions tells the companion, kept
 * in memory and nowhere else, so the phone sees those sessions while the leader (the Mac) is away.
 *
 *   rows    the host's own rows (judge 'host', host = the link's alias), joined into the phone's
 *           session list and detail beside the copy's rows (companion-host-ops.ts)
 *   facts   `row` patches, renames and drops change those rows; `live` is the session's state now
 *           (its turn, its prompts); every session event a fact carries is said on the phone's
 *           stream of that session (session-event-sse.ts), as the Mac's stream says its own
 *   flow    the text deltas, said on the same stream
 *
 * Which ids a link may stand for (standsFor, the one check every lookup by id goes through): one
 * the companion's copy does not know, or one the copy says runs on this very host; and one no
 * other link claimed first. So a host (or a stolen host token) can never take over the id of
 * another host's session or of a Mac session (land 5b review H1).
 *
 * A link that closes leaves its rows unknown (no live state, never operated) for LINK_GRACE_MS, so
 * a restart of the host's service does not blank the phone's list; then they go. Its claims stay
 * (they still say "this id is a host's own, never the daemon's direct path", companion-host-ops.ts)
 * until its credential is revoked (forgetHostListener), which drops the view at once.
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
import { cutRowFields, type FactRecord } from './fact-log.js'

/** What the listener door hands this module: the welcomed socket. */
export interface ListenerSocket {
  send(text: string): void
  close(code: number, why: string): void
}

interface Pending { resolve(v: { status: number; body: unknown }): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }

interface HostView {
  alias: string
  walnutId: string
  /** The link now; null while the host is not linked (its rows are unknown, then go). */
  sock: ListenerSocket | null
  rows: Map<string, SessionRecord>
  live: Map<string, LiveState>
  /** Sessions whose turn the phone's stream has opened (one `turn-start` reset per turn). */
  turns: Set<string>
  pending: Map<string, Pending>
  dropTimer: ReturnType<typeof setTimeout> | null
}

/** How long the rows of a closed link stay, unknown, before they go. */
export const LINK_GRACE_MS = 60_000

const views = new Map<string, HostView>()
/** Session id -> the alias of the link that claimed it first. */
const claims = new Map<string, string>()
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** The host the companion's own copy says a session runs on: its alias, '__local__' for the Mac's own. */
type CopyHosts = (sids: readonly string[]) => Promise<Map<string, string>>
let copyHosts: CopyHosts = readCopyHosts

/** A call to a host whose listener link is not up (nothing was sent). */
export class ListenerNotLinked extends Error {
  constructor(alias: string) { super(`the host ${alias} is not linked to this companion`); this.name = 'ListenerNotLinked' }
}

/** The copy's word on `sids`: the projection's host of each it lists, and the companion's own cloud sessions. */
async function readCopyHosts(sids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (sids.length === 0) return out
  const want = new Set(sids)
  const { readSessionProjection } = await import('../session-projection.js')
  for (const s of (await readSessionProjection())?.sessions ?? []) {
    if (want.has(s.id)) out.set(s.id, typeof s.host === 'string' && s.host ? s.host : '__local__')
  }
  const { cloudOwnedSession, cloudOwnedHostAlias } = await import('../cloud-owned-session.js')
  for (const sid of want) if (!out.has(sid) && await cloudOwnedSession(sid)) out.set(sid, cloudOwnedHostAlias)
  return out
}

/**
 * THE check (review H1): may the link of `alias` stand for `sid`, given the copy's host of it?
 * Only an id the copy does not know or places on this host, and that no other link claimed first.
 */
export function standsFor(alias: string, sid: string, copyHost: string | undefined): boolean {
  const claimed = claims.get(sid)
  return (claimed === undefined || claimed === alias) && (copyHost === undefined || copyHost === alias)
}

/** Is `row` shaped as one this host may tell: its own, judged by it, with a plain id. */
function ownShape(alias: string, row: unknown): row is SessionRecord {
  const r = row as SessionRecord | null
  return !!r && typeof r === 'object' && typeof r.claudeSessionId === 'string' && SID_RE.test(r.claudeSessionId) && judgedByHost(r) && r.host === alias
}

/** The rows of `candidates` this link may stand for (standsFor against the copy), claimed for it. */
async function admit(v: HostView, candidates: SessionRecord[]): Promise<SessionRecord[]> {
  const copy = await copyHosts(candidates.map((r) => r.claudeSessionId))
  const ok: SessionRecord[] = []
  for (const r of candidates) {
    const sid = r.claudeSessionId
    if (!standsFor(v.alias, sid, copy.get(sid))) {
      log.web.warn('companion listener: a host told a session it does not run; refused', { host: v.alias, sessionId: sid, copyHost: copy.get(sid) ?? null, claimedBy: claims.get(sid) ?? null })
      continue
    }
    claims.set(sid, v.alias)
    ok.push(r)
  }
  return ok
}

function release(v: HostView, sid: string): void {
  if (claims.get(sid) === v.alias) claims.delete(sid)
}

function rejectAll(v: HostView, why: string): void {
  for (const [, p] of v.pending) { clearTimeout(p.timer); p.reject(new Error(why)) }
  v.pending.clear()
}

/** The phone's stream of `sid` starts this turn (once a turn): a reset of its replay window. */
async function openTurn(v: HostView, sid: string): Promise<void> {
  if (v.turns.has(sid)) return
  v.turns.add(sid)
  const [{ emitSse }, { sessionChannelKey }] = await Promise.all([import('../../web/sse-channels.js'), import('../../web/session-event-sse.js')])
  emitSse(sessionChannelKey(sid), 'turn-start', {}, { reset: true })
}

/** A row changed (or appeared): its turn opens on the stream, and the phone's list hears it while the Mac is away. */
async function told(v: HostView, row: SessionRecord, before: SessionRecord | undefined): Promise<void> {
  if (row.process_status === 'running' && before?.process_status !== 'running') await openTurn(v, row.claudeSessionId)
  if (before && JSON.stringify(before) === JSON.stringify(row)) return
  const ops = await import('./companion-host-ops.js')
  await ops.pushListenedRow(row)
}

/** A fact or flow event on the phone's stream: kept in the stream's replay ring, so a phone that opens mid-turn sees the turn (L6). */
async function sayOnStream(v: HostView, sid: string, name: string, data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return
  const [{ emitSessionEventSse }] = await Promise.all([import('../../web/session-event-sse.js')])
  if (name === 'session:text-delta' || name === 'session:thinking-delta' || name === 'session:tool-use') await openTurn(v, sid)
  await emitSessionEventSse(sid, name, { ...(data as Record<string, unknown>), sessionId: sid }, 'host-channel')
  if (name === 'session:result' || name === 'session:error') v.turns.delete(sid)
}

async function applyRecord(v: HostView, rec: { sid?: unknown; name?: unknown; data?: unknown; refs?: FactRecord['refs'] }): Promise<void> {
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
    const row = mergeHostFacts(before ?? null, patch as Record<string, unknown>, whole, cutRowFields({ name, data, refs: rec.refs }))
    if (!ownShape(v.alias, row) || row.claudeSessionId !== sid) return
    if (!before && (await admit(v, [row])).length === 0) return
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
    v.turns.delete(from)
    release(v, from)
    const renamed = { ...row, claudeSessionId: sid }
    if ((await admit(v, [renamed])).length > 0) v.rows.set(sid, renamed)
    return
  }
  if (name === 'drop') {
    v.rows.delete(sid)
    v.live.delete(sid)
    v.turns.delete(sid)
    release(v, sid)
    return
  }
  if (channelClassOf(name) === 'fact' && v.rows.has(sid)) await sayOnStream(v, sid, name, data)
}

/** Take a welcomed listener link of `alias` (one per host: a newer one replaces the one before). */
export function attachHostListener(alias: string, walnutId: string, sock: ListenerSocket): { onText(text: string): void; onClose(): void; idle(): Promise<void> } {
  let v = views.get(alias)
  if (v?.sock) {
    try { v.sock.close(LISTEN_CLOSE.replaced, 'replaced') } catch { /* gone */ }
    rejectAll(v, 'the listener link was replaced before the host answered')
  }
  if (v && v.walnutId !== walnutId) { forgetHostListener(alias); v = undefined }
  if (!v) {
    v = { alias, walnutId, sock: null, rows: new Map(), live: new Map(), turns: new Set(), pending: new Map(), dropTimer: null }
    views.set(alias, v)
  }
  const view = v
  if (view.dropTimer) { clearTimeout(view.dropTimer); view.dropTimer = null }
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
          for (const sid of before.keys()) release(view, sid)
          const kept = await admit(view, rows.filter((r): r is SessionRecord => ownShape(alias, r)))
          view.rows = new Map(kept.map((r) => [r.claudeSessionId, r]))
          for (const sid of [...view.live.keys()]) if (!view.rows.has(sid)) view.live.delete(sid)
          for (const row of view.rows.values()) await told(view, row, before.get(row.claudeSessionId))
        })
      } else if (frame.op === 'facts') {
        const recs = Array.isArray(frame.recs) ? frame.recs : []
        serial(async () => { for (const r of recs) await applyRecord(view, r) })
      } else if (frame.op === 'flow') {
        const { sid, name, data } = frame
        if (typeof sid === 'string' && channelClassOf(String(name)) === 'flow') serial(async () => { if (view.rows.has(sid)) await sayOnStream(view, sid, String(name), data) })
      } else if (frame.op === 'refuse') {
        log.web.warn('companion listener: the host refused this companion', { host: alias, why: frame.why })
      }
    },
    onClose() {
      open = false
      rejectAll(view, 'the listener link closed before the host answered')
      if (view.sock !== sock || views.get(alias) !== view) return
      view.sock = null
      // Unknown, not live: nothing operates them, and they go after the grace (their claims stay).
      view.live.clear()
      view.turns.clear()
      view.dropTimer = setTimeout(() => { if (!view.sock) view.rows.clear() }, LINK_GRACE_MS)
      view.dropTimer.unref?.()
      log.web.info('companion listener: a host\'s link closed', { host: alias })
    },
    /** Tests: the frames taken so far are applied. */
    idle: () => chain,
  }
}

/** The host's credential was revoked (or no longer stands): its view and its claims go at once. */
export function forgetHostListener(alias: string): void {
  const v = views.get(alias)
  if (!v) return
  rejectAll(v, 'the host\'s credential was revoked')
  if (v.dropTimer) clearTimeout(v.dropTimer)
  views.delete(alias)
  for (const [sid, a] of [...claims]) if (a === alias) claims.delete(sid)
}

export interface StandingRow { alias: string; row: SessionRecord; live: LiveState | null; linked: boolean }

/** The host-judged row a link stands for as `sid` (standsFor, checked against the copy now), or null. */
export async function standingRow(sid: string): Promise<StandingRow | null> {
  const alias = claims.get(sid)
  const v = alias ? views.get(alias) : undefined
  const row = v?.rows.get(sid)
  if (!v || !row) return null
  if (!standsFor(v.alias, sid, (await copyHosts([sid])).get(sid))) return null
  return { alias: v.alias, row, live: v.live.get(sid) ?? null, linked: !!v.sock }
}

/** Every row the linked hosts stand for now (standsFor against the copy). */
export async function standingRows(): Promise<StandingRow[]> {
  const all = [...views.values()].filter((v) => v.sock).flatMap((v) => [...v.rows.values()].map((row) => ({ v, row })))
  const copy = await copyHosts(all.map((x) => x.row.claudeSessionId))
  return all.filter(({ v, row }) => standsFor(v.alias, row.claudeSessionId, copy.get(row.claudeSessionId)))
    .map(({ v, row }) => ({ alias: v.alias, row, live: v.live.get(row.claudeSessionId) ?? null, linked: true }))
}

/** The link that claimed `sid` as its host's own, if the copy does not say otherwise (its rows may be gone): its alias, or null. */
export async function claimedBy(sid: string): Promise<string | null> {
  const alias = claims.get(sid)
  if (!alias) return null
  return standsFor(alias, sid, (await copyHosts([sid])).get(sid)) ? alias : null
}

/** Has any linked host told rows (the list answers from them when the copy has none yet)? */
export function anyListenedRows(): boolean {
  return [...views.values()].some((v) => v.sock && v.rows.size > 0)
}

/** Is `alias`'s listener link up now? */
export function listenerLinked(alias: string): boolean {
  return !!views.get(alias)?.sock
}

/** Tests: the raw view of `sid` as a link told it, before any check against the copy. */
export function listenedRow(sid: string): { alias: string; row: SessionRecord; live: LiveState | null } | null {
  for (const v of views.values()) {
    const row = v.rows.get(sid)
    if (row) return { alias: v.alias, row, live: v.live.get(sid) ?? null }
  }
  return null
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
export function _resetCompanionListenerForTesting(o: { copyHosts?: CopyHosts } = {}): void {
  for (const v of views.values()) { rejectAll(v, 'reset'); if (v.dropTimer) clearTimeout(v.dropTimer) }
  views.clear()
  claims.clear()
  copyHosts = o.copyHosts ?? readCopyHosts
}
