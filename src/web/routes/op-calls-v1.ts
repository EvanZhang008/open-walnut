/**
 * GET /api/v1/op-calls/:id: what one op call did, by the id its caller's client chose
 * (src/lib/op-call-id.ts). The read behind `op_result`, for a caller whose answer did
 * not come back (`hub_timeout`, its own timeout).
 *
 *   { call_id, state, op?, started_at?, ended_at?, ok?, message?, result?, repeats?, writes[] }
 *
 * `state`:
 *   running  the call runs now (in this server), or one of its writes has not answered yet;
 *   done     it ended; `ok` and `result` (or `message`) are the answer it would have given;
 *   lost     its own write to this server's API got no answer; `writes` says what applied,
 *            and a re-run with the same id applies nothing twice;
 *   applied  this server no longer holds the call (a restart, a day later) but holds its
 *            writes, each with its answer;
 *   unknown  nothing of it here: it never reached this server, or it only read, or it ran
 *            more than the ledger keeps. Nothing it would write was applied here.
 *
 * The answer (`result`, `message`, each write's `answer`) goes only to the session that made
 * the call; another reader sees where it stands. An answer holding a secret, or too large, was
 * never kept (`not_kept`): a re-run under the same id gets it again through the route's checks.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { WALNUT_HOME } from '../../constants.js'
import { isCallId } from '../../lib/op-call-id.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const opCallsV1Router = Router()

/** A stored answer body, parsed when it is JSON. */
function bodyOf(body: string | undefined, contentType: string | undefined): unknown {
  if (body === undefined) return undefined
  if (contentType?.includes('json') || /^[[{]/.test(body.trim())) {
    try { return JSON.parse(body) } catch { /* not JSON after all */ }
  }
  return body
}

opCallsV1Router.get('/op-calls/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    if (!isCallId(id)) {
      sendError(res, 400, 'bad_request', 'Invalid call id (oc-…, as a Walnut client printed it)')
      return
    }
    const [{ opCallOf, answerLost }, { writesOfCall }] = await Promise.all([
      import('../../ops/op-calls.js'), import('../../core/offline-merge/ledger.js'),
    ])
    const call = opCallOf(id)
    // The answer goes only to the session that made the call (when it was one): an id seen
    // in another session's output reads where the call stands, never what it answered.
    const raw = req.headers['x-walnut-caller-sid']
    const reader = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
    const answers = !call?.callerSid || call.callerSid === reader
    const writes = writesOfCall(WALNUT_HOME, id).map((w) => ({
      route: w.entry?.route,
      state: w.state,
      opId: w.opId,
      ...(w.entry ? {
        status: w.entry.status,
        outcome: w.entry.outcome,
        at: new Date(w.entry.appliedAt).toISOString(),
        ...(answers && w.entry.body !== undefined ? { answer: bodyOf(w.entry.body, w.entry.contentType) } : {}),
      } : {}),
    }))
    const writeRunning = writes.some((w) => w.state === 'running')
    if (call) {
      const o = call.outcome
      const state = writeRunning || call.endedAt === undefined ? 'running' : o && answerLost(o) ? 'lost' : 'done'
      res.json({
        call_id: id,
        state,
        op: call.op,
        started_at: new Date(call.startedAt).toISOString(),
        ...(call.endedAt !== undefined ? { ended_at: new Date(call.endedAt).toISOString() } : {}),
        ...(o ? { ok: o.ok } : {}),
        ...(answers && o && o.ok ? { result: o.result } : {}),
        ...(answers && o && !o.ok ? { message: o.message, ...(o.result !== undefined ? { result: o.result } : {}) } : {}),
        ...(call.notKept ? { not_kept: call.notKept } : {}),
        ...(answers ? {} : { answer_withheld: 'the answer goes only to the session that made the call' }),
        repeats: call.repeats,
        writes,
      })
      return
    }
    res.json({ call_id: id, state: writeRunning ? 'running' : writes.length ? 'applied' : 'unknown', writes })
  } catch (err) {
    next(err)
  }
})
