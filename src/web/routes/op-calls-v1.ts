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
 *
 * A task_send held as a note that asks nothing (`delivery: "held"`) also says where that note
 * stands now, `held_note: { message_id, state, at?, why?, row?, sender_told? }`
 * (core/sessions/held-notices.ts): waiting to ride its target's next message, delivered (it rode
 * one), dropped (and why), or unknown (this server holds no record of it: held over 7 days ago, or
 * by an older version). `sender_told`: whether its sender was told it still waits or was dropped
 * (when, or why not yet: that notice still waits for the sender, or no live session took it).
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

type HeldNote = Awaited<ReturnType<typeof import('../../core/sessions/held-notices.js').heldNoteState>>

/** The first answer that held a note (`delivery: "held"` with its message id), read for where it stands now. */
async function heldNoteOf(answers: unknown[]): Promise<HeldNote | null> {
  for (const a of answers) {
    const b = a && typeof a === 'object' ? a as { delivery?: unknown; messageId?: unknown } : null
    if (b?.delivery !== 'held' || typeof b.messageId !== 'string') continue
    const { heldNoteState } = await import('../../core/sessions/held-notices.js')
    return heldNoteState(b.messageId)
  }
  return null
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
    const ledgerWrites = writesOfCall(WALNUT_HOME, id)
    const bodies = ledgerWrites.map((w) => (w.entry ? bodyOf(w.entry.body, w.entry.contentType) : undefined))
    const writes = ledgerWrites.map((w, i) => ({
      route: w.entry?.route,
      state: w.state,
      opId: w.opId,
      ...(w.entry ? {
        status: w.entry.status,
        outcome: w.entry.outcome,
        at: new Date(w.entry.appliedAt).toISOString(),
        ...(answers && w.entry.body !== undefined ? { answer: bodies[i] } : {}),
      } : {}),
    }))
    const writeRunning = writes.some((w) => w.state === 'running')
    // Where a held note stands now, read from the answer that held it (the call's own, else its
    // write's); another reader sees only its state, not where it went.
    const heldNote = await heldNoteOf([call?.outcome?.ok ? call.outcome.result : undefined, ...bodies])
    const shown = heldNote && !answers ? { message_id: heldNote.message_id, state: heldNote.state, ...(heldNote.at ? { at: heldNote.at } : {}) } : heldNote
    const note = shown ? { held_note: shown } : {}
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
        ...note,
      })
      return
    }
    res.json({ call_id: id, state: writeRunning ? 'running' : writes.length ? 'applied' : 'unknown', writes, ...note })
  } catch (err) {
    next(err)
  }
})
