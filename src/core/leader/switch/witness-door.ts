/**
 * A witness's direct door (docs/reference/leader-switch.md, "How a witness is reached", way b): a
 * witness kept by this machine answered on a service anyone may reach, with no leader link under
 * it. The cloud companion opens it as its capability `witness-door` (capabilities/witness-door.ts,
 * web/routes/witness-door.ts); any other service others can reach opens it the same way, with this
 * module. The wire is in witness-wire.ts.
 *
 * Who may ask: only a caller that proves the witness's OWN key (minted at its setup, kept beside its
 * record and in the leader data's leader_switch config, nowhere else), by challenge-response:
 *   1. the caller asks for a nonce for one call (the call's sha256); the nonce is good for that call
 *      only, once, for NONCE_TTL_MS;
 *   2. the caller sends the call with HMAC(key, caller text: Walnut, witness, nonce, call digest);
 *   3. the witness answers with HMAC(key, witness text: the same and the reply's digest), so a door
 *      that does not hold the key cannot pass for the witness either.
 * A replayed request finds its nonce used, a request with another's nonce finds another digest, a
 * late one an expired nonce, a wrong key or a wrong Walnut no proof that holds: each is refused
 * before the record is read, so no refusal ever changes the witness's number. The caller's own nonce
 * is in both proofs, so a recorded reply never passes for the answer to a new call. Challenges are
 * limited per caller and per witness, so a flood never crowds out another caller's nonce.
 *
 * Callback style on purpose: the model check (tests/core/leader/permit/sim.ts) runs this door on its
 * simulated clock and network, synchronously, as it runs the rest of the transport.
 */
import { hmacProof, proofSecret, proofsEqual, sha256Hex } from '../../../utils/hmac-proof.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams, type PermitReply, type PermitRequest } from '../permit/types.js'
import { serveLocalWitness, witnessDirEmpty } from './local-witnesses.js'
import { readWitnessKey, witnessDir } from './witness-route.js'
import {
  NO_WITNESS_HERE_CODE, doorCallerProofText, doorWitnessProofText, parseDoorChallenge, parseDoorRequest, parseWitnessCall, type DoorAnswer,
} from './witness-wire.js'

/** How long a nonce is good for: a call's two posts are a round trip apart, far under this. */
export const NONCE_TTL_MS = 10_000
/** Nonces open at once (all witnesses of the door): past it a new challenge is refused (429), never an open one evicted. */
export const MAX_OPEN_NONCES = 1024
/**
 * Nonces one caller (its address) may hold open at once: a flood from one place never crowds out another caller.
 * Above what one permit client keeps open to one witness (witness-transport.ts: 4 reads and 16 proposals), with
 * room for a second process of the same machine (the switch command's probe).
 */
export const MAX_NONCES_PER_CALLER = 32
/** Nonces open at once for one witness of one Walnut: a flood for one never crowds out the others. */
export const MAX_NONCES_PER_WITNESS = 256

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
  maxNonces?: number
  maxPerCaller?: number
  maxPerWitness?: number
  /** A refusal, by its code only (never a key, a proof or a body): for logs. A refused challenge past a limit is not one (no log flood). */
  onRefuse?(code: string): void
}

export interface WitnessDoor {
  /** `from`: who asks (the caller's address), for the per-caller limit. */
  challenge(body: unknown, from?: string): DoorResponse
  request(body: unknown, done: (r: DoorResponse) => void): void
  /** Nonces open now (tests). */
  openNonces(): number
}

interface Issued { walnutId: string; witness: string; digest: string; cnonce: string; until: number; from: string }

const refusal = (status: number, error: string): DoorResponse => ({ status, body: { ok: false, error } })
/** A witness this door does not keep with a key: the same answer as a door that keeps none (never evidence `absent`). */
const NOT_A_WITNESS = refusal(404, 'not_a_witness')
const TOO_MANY = refusal(429, 'too_many_challenges')

