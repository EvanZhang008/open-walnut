/**
 * Commit / push / open a PR for one session's changes (the Changed tab).
 *
 *   GET  /api/sessions/:sessionId/commit/plan            repos, files and hunks, attributed
 *   POST /api/sessions/:sessionId/commit/jobs            { action: commit|push|pr, ... } -> the job, at once
 *   GET  /api/sessions/:sessionId/commit/jobs            this session's recent jobs
 *   GET  /api/sessions/:sessionId/commit/jobs/:jobId     one job (from memory, never the daemon)
 *   POST /api/sessions/:sessionId/commit/suggest         { diff, files } -> { message }
 *
 * Thin edges over src/core/session-commit.ts; the git work runs in the session
 * host's daemon. Every route answers within a deadline (a host not connected yet
 * is dialled for at most 20s), and a commit's hooks run in a job whose progress
 * rides the `git-commit:job` WS event.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { SessionControlError } from '../../core/sessions/session-controls.js'
import {
  SessionCommitError,
  getSessionCommitJob,
  getSessionCommitPlan,
  listSessionCommitJobs,
  startSessionCommitJob,
  suggestSessionCommitMessage,
} from '../../core/session-commit.js'

export const sessionCommitRouter = Router()

const PLAN_DEADLINE_MS = 95_000
const START_DEADLINE_MS = 15_000
const SUGGEST_DEADLINE_MS = 75_000

class RouteDeadline extends Error {}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  work.catch(() => { /* answered by the deadline */ })
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RouteDeadline()), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof SessionCommitError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof SessionControlError) {
    res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
    return
  }
  if (err instanceof RouteDeadline) {
    res.status(504).json({ error: 'The host took too long to answer. Try again.', code: 'timeout' })
    return
  }
  next(err)
}

sessionCommitRouter.get('/:sessionId/commit/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // A host that is not connected yet is dialled with its own cap (session-commit.ts).
    res.json(await within(PLAN_DEADLINE_MS, getSessionCommitPlan(String(req.params.sessionId))))
  } catch (err) {
    sendError(res, err, next)
  }
})

sessionCommitRouter.post('/:sessionId/commit/jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    res.status(202).json({ job: await within(START_DEADLINE_MS, startSessionCommitJob(String(req.params.sessionId), body)) })
  } catch (err) {
    sendError(res, err, next)
  }
})

sessionCommitRouter.get('/:sessionId/commit/jobs', (req: Request, res: Response) => {
  res.json({ jobs: listSessionCommitJobs(String(req.params.sessionId)) })
})

sessionCommitRouter.get('/:sessionId/commit/jobs/:jobId', (req: Request, res: Response) => {
  const job = getSessionCommitJob(String(req.params.sessionId), String(req.params.jobId))
  if (!job) { res.status(404).json({ error: 'Job not found', code: 'not-found' }); return }
  res.json({ job })
})

sessionCommitRouter.post('/:sessionId/commit/suggest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    res.json(await within(SUGGEST_DEADLINE_MS, suggestSessionCommitMessage(String(req.params.sessionId), body)))
  } catch (err) {
    sendError(res, err, next)
  }
})
