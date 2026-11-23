/**
 * What a witness on another machine is asked and answers (witness-route.ts serves it over a
 * leader link, witness-door.ts over its direct door; the network transport in witness-transport.ts
 * and witness-direct.ts sends it). One request is one POST with a JSON body (two on the direct door:
 * its challenge, then the request); a request may be lost, repeated, or answered late: the permit
 * core (permit/client.ts, witness.ts, rules.ts) is built for that.
 */
import { MAX_CLOCK_MARK_LENGTH, type PermitRecord, type PermitReply, type PermitRequest } from '../permit/types.js'
import { PROOF_SECRET_RE, proofText } from '../../../utils/hmac-proof.js'

/** Every path of the witness route starts with this (`allowDoorCallPrefix` takes it for a host-dialed door). */
export const WITNESS_PREFIX = '/host-api/witness/'
/** Ask a witness: the body is a WitnessCall, the answer a WitnessAnswer. */
export const WITNESS_REQUEST_PATH = `${WITNESS_PREFIX}request`
/** Set a witness up, once, with the first list: the body is a WitnessSetup. Never part of a permit round. */
export const WITNESS_SETUP_PATH = `${WITNESS_PREFIX}setup`

/** Ids and the Walnut's id become directory names on the witness machine: plain names only. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export function isWitnessName(v: unknown): v is string {
  return typeof v === 'string' && NAME_RE.test(v) && !v.includes('..')
}

export interface WitnessCall {
  v: 1
  /** The Walnut this permit belongs to (the machine answers only its own). */
  walnutId: string
  /** The witness asked: the machine holds a record for this id or does not answer. */
  witness: string
  request: PermitRequest
  /**
   * A read carries a round number, chosen by the sender per read, and its answer echoes it: a reply to an
   * older read of the same witness (late over a slow link) is then no answer to the latest one. A propose
   * has none (its reply names the record's number).
   */
  round?: number
}

/**
 * What the caller saw at one other witness of the list before it asked for a setup (witness-route.ts
 * refuses a setup without it): 'absent' reached, and it answered that no witness is there (404, or no
 * record on this machine), 'unreached' no answer at all (a timeout, a cut, no way to it: it may hold a
 * record), 'blank' it answered that it holds no record and is at generation 0, 'record' it holds one.
 * A setup is allowed only when every other witness is 'absent' or 'blank'.
 */
export type WitnessSeen = 'absent' | 'unreached' | 'blank' | 'record'
/**
 * The one answer that is evidence `absent`: a 404 with this code, sent by a witness's route or door only
 * after it looked at its own directory and found neither a record nor a key. Every other 404 (a path the
 * service does not have, a capability off, a record with no key) and every other non-200 is `unreached`.
 */
export const NO_WITNESS_HERE_CODE = 'no_witness_here'
const SEEN: ReadonlySet<string> = new Set<WitnessSeen>(['absent', 'unreached', 'blank', 'record'])
export interface WitnessEvidence { witness: string; seen: WitnessSeen }

export interface WitnessSetup {
  v: 1
  walnutId: string
  witness: string
  /** The fixed witness list (all ids). */
  list: string[]
  /** One entry per OTHER witness of the list: a setup makes a witness from nothing, so it is allowed only while none holds a record. */
  evidence: WitnessEvidence[]
  /** The witness's own key (64 hex), minted by `walnut leader witnesses init`: what its direct door checks. */
  key?: string
  /**
   * Set up as a JOINING witness from this generation (permit/store.ts prepareJoiningWitness): it takes nothing
   * until a list change from that generation or later names it, so it is safe beside records. Only the leader
   * sends one, with the generation it read from the witnesses (generationToJoin), then adds it by a list change.
   */
  join?: number
}

export type WitnessAnswer =
  | { ok: true; reply: PermitReply; round?: number }
  | { ok: true; made: boolean }
  | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max
const isName = (v: unknown): v is string => isStr(v, 128) && v.length > 0
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(isName)
const MAX_ENTRIES = 100_000

