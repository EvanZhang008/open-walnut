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
 *                   the small words ride the listener link; no picture rides it.
 *   refuse          a session a host claimed, the Mac away, but its link down (or sessions turned
 *                   off for the companion): a clear refusal (hostRoute), never the daemon's direct
 *                   path around its judge
 *
 * The user's setting that keeps sessions off the companion (Settings, kinds/gate.ts copyKindOff)
 * wins here too: with it off, no host row joins a list or a push and nothing is operated.
 */
import { listenerLinked, callListenedHost, ListenerNotLinked, standingRow, standingRows, anyListenedRows as anyRows } from './companion-listener.js'
import { hostJudgedAlias, hostUnreachableSentence } from './host-judged-direct.js'
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

async function call(t: OperatedSession, path: string, body: unknown, timeoutMs: number): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; answer: HostAnswer }> {
  try {
    const r = await callListenedHost(t.alias, path, body, timeoutMs)
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>
    if (r.status === 200 && b.ok === true) return { ok: true, body: b }
    const why = typeof b.error === 'string' ? b.error : `the host answered ${r.status}`
    if (why === 'not_own_session') return { ok: false, answer: v1Error(404, 'not_found', 'The session\'s host does not run this session') }
    return { ok: false, answer: v1Error(r.status >= 400 && r.status < 500 ? r.status : 503, r.status >= 400 && r.status < 500 ? 'bad_request' : 'bridge_offline', why) }
  } catch (err) {
    // Not linked: nothing was sent. A timeout or a dropped link: the host may have taken it, and a
    // retry with the same message id is queued once there (the host's queue keys it by that id).
    if (err instanceof ListenerNotLinked) return { ok: false, answer: v1Error(503, 'bridge_offline', 'The session\'s host is not linked to the companion right now; retrying automatically') }
    return { ok: false, answer: { ...v1Error(503, 'bridge_offline', 'The session\'s host did not answer in time; retrying automatically'), maybeTaken: true } }
  }
}

/**
 * Pictures for a session its host runs, saved on that host before its words go (saveImagesViaBridge:
 * the daemon's narrow `image.save`, its folder, its names and its caps). The bridge is the host's own:
 * its token is bound to the alias the listener link stands for (bridge-registry.ts tokenBoundAlias),
 * so a picture lands only on the session's host. A picture that cannot be saved sends nothing: a
 * reason a retry will not fix is a 400 with its code, as a legacy send answers it; a host whose bridge
 * did not answer is `bridge_offline`, which the phone retries with the same message id.
 */
async function picturesOnHost(t: OperatedSession, images: SessionImage[]): Promise<{ ok: true; paths: string[] } | { ok: false; answer: HostAnswer }> {
  const [{ saveImagesViaBridge, CloudImageError }, { hostDisplayName }] = await Promise.all([import('../sessions/cloud-images.js'), import('../hosts/host-display-name.js')])
  try {
    return { ok: true, paths: await saveImagesViaBridge(t.alias, t.row.claudeSessionId, images, t.row.host_label) }
  } catch (err) {
    if (err instanceof CloudImageError) return { ok: false, answer: v1Error(400, err.code, err.message) }
    return { ok: false, answer: v1Error(503, 'bridge_offline', `${hostDisplayName(t.alias, t.row.host_label)} could not take the pictures right now; retrying automatically`) }
  }
}

/**
 * A phone's send, queued on the host under the phone's message id (a retry is queued once). Its
 * pictures are saved on the host first and named at the head of the words (withImagePaths), as a
 * legacy send's are; `timeoutMs` is the host's time to answer the send itself, after them.
 */
export async function sendViaHost(t: OperatedSession, o: { text: string; messageId: string; timeoutMs: number; images?: SessionImage[] }): Promise<HostAnswer> {
  const sid = t.row.claudeSessionId
  let text = o.text
  if (o.images?.length) {
    const saved = await picturesOnHost(t, o.images)
    if (!saved.ok) return saved.answer
    text = (await import('../sessions/cloud-images.js')).withImagePaths(text, saved.paths)
  }
  const body = {
    sessionId: sid, message: text, ...(t.row.taskId ? { taskId: t.row.taskId } : {}),
    queued: [{ id: o.messageId, message: text, sentBy: 'person' as const }], busSource: 'mobile',
  }
  const r = await call(t, '/host-api/sessions/send', body, o.timeoutMs)
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
    const [{ inlineAnswerPictures }, { withAnswerImagePaths }] = await Promise.all([import('../answer-pictures.js'), import('../sessions/cloud-images.js')])
    const inline = await inlineAnswerPictures(b)
    if (inline.length > 0) {
      const saved = await picturesOnHost(t, inline)
      if (!saved.ok) return saved.answer
      given = withAnswerImagePaths(given, saved.paths)
      pictures = saved.paths.length
    }
  }
  const patch = given !== undefined && Object.keys(given).length > 0 ? { answers: given } : undefined
  // The session's own parameters (claude-code-session.ts, acp-session.ts); a trailing one left out is
  // absent there, an inner one null (JSON carries no undefined).
  const raw: unknown[] = acp ? [requestId, allow, optionId] : [requestId, allow, message, patch, optionId]
  while (raw.length > 0 && raw[raw.length - 1] === undefined) raw.pop()
  const args = raw.map((v) => (v === undefined ? null : v))
  const sid = t.row.claudeSessionId
  const r = await call(t, '/host-api/sessions/call', { sid, target: acp ? 'acp' : 'session', member: 'resolvePermissionRequest', args }, timeoutMs)
  if (!r.ok) {
    const e = (r.answer.body.error as { message?: string } | undefined)?.message
    if (e === 'not_pending' || e === 'no_live_session') return v1Error(404, 'not_found', 'Permission request not found or already resolved')
    return r.answer
  }
  if (r.body.value !== true) return v1Error(503, 'bridge_offline', 'Permission answer was not confirmed by the session host; retry the same request')
  return { status: 200, body: { status: 'resolved', requestId, allow, viaHost: true, ...(pictures > 0 ? { pictures } : {}) } }
}
