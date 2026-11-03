/**
 * One file between two hosts for a task's session (core/hosts/host-copy.ts), under
 * the grant host_exec uses (core/hosts/exec-grants.ts). Additive to v1.
 *
 *   POST /api/v1/host-copy            { from, to, from_host?, to_host?, copy_id?, allow_prompts? } → the copy, or { running, copyId }
 *   GET  /api/v1/host-copy/:copyId?wait_ms= → that copy's answer
 *
 * The caller is the session in `x-walnut-caller-sid`; only the leader runs copies
 * (it holds the links and the grants).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'

export const hostCopyV1Router = Router()

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = Array.isArray(raw) ? raw[0] : raw
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined
}

function leaderOnly(res: Response): boolean {
  if (!isFollower()) return false
  res.status(404).json({ error: 'Copies between hosts run through the Mac', code: 'leader_only' })
  return true
}

/**
 * The copy's answer, or its refusal with its code and the copy's id. The work runs under the
 * caller's deadline when its self-call carries one (src/lib/answer-by.ts: a session on another
 * host, whose gateway gives up at 20 s), so a hold lets go in time for the answer to get back.
 */
async function answer(req: Request, res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  const [{ HostExecError }, { ANSWER_BY_HEADER, parseAnswerBy, withAnswerBy }] = await Promise.all([
    import('../../core/hosts/host-exec.js'), import('../../lib/answer-by.js'),
  ])
  try {
    res.json(await withAnswerBy(parseAnswerBy(req.headers[ANSWER_BY_HEADER]), work))
  } catch (err) {
    if (err instanceof HostExecError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.data })
      return
    }
    next(err)
  }
}

hostCopyV1Router.post('/host-copy', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(req, res, next, async () => (await import('../../core/hosts/host-copy.js')).copyBetweenHosts({
    from: b.from, to: b.to, from_host: b.from_host, to_host: b.to_host, copy_id: b.copy_id, allow_prompts: b.allow_prompts,
  }, callerSid(req)))
})

hostCopyV1Router.get('/host-copy/:copyId', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const raw = req.query.wait_ms
  const wait = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : undefined
  const id = Array.isArray(req.params.copyId) ? String(req.params.copyId[0] ?? '') : String(req.params.copyId ?? '')
  void answer(req, res, next, async () => (await import('../../core/hosts/host-copy.js')).copyResult({
    copy_id: id, ...(wait !== undefined && Number.isFinite(wait) ? { wait_ms: wait } : {}),
  }, callerSid(req)))
})
