/**
 * /api/v1 session extras (additive, Wave 2) — provider controls, settings
 * snapshot, side questions, workflow/plan reads, subagent-lane history,
 * execute-compact, queued-message management, and the launcher's host
 * directory listing. Semantics identical to the web routes
 * (src/web/routes/sessions.ts) because both call the SAME core functions in
 * core/sessions/session-extras.ts.
 *
 *   GET    /sessions/list-dirs?prefix&host&depth → { dirs, parent, exists }
 *   GET    /sessions/:id/controls               → { engine, controls }
 *   POST   /sessions/:id/controls { id, value } → { engine, controls }
 *   GET    /sessions/:id/settings?details=1     → { live, requested, applied, effective, details? }
 *   GET    /sessions/:id/side-questions         → { sideQuestions }
 *   POST   /sessions/:id/side-question { question } → { sideQuestion }
 *   POST   /sessions/:id/side-question/:qid/promote → { taskId, parentTaskId? }
 *   DELETE /sessions/:id/side-question/:qid     → { status: 'deleted' }
 *   GET    /sessions/:id/workflow               → workflow payload (204 = none)
 *   GET    /sessions/:id/plan                   → { content, planFile?, sourceSessionId? }
 *   GET    /sessions/:id/subagent/:agentId/history?workflow=1 → { messages }
 *   POST   /sessions/:id/execute-compact        → { status:'started', … }
 *   GET    /sessions/:id/queue                  → { messages }
 *   PATCH  /sessions/:id/queue/:messageId { text } → { ok }
 *   DELETE /sessions/:id/queue/:messageId       → { ok }
 *
 * Cloud companion (REPLICA): all Class B — session records + live CLIs live
 * on the primary, so every endpoint relays through the existing allowlisted
 * `session.control` daemon command with new action names (the daemon forwards
 * actions opaquely — no daemon protocol change; an old PRIMARY answers
 * "Unknown control action" → 400 session_control_needs_upgrade). list-dirs
 * rides the box-level `server.list-dirs` action ('__server__' placeholder).
 * Failure ladder identical to session-lifecycle-v1.ts.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError, v1ErrorCode } from './v1-control-relay.js'

export const sessionExtrasV1Router = Router()

/** Placeholder sessionId for the box-level `server.*` relay actions. */
const SERVER_RELAY_SID = '__server__'

/** Session ids land in daemon commands — restrict to the safe id alphabet. */
const SID_RE = /^[A-Za-z0-9_-]+$/

function validSid(req: Request, res: Response): string | null {
  const sessionId = String(req.params.id ?? '')
  if (!SID_RE.test(sessionId)) {
    sendError(res, 400, 'bad_request', 'Invalid session id')
    return null
  }
  return sessionId
}

/** Local-path runner: SessionControlError → the frozen v1 shape. */
async function runLocal(
  res: Response,
  next: NextFunction,
  successStatus: number,
  fn: () => Promise<unknown>,
): Promise<void> {
  const { SessionControlError } = await import('../../core/sessions/session-controls.js')
  try {
    res.status(successStatus).json(await fn())
  } catch (err) {
    if (err instanceof SessionControlError) {
      const code = err.statusCode === 502 ? 'bad_gateway' : v1ErrorCode(err.statusCode)
      sendError(res, err.statusCode, code, err.message)
      return
    }
    next(err)
  }
}

// ── Launcher: host directory listing ─────────────────────────────────────────

// GET /api/v1/sessions/list-dirs?prefix=&host=&depth= — subdirectory listing
// for the session-creation path picker (auto-complete). Registered BEFORE the
// :id routes so "list-dirs" is never treated as a session id.
sessionExtrasV1Router.get('/sessions/list-dirs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const input = {
      prefix: typeof req.query.prefix === 'string' ? req.query.prefix : '/',
      ...(host ? { host } : {}),
      depth: Number(req.query.depth) || undefined,
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.list-dirs', SERVER_RELAY_SID, input, 200)
      return
    }
    const { listSessionDirs } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => listSessionDirs(input.prefix, host, input.depth))
  } catch (err) {
    next(err)
  }
})

// ── Provider controls ────────────────────────────────────────────────────────

// GET /api/v1/sessions/:id/controls — provider-neutral selectable controls
// (mode select for Claude sessions; the native control set for Codex/ACP).
sessionExtrasV1Router.get('/sessions/:id/controls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'controls', sessionId, undefined, 200)
      return
    }
    const { getSessionControls } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => getSessionControls(sessionId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/controls { id, value } — apply one control.
sessionExtrasV1Router.post('/sessions/:id/controls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    if (CLOUD_MODE) {
      await relayControlAction(res, 'controls.apply', sessionId, { id: body.id, value: body.value }, 200)
      return
    }
    const { applySessionControl } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => applySessionControl(sessionId, body.id, body.value))
  } catch (err) {
    next(err)
  }
})

// ── Settings snapshot ────────────────────────────────────────────────────────

// GET /api/v1/sessions/:id/settings?details=1 — requested vs applied settings
// (+ context usage / binary version when details=1 and the CLI is live).
sessionExtrasV1Router.get('/sessions/:id/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const details = req.query.details === '1' || req.query.details === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'settings', sessionId, details ? { details: true } : undefined, 200)
      return
    }
    const { getSessionSettings } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => getSessionSettings(sessionId, details))
  } catch (err) {
    next(err)
  }
})

// ── Side questions ───────────────────────────────────────────────────────────

