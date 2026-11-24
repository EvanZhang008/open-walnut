/**
 * What the cloud companion's phone routes do with a session its host judges, from what that host's
 * listener link told (companion-listener.ts):
 *
 *   list / detail   the rows a host stands for (companion-listener.ts standsFor) join the phone's
 *                   session list and its push feed while the Mac is away, over the copy's own fields
 *                   (overCopy), and answer its detail with the prompts of the `live` state
 *   operate         only while the Mac is away (macAway): a send, an interrupt and a prompt's answer
 *                   go to the host's own routes as call frames on the listener link (listener-wire.ts
 *                   LISTENER_CALLS), answered by the same route table and checks the leader's calls
 *                   go through. While the Mac answers, each route relays to it as before: one path
 *                   at a time. Every answer of this path carries `viaHost: true` (additive).
 *   pictures        a send's or an answer's pictures are saved on the host first, by its daemon's
 *                   `image.save` over the host's own bridge, the way a phone picture for a session on
 *                   another machine has always gone (sessions/cloud-images.ts): the same folder, names,
 *                   caps and header, so the words reach the CLI exactly as a legacy send's do. Only
 *                   the small words ride the listener link; no picture rides it. A host whose link is
 *                   up but whose bridge is not gets a retryable refusal, never a hold: as a text send
 *                   whose link is down, the phone's retry ladder carries it (no held-send drain runs
 *                   through a host's link)
 *   refuse          a session a host claimed, the Mac away, but its link down (or sessions turned
 *                   off for the companion): a clear refusal (hostRoute), never the daemon's direct
 *                   path around its judge
 *
 * The user's setting that keeps sessions off the companion (Settings, kinds/gate.ts copyKindOff)
 * wins here too: with it off, no host row joins a list or a push and nothing is operated.
 */
import { listenerLinked, callListenedHost, ListenerNotLinked, standingRow, standingRows, anyListenedRows as anyRows } from './companion-listener.js'
import { hostJudgedAlias, hostUnreachableSentence } from './host-judged-direct.js'
import { callArgsOut } from './host-calls.js'
import type { LiveState } from './host-api.js'
import type { SessionRecord } from '../types.js'
import type { SessionImage } from '../sessions/cloud-images.js'

const MAC_ALIAS = '__local__'
/**
 * How long the Mac's own bridge may be gone (counted from its last heartbeat) before the Mac reads
 * as away: a bridge blip or a deploy's restart does not flip the paths (review L4). A restart the
 * Mac announced (its heartbeat's restartingMs) holds it longer, to that window's end.
 */
export const MAC_BLIP_MS = 15_000

/**
 * Is the Mac away now? Its heartbeat quiet for the takeover window (the backup leader's own measure,
 * a restart it announced included), or its own bridge gone and the heartbeat quiet for MAC_BLIP_MS.
 */
export async function macAway(now = Date.now()): Promise<boolean> {
  const [{ bridgeForHost }, { getBackupLeader }] = await Promise.all([import('../../web/ws/bridge-registry.js'), import('../leader/backup-leader.js')])
  const s = (await getBackupLeader())?.status()
  if (!s) return !bridgeForHost(MAC_ALIAS).connected
  const quiet = now - s.primaryLastSeenAt
  const restart = s.restartingUntil && s.restartingUntil > now ? s.restartingUntil - s.primaryLastSeenAt : 0
  const window = bridgeForHost(MAC_ALIAS).connected ? s.takeoverMs : MAC_BLIP_MS
  return quiet >= Math.max(window, restart)
}

/** Sessions turned off for this companion (Settings): the listener shows and operates nothing. */
async function sessionsOff(): Promise<boolean> {
  return (await import('../replication/kinds/gate.js')).copyKindOff('sessions')
}

export interface OperatedSession { alias: string; row: SessionRecord; live: LiveState | null }

