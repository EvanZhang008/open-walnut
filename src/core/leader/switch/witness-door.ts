/**
 * A witness's direct door (docs/reference/leader-switch.md, "How a witness is reached", way b): a
 * witness kept by this machine answered on a service anyone may reach, with no leader link under
 * it. A server opens it as the capability `witness-door` (capabilities/witness-door.ts): the
 * companion, a host's service, the leader server and the handed-over standby that replaces it
 * (web/routes/witness-door.ts, handed-over.ts), all with this module. The wire is in witness-wire.ts.
 *
 * Who may ask: only a caller that proves the witness's OWN key (minted at its setup, kept beside its
 * record and in the leader data's leader_switch config, nowhere else), by challenge-response:
 *   1. the caller asks for a nonce for one call (the call's sha256 and its own nonce); the door keeps
 *      nothing: the nonce is its expiry and the door's HMAC (a secret of this door) over the call;
 *   2. the caller sends the call with HMAC(key, caller text: Walnut, witness, nonce, its nonce, call digest);
 *   3. the witness answers with HMAC(key, witness text: the same and the reply's digest), so a door
 *      that does not hold the key cannot pass for the witness either.
 * A nonce is remembered as used only once a proof over it held, so a caller without the key fills no
 * state at all. A replayed request finds its nonce used, a request with another's nonce, another
 * Walnut's or a forged one no nonce of this door, a late one an expired nonce, a wrong key no proof
 * that holds: each is refused before the record is read, so no refusal ever changes the witness's
 * number. The caller's own nonce is in both proofs, so a recorded reply never passes for the answer
 * to a new call.
 *
 * Callback style on purpose: the model check (tests/core/leader/permit/sim.ts) runs this door on its
 * simulated clock and network, synchronously, as it runs the rest of the transport.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hmacProof, proofSecret, proofText, proofsEqual, sha256Hex } from '../../../utils/hmac-proof.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams, type PermitReply, type PermitRequest } from '../permit/types.js'
import { serveLocalWitness, witnessDirEmpty } from './local-witnesses.js'
import { readWitnessKey, witnessDir } from './witness-route.js'
import {
  NO_WITNESS_HERE_CODE, WITNESS_DOOR_CHALLENGE, WITNESS_DOOR_MAX_CALL, WITNESS_DOOR_REQUEST, doorCallerProofText, doorWitnessProofText, parseDoorChallenge, parseDoorRequest, parseWitnessCall, type DoorAnswer,
} from './witness-wire.js'

/** How long a nonce is good for: a call's two posts are a round trip apart, far under this. */
export const NONCE_TTL_MS = 10_000
/**
 * Nonces taken (a request whose proof held) and not expired yet, remembered so each is used once. Only a
 * caller that holds the witness's key can add one, so this cap is reached only by a key holder's flood;
 * past it a request is refused (429), never an entry dropped (a dropped one could be replayed).
 */
export const MAX_USED_NONCES = 4096
/**
 * Challenges one caller may ask for in one NONCE_TTL_MS window (the address, an IPv6 address by its /64): a
 * brake on the HMAC work one place can cause. A challenge holds no state, so no flood of them takes another
 * caller's nonce; one permit client asks for at most a few dozen a window (renews, reads, retransmits).
 */
export const MAX_CHALLENGES_PER_CALLER = 256
/** Callers whose window is counted at once; past it a new caller is not counted (never refused for it). */
export const MAX_COUNTED_CALLERS = 4096

export interface DoorResponse { status: number; body: DoorAnswer }

export interface WitnessDoorDeps {
  /** The key of witness `witness` of Walnut `walnutId` kept here, or null when none is (no such witness here, or one set up without a key). */
  keyOf(walnutId: string, witness: string): string | null
  /**
   * Whether this machine holds nothing of that witness (no record, no key: local-witnesses.ts witnessDirEmpty). Only
   * then does the door answer NO_WITNESS_HERE_CODE, the one 404 a setup's evidence counts as `absent`. Default: never.
   */
  holdsNothing?(walnutId: string, witness: string): boolean
  /** Serve one permit request at that witness: its reply, null when it does not answer (its record gone), 'busy' when it cannot now. */
  serve(walnutId: string, witness: string, req: PermitRequest, done: (reply: PermitReply | null | 'busy') => void): void
  /** Milliseconds on a clock that only goes forward (default performance.now). */
  now?(): number
  nonceTtlMs?: number
  maxUsed?: number
  maxPerCaller?: number
  /** The door's own secret the nonces are made with (64 hex; default random per door: a restart voids every open nonce). */
  secret?: string
  /** A refusal, by its code only (never a key, a proof or a body): for logs. A challenge past a limit is not one (no log flood). */
  onRefuse?(code: string): void
}