const RECORD_KEYS = new Set(['number', 'kind', 'holder', 'by', 'nonce', 'from', 'to', 'validMs', 'list', 'cfg', 'epoch', 'joint', 'newList', 'stage', 'progress', 'ops', 'ledger', 'pairBy', 'clock'])
const KINDS = new Set(['grant', 'renew', 'handover', 'cancel', 'members', 'release'])
const OP_STATES = new Set(['registered', 'sent', 'not-sent'])

function isIdList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_ENTRIES && v.every((x) => isStr(x))
}

/**
 * The whole shape of a PermitRecord, field by field (permit/types.ts). A record this route stores is one a
 * majority may later count as the permission, so a body that is not exactly one is refused whole, unknown
 * fields included (a witness never stores what the sender did not mean to send).
 */
export function isPermitRecord(v: unknown): v is PermitRecord {
  if (!isObj(v)) return false
  for (const k of Object.keys(v)) if (!RECORD_KEYS.has(k)) return false
  if (!isInt(v.number) || !isStr(v.kind) || !KINDS.has(v.kind)) return false
  if (!isStr(v.holder, 128) || !isName(v.by) || !isName(v.nonce) || !isInt(v.epoch)) return false
  if (typeof v.validMs !== 'number' || !Number.isFinite(v.validMs) || v.validMs <= 0 || v.validMs > 86_400_000) return false
  if (!isNameList(v.list) || !isName(v.cfg)) return false
  for (const k of ['from', 'to'] as const) if (v[k] !== undefined && !isStr(v[k], 128)) return false
  for (const k of ['joint', 'newList'] as const) if (v[k] !== undefined && !isNameList(v[k])) return false
  if (v.stage !== undefined && v.stage !== 'joint' && v.stage !== 'final') return false
  if (v.pairBy !== undefined && !isNameList(v.pairBy)) return false
  if (v.clock !== undefined && !isStr(v.clock, MAX_CLOCK_MARK_LENGTH)) return false
  if (v.progress !== undefined) {
    const p = v.progress
    if (!isObj(p) || !isInt(p.seq) || typeof p.writtenAt !== 'number' || !Number.isFinite(p.writtenAt)) return false
    if (p.by !== undefined && !isStr(p.by, 128)) return false
    if (Object.keys(p).some((k) => k !== 'seq' && k !== 'writtenAt' && k !== 'by')) return false
  }
  if (v.ops !== undefined) {
    const o = v.ops
    if (!isObj(o) || Object.keys(o).some((k) => k !== 'register' && k !== 'sent' && k !== 'notSent')) return false
    for (const k of ['register', 'sent', 'notSent'] as const) if (o[k] !== undefined && !isIdList(o[k])) return false
  }
  if (v.ledger !== undefined) {
    if (!Array.isArray(v.ledger) || v.ledger.length > MAX_ENTRIES) return false
    for (const e of v.ledger) {
      if (!isObj(e) || !isStr(e.id) || !isStr(e.state) || !OP_STATES.has(e.state) || !isStr(e.by, 128) || !isStr(e.nonce, 128)) return false
      if (Object.keys(e).some((k) => k !== 'id' && k !== 'state' && k !== 'by' && k !== 'nonce')) return false
    }
  }
  return true
}

/** The request body of a witness call, or null when it is not one. */
export function parseWitnessCall(raw: unknown): WitnessCall | null {
  if (!isObj(raw) || raw.v !== 1 || !isWitnessName(raw.walnutId) || !isWitnessName(raw.witness) || !isObj(raw.request)) return null
  const r = raw.request
  const base = { v: 1 as const, walnutId: raw.walnutId, witness: raw.witness }
  if (r.type === 'read') {
    if (raw.round !== undefined && !isInt(raw.round)) return null
    return { ...base, request: { type: 'read' }, ...(raw.round !== undefined ? { round: raw.round as number } : {}) }
  }
  if (r.type === 'propose' && isPermitRecord(r.record)) return { ...base, request: { type: 'propose', record: r.record } }
  return null
}

