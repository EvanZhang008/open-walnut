/**
 * POST /tasks/start-check { mode } → 200 { allowed, mode, caller, reason? } (task_start_check):
 * whether the caller may start a task in `mode` right now, under the one start-mode ceiling every
 * start applies (core/sessions/delegated-mode.ts). It reads the caller with the start route's own
 * reader (core/sessions/start-request-caller.ts) and creates no task, starts no session and writes
 * nothing. Allowed and refused both answer 200, so a job's periodic check is never a failed call;
 * only a malformed mode is a 400.
 *
 * A POST so the op's self-call carries what a start's does (the caller sid, the vouched job's
 * credential, the unproven mark). A host's own server answers it while the Mac is away with its
 * own reading of the caller (replica/start-ceiling.ts awayStartCheck, mounted before this route).
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { START_CHECK_BAD_MODE, startCallerOf, startCheckAnswer, startCheckMode } from '../../core/sessions/delegated-mode.js'
import { sendV1Error } from './v1-control-relay.js'

export const taskStartCheckV1Router = Router()

taskStartCheckV1Router.post('/tasks/start-check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = startCheckMode(req.body)
    if (!mode) { sendV1Error(res, 400, 'bad_request', START_CHECK_BAD_MODE); return }
    const { startRequestCaller } = await import('../../core/sessions/start-request-caller.js')
    const trust = startRequestCaller(req)
    const caller = await startCallerOf(trust.callerSid, { job: trust.callerJob, unproven: trust.callerUnproven })
    res.json(startCheckAnswer(caller, mode, { unproven: trust.callerUnproven }))
  } catch (err) {
    next(err)
  }
})