export function createWitnessDoor(deps: WitnessDoorDeps): WitnessDoor {
  const now = deps.now ?? (() => performance.now())
  const ttl = deps.nonceTtlMs ?? NONCE_TTL_MS
  const max = deps.maxNonces ?? MAX_OPEN_NONCES
  const perCaller = deps.maxPerCaller ?? MAX_NONCES_PER_CALLER
  const perWitness = deps.maxPerWitness ?? MAX_NONCES_PER_WITNESS
  const issued = new Map<string, Issued>()
  const byCaller = new Map<string, number>()
  const byWitness = new Map<string, number>()
  const witnessKey = (i: { walnutId: string; witness: string }) => `${i.walnutId}\n${i.witness}`
  const bump = (m: Map<string, number>, k: string, by: number) => { const n = (m.get(k) ?? 0) + by; if (n > 0) m.set(k, n); else m.delete(k) }
  const take = (nonce: string): Issued | undefined => {
    const i = issued.get(nonce)
    if (!i) return undefined
    issued.delete(nonce)
    bump(byCaller, i.from, -1)
    bump(byWitness, witnessKey(i), -1)
    return i
  }
  const refuse = (status: number, code: string): DoorResponse => { deps.onRefuse?.(code); return refusal(status, code) }

  const sweep = (t: number): void => {
    // Issued in time order with one ttl: the expired ones are first.
    for (const [n, i] of issued) { if (i.until > t) break; take(n) }
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
      sweep(t)
      const wk = witnessKey(c)
      if (issued.size >= max || (byCaller.get(from) ?? 0) >= perCaller || (byWitness.get(wk) ?? 0) >= perWitness) return TOO_MANY
      const nonce = proofSecret()
      issued.set(nonce, { walnutId: c.walnutId, witness: c.witness, digest: c.digest, cnonce: c.cnonce, until: t + ttl, from })
      bump(byCaller, from, 1)
      bump(byWitness, wk, 1)
      return { status: 200, body: { ok: true, nonce, ttlMs: ttl } }
    },

    request(body, done) {
      const r = parseDoorRequest(body)
      if (!r) return done(refuse(400, 'bad_request'))
      // Used once, whatever happens next: a replay, or a second guess at a proof, finds it gone.
      const n = take(r.nonce)
      if (!n) return done(refuse(403, 'unknown_nonce'))
      if (now() >= n.until) return done(refuse(403, 'expired_nonce'))
      const digest = sha256Hex(r.call)
      if (digest !== n.digest) return done(refuse(403, 'nonce_for_another_request'))
      let parsed: unknown
      try { parsed = JSON.parse(r.call) } catch { return done(refuse(400, 'bad_request')) }
      const call = parseWitnessCall(parsed)
      if (!call) return done(refuse(400, 'bad_request'))
      if (call.walnutId !== n.walnutId || call.witness !== n.witness) return done(refuse(403, 'nonce_for_another_request'))
      const key = deps.keyOf(n.walnutId, n.witness)
      if (!key) { deps.onRefuse?.('not_a_witness'); return done(NOT_A_WITNESS) }
      const fields = { walnutId: n.walnutId, witness: n.witness, nonce: r.nonce, cnonce: n.cnonce, digest }
      if (!proofsEqual(hmacProof(key, doorCallerProofText(fields)), r.proof)) return done(refuse(403, 'bad_proof'))
      deps.serve(n.walnutId, n.witness, call.request, (reply) => {
        if (reply === 'busy') return done(refusal(503, 'busy'))
        if (!reply) return done(NOT_A_WITNESS)
        const text = JSON.stringify(reply)
        done({ status: 200, body: { ok: true, reply: text, proof: hmacProof(key, doorWitnessProofText({ ...fields, replyDigest: sha256Hex(text) })) } })
      })
    },

    openNonces: () => issued.size,
  }
}

/**
 * The door over this machine's witness records (machine-id.ts witnessRoot): the key beside each
 * record (witness-route.ts readWitnessKey), the record served by the one code every way uses
 * (local-witnesses.ts serveLocalWitness, under its lock).
 */
export function machineWitnessDoor(o: { root: string; params?: PermitParams; onRefuse?: (code: string) => void; log?: (level: 'warn', msg: string, data?: Record<string, unknown>) => void; now?: () => number; nonceTtlMs?: number; limits?: Pick<WitnessDoorDeps, 'maxNonces' | 'maxPerCaller' | 'maxPerWitness'> }): WitnessDoor {
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
