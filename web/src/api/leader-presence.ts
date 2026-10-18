/**
 * Whether the Mac answers this console, as a host replica tells it
 * (docs/plan/walnut-replica-servers-impl.md, section 3 "Presence" and WP7).
 *
 * Five sources, all cheap and none a request of its own:
 *   - the `replica:presence {answers, asOf, host, hostKey, why, seq, boot}` event a
 *     replica sends on its own /ws at connect and on every change
 *   - `x-walnut-offline: <asOf ms>` (0 = age unknown) with `x-walnut-offline-why:
 *     away|suspect` on an HTTP answer from the replica's copies
 *   - `x-walnut-answered-via: leader|companion` on an answer the replica forwarded
 *   - `x-walnut-presence-seq` / `x-walnut-presence-boot` on every replica answer:
 *     the replica's count of its presence changes, and which run of it counted
 *   - the close code of /ws: 4001 leader_away (the replica moved this socket off
 *     a Mac that went quiet), 4002 leader_back (the Mac answers again)
 *   - GET /api/config's `replica.hostKey` (the Mac's name for this host)
 *
 * ONE state machine reads them. Away is set only by the event (answers false), a
 * 4001 close, or an answer from the copies whose why is not `suspect`; it is
 * cleared only by the event (answers true), a 4002 close, or an answer the
 * replica forwarded. A signal stamped with a lower seq than the last one applied
 * (same boot) is older news and is dropped, so an answer that left before the Mac
 * came back can never put the away line back. A new boot starts the count again.
 *
 * A console served by the Mac itself never sees any of them, so the default
 * state is "the Mac answers" and nothing renders. Pure: no React, no socket.
 */

export interface LeaderPresenceState {
  /** The Mac answers (also: this console is not behind a host replica at all). */
  answers: boolean
  /** When the copies were last fresh (the Mac last heard), ms epoch of the host; null = not known. */
  asOf: number | null
  /** The host replica's label (hosts.<key>.label on the Mac). */
  host: string | null
  /** The Mac's name for this host: the `host` of the sessions that run here. */
  hostKey: string | null
  /** Why the Mac does not answer (the replica's word), or null. */
  why: string | null
  /** Where the latest word came from (logs, tests). */
  source: 'none' | 'ws' | 'http' | 'close' | 'config'
}

export const OFFLINE_HEADER = 'x-walnut-offline'
export const OFFLINE_WHY_HEADER = 'x-walnut-offline-why'
export const ANSWERED_VIA_HEADER = 'x-walnut-answered-via'
export const PRESENCE_SEQ_HEADER = 'x-walnut-presence-seq'
export const PRESENCE_BOOT_HEADER = 'x-walnut-presence-boot'
/** The replica moved this socket off a Mac that went quiet. */
export const WS_LEADER_AWAY = 4001
/** The Mac answers again: the next socket reaches it. */
export const WS_LEADER_BACK = 4002

const INITIAL: LeaderPresenceState = { answers: true, asOf: null, host: null, hostKey: null, why: null, source: 'none' }

let state: LeaderPresenceState = INITIAL
const listeners = new Set<() => void>()

/**
 * The newest presence count applied. `strict`: a close came after it, so the
 * presence moved past `seq` without this browser seeing the new count; until a
 * higher count arrives, a signal still at `seq` may not flip `answers` back.
 */
interface Order { boot: string | null; seq: number | null; strict: boolean }
let order: Order = { boot: null, seq: null, strict: false }
/** Boots this browser has moved off: a late answer from one of them is never applied. */
let retiredBoots: string[] = []
const RETIRED_BOOTS_KEPT = 8

export function getLeaderPresence(): LeaderPresenceState {
  return state
}

/** The newest presence count applied (logs, tests). */
export function getPresenceOrder(): Readonly<Order> {
  return order
}

