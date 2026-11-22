/**
 * The wire of the door a host dials into its leader (host-door.ts on the leader, host-dialer.ts on
 * the host), one file both sides build against. Everything here is behind the experiment
 * `host_runs_sessions` (switch.ts).
 *
 *   GET /host-door          WebSocket upgrade; the host's door token as `Authorization: Bearer` or a
 *                           `walnut.bearer.` subprotocol entry, never in the URL
 *   host -> door  hello     {ch:'door', op:'hello', v:1, walnutId, machineId, nonce}
 *   door -> host  welcome   {ch:'door', op:'welcome', walnutId, holder, permitNumber, epoch, doors, proof}
 *                           proof = HMAC-SHA256(S, doorProofText(...)), S the verify key that
 *                           belongs to the token the host used (its previous one for the previous);
 *                           `holder` is informational (the host checks the pair, not who holds it);
 *                           `doors` the leader's session.host_door_urls now (the host keeps it
 *                           under the standing rule, host-credential-file.ts updateHostCredentialDoors)
 *   then the session channel's own frames (channel.ts) on the same socket, and:
 *   door -> host  call      {ch:'door', op:'call', id, method, path, body}  (door-calls.ts: only
 *                           an allowed prefix; the credential and doors routes never)
 *   host -> door  reply     {ch:'door', op:'reply', id, status, body}
 *   door -> host  doors     {ch:'door', op:'doors', doors}  (pushHostDoors; under the socket's welcome pair)
 *
 *   POST /host-api/credential (over the leader's authenticated daemon link only, host-routes.ts):
 *     {walnutId, machineId, token, verifyKey, doors, permitNumber, epoch}  -> {ok:true}
 *     {check:true, walnutId, machineId}  -> {ok:true, holds: false} | {ok:true, holds:true, tokenHash, doors, issuedAt}
 *   POST /host-api/doors (the same link): {walnutId, machineId, doors, permitNumber, epoch} -> {ok:true, updated}
 */
import crypto from 'node:crypto'

export const HOST_DOOR_PATH = '/host-door'
/** Capability a host's service names when it keeps a door credential and dials its leader's door. */
export const HOST_DOOR_CAP = 'host-door-v1'
export const HOST_CREDENTIAL_PATH = '/host-api/credential'
export const HOST_DOORS_PATH = '/host-api/doors'
/** A door token and a verify key: 32 random bytes, hex. */
export const DOOR_SECRET_RE = /^[0-9a-f]{64}$/

export type DoorFrame =
  | { ch: 'door'; op: 'hello'; v: 1; walnutId: string; machineId: string; nonce: string }
  | { ch: 'door'; op: 'welcome'; walnutId: string; holder: string; permitNumber: number; epoch: number; doors?: string[]; proof: string }
  | { ch: 'door'; op: 'doors'; doors: string[] }
  | { ch: 'door'; op: 'call'; id: string; method: string; path: string; body: unknown }
  | { ch: 'door'; op: 'reply'; id: string; status: number; body: unknown }

export function isDoorFrame(v: unknown): v is DoorFrame {
  const f = v as { ch?: unknown; op?: unknown } | null
  return !!f && typeof f === 'object' && f.ch === 'door' && typeof f.op === 'string'
}

/** Close codes of the door (4000s, as the bridge's). */
export const DOOR_CLOSE = { mismatch: 4001, revoked: 4003, replaced: 4000 } as const

/** The text the leader's proof is the HMAC of: every field the host checks, one per line. */
export function doorProofText(f: { nonce: string; walnutId: string; machineId: string; permitNumber: number; epoch: number }): string {
  return ['walnut-host-door-v1', f.nonce, f.walnutId, f.machineId, String(f.permitNumber), String(f.epoch)].join('\n')
}

/** HMAC-SHA256 hex of the proof text under the verify key `keyHex`. */
export function doorProof(keyHex: string, f: Parameters<typeof doorProofText>[0]): string {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(doorProofText(f), 'utf8').digest('hex')
}

/** Does `given` equal the proof `keyHex` makes for these fields? Constant time. */
export function doorProofMatches(keyHex: string, f: Parameters<typeof doorProofText>[0], given: unknown): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false
  return crypto.timingSafeEqual(Buffer.from(doorProof(keyHex, f), 'hex'), Buffer.from(given, 'hex'))
}

/** A fresh door secret (a token, a verify key, a nonce): 32 random bytes, hex. */
export function doorSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** A loopback or private-network host name or address (the token is a bearer: plain ws:// only there). */
export function privateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  // fc00::/7 unique local, fe80::/10 link local.
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)
}

/** Why `raw` is not a door URL a host may dial, or null when it is: wss://, or ws:// to a private address, path /host-door, no credentials or query. */
export function doorUrlRefusal(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return 'not a URL'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return 'not ws:// or wss://'
  if (u.protocol === 'ws:' && !privateHost(u.hostname)) return 'ws:// only to a loopback or private-network address (the token is a bearer)'
  if (u.username || u.password) return 'a door URL carries no credentials'
  if (u.search || u.hash) return 'a door URL carries no query'
  if (u.pathname !== HOST_DOOR_PATH) return `the path is not ${HOST_DOOR_PATH}`
  return null
}

/** The door URLs a leader hands its hosts (config `session.host_door_urls`): the ones a host may dial, in order, at most 8. */
export function cleanDoorUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const u of raw) if (doorUrlRefusal(u) === null && !out.includes(u as string)) out.push(u as string)
  return out.slice(0, 8)
}