export function parseWitnessSetup(raw: unknown): WitnessSetup | null {
  if (!isObj(raw) || raw.v !== 1 || !isWitnessName(raw.walnutId) || !isWitnessName(raw.witness)) return null
  if (!Array.isArray(raw.list) || raw.list.length < 3 || !raw.list.every(isWitnessName) || !raw.list.includes(raw.witness)) return null
  if (!Array.isArray(raw.evidence) || raw.evidence.length > raw.list.length) return null
  const evidence: WitnessEvidence[] = []
  for (const e of raw.evidence) {
    if (!isObj(e) || !isWitnessName(e.witness) || typeof e.seen !== 'string' || !SEEN.has(e.seen)) return null
    evidence.push({ witness: e.witness, seen: e.seen as WitnessSeen })
  }
  if (raw.key !== undefined && !(typeof raw.key === 'string' && PROOF_SECRET_RE.test(raw.key))) return null
  if (raw.join !== undefined && !isInt(raw.join)) return null
  return { v: 1, walnutId: raw.walnutId, witness: raw.witness, list: raw.list as string[], evidence, ...(typeof raw.key === 'string' ? { key: raw.key } : {}), ...(raw.join !== undefined ? { join: raw.join as number } : {}) }
}

/**
 * Whether a setup's evidence allows making the witness: it names every OTHER witness of the list exactly
 * once, and each was reached and holds nothing ('absent' or 'blank'). One not reached may hold a record, so it
 * refuses too. A witness that lost its disk while the others still hold records is therefore never made
 * again as a fresh one (permit/store.ts: it rejoins through a list change).
 */
export function setupAllowed(setup: WitnessSetup): { ok: true } | { ok: false; error: string } {
  const others = setup.list.filter((w) => w !== setup.witness)
  const named = setup.evidence.map((e) => e.witness)
  if (new Set(named).size !== named.length || named.length !== others.length || !others.every((w) => named.includes(w))) return { ok: false, error: 'evidence_incomplete' }
  // A joining witness takes nothing until a list change names it: safe whatever the others hold.
  if (setup.join !== undefined) return { ok: true }
  if (setup.evidence.some((e) => e.seen === 'record')) return { ok: false, error: 'witnesses_hold_records' }
  if (setup.evidence.some((e) => e.seen !== 'absent' && e.seen !== 'blank')) return { ok: false, error: 'witnesses_unreached' }
  return { ok: true }
}

/** The number a reply answers: the record's, or 'read'. */
export function requestRe(req: PermitRequest): number | 'read' {
  return req.type === 'propose' ? req.record.number : 'read'
}

/**
 * The reply inside an answer, only when it is what was asked: from the witness asked (a
 * machine reached by a wrong alias, or one that answers for another witness, is no witness of
 * ours) and to the request sent (a reply to another record is no answer to this one). Anything
 * else is no answer at all.
 */
export function acceptReply(body: unknown, asked: string, req: PermitRequest, round?: number): PermitReply | null {
  if (!isObj(body) || body.ok !== true || !isObj(body.reply)) return null
  // A read is answered for the round it carried; an answer that echoes another round is a late one.
  if (round !== undefined && body.round !== round) return null
  const r = body.reply
  if (r.witness !== asked || r.re !== requestRe(req) || typeof r.ok !== 'boolean') return null
  if (r.held !== null && (!isObj(r.held) || !Number.isSafeInteger(r.held.number))) return null
  if (typeof r.grantable !== 'boolean') return null
  for (const k of ['list', 'joint', 'ops'] as const) if (r[k] !== null && !Array.isArray(r[k])) return null
  return r as unknown as PermitReply
}

