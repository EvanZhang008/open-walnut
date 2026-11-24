/**
 * The wire of the cloud companion's listener door (land 5b), one file both sides build against:
 * a host's one Walnut service dials the companion it already has a /bridge link to, so the phone
 * sees and operates the host's own sessions while the leader (the Mac) is away. Behind the
 * experiment `host_runs_sessions` (switch.ts): the host dials only while its switch is on, the
 * companion opens the door only while the leader's heartbeat says the switch is on (or its own
 * switch is).
 *
 *   GET /host-listen        WebSocket upgrade on the companion; the host's /bridge machine token
 *                           (the `bridge-<alias>` record its leader minted on the companion, read
 *                           from the per-Walnut bridge.json of the runtime the host's service runs)
 *                           as `Authorization: Bearer`, never in the URL
 *   host -> companion hello    {ch:'door', op:'hello', v:1, role:'listener', walnutId, hostAlias}
 *   companion -> host welcome  {ch:'door', op:'welcome', role:'listener', walnutId}
 *                           no proof and no standing: the companion proves itself by TLS on its own
 *                           domain, as for /bridge (the host dials only the wss:// URL of its bridge
 *                           config, or ws:// to a loopback address), and it never leads
 *   then the session channel (channel.ts) on the same socket: the host's hello, the companion's
 *   `listen` (the host takes no other channel frame on this link: no resume, ack or resync), and
 *   the host's rows, facts and flow
 *   companion -> host call     {ch:'door', op:'call', id, method, path, body}: only LISTENER_CALLS
 *   host -> companion reply    {ch:'door', op:'reply', id, status, body}
 *
 * The leader's own door (door-wire.ts, host-door.ts) is another module with its own handshake;
 * nothing here reaches it.
 */
import { HOST_SESSIONS_PATH } from './host-api.js'

export const HOST_LISTEN_PATH = '/host-listen'

export type ListenerFrame =
  | { ch: 'door'; op: 'hello'; v: 1; role: 'listener'; walnutId: string; hostAlias: string }
  | { ch: 'door'; op: 'welcome'; role: 'listener'; walnutId: string }
  | { ch: 'door'; op: 'call'; id: string; method: string; path: string; body: unknown }
  | { ch: 'door'; op: 'reply'; id: string; status: number; body: unknown }

export function isListenerFrame(v: unknown): v is ListenerFrame {
  const f = v as { ch?: unknown; op?: unknown } | null
  return !!f && typeof f === 'object' && f.ch === 'door' && typeof f.op === 'string'
}

/** Close codes of the listener door (4000s, as the bridge's and the leader door's). */
export const LISTEN_CLOSE = { mismatch: 4001, revoked: 4003, replaced: 4000, shut: 4004 } as const

/** A loopback host name or address (plain ws:// is allowed only there: the token is a bearer). */
function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * The listener door of the companion whose /bridge URL is `bridgeUrl` (its bridge config), or
 * null when that URL is not one a host may send its token to: wss://, or ws:// to a loopback
 * address only, with no credentials in it.
 */
export function listenerUrlOf(bridgeUrl: unknown): string | null {
  if (typeof bridgeUrl !== 'string' || bridgeUrl.length === 0 || bridgeUrl.length > 2048) return null
  let u: URL
  try { u = new URL(bridgeUrl) } catch { return null }
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && loopbackHost(u.hostname))) return null
  if (u.username || u.password) return null
  return `${u.protocol}//${u.host}${HOST_LISTEN_PATH}`
}

/**
 * The host routes a companion's call frame may reach, a fixed list: what a person does to a session
 * from the phone while the Mac is away (the task's brief: the phone sees AND operates a dev box's
 * session through the companion). A send, an interrupt, the answer to a permission prompt, a Stop
 * (`terminateSession`) and a permission mode change (`changeSessionModeOf`, under the same mode rule
 * the companion's route applies to every mode change: sessions/delegated-mode.ts modeChangeRefusal).
 * Each call reaches the companion only from a person's paired device (the phone API's own auth: a
 * machine credential is no API credential there), and the host's route table checks the session is
 * its own. Never a start (a start's bundle is the leader's to make), a drop, any other call member,
 * or the credential and doors routes.
 */
export const LISTENER_CALLS: Readonly<Record<string, readonly string[] | null>> = {
  [`${HOST_SESSIONS_PATH}/send`]: null,
  [`${HOST_SESSIONS_PATH}/interrupt`]: null,
  [`${HOST_SESSIONS_PATH}/call`]: ['resolvePermissionRequest', 'terminateSession', 'changeSessionModeOf'],
}

/** Why a companion's call is refused (null: it may go to the host's routes). */
export function listenerCallRefusal(method: unknown, path: unknown, body: unknown): string | null {
  if (method !== 'POST' || typeof path !== 'string' || !Object.hasOwn(LISTENER_CALLS, path)) return 'not_callable'
  const members = LISTENER_CALLS[path]
  if (members === null) return null
  const member = (body as { member?: unknown } | null)?.member
  return typeof member === 'string' && members.includes(member) ? null : 'not_callable'
}
