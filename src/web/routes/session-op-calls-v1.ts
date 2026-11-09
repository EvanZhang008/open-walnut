/**
 * /api/v1 Walnut's record of a session's own Walnut calls (core/sessions/op-call-log.ts):
 * what each send, thread update, Brief write or letter said, for the session's chat cards.
 *
 *   POST /sessions/op-calls { op, form, path?, ok, error?, fields }   (x-walnut-caller-sid)
 *        → { id, toolUseId? }   204 when not kept (an op no card covers, the companion)
 *   POST /sessions/:id/op-calls/lookup { tools: [toolUseId…] }
 *        → { calls: { [toolUseId]: OpCallEntry[] } }
 *
 * Only the caller's own session is written: the sid comes from the header the `walnut`
 * CLI sends, never the body. Display data only; a companion keeps none.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const sessionOpCallsV1Router = Router()

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TOOL_RE = /^[A-Za-z0-9_-]{1,128}$/
const MAX_LOOKUP = 400

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return SID_RE.test(sid) ? sid : undefined
}

sessionOpCallsV1Router.post('/sessions/op-calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sid = callerSid(req)
    if (!sid) { sendError(res, 400, 'bad_request', 'Only a session records its own calls (x-walnut-caller-sid)'); return }
    const body = (req.body ?? {}) as Record<string, unknown>
    const op = typeof body.op === 'string' ? body.op : ''
    const { recordOpCall } = await import('../../core/sessions/op-call-log.js')
    const entry = await recordOpCall(sid, { op, form: body.form, path: body.path, ok: body.ok, error: body.error, fields: body.fields, key: body.key })
    if (!entry) { res.status(204).end(); return }
    res.json({ id: entry.id, ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}) })
  } catch (err) {
    next(err)
  }
})

sessionOpCallsV1Router.post('/sessions/:id/op-calls/lookup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sid = String(req.params.id ?? '')
    if (!SID_RE.test(sid)) { sendError(res, 400, 'bad_request', 'Invalid session id'); return }
    const raw = (req.body as { tools?: unknown } | undefined)?.tools
    const tools = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string' && TOOL_RE.test(t)).slice(0, MAX_LOOKUP) : []
    if (tools.length === 0) { res.json({ calls: {} }); return }
    const { opCallsForTools } = await import('../../core/sessions/op-call-log.js')
    res.json({ calls: await opCallsForTools(sid, tools) })
  } catch (err) {
    next(err)
  }
})