// ---- the direct door (witness-door.ts) ----------------------------------------------------
//
// A witness's own door on a service others can reach (the capability `witness-door`: the companion,
// a host's service, the leader server or its handed-over standby), independent of any leader link. The caller proves the witness's key; the
// witness proves the same key over its reply. Two POSTs per request:
//
//   POST <url>/challenge  {v:1, walnutId, witness, digest, cnonce}   digest = sha256(call text), cnonce = the caller's own nonce
//                         -> {ok:true, nonce, ttlMs}                  a nonce for THIS call only, used once (the door
//                                                                     keeps nothing: it is its expiry and the door's HMAC)
//   POST <url>/request    {v:1, nonce, cnonce, proof, call}           call = the WitnessCall's JSON text,
//                                                                     proof = HMAC(key, doorCallerProofText)
//                         -> {ok:true, reply, proof}                  reply = the PermitReply's JSON text,
//                                                                     proof = HMAC(key, doorWitnessProofText)
// Every refusal is 4xx {ok:false, error} with a fixed code and nothing else: never a key, a proof or
// the record. A refused request never reaches the record (its number is never lowered or raised).

/** The direct door's mount path on a service; a witness's `url` names where it is reached (this path behind a proxy). */
export const WITNESS_DOOR_PATH = '/leader-witness'
export const WITNESS_DOOR_CHALLENGE = '/challenge'
export const WITNESS_DOOR_REQUEST = '/request'
/** The largest call text the door takes (a list change carries every op entry). */
export const WITNESS_DOOR_MAX_CALL = 4 * 1024 * 1024

/** `cnonce`: the caller's own fresh nonce, in both proofs, so no recorded reply passes for a new one. */
export interface DoorChallenge { v: 1; walnutId: string; witness: string; digest: string; cnonce: string }
export interface DoorRequest { v: 1; nonce: string; cnonce: string; proof: string; call: string }
/** A door's nonce: 12 hex of its expiry on the door's clock, then 64 hex of the door's HMAC over the call it is for. */
export const DOOR_NONCE_RE = /^[0-9a-f]{76}$/
export type DoorAnswer =
  | { ok: true; nonce: string; ttlMs: number }
  | { ok: true; reply: string; proof: string }
  | { ok: false; error: string }

export function parseDoorChallenge(raw: unknown): DoorChallenge | null {
  if (!isObj(raw) || raw.v !== 1 || !isWitnessName(raw.walnutId) || !isWitnessName(raw.witness)) return null
  if (typeof raw.digest !== 'string' || !PROOF_SECRET_RE.test(raw.digest)) return null
  if (typeof raw.cnonce !== 'string' || !PROOF_SECRET_RE.test(raw.cnonce)) return null
  return { v: 1, walnutId: raw.walnutId, witness: raw.witness, digest: raw.digest, cnonce: raw.cnonce }
}

export function parseDoorRequest(raw: unknown): DoorRequest | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.nonce !== 'string' || !DOOR_NONCE_RE.test(raw.nonce)) return null
  if (typeof raw.cnonce !== 'string' || !PROOF_SECRET_RE.test(raw.cnonce)) return null
  if (typeof raw.proof !== 'string' || !PROOF_SECRET_RE.test(raw.proof)) return null
  if (typeof raw.call !== 'string' || raw.call.length === 0 || raw.call.length > WITNESS_DOOR_MAX_CALL) return null
  return { v: 1, nonce: raw.nonce, cnonce: raw.cnonce, proof: raw.proof, call: raw.call }
}

interface DoorProofFields { walnutId: string; witness: string; nonce: string; cnonce: string; digest: string }

/** What the caller's proof is the HMAC of: the witness asked, the nonce it issued, the caller's nonce, the call's digest. */
export function doorCallerProofText(f: DoorProofFields): string {
  return proofText(['walnut-witness-door-v1', 'caller', f.walnutId, f.witness, f.nonce, f.cnonce, f.digest])
}

/** What the witness's proof of its reply is the HMAC of: the same, and the reply's digest (its own tag). */
export function doorWitnessProofText(f: DoorProofFields & { replyDigest: string }): string {
  return proofText(['walnut-witness-door-v1', 'witness', f.walnutId, f.witness, f.nonce, f.cnonce, f.digest, f.replyDigest])
}