/** The host-judged session `sid` this companion operates now: a linked host stands for it, the Mac away, sessions kept. Else null. */
export async function hostOperated(sid: string): Promise<OperatedSession | null> {
  const t = await standingRow(sid)
  if (!t || !t.linked || !listenerLinked(t.alias)) return null
  if (!(await macAway()) || await sessionsOff()) return null
  return { alias: t.alias, row: t.row, live: t.live }
}

export type HostRoute =
  | { kind: 'none' }
  | { kind: 'operated'; t: OperatedSession }
  | { kind: 'refuse'; status: number; code: string; message: string }

/**
 * Where an operation of `sid` goes: `none` (not a host's own, or the Mac answers: today's path),
 * `operated` (through the host's link), or `refuse` (a host's own, the Mac away, and its link down
 * or sessions off here). A host-judged session never takes the daemon's direct path (review M2).
 */
export async function hostRoute(sid: string): Promise<HostRoute> {
  const alias = await hostJudgedAlias(sid)
  if (!alias || !(await macAway())) return { kind: 'none' }
  if (await sessionsOff()) {
    const { SESSIONS_NOT_KEPT } = await import('../../replica/away-kind-reads.js')
    return { kind: 'refuse', status: 503, code: 'not_kept_here', message: SESSIONS_NOT_KEPT }
  }
  const t = await hostOperated(sid)
  if (t) return { kind: 'operated', t }
  const { hostDisplayName } = await import('../hosts/host-display-name.js')
  // `bridge_offline`: the code the phone retries on its own with the same message id (ios-native
  // Models.swift leaderAwayCodes, SendRetryPolicy), and the host's queue takes an id once (review M6).
  return { kind: 'refuse', status: 503, code: 'bridge_offline', message: hostUnreachableSentence(hostDisplayName(alias)) }
}

/** The stream of `sid` comes from its host's link (reading is no authority): a linked host stands for it, sessions kept here. */
export async function streamedByListener(sid: string): Promise<{ processStatus: string } | null> {
  const t = await standingRow(sid)
  if (!t?.linked || await sessionsOff()) return null
  return { processStatus: t.row.process_status ?? '' }
}

/** Has any linked host told rows (the list answers from them when the copy has none yet)? */
export function anyListenedRows(): boolean {
  return anyRows()
}

/** `heard` over `copy`: the host's fields win, except where the host has none (the copy's task title, folder, pin, host label). */
export function overCopy<C extends Record<string, unknown>>(copy: C | undefined, heard: Record<string, unknown>): C & Record<string, unknown> {
  const out: Record<string, unknown> = { ...(copy ?? {}) }
  for (const [k, val] of Object.entries(heard)) if (val !== undefined && val !== null && val !== '') out[k] = val
  return out as C & Record<string, unknown>
}

/**
 * The phone's session list with the rows linked hosts stand for joined in, while the Mac is away: a
 * row the copy also has is the host's, over the copy's own fields; one the copy lacks (born while
 * the Mac was away) is added. While the Mac answers, or with sessions off here, the list as it is.
 */
export async function joinListenedRows<P extends { id: string }>(projected: P[]): Promise<Array<P | Record<string, unknown> & { id: string }>> {
  if (!anyRows() || !(await macAway()) || await sessionsOff()) return projected
  const told = await standingRows()
  if (told.length === 0) return projected
  const { projectSession } = await import('../session-projection.js')
  const byId = new Map(told.map((t) => [t.row.claudeSessionId, t]))
  const out: Array<P | Record<string, unknown> & { id: string }> = projected.map((p) => {
    const t = byId.get(p.id)
    if (!t) return p
    byId.delete(p.id)
    return overCopy(p as unknown as Record<string, unknown>, projectSession(t.row, undefined) as unknown as Record<string, unknown>) as unknown as P
  })
  for (const t of byId.values()) out.push(projectSession(t.row, undefined) as unknown as Record<string, unknown> & { id: string })
  return out
}

