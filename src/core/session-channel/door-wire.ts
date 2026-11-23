/**
 * The wire of the door a host dials into its leader (host-door.ts on the leader, host-dialer.ts on
 * the host), one file both sides build against. Everything here is behind the experiment
 * `host_runs_sessions` (switch.ts).
 *
 * No reusable secret ever crosses the wire: the host and the leader share a key S (the leader's
 * record, the host's credential file), and each proves it holds S with an HMAC over both sides'
 * fresh nonces. A fake door learns nothing it can use at the real one, on any transport.
 *
 *   GET /host-door          WebSocket upgrade carrying no secret; refused 429 while the address is
 *                           rate limited, 503 when the door cannot check right now
 *   host -> door  hello     {ch:'door', op:'hello', v:2, walnutId, machineId, nonce}       (nonceH)
 *   door -> host  welcome   {ch:'door', op:'welcome', walnutId, holder, permitNumber, epoch, nonce, proofs}
 *                           nonce = nonceD; proofs = [{keyId, proof}] for the record's current S and
 *                           its previous S within its grace; keyId = the first 8 hex of sha256(S)
 *                           (the host picks the one of its own key); proof = leaderDoorProof(S, ...);
 *                           `holder` is informational (the host checks the pair, never who holds it)
 *   host -> door  auth      {ch:'door', op:'auth', keyId, proof}  proof = hostDoorProof(S, ...)
 *   door: closes DOOR_CLOSE.unknown when it keeps no credential for the machine (or its host is no
 *         longer configured), DOOR_CLOSE.mismatch on a wrong Walnut, machine or proof. Until the auth
 *         passed nothing but the hello and the auth is taken from the socket, and nothing but the
 *         welcome is sent to it. Then:
 *   door -> host  doors     {ch:'door', op:'doors', doors}  (the leader's session.host_door_urls, kept
 *                           under the standing rule, host-credential-file.ts updateHostCredentialDoors)
 *   then the session channel's own frames (channel.ts) on the same socket, and:
 *   door -> host  call      {ch:'door', op:'call', id, method, path, body}  (door-calls.ts: only
 *                           an allowed prefix; the credential and doors routes never)
 *   host -> door  reply     {ch:'door', op:'reply', id, status, body}
 *
 *   POST /host-api/credential (over the leader's authenticated daemon link only, host-routes.ts):
 *     {walnutId, machineId, verifyKey, doors, permitNumber, epoch}  -> {ok:true}
 *     {check:true, walnutId, machineId}  -> {ok:true, holds: false} | {ok:true, holds:true, keyId, doors, issuedAt}
 *   POST /host-api/doors (the same link): {walnutId, machineId, doors, permitNumber, epoch} -> {ok:true, updated}
 */
import crypto from 'node:crypto'

export const HOST_DOOR_PATH = '/host-door'
/** Capability a host's service names when it keeps a door credential and dials its leader's door. */
export const HOST_DOOR_CAP = 'host-door-v1'
export const HOST_CREDENTIAL_PATH = '/host-api/credential'
export const HOST_DOORS_PATH = '/host-api/doors'
/** A verify key and a nonce: 32 random bytes, hex. */
export const DOOR_SECRET_RE = /^[0-9a-f]{64}$/
export const DOOR_KEY_ID_RE = /^[0-9a-f]{8}$/

export interface DoorKeyProof { keyId: string; proof: string }

export type DoorFrame =
  | { ch: 'door'; op: 'hello'; v: 2; walnutId: string; machineId: string; nonce: string }
  | { ch: 'door'; op: 'welcome'; walnutId: string; holder: string; permitNumber: number; epoch: number; nonce: string; proofs: DoorKeyProof[] }
  | { ch: 'door'; op: 'auth'; keyId: string; proof: string }
  | { ch: 'door'; op: 'doors'; doors: string[] }
  | { ch: 'door'; op: 'call'; id: string; method: string; path: string; body: unknown }
  | { ch: 'door'; op: 'reply'; id: string; status: number; body: unknown }

export function isDoorFrame(v: unknown): v is DoorFrame {
  const f = v as { ch?: unknown; op?: unknown } | null
  return !!f && typeof f === 'object' && f.ch === 'door' && typeof f.op === 'string'
}

/**
 * Close codes of the door (4000s, as the bridge's). `unknown` is the only one that tells a host its
 * credential is not this door's (host-dialer.ts then tries that door again only slowly).
 */
export const DOOR_CLOSE = { replaced: 4000, mismatch: 4001, revoked: 4003, unknown: 4004, overflow: 4009 } as const

/** The id of a verify key a proof names: the first 8 hex of sha256(S). Not secret. */
export function doorKeyId(keyHex: string): string {
  return crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex').slice(0, 8)
}

interface LeaderProofFields { nonceH: string; nonceD: string; walnutId: string; machineId: string; permitNumber: number; epoch: number }
interface HostProofFields { nonceH: string; nonceD: string; walnutId: string; machineId: string }

/** The text the leader's proof is the HMAC of: every field the host checks, one per line (all newline free). */
export function leaderDoorProofText(f: LeaderProofFields): string {
  return ['walnut-host-door-v2', 'leader', f.nonceH, f.nonceD, f.walnutId, f.machineId, String(f.permitNumber), String(f.epoch)].join('\n')
}

/** The text the host's proof is the HMAC of (its own domain tag and the nonces the other way round). */
export function hostDoorProofText(f: HostProofFields): string {
  return ['walnut-host-door-v2', 'host', f.nonceD, f.nonceH, f.walnutId, f.machineId].join('\n')
}

const hmac = (keyHex: string, text: string): string => crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest('hex')

export const leaderDoorProof = (keyHex: string, f: LeaderProofFields): string => hmac(keyHex, leaderDoorProofText(f))
export const hostDoorProof = (keyHex: string, f: HostProofFields): string => hmac(keyHex, hostDoorProofText(f))

/** Does `given` equal `expected` (both 32-byte hex)? Constant time. */
export function proofsEqual(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !DOOR_SECRET_RE.test(given)) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
}

/** A fresh door secret (a verify key, a nonce): 32 random bytes, hex. */
export function doorSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** A loopback host name or address: the only place a door may be plain ws:// (an ssh tunnel). */
export function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Why `raw` is not a door URL a host may dial, or null when it is: wss://, or ws:// to loopback only, path /host-door, no credentials or query. */
export function doorUrlRefusal(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return 'not a URL'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return 'not ws:// or wss://'
  if (u.protocol === 'ws:' && !loopbackHost(u.hostname)) return 'ws:// only to a loopback address (an ssh tunnel); every other door is wss://'
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