export interface WitnessDoor {
  /** `from`: who asks (the caller's address), for the per-caller brake. */
  challenge(body: unknown, from?: string): DoorResponse
  request(body: unknown, done: (r: DoorResponse) => void): void
  /** Nonces remembered as used now (tests). */
  usedNonces(): number
}

const refusal = (status: number, error: string): DoorResponse => ({ status, body: { ok: false, error } })
/** A witness this door does not keep with a key: the same answer as a door that keeps none (never evidence `absent`). */
const NOT_A_WITNESS = refusal(404, 'not_a_witness')
const TOO_MANY = refusal(429, 'too_many_challenges')

/**
 * The key a caller is counted by: its address, an IPv6 one by its /64 (one host gets a whole /64), an
 * IPv4-mapped IPv6 one as the IPv4 address.
 */
export function callerKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (!a.includes(':')) return a
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return mapped[1]!
  const [head, tail] = a.includes('::') ? a.split('::', 2) as [string, string] : [a, null]
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = tail === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** A nonce is its expiry on the door's clock (12 hex) and this, the door's HMAC over the call it is for (64 hex). */
const nonceMac = (secret: string, f: { walnutId: string; witness: string; digest: string; cnonce: string }, exp: string): string =>
  hmacProof(secret, proofText(['walnut-witness-door-nonce-v1', f.walnutId, f.witness, f.digest, f.cnonce, exp]))

export function createWitnessDoor(deps: WitnessDoorDeps): WitnessDoor {
  const now = deps.now ?? (() => performance.now())
  const ttl = deps.nonceTtlMs ?? NONCE_TTL_MS
  const maxUsed = deps.maxUsed ?? MAX_USED_NONCES
  const perCaller = deps.maxPerCaller ?? MAX_CHALLENGES_PER_CALLER
  const secret = deps.secret ?? proofSecret()
  /** Used nonces and their expiry, in the order taken (one ttl: the expired ones are first). */
  const used = new Map<string, number>()
  /** Challenges per caller in its current window. */
  const counted = new Map<string, { n: number; until: number }>()
  const refuse = (status: number, code: string): DoorResponse => { deps.onRefuse?.(code); return refusal(status, code) }

  const sweepUsed = (t: number): void => { for (const [n, until] of used) { if (until > t) break; used.delete(n) } }
  /** False when `from` asked for more than its share this window. */
  const brake = (from: string, t: number): boolean => {
    const k = callerKey(from)
    const c = counted.get(k)
    if (c && c.until > t) { c.n++; return c.n <= perCaller }
    if (c) counted.delete(k)
    if (counted.size >= MAX_COUNTED_CALLERS) for (const [key, x] of counted) { if (x.until > t) break; counted.delete(key) }
    if (counted.size < MAX_COUNTED_CALLERS) counted.set(k, { n: 1, until: t + ttl })
    return true
  }

  return {
    challenge(body, from = 'unknown') {
      const c = parseDoorChallenge(body)
      if (!c) return refuse(400, 'bad_request')
      // A nonce only for a witness kept here with a key: a door with none set up (or its capability on
      // and no key configured) refuses every caller. Only a directory that holds nothing says so.
      if (!deps.keyOf(c.walnutId, c.witness)) {
        if (deps.holdsNothing?.(c.walnutId, c.witness)) { deps.onRefuse?.(NO_WITNESS_HERE_CODE); return refusal(404, NO_WITNESS_HERE_CODE) }
        deps.onRefuse?.('not_a_witness')
        return NOT_A_WITNESS
      }
      const t = now()
      if (!brake(from, t)) return TOO_MANY
      // Nothing is kept: the nonce carries its expiry and the door's HMAC over the call it is for.
      const exp = Math.max(0, Math.ceil(t + ttl)).toString(16).padStart(12, '0')
      return { status: 200, body: { ok: true, nonce: exp + nonceMac(secret, c, exp), ttlMs: ttl } }
    },

    request(body, done) {
      const r = parseDoorRequest(body)
      if (!r) return done(refuse(400, 'bad_request'))
      let parsed: unknown
      try { parsed = JSON.parse(r.call) } catch { return done(refuse(400, 'bad_request')) }
      const call = parseWitnessCall(parsed)
      if (!call) return done(refuse(400, 'bad_request'))
      const digest = sha256Hex(r.call)
      const exp = r.nonce.slice(0, 12)
      // A nonce this door made for exactly this call (Walnut, witness, digest, caller's nonce): else no nonce of it.
      if (!proofsEqual(nonceMac(secret, { walnutId: call.walnutId, witness: call.witness, digest, cnonce: r.cnonce }, exp), r.nonce.slice(12))) return done(refuse(403, 'unknown_nonce'))
      const t = now()
      if (t >= Number.parseInt(exp, 16)) return done(refuse(403, 'expired_nonce'))
      const key = deps.keyOf(call.walnutId, call.witness)
      if (!key) { deps.onRefuse?.('not_a_witness'); return done(NOT_A_WITNESS) }
      const fields = { walnutId: call.walnutId, witness: call.witness, nonce: r.nonce, cnonce: r.cnonce, digest }
      if (!proofsEqual(hmacProof(key, doorCallerProofText(fields)), r.proof)) return done(refuse(403, 'bad_proof'))
      // Remembered only now, once the proof held: a caller without the key fills nothing.
      sweepUsed(t)
      if (used.has(r.nonce)) return done(refuse(403, 'unknown_nonce'))
      if (used.size >= maxUsed) return done(refuse(429, 'too_many_requests'))
      used.set(r.nonce, Number.parseInt(exp, 16))
      deps.serve(call.walnutId, call.witness, call.request, (reply) => {
        if (reply === 'busy') return done(refusal(503, 'busy'))
        if (!reply) return done(NOT_A_WITNESS)
        const text = JSON.stringify(reply)
        done({ status: 200, body: { ok: true, reply: text, proof: hmacProof(key, doorWitnessProofText({ ...fields, replyDigest: sha256Hex(text) })) } })
      })
    },

    usedNonces: () => used.size,
  }
}