/** A told row on the phone's push feed: only while the Mac is away (else the Mac's own push says it), over the copy's row. */
export async function pushListenedRow(row: SessionRecord): Promise<void> {
  if (!(await macAway()) || await sessionsOff()) return
  const t = await standingRow(row.claudeSessionId)
  if (!t || !t.linked) return
  const [{ projectSession, readSessionProjection }, { handleBridgeMobileEvent }] = await Promise.all([import('../session-projection.js'), import('../../web/routes/events-v1.js')])
  const copy = (await readSessionProjection())?.sessions.find((s) => s.id === row.claudeSessionId)
  // The feed's session-upsert also says the status on the session's own stream (events-v1.ts).
  handleBridgeMobileEvent('session-upsert', overCopy(copy as unknown as Record<string, unknown> | undefined, projectSession(row, undefined) as unknown as Record<string, unknown>))
}

/** The Mac's last known presence, for the push when it turns away (null: not asked yet). */
let wasAway: boolean | null = null
let awayWatch: ReturnType<typeof setInterval> | null = null
/** How often a linked companion asks whether the Mac turned away. */
export const MAC_AWAY_WATCH_MS = 2_000

/**
 * The Mac just turned away: the phone's push feed hears every row the linked hosts stand for once,
 * so its list fills in without waiting for the next change of a row (review L11). A row told while
 * the Mac is away is pushed as it comes (pushListenedRow), so only the turn needs this.
 */
export async function checkMacAway(): Promise<void> {
  if (!anyRows()) { wasAway = null; return }
  const away = await macAway()
  const turned = away && wasAway === false
  wasAway = away
  if (!turned) return
  for (const t of await standingRows()) await pushListenedRow(t.row)
}

/** Watch for the Mac turning away while a host is linked (listener-door.ts starts it with the first link). */
export function watchMacAway(): void {
  if (awayWatch) return
  awayWatch = setInterval(() => { void checkMacAway().catch(() => {}) }, MAC_AWAY_WATCH_MS)
  awayWatch.unref?.()
}

/** GET /sessions/:id from the host's word: its row and the prompts it waits on now. */
export function listenedDetail(t: OperatedSession): Record<string, unknown> {
  const pending = Array.isArray(t.live?.pendingPermissionRequests) ? t.live!.pendingPermissionRequests : []
  return { session: t.row, pendingPermissions: pending, viaHost: true }
}

/** A host answer as the phone's route gives it; `maybeTaken`: no answer came, the host may have taken it. */
export interface HostAnswer { status: number; body: Record<string, unknown>; maybeTaken?: true }

const v1Error = (status: number, code: string, message: string): HostAnswer => ({ status, body: { error: { code, message } } })

/** The code of a call the session's host is too old to take (nothing was done there). */
export const NEEDS_UPDATE = 'needs_upgrade'

async function call(t: OperatedSession, path: string, body: unknown, timeoutMs: number): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; answer: HostAnswer }> {
  try {
    const r = await callListenedHost(t.alias, path, body, timeoutMs)
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>
    if (r.status === 200 && b.ok === true) return { ok: true, body: b }
    const why = typeof b.error === 'string' ? b.error : `the host answered ${r.status}`
    if (why === 'not_own_session') return { ok: false, answer: v1Error(404, 'not_found', 'The session\'s host does not run this session') }
    // A host on an older Walnut whose listener does not take this call yet (listener-wire.ts
    // LISTENER_CALLS grew: a stop and a mode change, 2026-11-24): nothing was done there.
    if (why === 'not_callable') return { ok: false, answer: v1Error(503, NEEDS_UPDATE, `The Walnut on ${t.alias} needs an update before the phone can do this while the Mac is away; it updates with its next deploy.`) }
    const refused = r.status >= 400 && r.status < 500
    return { ok: false, answer: v1Error(refused ? r.status : 503, refused ? (typeof b.code === 'string' ? b.code : 'bad_request') : 'bridge_offline', why) }
  } catch (err) {
    // Not linked: nothing was sent. A timeout or a dropped link: the host may have taken it, and a
    // retry with the same message id is queued once there (the host's queue keys it by that id).
    if (err instanceof ListenerNotLinked) return { ok: false, answer: v1Error(503, 'bridge_offline', 'The session\'s host is not linked to the companion right now; retrying automatically') }
    return { ok: false, answer: { ...v1Error(503, 'bridge_offline', 'The session\'s host did not answer in time; retrying automatically'), maybeTaken: true } }
  }
}

