/**
 * What a witness on another machine is asked and answers (witness-route.ts serves it, the
 * network transport in witness-transport.ts sends it). One request is one POST with a JSON body;
 * nothing here is stateful, so a request may be lost, repeated, or answered late: the permit core
 * (permit/client.ts, witness.ts, rules.ts) is built for that.
 */
import { MAX_CLOCK_MARK_LENGTH, type PermitRecord, type PermitReply, type PermitRequest } from '../permit/types.js'

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
 * refuses a setup without it): 'none' no answer (not set up, or not reached), 'blank' it answered that it
 * holds no record and is at generation 0, 'record' it holds one (the setup is then refused).
 */
export type WitnessSeen = 'none' | 'blank' | 'record'
export interface WitnessEvidence { witness: string; seen: WitnessSeen }

export interface WitnessSetup {
  v: 1
  walnutId: string
  witness: string
  /** The fixed witness list (all ids). */
  list: string[]
  /** One entry per OTHER witness of the list: a setup makes a witness from nothing, so it is allowed only while none holds a record. */
  evidence: WitnessEvidence[]
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
    if (!isObj(e) || !isWitnessName(e.witness) || (e.seen !== 'none' && e.seen !== 'blank' && e.seen !== 'record')) return null
    evidence.push({ witness: e.witness, seen: e.seen })
  }
  return { v: 1, walnutId: raw.walnutId, witness: raw.witness, list: raw.list as string[], evidence }
}

/**
 * Whether a setup's evidence allows making the witness: it names every OTHER witness of the list exactly
 * once and none of them was seen holding a record. A witness that lost its disk while the others still hold
 * records is therefore never made again as a fresh one (permit/store.ts: it rejoins through a list change).
 */
export function setupAllowed(setup: WitnessSetup): { ok: true } | { ok: false; error: string } {
  const others = setup.list.filter((w) => w !== setup.witness)
  const named = setup.evidence.map((e) => e.witness)
  if (new Set(named).size !== named.length || named.length !== others.length || !others.every((w) => named.includes(w))) return { ok: false, error: 'evidence_incomplete' }
  if (setup.evidence.some((e) => e.seen === 'record')) return { ok: false, error: 'witnesses_hold_records' }
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