/**
 * The door over this machine's witness records (machine-id.ts witnessRoot): the key beside each
 * record (witness-route.ts readWitnessKey), the record served by the one code every way uses
 * (local-witnesses.ts serveLocalWitness, under its lock).
 */
export function machineWitnessDoor(o: { root: string; params?: PermitParams; onRefuse?: (code: string) => void; log?: (level: 'warn', msg: string, data?: Record<string, unknown>) => void; now?: () => number; nonceTtlMs?: number; limits?: Pick<WitnessDoorDeps, 'maxUsed' | 'maxPerCaller'> }): WitnessDoor {
  const params = o.params ?? DEFAULT_PERMIT_PARAMS
  return createWitnessDoor({
    keyOf: (walnutId, witness) => readWitnessKey(witnessDir(o.root, walnutId, witness)),
    holdsNothing: (walnutId, witness) => witnessDirEmpty(witnessDir(o.root, walnutId, witness)),
    serve: (walnutId, witness, req, done) => {
      serveLocalWitness({ id: witness, dir: witnessDir(o.root, walnutId, witness) }, req, params).then(done, (err: unknown) => {
        o.log?.('warn', 'witness door: a request could not be served', { witness, error: err instanceof Error ? err.message : String(err) })
        done('busy')
      })
    },
    ...(o.onRefuse ? { onRefuse: o.onRefuse } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.nonceTtlMs !== undefined ? { nonceTtlMs: o.nonceTtlMs } : {}),
    ...o.limits,
  })
}

/** `door.request` as a promise (an HTTP route's handler). */
export function doorRequest(door: WitnessDoor, body: unknown): Promise<DoorResponse> {
  return new Promise((resolve) => door.request(body, resolve))
}

/** The largest body each door path takes: a challenge is a few hundred bytes, a request one call text (JSON-escaped). */
const BODY_LIMIT = { [WITNESS_DOOR_CHALLENGE]: 64 * 1024, [WITNESS_DOOR_REQUEST]: 2 * WITNESS_DOOR_MAX_CALL + 64 * 1024 } as Record<string, number>

/**
 * One POST to the door read off a node request: `sub` is the path under the door's mount ('/challenge' or
 * '/request'), `from` the caller's address. Reads the body (capped), answers, and returns true; false (nothing
 * written) for any other method or path. Every server that opens the door answers through this one function
 * (web/routes/witness-door.ts, the handed-over standby in handed-over.ts).
 */
export function serveDoorHttp(door: WitnessDoor, sub: string, req: IncomingMessage, res: ServerResponse, from: string): boolean {
  const limit = BODY_LIMIT[sub]
  if (req.method !== 'POST' || limit === undefined) return false
  const send = (r: DoorResponse) => {
    if (res.headersSent) return
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(r.body))
  }
  const answer = (body: unknown) => {
    if (sub === WITNESS_DOOR_CHALLENGE) send(door.challenge(body, from))
    else door.request(body, send)
  }
  // A body an earlier parser already read (a server that parses every body first).
  const parsed = (req as IncomingMessage & { body?: unknown }).body
  if (req.readableEnded && parsed !== undefined) { answer(parsed); return true }
  const chunks: Buffer[] = []
  let size = 0
  let over = false
  req.on('data', (c: Buffer) => {
    if (over) return
    size += c.length
    if (size > limit) { over = true; send({ status: 413, body: { ok: false, error: 'too_large' } }); return }
    chunks.push(c)
  })
  req.on('end', () => {
    if (over) return
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { send({ status: 400, body: { ok: false, error: 'bad_request' } }); return }
    answer(body)
  })
  req.on('error', () => { if (!res.headersSent) res.destroy() })
  return true
}