/**
 * The files a message's pictures were saved as on its host, by session and message id: a retry of
 * the same id (its answer was lost, ledger `maybe-relayed`) names the same files without moving
 * the pictures again, so it is a words-only call the host's id-keyed queue dedupes, and it still
 * reaches the host while the host's bridge is down. Memory only (a restarted companion saves them
 * again), kept SAVED_PICTURES_MS and at most SAVED_PICTURES_MAX entries.
 */
const savedPictures = new Map<string, { paths: string[]; at: number }>()
const SAVED_PICTURES_MS = 30 * 60_000
const SAVED_PICTURES_MAX = 500
/** The host's time to answer a send after its pictures took the window: at least this. */
export const SEND_AFTER_PICTURES_FLOOR_MS = 3_000

function keptPictures(key: string, count: number, now = Date.now()): string[] | null {
  for (const [k, v] of savedPictures) if (now - v.at > SAVED_PICTURES_MS) savedPictures.delete(k)
  const kept = savedPictures.get(key)
  return kept && kept.paths.length === count ? kept.paths : null
}

function keepPictures(key: string, paths: string[]): void {
  savedPictures.delete(key)
  savedPictures.set(key, { paths, at: Date.now() })
  while (savedPictures.size > SAVED_PICTURES_MAX) savedPictures.delete(savedPictures.keys().next().value!)
}

/** Tests only. */
export function _resetSavedPicturesForTesting(): void {
  savedPictures.clear()
}

/**
 * Pictures for a session its host runs, saved on that host before its words go (saveImagesViaBridge:
 * the daemon's narrow `image.save`, its folder, its names and its caps). The bridge is the host's own:
 * its token is bound to the alias the listener link stands for (bridge-registry.ts tokenBoundAlias),
 * so a picture lands only on the session's host. A picture that cannot be saved sends nothing
 * (cloud-images.ts imageSaveRefusal: the legacy codes).
 */
async function picturesOnHost(t: OperatedSession, images: SessionImage[]): Promise<{ ok: true; paths: string[] } | { ok: false; answer: HostAnswer }> {
  const { saveImagesViaBridge, imageSaveRefusal } = await import('../sessions/cloud-images.js')
  try {
    return { ok: true, paths: await saveImagesViaBridge(t.alias, t.row.claudeSessionId, images, t.row.host_label) }
  } catch (err) {
    const r = imageSaveRefusal(err, t.alias, t.row.host_label)
    return { ok: false, answer: v1Error(r.status, r.code, r.message) }
  }
}

/**
 * A phone's send, queued on the host under the phone's message id (a retry is queued once). Its
 * pictures are saved on the host first (or named again from an earlier try of the same id) and
 * named at the head of the words (withImagePaths), as a legacy send's are. `timeoutMs` is the
 * send's window from now; the host's call gets what is left of it after the pictures, never less
 * than SEND_AFTER_PICTURES_FLOOR_MS.
 */
export async function sendViaHost(t: OperatedSession, o: { text: string; messageId: string; timeoutMs: number; images?: SessionImage[] }): Promise<HostAnswer> {
  const sid = t.row.claudeSessionId
  const answerBy = Date.now() + o.timeoutMs
  let text = o.text
  let timeoutMs = o.timeoutMs
  if (o.images?.length) {
    const key = `${sid}\u0000${o.messageId}`
    let paths = keptPictures(key, o.images.length)
    if (!paths) {
      const saved = await picturesOnHost(t, o.images)
      if (!saved.ok) return saved.answer
      paths = saved.paths
      keepPictures(key, paths)
    }
    text = (await import('../sessions/cloud-images.js')).withImagePaths(text, paths)
    timeoutMs = Math.max(SEND_AFTER_PICTURES_FLOOR_MS, answerBy - Date.now())
  }
  const body = {
    sessionId: sid, message: text, ...(t.row.taskId ? { taskId: t.row.taskId } : {}),
    queued: [{ id: o.messageId, message: text, sentBy: 'person' as const }], busSource: 'mobile',
  }
  const r = await call(t, '/host-api/sessions/send', body, timeoutMs)
  return r.ok ? { status: 202, body: { messageId: o.messageId, viaHost: true } } : r.answer
}

