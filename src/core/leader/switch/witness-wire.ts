/**
 * What a witness on another machine is asked and answers (witness-route.ts serves it, the
 * network transport in witness-transport.ts sends it). One request is one POST with a JSON body;
 * nothing here is stateful, so a request may be lost, repeated, or answered late: the permit core
 * (permit/client.ts, witness.ts, rules.ts) is built for that.
 */
import type { PermitReply, PermitRequest } from '../permit/types.js'

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
}

export interface WitnessSetup {
  v: 1
  walnutId: string
  witness: string
  /** The fixed witness list (all ids). */
  list: string[]
}

export type WitnessAnswer =
  | { ok: true; reply: PermitReply }
  | { ok: true; made: boolean }
  | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** The request body of a witness call, or null when it is not one. */
export function parseWitnessCall(raw: unknown): WitnessCall | null {
  if (!isObj(raw) || raw.v !== 1 || !isWitnessName(raw.walnutId) || !isWitnessName(raw.witness) || !isObj(raw.request)) return null
  const r = raw.request
  if (r.type === 'read') return { v: 1, walnutId: raw.walnutId, witness: raw.witness, request: { type: 'read' } }
  if (r.type === 'propose' && isObj(r.record) && Number.isSafeInteger(r.record.number) && typeof r.record.kind === 'string') {
    return { v: 1, walnutId: raw.walnutId, witness: raw.witness, request: r as unknown as PermitRequest }
  }
  return null
}

export function parseWitnessSetup(raw: unknown): WitnessSetup | null {
  if (!isObj(raw) || raw.v !== 1 || !isWitnessName(raw.walnutId) || !isWitnessName(raw.witness)) return null
  if (!Array.isArray(raw.list) || raw.list.length < 3 || !raw.list.every(isWitnessName) || !raw.list.includes(raw.witness)) return null
  return { v: 1, walnutId: raw.walnutId, witness: raw.witness, list: raw.list as string[] }
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
export function acceptReply(body: unknown, asked: string, req: PermitRequest): PermitReply | null {
  if (!isObj(body) || body.ok !== true || !isObj(body.reply)) return null
  const r = body.reply
  if (r.witness !== asked || r.re !== requestRe(req) || typeof r.ok !== 'boolean') return null
  if (r.held !== null && (!isObj(r.held) || !Number.isSafeInteger(r.held.number))) return null
  if (typeof r.grantable !== 'boolean') return null
  for (const k of ['list', 'joint', 'ops'] as const) if (r[k] !== null && !Array.isArray(r[k])) return null
  return r as unknown as PermitReply
}
