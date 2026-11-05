/**
 * What each op call did, by the call id its caller chose (src/lib/op-call-id.ts).
 *
 * A write op's call runs at most once per id in this process: a second copy while the
 * first still runs waits for the first's answer, and one after it gets that answer
 * again. A call whose own self-call lost its answer (timed out, connection dropped, a body
 * cut short), or was answered with a status a retry may change (5xx, 408, 429), is not
 * kept: its retry runs again, and every write it makes then meets the applied-ops ledger
 * under the same op id (executor.ts writeOpId), which answers the first write's answer
 * instead of applying it twice. `op_result` reads a call here
 * (src/web/routes/op-calls-v1.ts), then in that ledger.
 *
 * An answer holding a secret (a vault item's fields, a token) is never kept, and a copy from
 * another session under the same id is refused: a replay must never hand a secret past the
 * checks its route makes on every call.
 *
 * In memory: a restart forgets the calls, never their writes, which the ledger keeps.
 */
import { createHash } from 'node:crypto'
import type { OpOutcome } from './executor.js'
import { ANSWER_SECRET_KEYS } from '../lib/secret-keys.js'

/** How long a finished call is kept for a retry or a read. */
export const OP_CALL_TTL_MS = 24 * 60 * 60 * 1000
/** Calls kept at most; the oldest finished ones go first. */
const MAX_CALLS = 5000
/** Bytes of answers kept at most, and the largest one kept: a bigger answer is not held for a copy. */
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ANSWER_BYTES = 256 * 1024

export interface OpCallRecord {
  callId: string
  op: string
  argsHash: string
  callerSid?: string
  startedAt: number
  endedAt?: number
  /** The answer kept for a copy and for op_result; absent while it runs, or when it was not kept. */
  outcome?: OpOutcome
  /** Why the answer was not kept (too large, it holds a secret). */
  notKept?: string
  /** How many copies of the call arrived after the first. */
  repeats: number
  /** A copy runs the call again: its answer was lost or may change (the ledger answers what applied). */
  rerun?: true
}

/** `done` is the running call's promise; once it settled, only `record.outcome` is held. */
interface Entry { record: OpCallRecord; done?: Promise<OpOutcome>; bytes: number }

const calls = new Map<string, Entry>()
let heldBytes = 0

function drop(id: string, e: Entry): void {
  if (calls.get(id) === e) calls.delete(id)
  heldBytes -= e.bytes
  e.bytes = 0
}

/**
 * A stable hash of the call's arguments (key order ignored), so another call under a reused id
 * is caught. A message id is left out: a host daemon fills one in on the way (from the call id
 * when it has one, offline-host-core.ts), so it names the delivery, not the call.
 */
export function argsHashOf(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  const { messageId: _delivery, ...rest } = args
  return createHash('sha256').update(JSON.stringify(canon(rest)) ?? '').digest('hex').slice(0, 16)
}

function prune(now: number): void {
  for (const [id, e] of calls) {
    if (e.record.endedAt !== undefined && now - e.record.endedAt > OP_CALL_TTL_MS) drop(id, e)
  }
  if (calls.size <= MAX_CALLS && heldBytes <= MAX_BYTES) return
  // Oldest first: a Map iterates in insertion order.
  for (const [id, e] of calls) {
    if (calls.size <= MAX_CALLS && heldBytes <= MAX_BYTES) break
    if (e.record.endedAt !== undefined) drop(id, e)
  }
}

/** A self-call that got no answer at all (executor.ts rawRequest): the write may have applied. */
export function answerLost(outcome: OpOutcome): boolean {
  return !outcome.ok && (outcome.unreachable === true || outcome.lost === true)
}

/**
 * An outcome a copy of the call must not be handed again: no answer came, or one of its
 * self-calls was answered with a status a retry may change (5xx, 408, 429, the applied-ops
 * ledger's rule too), also when its handler went on and answered ok.
 */
export function runsAgain(outcome: OpOutcome): boolean {
  return answerLost(outcome) || outcome.retry === true
}

function refused(message: string): OpOutcome {
  return { ok: false, message: `Refused, nothing ran: ${message}` }
}

/**
 * Run `run` once for `callId`. A copy with the same op and arguments while it runs, or
 * after it settled, gets its answer; one under the same id with another op, other
 * arguments or from another session is refused and runs nothing.
 */
export async function runOnce(
  callId: string,
  op: string,
  args: Record<string, unknown>,
  callerSid: string | undefined,
  run: () => Promise<OpOutcome>,
  now: () => number = Date.now,
): Promise<OpOutcome> {
  const at = now()
  prune(at)
  const argsHash = argsHashOf(args)
  const seen = calls.get(callId)
  if (seen && (seen.record.op !== op || seen.record.argsHash !== argsHash)) {
    return refused(`call id ${callId} was already used for ${seen.record.op === op ? 'this op with other arguments' : seen.record.op}. `
      + 'A call id names ONE call: send a new call without "_call_id", or the same arguments to re-run that call.')
  }
  if (seen && seen.record.callerSid && callerSid && seen.record.callerSid !== callerSid) {
    return refused(`call id ${callId} belongs to another session's call; send your own call without "_call_id".`)
  }
  if (seen && !seen.record.rerun) {
    seen.record.repeats += 1
    if (seen.done) return seen.done
    if (seen.record.outcome) return seen.record.outcome
  }
  const record: OpCallRecord = {
    callId, op, argsHash, ...(callerSid ? { callerSid } : {}), startedAt: at, repeats: seen ? seen.record.repeats + 1 : 0,
  }
  let settle!: (o: OpOutcome) => void
  const done = new Promise<OpOutcome>((resolve) => { settle = resolve })
  if (seen) drop(callId, seen)
  const entry: Entry = { record, done, bytes: 0 }
  calls.set(callId, entry)
  let outcome: OpOutcome
  try {
    outcome = await run()
  } catch (err) {
    outcome = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  record.endedAt = now()
  let text = ''
  try { text = JSON.stringify(outcome) ?? '' } catch { text = '' }
  const bytes = Buffer.byteLength(text)
  // Lost on the way, or refused for now: the next copy runs again, and the ledger answers any
  // write that applied. Too big or a secret: not held, so a copy runs again too, and meets the
  // route's own checks.
  const notKept = !text || bytes > MAX_ANSWER_BYTES ? `the answer (${bytes} bytes) was too large to keep`
    : ANSWER_SECRET_KEYS.test(text) ? 'the answer holds a secret, which is never kept' : ''
  if (notKept) record.notKept = notKept
  else {
    record.outcome = outcome
    entry.bytes = bytes
    heldBytes += bytes
  }
  if (notKept || runsAgain(outcome)) record.rerun = true
  // Copies waiting now get the full answer; later ones read only what is held.
  entry.done = undefined
  settle(outcome)
  return outcome
}

/** The call kept under `callId`, or null. */
export function opCallOf(callId: string, now = Date.now()): OpCallRecord | null {
  const e = calls.get(callId)
  if (!e) return null
  if (e.record.endedAt !== undefined && now - e.record.endedAt > OP_CALL_TTL_MS) return null
  return e.record
}

export function _resetOpCallsForTesting(): void {
  calls.clear()
  heldBytes = 0
}

/** Tests only: the bytes of answers held. */
export function _heldBytesForTesting(): number {
  return heldBytes
}