/** The phone's Stop: the running turn only. */
export async function interruptViaHost(t: OperatedSession, timeoutMs = 15_000): Promise<HostAnswer> {
  const sid = t.row.claudeSessionId
  const wasRunning = t.live?.turnRunning ?? t.live?.inTurn ?? t.row.process_status === 'running'
  const r = await call(t, '/host-api/sessions/interrupt', { sessionId: sid, busSource: 'mobile' }, timeoutMs)
  return r.ok ? { status: 200, body: { status: 'interrupted', sessionId: sid, wasRunning: wasRunning === true, viaHost: true } } : r.answer
}

/**
 * The phone's Stop of the whole session (POST /sessions/:id/terminate): the host's own stop of its
 * own session (session-lifecycle.ts terminateSession), as the Mac hands it over. Answers the host's
 * TerminateResult (a `pending` one is the route's stop_pending), or the refusal.
 */
export async function stopViaHost(t: OperatedSession, force: boolean, timeoutMs = 30_000): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; answer: HostAnswer }> {
  const r = await call(t, '/host-api/sessions/call', { sid: t.row.claudeSessionId, target: 'lifecycle', member: 'terminateSession', ...callArgsOut([{ force }]) }, timeoutMs)
  if (!r.ok) return r
  const value = r.body.value && typeof r.body.value === 'object' ? r.body.value as Record<string, unknown> : {}
  return { ok: true, result: { ...value, viaHost: true } }
}

/**
 * The phone's permission mode change: the host keeps the mode on its own row and applies it to the
 * live session (session-lifecycle.ts changeSessionModeOf, as the Mac hands it over). The caller's
 * ceiling (delegated-mode.ts modeChangeRefusal) was applied by the route before this, as for every
 * mode change. Answers the mode the host kept.
 */
export async function modeViaHost(t: OperatedSession, mode: string, timeoutMs = 20_000): Promise<{ ok: true; mode: string } | { ok: false; answer: HostAnswer }> {
  const r = await call(t, '/host-api/sessions/call', { sid: t.row.claudeSessionId, target: 'lifecycle', member: 'changeSessionModeOf', ...callArgsOut([mode]) }, timeoutMs)
  if (!r.ok) return r
  const kept = (r.body.value as { mode?: unknown } | null)?.mode
  return { ok: true, mode: typeof kept === 'string' ? kept : mode }
}

/**
 * PATCH /sessions/:id with a mode on the companion: null when the session is not one a linked host
 * stands for with the Mac away (the route goes on as before); else the answer. The mode goes to the
 * host (modeViaHost); the rest of the patch is metadata, kept for the Mac (control-queue.ts), as the
 * lead path keeps it. The route applied the caller's ceiling before this.
 */
export async function patchModeViaHost(sid: string, mode: unknown, patch: Record<string, unknown>): Promise<HostAnswer | null> {
  const route = await hostRoute(sid)
  if (route.kind === 'none') return null
  if (route.kind === 'refuse') return v1Error(route.status, route.code, route.message)
  const { VALID_SESSION_MODE_IDS } = await import('../types.js')
  if (typeof mode !== 'string' || !VALID_SESSION_MODE_IDS.has(mode)) return v1Error(400, 'bad_request', `mode must be one of ${[...VALID_SESSION_MODE_IDS].join(', ')}`)
  const applied = await modeViaHost(route.t, mode)
  if (!applied.ok) return applied.answer
  const { mode: _mode, ...rest } = patch
  const { keepSessionPatch } = await import('../control-queue.js')
  const opId = Object.keys(rest).length > 0 ? await keepSessionPatch(sid, rest) : null
  const row = route.t.row
  const session = { claudeSessionId: sid, process_status: row.process_status, ...(row.title !== undefined ? { title: row.title } : {}), mode: applied.mode, ...rest }
  return { status: 200, body: { session, viaHost: true, ...(opId ? { queued: true } : {}) } }
}