// GET /api/v1/sessions/:id/side-questions — Q&A history for the drawer.
sessionExtrasV1Router.get('/sessions/:id/side-questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'side-questions', sessionId, undefined, 200)
      return
    }
    const { listSessionSideQuestions } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => listSessionSideQuestions(sessionId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/side-question { question } — ask the live CLI a
// question WITHOUT injecting into its main conversation; persists + broadcasts.
// Synchronous: the response carries the answer (can take tens of seconds).
sessionExtrasV1Router.post('/sessions/:id/side-question', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const question = (req.body ?? {}).question
    if (CLOUD_MODE) {
      await relayControlAction(res, 'side-question.ask', sessionId, { question }, 200)
      return
    }
    const { askSessionSideQuestion } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => askSessionSideQuestion(sessionId, question))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/side-question/:qid/promote — Q&A → task.
sessionExtrasV1Router.post('/sessions/:id/side-question/:qid/promote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const qid = String(req.params.qid ?? '')
    if (CLOUD_MODE) {
      await relayControlAction(res, 'side-question.promote', sessionId, { id: qid }, 200)
      return
    }
    const { promoteSessionSideQuestion } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => promoteSessionSideQuestion(sessionId, qid))
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/sessions/:id/side-question/:qid — remove a Q&A from history.
sessionExtrasV1Router.delete('/sessions/:id/side-question/:qid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const qid = String(req.params.qid ?? '')
    if (CLOUD_MODE) {
      await relayControlAction(res, 'side-question.delete', sessionId, { id: qid }, 200)
      return
    }
    const { removeSessionSideQuestion } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => removeSessionSideQuestion(sessionId, qid))
  } catch (err) {
    next(err)
  }
})

// ── Workflow / plan reads ────────────────────────────────────────────────────

// GET /api/v1/sessions/:id/workflow — dynamic-workflow progress payload.
// 200 with the payload, or 204 when no workflow ran (matches the web route).
// On a REPLICA the relay answers { workflow: null } for the none case (the
// relay envelope must be an object) — this route unwraps it back to 204.
sessionExtrasV1Router.get('/sessions/:id/workflow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      const { driveControlRelay, sendRelayReplyError } = await import('./v1-control-relay.js')
      const reply = await driveControlRelay(res, 'workflow', sessionId, undefined)
      if (!reply) return // bridge offline — error already sent
      if (reply.ok === true && reply.result && typeof reply.result === 'object') {
        const workflow = (reply.result as Record<string, unknown>).workflow
        if (!workflow) {
          res.status(204).end()
          return
        }
        res.json(workflow)
        return
      }
      sendRelayReplyError(res, reply)
      return
    }
    const { getSessionWorkflowPayload } = await import('../../core/sessions/session-extras.js')
    const payload = await getSessionWorkflowPayload(sessionId)
    if (!payload) {
      res.status(204).end()
      return
    }
    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions/:id/plan — plan content for a plan session (or its
// source plan session, one hop).
sessionExtrasV1Router.get('/sessions/:id/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'plan', sessionId, undefined, 200)
      return
    }
    const { getSessionPlanPayload } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => getSessionPlanPayload(sessionId))
  } catch (err) {
    next(err)
  }
})

// ── Subagent lane history ────────────────────────────────────────────────────

// GET /api/v1/sessions/:id/subagent/:agentId/history?workflow=1 — one
// subagent lane's rich history (Task/Team layout; workflow=1 = the nested
// dynamic-workflow layout).
sessionExtrasV1Router.get('/sessions/:id/subagent/:agentId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const agentId = String(req.params.agentId ?? '')
    const isWorkflow = req.query.workflow === '1' || req.query.workflow === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'subagent-history', sessionId, { agentId, workflow: isWorkflow }, 200)
      return
    }
    const { getSubagentHistoryPayload } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => getSubagentHistoryPayload(sessionId, agentId, isWorkflow))
  } catch (err) {
    next(err)
  }
})

// ── Execute-compact ──────────────────────────────────────────────────────────

// POST /api/v1/sessions/:id/execute-compact — execute a completed plan by
// injecting a compact boundary into the SAME session (pairs with the Wave-1
// execute-continue; this is the "clear the plan chatter first" variant).
sessionExtrasV1Router.post('/sessions/:id/execute-compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const input = {
      task_id: typeof body.task_id === 'string' ? body.task_id : undefined,
      working_directory: typeof body.working_directory === 'string' ? body.working_directory : undefined,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'execute-compact', sessionId, input, 200)
      return
    }
    const { executeCompactSession } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => executeCompactSession(sessionId, input))
  } catch (err) {
    next(err)
  }
})

// ── Queued-message management (WS RPC → REST twins) ──────────────────────────

// GET /api/v1/sessions/:id/queue — pending/processing queued messages.
sessionExtrasV1Router.get('/sessions/:id/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'queue', sessionId, undefined, 200)
      return
    }
    const { getSessionQueuePayload } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => getSessionQueuePayload(sessionId))
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/sessions/:id/queue/:messageId { text } — edit a queued message.
// 409 conflict when the message already started processing / is gone.
sessionExtrasV1Router.patch('/sessions/:id/queue/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const messageId = String(req.params.messageId ?? '')
    const text = (req.body ?? {}).text
    if (CLOUD_MODE) {
      await relayControlAction(res, 'queue.edit', sessionId, { messageId, text }, 200)
      return
    }
    const { editSessionQueuedMessage } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => editSessionQueuedMessage(sessionId, messageId, text))
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/sessions/:id/queue/:messageId — delete a queued message.
sessionExtrasV1Router.delete('/sessions/:id/queue/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const messageId = String(req.params.messageId ?? '')
    if (CLOUD_MODE) {
      await relayControlAction(res, 'queue.delete', sessionId, { messageId }, 200)
      return
    }
    const { deleteSessionQueuedMessage } = await import('../../core/sessions/session-extras.js')
    await runLocal(res, next, 200, () => deleteSessionQueuedMessage(sessionId, messageId))
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
sessionExtrasV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session extras route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
