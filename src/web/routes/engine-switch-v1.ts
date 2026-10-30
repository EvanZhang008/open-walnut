/**
 * Switch a task's engine inside the task (core/sessions/engine-switch.ts), and
 * list the sessions a task held over its life, oldest first.
 *
 *   GET    /tasks/:id/sessions         { taskId, activeSessionId, sessions: [...] } every session
 *                                      of the task in order (the active one last, `active: true`)
 *   POST   /tasks/:id/switch-engine    { engine, text, model?, effort?, permission_mode? }
 *                                      → 200 done (the new session), 202 pending (the running turn
 *                                      ends first) or switching (still starting after wait_ms);
 *                                      409 engine_not_on_host when the task's host cannot run it
 *                                      (a switch never moves the work to another host)
 *   DELETE /tasks/:id/switch-engine    cancel a pending switch; `deliver: true` sends its message
 *                                      to the current session instead
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isKnownEngine } from '../../core/agents/engine-registry.js'
import { placement } from '../../core/server-role.js'
import type { SessionEffort, SessionEngine, SessionMode, SessionRecord } from '../../core/types.js'

export const engineSwitchV1Router = Router()

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = Array.isArray(raw) ? raw[0] : raw
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined
}

function sendError(res: Response, err: unknown, next: NextFunction): void {
  const status = (err as { status?: number }).status
  if (typeof status === 'number') {
    res.status(status).json({ error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code })
    return
  }
  next(err)
}

/** One row of GET /tasks/:id/sessions. */
export function sessionHistoryRow(r: SessionRecord, activeId: string | undefined) {
  return {
    session_id: r.claudeSessionId,
    engine: r.engine ?? 'claude',
    model: r.cliModel || r.model || r.acpModel || null,
    host: r.host || null,
    cwd: r.cwd ?? null,
    started_at: r.startedAt ?? null,
    last_active_at: r.lastActiveAt ?? null,
    message_count: r.messageCount ?? 0,
    process_status: r.process_status,
    active: r.claudeSessionId === activeId,
    ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
    ...(r.engineSwitch ? {
      switched_from: {
        session_id: r.engineSwitch.fromSessionId, engine: r.engineSwitch.fromEngine ?? 'claude',
        model: r.engineSwitch.fromModel ?? null, at: r.engineSwitch.at,
        carried_turns: r.engineSwitch.carriedTurns, trimmed_turns: r.engineSwitch.trimmedTurns,
        compacted: r.engineSwitch.compacted === true, transcript_path: r.engineSwitch.transcriptPath ?? null,
      },
    } : {}),
    ...(r.resumedBySwitch ? {
      resumed: {
        session_id: r.resumedBySwitch.fromSessionId, engine: r.resumedBySwitch.fromEngine ?? 'claude',
        at: r.resumedBySwitch.at, carried_turns: r.resumedBySwitch.carriedTurns,
      },
    } : {}),
  }
}

engineSwitchV1Router.get('/tasks/:id/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    const task = await getTask(String(req.params.id)).catch(() => null)
    if (!task) { res.status(404).json({ error: 'Task not found', code: 'not_found' }); return }
    const { getSessionsForTask } = await import('../../core/session-tracker.js')
    const { taskConversation } = await import('../../core/sessions/task-session-claim.js')
    const active = (await taskConversation(task.id))?.claudeSessionId ?? task.session_id
    const rows = (await getSessionsForTask(task.id))
      .filter((r) => !r.archive_reason?.startsWith('acp_identity_replaced:'))
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    res.json({
      taskId: task.id,
      activeSessionId: active ?? null,
      sessions: rows.map((r) => sessionHistoryRow(r, active)),
      // Sessions an older Walnut split off the task (history only, not linked).
      legacySessionIds: task.legacy_session_ids ?? [],
      ...(task.engine_switch ? { engineSwitch: { ...task.engine_switch, message: undefined, held_rows: undefined } } : {}),
    })
  } catch (err) { next(err) }
})

engineSwitchV1Router.use('/tasks/:id/switch-engine', (req: Request, res: Response, next: NextFunction) => {
  if (placement() !== 'cloud') { next(); return }
  res.status(501).json({ error: 'An engine switch runs on your Mac only', code: 'not_supported_cloud' })
})

engineSwitchV1Router.post('/tasks/:id/switch-engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.engine !== 'string' || !isKnownEngine(body.engine)) {
      res.status(400).json({ error: 'engine must be one of the engines Walnut offers', code: 'bad_engine' }); return
    }
    const text = typeof body.text === 'string' ? body.text : typeof body.message === 'string' ? body.message : ''
    if (!text.trim()) { res.status(400).json({ error: 'text is the message the new session starts with', code: 'message_required' }); return }
    const { requestEngineSwitch } = await import('../../core/sessions/engine-switch.js')
    const waitFor = Math.min(Math.max(Number(body.wait_ms ?? 25_000) || 0, 0), 180_000)
    const work = requestEngineSwitch({
      taskId: String(req.params.id), engine: body.engine as SessionEngine, message: text,
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(typeof body.effort === 'string' ? { effort: body.effort as SessionEffort } : {}),
      ...(typeof body.permission_mode === 'string' ? { permissionMode: body.permission_mode as SessionMode } : {}),
      callerSid: callerSid(req), source: 'api',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      work.then((r) => ({ r }), (e: unknown) => ({ e })),
      new Promise<{ late: true }>((resolve) => { timer = setTimeout(() => resolve({ late: true }), waitFor) }),
    ])
    if (timer) clearTimeout(timer)
    if ('late' in outcome) {
      work.catch(() => {})
      res.status(202).json({ state: 'switching', taskId: String(req.params.id) })
      return
    }
    if ('e' in outcome) { sendError(res, outcome.e, next); return }
    res.status(outcome.r.state === 'pending' ? 202 : 200).json(outcome.r)
  } catch (err) { sendError(res, err, next) }
})

engineSwitchV1Router.delete('/tasks/:id/switch-engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { cancelPendingSwitch } = await import('../../core/sessions/engine-switch.js')
    const deliver = body.deliver === true || req.query.deliver === '1'
    res.json(await cancelPendingSwitch(String(req.params.id), { deliver }))
  } catch (err) { sendError(res, err, next) }
})