/**
 * The phone's answer to a prompt: checked as the Mac's route checks it, then the session's own
 * `resolvePermissionRequest` on the host (which first proves the request is pending on that session).
 * Its pictures (inline, or this box's uploads made inline: answer-pictures.ts) go as an answer's do
 * while the companion leads a host (leader/host-session-control.ts withPictures): saved on the host
 * and named at the head of the last answer, for an allowed answer with answers.
 */
export async function permissionViaHost(t: OperatedSession, b: Record<string, unknown>, timeoutMs = 20_000): Promise<HostAnswer> {
  const { requestId, allow, message, optionId, answers } = b
  if (typeof requestId !== 'string' || !requestId || typeof allow !== 'boolean') return v1Error(400, 'bad_request', 'requestId (string) and allow (boolean) are required')
  if (message !== undefined && typeof message !== 'string') return v1Error(400, 'bad_request', 'message must be a string')
  if (optionId !== undefined && typeof optionId !== 'string') return v1Error(400, 'bad_request', 'optionId must be a string')
  if (answers !== undefined && (typeof answers !== 'object' || answers === null || Array.isArray(answers) || Object.values(answers).some((v) => typeof v !== 'string'))) {
    return v1Error(400, 'bad_request', 'answers must be an object mapping question to answer string')
  }
  const { isAcpEngine } = await import('../agents/engine-registry.js')
  const acp = isAcpEngine(t.row.engine)
  let given = answers as Record<string, string> | undefined
  let pictures = 0
  if (!acp && allow && given && Object.keys(given).length > 0 && (b.images !== undefined || b.imageRefs !== undefined)) {
    // The prompt as the host last told it: an answer to one it no longer holds moves no picture
    // (the host's own proof below stays the authority for every other answer).
    const held = Array.isArray(t.live?.pendingPermissionRequests) ? t.live!.pendingPermissionRequests as Array<{ requestId?: unknown; input?: unknown }> : null
    const prompt = held?.find((p) => p?.requestId === requestId)
    if (held && !prompt) return v1Error(404, 'not_found', 'Permission request not found or already resolved')
    const [{ inlineAnswerPictures }, { withAnswerImagePaths }] = await Promise.all([import('../answer-pictures.js'), import('../sessions/cloud-images.js')])
    const inline = await inlineAnswerPictures(b)
    if (inline.length > 0) {
      const saved = await picturesOnHost(t, inline)
      if (!saved.ok) return saved.answer
      const input = prompt?.input && typeof prompt.input === 'object' ? prompt.input as Record<string, unknown> : undefined
      given = withAnswerImagePaths(given, saved.paths, input)
      pictures = saved.paths.length
    }
  }
  const patch = given !== undefined && Object.keys(given).length > 0 ? { answers: given } : undefined
  // The session's own parameters (claude-code-session.ts, acp-session.ts), each one left out still
  // undefined there (host-calls.ts callArgsOut: JSON carries no undefined).
  const raw = acp ? [requestId, allow, optionId] : [requestId, allow, message, patch, optionId]
  const sid = t.row.claudeSessionId
  const r = await call(t, '/host-api/sessions/call', { sid, target: acp ? 'acp' : 'session', member: 'resolvePermissionRequest', ...callArgsOut(raw) }, timeoutMs)
  if (!r.ok) {
    const e = (r.answer.body.error as { message?: string } | undefined)?.message
    if (e === 'not_pending' || e === 'no_live_session') return v1Error(404, 'not_found', 'Permission request not found or already resolved')
    return r.answer
  }
  if (r.body.value !== true) return v1Error(503, 'bridge_offline', 'Permission answer was not confirmed by the session host; retry the same request')
  return { status: 200, body: { status: 'resolved', requestId, allow, viaHost: true, ...(pictures > 0 ? { pictures } : {}) } }
}
