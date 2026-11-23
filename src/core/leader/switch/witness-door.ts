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
 * before the record is read, so no refusal ever changes the witness's number.
 *
 * Callback style on purpose: the model check (tests/core/leader/permit/sim.ts) runs this door on its
 * simulated clock and network, synchronously, as it runs the rest of the transport.
 */
import { hmacProof, proofSecret, proofsEqual, sha256Hex } from '../../../utils/hmac-proof.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams, type PermitReply, type PermitRequest } from '../permit/types.js'
import { serveLocalWitness } from './local-witnesses.js'
import { readWitnessKey, witnessDir } from './witness-route.js'
import {
  doorCallerProofText, doorWitnessProofText, parseDoorChallenge, parseDoorRequest, parseWitnessCall, type DoorAnswer,
} from './witness-wire.js'

/** How long a nonce is good for: a call's two posts are a round trip apart, far under this. */
export const NONCE_TTL_MS = 10_000
/** Nonces open at once (all witnesses of the door): a flood of challenges pushes out the oldest, never grows memory. */
export const MAX_OPEN_NONCES = 1024

export interface DoorResponse { status: number; body: DoorAnswer }

export interface WitnessDoorDeps {
  /** The key of witness `witness` of Walnut `walnutId` kept here, or null when none is (no such witness here, or one set up without a key). */
  keyOf(walnutId: string, witness: string): string | null
  /** Serve one permit request at that witness: its reply, null when it does not answer (its record gone), 'busy' when it cannot now. */
  serve(walnutId: string, witness: string, req: PermitRequest, done: (reply: PermitReply | null | 'busy') => void): void
  /** Milliseconds on a clock that only goes forward (default performance.now). */
  now?(): number
  nonceTtlMs?: number
  maxNonces?: number
  /** A refusal, by its code only (never a key, a proof or a body): for logs and the address limiter. */
  onRefuse?(code: string): void
}

export interface WitnessDoor {
  challenge(body: unknown): DoorResponse
  request(body: unknown, done: (r: DoorResponse) => void): void
  /** Nonces open now (tests). */
  openNonces(): number
}

interface Issued { walnutId: string; witness: string; digest: string; until: number }

const refusal = (status: number, error: string): DoorResponse => ({ status, body: { ok: false, error } })
/** A witness this door does not keep: the same answer as no witness at all. */
const NOT_A_WITNESS = refusal(404, 'not_a_witness')

export function createWitnessDoor(deps: WitnessDoorDeps): WitnessDoor {
  const now = deps.now ?? (() => performance.now())
  const ttl = deps.nonceTtlMs ?? NONCE_TTL_MS
  const max = deps.maxNonces ?? MAX_OPEN_NONCES
  const issued = new Map<string, Issued>()
  const refuse = (status: number, code: string): DoorResponse => { deps.onRefuse?.(code); return refusal(status, code) }

  const sweep = (t: number): void => {
    for (const [n, i] of issued) { if (i.until > t) break; issued.delete(n) }
    while (issued.size >= max) issued.delete(issued.keys().next().value as string)
  }

  return {
    challenge(body) {
      const c = parseDoorChallenge(body)
      if (!c) return refuse(400, 'bad_request')
      // A nonce only for a witness kept here with a key: a door with none set up (or its capability on
      // and no key configured) refuses every caller, as a door that has no such witness.
      if (!deps.keyOf(c.walnutId, c.witness)) { deps.onRefuse?.('not_a_witness'); return NOT_A_WITNESS }
      const t = now()
      sweep(t)
      const nonce = proofSecret()
      issued.set(nonce, { walnutId: c.walnutId, witness: c.witness, digest: c.digest, until: t + ttl })
      return { status: 200, body: { ok: true, nonce, ttlMs: ttl } }
    },

    request(body, done) {
      const r = parseDoorRequest(body)
      if (!r) return done(refuse(400, 'bad_request'))
      const n = issued.get(r.nonce)
      // Used once, whatever happens next: a replay, or a second guess at a proof, finds it gone.
      issued.delete(r.nonce)
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
      const fields = { walnutId: n.walnutId, witness: n.witness, nonce: r.nonce, digest }
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
export function machineWitnessDoor(o: { root: string; params?: PermitParams; onRefuse?: (code: string) => void; log?: (level: 'warn', msg: string, data?: Record<string, unknown>) => void; now?: () => number; nonceTtlMs?: number }): WitnessDoor {
  const params = o.params ?? DEFAULT_PERMIT_PARAMS
  return createWitnessDoor({
    keyOf: (walnutId, witness) => readWitnessKey(witnessDir(o.root, walnutId, witness)),
    serve: (walnutId, witness, req, done) => {
      serveLocalWitness({ id: witness, dir: witnessDir(o.root, walnutId, witness) }, req, params).then(done, (err: unknown) => {
        o.log?.('warn', 'witness door: a request could not be served', { witness, error: err instanceof Error ? err.message : String(err) })
        done('busy')
      })
    },
    ...(o.onRefuse ? { onRefuse: o.onRefuse } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.nonceTtlMs !== undefined ? { nonceTtlMs: o.nonceTtlMs } : {}),
  })
}

/** `door.request` as a promise (an HTTP route's handler). */
export function doorRequest(door: WitnessDoor, body: unknown): Promise<DoorResponse> {
  return new Promise((resolve) => door.request(body, resolve))
}