export function subscribeLeaderPresence(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function set(patch: Partial<LeaderPresenceState>): void {
  const next = { ...state, ...patch }
  if (next.answers === state.answers && next.asOf === state.asOf && next.host === state.host
    && next.hostKey === state.hostKey && next.why === state.why) {
    // Same facts: no render, but keep the latest source for the logs.
    state = { ...state, source: next.source }
    return
  }
  state = next
  for (const cb of [...listeners]) {
    try { cb() } catch { /* one listener never stops the others */ }
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

interface Stamp { seq: number; boot: string | null }

/** A presence count, from the event's fields or the two headers; null when the signal carries none. */
function stampOf(seq: unknown, boot: unknown): Stamp | null {
  const n = typeof seq === 'number' ? seq : typeof seq === 'string' && seq.trim() ? Number(seq) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return { seq: n, boot: str(boot) }
}

/**
 * Whether a stamped signal may be applied, recording its count when it may.
 * `flips`: applying it would change `answers`. A signal with no stamp (an older
 * replica) is taken as it comes.
 */
function admit(stamp: Stamp | null, flips: boolean): boolean {
  if (!stamp) return true
  if (stamp.boot !== null && retiredBoots.includes(stamp.boot)) return false
  if (stamp.boot !== null && order.boot !== null && stamp.boot !== order.boot) {
    // The replica restarted: its count starts again, and the run before it is done.
    retiredBoots = [...retiredBoots.filter((b) => b !== order.boot), order.boot].slice(-RETIRED_BOOTS_KEPT)
    order = { boot: stamp.boot, seq: stamp.seq, strict: false }
    return true
  }
  if (order.seq !== null) {
    if (stamp.seq < order.seq) return false
    if (stamp.seq === order.seq && order.strict && flips) return false
  }
  const strict = order.seq !== null && stamp.seq === order.seq ? order.strict : false
  order = { boot: stamp.boot ?? order.boot, seq: stamp.seq, strict }
  return true
}

/** The replica's `replica:presence` event. */
export function notePresenceEvent(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const d = data as Record<string, unknown>
  if (typeof d.answers !== 'boolean') return
  if (!admit(stampOf(d.seq, d.boot), d.answers !== state.answers)) return
  // `asOf: null` says the copies' age is not known; an event without the field
  // (an older replica) keeps what was known while it stays away.
  const asOf = num(d.asOf) ?? (d.asOf === undefined && !d.answers && !state.answers ? state.asOf : null)
  set({
    answers: d.answers,
    asOf,
    host: str(d.host) ?? state.host,
    hostKey: str(d.hostKey) ?? state.hostKey,
    why: d.answers ? null : str(d.why),
    source: 'ws',
  })
}

/** Any same-origin HTTP answer: its headers say who answered it. */
export function noteResponseHeaders(headers: { get(name: string): string | null } | null | undefined): void {
  // A test's stand-in response may carry no headers at all.
  if (!headers || typeof headers.get !== 'function') return
  const stamp = stampOf(headers.get(PRESENCE_SEQ_HEADER), headers.get(PRESENCE_BOOT_HEADER))
  const offline = headers.get(OFFLINE_HEADER)
  if (offline !== null) {
    // The Mac is only suspect for a moment: an answer from the copies, but no away line.
    if ((headers.get(OFFLINE_WHY_HEADER) ?? '').trim().toLowerCase() === 'suspect') {
      admit(stamp, false)
      return
    }
    if (!admit(stamp, state.answers)) return
    const raw = Number(offline)
    const asOf = Number.isFinite(raw) && raw > 0 ? raw : null
    // An answer from the copies: the Mac is away. While it stays away a newer
    // answer never moves asOf back, and one that knows no age keeps the known one.
    if (state.answers) set({ answers: false, asOf, why: null, source: 'http' })
    else set({ asOf: asOf === null ? state.asOf : Math.max(asOf, state.asOf ?? 0), source: 'http' })
    return
  }
  const via = headers.get(ANSWERED_VIA_HEADER)
  // Forwarded to the Mac (or to the companion standing in, which has live data): no line.
  if (via === 'leader' || via === 'companion') {
    if (!admit(stamp, !state.answers)) return
    set({ answers: true, why: null, source: 'http' })
    return
  }
  // Any other replica answer changes nothing, but its count is the newest news.
  admit(stamp, false)
}

/** /ws closed: the replica's handover codes say which side the next socket reaches. */
export function noteWsClose(code: number): void {
  if (code !== WS_LEADER_AWAY && code !== WS_LEADER_BACK) return
  // The presence moved on the replica after every count seen so far.
  if (order.seq !== null) order = { ...order, strict: true }
  if (code === WS_LEADER_AWAY) {
    // A close says nothing about the copies' age: unknown, unless this socket was already away.
    if (state.answers) set({ answers: false, asOf: null, why: 'leader_away', source: 'close' })
    else set({ source: 'close' })
  } else {
    set({ answers: true, why: null, source: 'close' })
  }
}

/** GET /api/config: on a host replica, `replica.hostKey` names this host's sessions (absent elsewhere). */
export function noteReplicaConfig(body: unknown): void {
  if (!body || typeof body !== 'object') return
  const replica = (body as { replica?: unknown }).replica
  if (!replica || typeof replica !== 'object') return
  const hostKey = str((replica as { hostKey?: unknown }).hostKey)
  if (hostKey) set({ hostKey, source: 'config' })
}

export function isHandoverClose(code: number): boolean {
  return code === WS_LEADER_AWAY || code === WS_LEADER_BACK
}

export function _resetLeaderPresenceForTesting(): void {
  state = INITIAL
  order = { boot: null, seq: null, strict: false }
  retiredBoots = []
  listeners.clear()
}

/** "just now", "1 min ago", "2 min ago", "3 h ago", "2 days ago"; null when the age is not known. */
export function agoText(asOf: number | null, now: number): string | null {
  if (asOf === null || !(asOf > 0)) return null
  const s = Math.max(0, Math.round((now - asOf) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${Math.max(1, m)} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

/** The quiet line while the Mac is away, or null while it answers. */
export function awayLineText(p: LeaderPresenceState, now: number): { line: string; prompts: string } | null {
  if (p.answers) return null
  const host = p.host ?? 'this host'
  const ago = agoText(p.asOf, now)
  return {
    line: ago === null
      ? `Your Mac is away. This is the copy on ${host}; its age is not known.`
      : `Your Mac is away. This is the copy on ${host} from ${ago}.`,
    prompts: `Prompts on ${host} are not pushed to your phone.`,
  }
}

/** Whether a session's controls need the Mac right now: it is away and the session runs elsewhere than this host. */
export function isMacSessionAway(p: LeaderPresenceState, session: { host?: string | null } | null | undefined): boolean {
  if (p.answers || !session) return false
  const host = typeof session.host === 'string' ? session.host.trim() : ''
  if (!host || host === '__local__') return true
  return p.hostKey === null || host !== p.hostKey
}

/**
 * Plain words for every `why` a replica answers `needs_leader` with (src/replica/
 * route-table.ts, ws-rpc-table.ts, dispatch.ts, presence.ts, away-session-reads.ts,
 * notes-routes.ts, src/providers/offline-host-core.ts, the copy kinds). Ratchet:
 * tests/replica/needs-leader-reasons-ratchet.test.ts reads src/ and fails on a
 * code missing here.
 */
export const NEEDS_LEADER_REASONS: Readonly<Record<string, string>> = {
  // Route and RPC rows (route-table.ts, ws-rpc-table.ts).
  task_writes_need_mac: 'Changing a task needs your Mac for now.',
  session_writes_need_mac: 'Sending to a session needs your Mac for now.',
  device_changes_need_mac: 'Changing a device needs your Mac.',
  plugins_need_mac: 'Plugins run on your Mac.',
  ask_needs_mac: 'Asking Walnut needs your Mac for now.',
  terminal_needs_mac: 'The terminal runs through your Mac.',
  files_need_mac: 'Opening files needs your Mac for now.',
  usage_needs_mac: 'Usage and budgets are counted on your Mac.',
  needs_mac: 'Only your Mac can do this.',
  // A session's reads (away-session-reads.ts).
  session_on_mac: 'This session runs through your Mac; its conversation is there.',
  session_files_need_mac: 'Reading this session\'s files needs your Mac for now.',
  history_pages_need_mac: 'Older messages load when your Mac is back.',
  // The daemon and its journal (dispatch.ts, offline-host-core.ts).
  daemon_needs_upgrade: 'This host\'s Walnut daemon is too old to keep changes; it updates on your Mac\'s next connect.',
  daemon_unreachable: 'This host\'s Walnut daemon did not answer.',
  not_queueable: 'This change cannot wait on this host until your Mac is back.',
  mac_too_old: 'Your Mac runs an older Walnut that cannot take this change later.',
  fields: 'Some of these fields can only be changed while your Mac answers.',
  board_not_here: 'This Board is not kept on this host.',
  // The away writes of a host replica (replica/away-writes.ts, ws-writes.ts).
  reorder_needs_mac: 'Only one task can be moved at a time while your Mac is away.',
  list_order_needs_mac: 'Reordering a list needs your Mac; the Focus bar can be reordered while it is away.',
  images_need_mac: 'Pictures reach a session through your Mac; send the text alone, or wait for your Mac.',
  // The copies (kinds/gate.ts, notes-routes.ts).
  kind_not_copied: 'This host keeps no copy of it.',
  copy_unreadable: 'The copy on this host could not be read.',
  no_spawn_template: 'Starting a session here needs your Mac once first.',
  persona_not_copied: 'This host has no copy of the agent yet.',
  // A host replica's own refusals of what it keeps a copy of (WP5: config, routines, prefs, chat lists).
  config_writes_need_mac: 'Changing settings needs your Mac.',
  routine_writes_need_mac: 'Changing a routine needs your Mac.',
  prefs_writes_need_mac: 'Changing favorites or the layout needs your Mac.',
  conversation_writes_need_mac: 'Changing the chat list needs your Mac.',
  conversation_bodies_need_mac: 'The messages of a chat are on your Mac; this host keeps only the list.',
  other_hosts_need_mac: 'Reaching another host goes through your Mac.',
  // Where the replica's route stands (presence.ts, dispatch.ts): the why of a write with no row of its own.
  'mac-away': 'Your Mac is away right now.',
  'no-daemon': 'This host\'s Walnut daemon is not answering.',
  'nobody-answers': 'Neither your Mac nor the cloud companion answers right now.',
  draining: 'This host is still handing its changes to your Mac; try again in a few seconds.',
  unreachable: 'Your Mac did not answer just now; try again in a moment.',
  // leader_unsure (dispatch.ts).
  lost_answer: 'This host may have kept the change; check it before you try again.',
  // Notes while the Mac is away (WP11: route-table.ts, offline-host-core.ts notePut).
  note_changes_need_mac: 'Editing a note works while your Mac is away; moving, renaming, folders and pictures need your Mac.',
  note_not_kept: 'This host keeps no copy of this note, so it can only be changed on your Mac.',
  note_too_large: 'Notes over 1 MB can only be changed on your Mac.',
}

const GENERIC_REASON = 'Your Mac is not answering right now.'

const hasReason = (why: string): boolean => Object.prototype.hasOwnProperty.call(NEEDS_LEADER_REASONS, why)

/** A server message as a sentence: trimmed, capitalized, ending in a period. */
function sentence(text: string): string {
  const t = text.trim()
  if (!t) return t
  const head = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(head) ? head : `${head}.`
}

/**
 * Whether a message is one of leaderErrorMessage's: already plain words about
 * the Mac, so a surface shows it as it is, with no "Failed to ..." in front.
 */
export function isLeaderWords(message: unknown): boolean {
  return typeof message === 'string' && /^(Needs your Mac\. |Your Mac (just came back|did not answer in time)|This host (already keeps|could not keep|did not answer))/.test(message)
}

/**
 * The words for a host journal that did not take a write while the Mac is away
 * (plan section 5 "Limits", row R20): full (`queue_full`, 1000 records or the note
 * bodies' budget), or not writable (`journal_unwritable`: a full disk, a lost lock,
 * a daemon that no longer owns its dir). Either way the changes it kept before are
 * kept. `no_answer` is the dispatcher's: every try went unanswered, so it may be kept.
 */
const JOURNAL_WORDS = {
  full: 'This host already keeps as many changes as it can until your Mac is back; this one was not kept. Try it again once your Mac is back.',
  diskFull: 'This host could not keep this change: its disk is full. The changes it kept before are safe.',
  unwritable: 'This host could not keep this change. The changes it kept before are safe; try again in a moment.',
  noAnswer: 'This host did not answer, and it may have kept the change; check it before you try again.',
} as const

/**
 * The message for a replica's error body, or null when it is not one: "Needs
 * your Mac" with the reason for needs_leader (the why's words, else the server's
 * own message, else the generic words), and the plain words for leader_unsure,
 * primary_timeout and a host journal that did not take the write. Two shapes:
 * `{error:{code, why, message, sent}}` and the console's flat `{error: '<message>', code, why}`.
 * `status`: the answer's HTTP status; a `queue_full` is the journal's only as a 503
 * (a busy session's queue on the Mac answers 429 with words of its own).
 */
export function leaderErrorMessage(body: unknown, status?: number): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { error?: unknown; code?: unknown; why?: unknown }
  let e: { code?: unknown; why?: unknown; sent?: unknown; message?: unknown }
  if (b.error && typeof b.error === 'object') e = b.error as typeof e
  else if (typeof b.code === 'string') e = { code: b.code, why: b.why, message: b.error }
  else return null
  const why = typeof e.why === 'string' ? e.why : ''
  if (e.code === 'needs_leader') {
    const own = typeof e.message === 'string' ? sentence(e.message) : ''
    const reason = (hasReason(why) ? NEEDS_LEADER_REASONS[why] : undefined) || own || GENERIC_REASON
    return `Needs your Mac. ${reason}`
  }
  if (e.code === 'leader_unsure') {
    return why === 'lost_answer' ? `Your Mac just came back. ${NEEDS_LEADER_REASONS.lost_answer}` : 'Your Mac just came back; try again in a few seconds.'
  }
  if (e.code === 'primary_timeout') {
    return e.sent === false
      ? 'Your Mac did not answer in time. Nothing was saved; try again.'
      : 'Your Mac did not answer in time, and it may have kept the change; check it before you try again.'
  }
  if (e.code === 'queue_full' && status === 503) return JOURNAL_WORDS.full
  if (e.code === 'journal_unwritable') {
    return why === 'no_answer' ? JOURNAL_WORDS.noAnswer : why === 'disk_full' ? JOURNAL_WORDS.diskFull : JOURNAL_WORDS.unwritable
  }
  return null
}

/** The plain words for a `why` the replica gave (an older-messages page, a refusal), or null for one it does not know. */
export function leaderReasonText(why: unknown): string | null {
  return typeof why === 'string' && hasReason(why) ? NEEDS_LEADER_REASONS[why]! : null
}
