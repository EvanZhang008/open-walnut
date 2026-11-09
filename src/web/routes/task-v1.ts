/**
 * /api/v1 task + focus endpoints (additive) — the Wave-1 mobile parity set.
 * Semantics are identical to the web routes (src/web/routes/tasks.ts,
 * src/web/routes/focus.ts) because both call the SAME task-manager functions.
 *
 *   GET    /tasks/:id                → { task } (full detail incl. note/description/summary/deps)
 *   DELETE /tasks/:id?force=true     → 204 (409 conflict when sessions are active)
 *   POST   /tasks/:id/complete       → { task } (completeTask semantics, CLI parity)
 *   POST   /tasks/:id/start          → { action, taskId, title, sessionId? }
 *   PUT    /tasks/:id/report         → { task, phase } (its own line, set by its lead, VP, Main or a person)
 *   POST   /tasks/:id/ask-answer/withdraw → { task, withdrawn, needsAgain } (an answer given in the user's place, taken back)
 *   POST   /tasks/:id/star           → { task, starred: false } (RETIRED no-op)
 *   POST   /tasks/:id/notes          → { task } (append timestamped note)
 *   PUT    /tasks/:id/note           → { task } (replace whole note)
 *   PUT    /tasks/:id/description    → { task }
 *   PUT    /tasks/:id/summary        → { task }
 *   PUT    /tasks/:id/depends-on     → { task }
 *   PATCH  /tasks/reorder            → { ok: true }
 *   POST   /tasks/batch/phase        → { changed, failed, syncFailed } (partial success)
 *   POST   /tasks/batch/delete       → { deleted, failed } (partial success)
 *   GET    /focus/tasks              → TierResult
 *   POST   /focus/tasks/:id          → { pinned_tasks }
 *   DELETE /focus/tasks/:id          → { pinned_tasks }
 *   PUT    /focus/reorder            → TierResult
 *   PUT    /focus/tasks/:id/tier     → TierResult
 *   GET    /focus/tiers              → { tiers }
 *
 * Cloud companion (REPLICA): all Class A EXCEPT POST /tasks/:id/start (Class
 * C — 501; a replica has no session-runner, see the handler). The replica has
 * a REAL local task store (seeded by the projection import), and every
 * mutation here goes through task-manager which emits TASK_* bus events — the
 * cloud outbox subscriber (server.ts) turns those into op files that ride
 * git-sync back to the primary (task-outbox.ts). Nothing else here needs a
 * bridge. Detail responses serve the FULL local task row (not the slim
 * projection) so note/description read back — the frozen GET /v1/tasks list
 * stays slim and untouched.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { matchParentRef, refNamesId } from '../../lib/id-ref.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { CLOUD_MODE } from '../../constants.js'
import { role } from '../../core/server-role.js'
import type { SessionEffort, Task, TaskPhase } from '../../core/types.js'
import { isKnownEngine } from '../../core/agents/engine-registry.js'
import { PIN_TIER_POLICY, SESSION_ENGINE_IDS, migrateFocusTier } from '../../core/types.js'
import { handsToAppErrorHandler } from '../middleware/link-failure-answer.js'
import { logRouteError } from './route-error-log.js'

export const taskV1Router = Router()

// Same frozen error shape as api-v1.ts.
function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Express 5 params can be string[] on routers with wildcard routes. */
function paramStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join('/')
  return v ?? ''
}

/**
 * Map the task-manager's message-based errors to the frozen v1 vocabulary.
 * Returns true when the error was handled (response sent).
 */
function sendTaskManagerError(res: Response, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/No task found matching/i.test(msg) || /^Task not found/i.test(msg)) {
    sendError(res, 404, 'not_found', msg)
    return true
  }
  if (/Ambiguous ID prefix/i.test(msg)) {
    sendError(res, 400, 'bad_request', msg)
    return true
  }
  // An error that names the caller's own input (a depends_on id that is no task's, a task
  // depending on itself: DependencyValidationError) is theirs to fix, never a 500.
  if ((err as { status?: number } | null)?.status === 400) {
    sendError(res, 400, 'bad_request', msg)
    return true
  }
  return false
}

async function resolveTaskIdPrefix(res: Response, id: string): Promise<string | null> {
  const { getTask } = await import('../../core/task-manager.js')
  try {
    return (await getTask(id)).id
  } catch (err) {
    if (sendTaskManagerError(res, err)) return null
    throw err
  }
}

// ─── Task detail / delete / field setters ───────────────────────────────────

/**
 * Collection-level subpaths served by LATER-mounted v1 routers (task-extras'
 * GET /tasks/groups, console-extras' GET /tasks/enriched). This GET /tasks/:id
 * is the first single-segment catch-all under /api/v1/tasks, so without this
 * forward it swallows them as task-id prefixes and answers 404 — which is
 * exactly what happened to GET /v1/tasks/groups in Wave 2 (its test mounted
 * only the extras router, hiding the shadowing).
 */
const RESERVED_TASK_SUBPATHS = new Set(['groups', 'enriched'])
/** How long a task detail waits to learn which of its link files are gone. */
const LINK_EXISTS_DEADLINE_MS = 1500
/**
 * How long an agent's start waits for its session to come up before it answers: under the
 * start's own 120 s spawn deadline (task-start.ts) and the task_start / task_create op's
 * timeout (ops/work.ts, ops/tasks.ts).
 */
const AGENT_START_ANSWER_MS = 110_000

// GET /api/v1/tasks/:id — FULL task detail (description/note/summary readback
// — the slim list projection is write-only for those fields). Adds the same
// dependency/children/parent decorations the web detail endpoint serves.
taskV1Router.get('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (RESERVED_TASK_SUBPATHS.has(String(req.params.id))) { next(); return }
    const id = paramStr(req.params.id)
    const tm = await import('../../core/task-manager.js')
    let task: Task
    try {
      task = await tm.getTask(id)
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
    // REPLICA readback upgrade: the replica row's description/note are
    // projection-blind (often ''), so with a live bridge fetch the primary's
    // authoritative row. Best-effort with a short budget — bridge down or an
    // old primary just serves the local row (fast, mildly degraded), never an
    // error. LWW guard: never let a STALE primary row (op still queued /
    // in-flight) shadow a newer local edit.
    // A row the primary's own copy of its store holds is already its row, every
    // field included (core/replication/task-replica-store.ts): no round trip,
    // and no 5s wait while the primary is asleep.
    const { taskReplicaHoldsRow } = await import('../../core/replication/task-replica-store.js')
    if (CLOUD_MODE && !(await taskReplicaHoldsRow(task.id))) {
      try {
        const { callPrimaryControl } = await import('./v1-control-relay.js')
        const reply = await callPrimaryControl('server.tasks.get', '__server__', { id: task.id }, 5_000)
        if (reply.ok && reply.result.task && typeof reply.result.task === 'object') {
          const primaryRow = reply.result.task as Task
          if (Date.parse(primaryRow.updated_at) >= Date.parse(task.updated_at)) task = primaryRow
        }
      } catch { /* serve the local row */ }
    }
    const allTasks = await tm.listTasks({})
    const detail: Record<string, unknown> = { ...task }
    if (task.depends_on?.length) {
      detail.is_blocked = tm.isTaskBlocked(task, allTasks)
      detail.resolved_dependencies = task.depends_on.map((depId) => {
        const dep = allTasks.find((t) => t.id === depId)
        return dep ? { id: dep.id, title: dep.title, phase: dep.phase } : { id: depId, title: '(not found)', phase: 'UNKNOWN' }
      })
    }
    const dependents = allTasks.filter((t) => t.depends_on?.includes(task.id))
    if (dependents.length > 0) {
      detail.dependents = dependents.map((t) => ({ id: t.id, title: t.title, phase: t.phase }))
    }
    // Children — tolerate prefix parent_task_id (legacy data), like the web route.
    const ids = new Set(allTasks.map((t) => t.id))
    const children = allTasks.filter((t) => t.parent_task_id && refNamesId(t.parent_task_id, task.id, ids.has(t.parent_task_id), t.id))
    if (children.length > 0) {
      detail.children = children.map((t) => ({ id: t.id, title: t.title, phase: t.phase, status: t.status, priority: t.priority }))
    }
    if (task.parent_task_id) {
      const parent = matchParentRef(allTasks, task)
      if (parent) detail.parent = { id: parent.id, title: parent.title, phase: parent.phase, status: parent.status }
    }
    // The link tags as the phone draws them: a name each, its kind, and whether the file is gone
    // (asked of the session's host, within a short deadline; unknown when it does not answer).
    const { linkTagViews } = await import('../../core/link-tags.js')
    const links = linkTagViews(task.tags, task.link_names)
    if (links.length > 0) {
      const files = links.filter((l) => l.file).map((l) => l.target)
      let exists: Record<string, boolean> = {}
      if (files.length > 0) {
        const { linkPathsExist } = await import('./files.js')
        const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
        const host = task.session_id ? (await getSessionByClaudeId(task.session_id).catch(() => null))?.host : undefined
        exists = await Promise.race([
          linkPathsExist(files, host ?? undefined).catch(() => ({})),
          new Promise<Record<string, boolean>>((resolve) => { setTimeout(() => resolve({}), LINK_EXISTS_DEADLINE_MS).unref?.() }),
        ])
      }
      detail.links = links.map((l) => (l.file && exists[l.target] === false ? { ...l, gone: true } : l))
    }
    res.json({ task: detail })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/tasks/:id?force=true — 204; 409 conflict when the task has
// active sessions and force is not set (force stops the sessions first).
taskV1Router.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const force = req.query.force === 'true' || (req.body ?? {}).force === true
    const tm = await import('../../core/task-manager.js')
    try {
      const result = await tm.deleteTask(id)
      log.web.info('task deleted via api-v1', { taskId: id })
      bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui'], { source: 'api-v1' })
      res.status(204).end()
    } catch (err) {
      if (err instanceof tm.ActiveSessionError && force) {
        // Force mode: stop sessions and retry — same flow as the web route.
        const { completeTaskSessions } = await import('../../core/session-tracker.js')
        await completeTaskSessions(err.activeSessionIds)
        for (const sid of err.activeSessionIds) {
          try { await tm.clearSessionSlot(id, sid) } catch { /* best-effort */ }
          try { await tm.clearSession(id, sid) } catch { /* best-effort */ }
        }
        const result = await tm.deleteTask(id)
        log.web.info('task force-deleted via api-v1 (stopped sessions)', { taskId: id, stoppedSessions: err.activeSessionIds.length })
        bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui'], { source: 'api-v1' })
        res.status(204).end()
        return
      }
      if (err instanceof tm.ActiveSessionError) {
        sendError(res, 409, 'conflict',
          `Cannot delete task: has active sessions: ${err.activeSessionIds.join(', ')}`,
          { active_session_ids: err.activeSessionIds })
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/complete — completeTask() semantics.
//
// WHY this is not just PATCH { status: 'done' }: completeTask propagates a
// sync-push failure to the caller (a plugin-backed task that didn't reach its
// remote store is a real error), whereas the v1 PATCH uses asyncPush and
// swallows it into a log line. (It also used to auto-unpin; that behavior was
// removed 2026-08-26 — completed pins stay in their tier.)
// The CLI's `done` command has always had completeTask semantics, so it needs
// this endpoint rather than the PATCH.
taskV1Router.post('/tasks/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const tm = await import('../../core/task-manager.js')
    try {
      // The acting session rides on the phase event, so the notices this
      // completion causes can skip their own author (a leader completing its
      // worker is not told what it just did, 2026-10-02).
      const rawActor = req.headers['x-walnut-caller-sid']
      const actorSid = (Array.isArray(rawActor) ? rawActor[0] : rawActor)?.trim() || undefined
      const b = (req.body ?? {}) as Record<string, unknown>
      const { readStructuredReply, scoreProblem } = await import('../../core/peers/structured-reply.js')
      const badScore = scoreProblem(b.score)
      if (badScore) {
        sendError(res, 400, 'bad_request', badScore)
        return
      }
      const fields = readStructuredReply(b)
      // A session closing ANOTHER task the user may still be using (2026-10-28: a lead completed
      // the task the user had open in a terminal) is refused with the reasons, unless it says why.
      const { admitCompleteOfOther } = await import('../../core/sessions/complete-in-use.js')
      const admit = await admitCompleteOfOther(id, actorSid, { force: b.force === true, reason: typeof b.reason === 'string' ? b.reason : undefined, fields })
      if (!admit.ok) {
        sendError(res, 409, 'task_in_use', admit.message, { reasons: admit.reasons })
        return
      }
      // A session's close of a task that still holds something for the user keeps it open as
      // Partial and Needs you (core/sessions/owed-to-user.ts).
      const { admitSessionClose, closeWithSettle } = await import('../../core/sessions/owed-to-user.js')
      const owed = await admitSessionClose(id, actorSid, { force: b.force === true, reason: typeof b.reason === 'string' ? b.reason : undefined, fields })
      if (!owed.ok) {
        sendError(res, 409, owed.code, owed.message, { items: owed.items })
        return
      }
      // What came of it, and what is not done (core/peers/structured-reply.ts): the Board, the
      // Brief and its parent's open items read Partial from a non-empty not_done. Written BEFORE
      // the completion, so the parent's completed notice and the completion event carry it; a
      // completion that says nothing more still ends an earlier Partial (COMPLETE is verified).
      const { isPartial } = await import('../../core/peers/structured-reply.js')
      const before = await tm.getTask(id).catch(() => null)
      let wroteReport = !!owed.settle
      // A settle of the user's items (a forced close, a person's close of a held task) is written
      // with the close and put back if the close fails (owed-to-user.ts closeWithSettle).
      if (!owed.settle && before && before.phase !== 'COMPLETE' && (fields || isPartial(before.result_report))) {
        const { noteResultReport } = await import('../../core/sessions/session-send-core.js')
        const { resultWriterOf } = await import('../../core/peers/structured-reply.js')
        wroteReport = !!(await noteResultReport(before.id, { via: 'complete', ...resultWriterOf(actorSid, admit.callerTaskId, admit.callerSessionId) }, fields, { emit: false }))
      }
      // A score the report write above did not take (a settle writes its own result; a task already
      // complete writes no report) is kept on its own: a 200 never drops the reviewer's verdict.
      if (fields?.score && (owed.settle || !before || before.phase === 'COMPLETE')) {
        const { noteReviewScore } = await import('../../core/sessions/session-send-core.js')
        await noteReviewScore(id, fields.score, 'complete')
      }
      const result = await closeWithSettle(owed.settle, fields, () => tm.completeTask(id, actorSid ? { actorSid } : undefined))
      log.web.info('task completed via api-v1', { taskId: result.task.id, ...(actorSid ? { actorSid } : {}) })
      // fields (additive): scopes the replica outbox op to what completion
      // actually changes (auto-unpin was removed 2026-08-26 — pins persist).
      bus.emit(EventNames.TASK_COMPLETED, {
        task: result.task,
        fields: ['status', 'phase', 'completed_at', ...(wroteReport ? ['result_report'] : [])],
      }, ['web-ui'], { source: 'api-v1' })
      // Open subtasks never block a completion; the caller is told which ones
      // keep running without it (additive, present only when there are any).
      const { listOpenSubtasks } = await import('../../core/sessions/open-items.js')
      const open = await listOpenSubtasks(result.task.id).catch(() => ({ subtasks: [], more: 0 }))
      // A forced close names what it settled for the user, so the closer can tell them (additive).
      const settledOwed = owed.settle && !owed.settle.person ? { owed_settled: owed.settle.items.map((i) => i.text) } : {}
      res.json(open.subtasks.length > 0
        ? { ...result, ...settledOwed, open_subtasks: open.subtasks, ...(open.more > 0 ? { more_open_subtasks: open.more } : {}) }
        : { ...result, ...settledOwed })
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/start { message?, cwd?, host?, model?, mode?, effort?,
// engine?, expect_reply?, reply_timeout?, user_request?, create_cwd?, workspace? }
// → 202 { taskId, title, sessionId?, requestId?, started, preparing?, continued?,
// applied? } (`applied` names the newer launch fields it honoured). — start a NEW session for an EXISTING task
// (the session_start op). Distinct from POST /api/v1/sessions, whose body
// requires an absolute `cwd`: this one names only a task and lets the
// session-runner resolve cwd from the task/project chain. A live session →
// 409 with existing_session_id (use session_send). Core:
// core/sessions/task-start.ts (shared with the CLI's direct escape hatch).
// POST /api/v1/tasks/:id/not-done { how: 'taken' | 'dropped', note? } → { task }: the not-done items
// of its last result are taken up or dropped, so it stops reading Partial (core/peers/structured-reply.ts).
taskV1Router.post('/tasks/:id/not-done', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (b.how !== 'taken' && b.how !== 'dropped') {
      sendError(res, 400, 'bad_request', 'how must be "taken" or "dropped"')
      return
    }
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : undefined
    const rawActor = req.headers['x-walnut-caller-sid']
    const actorSid = (Array.isArray(rawActor) ? rawActor[0] : rawActor)?.trim() || undefined
    let by = 'human'
    if (actorSid) {
      const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
      const caller = await resolveCaller(actorSid).catch(() => null)
      if (caller?.kind === 'session' && caller.record.taskId) by = `task:${caller.record.taskId}`
    }
    const tm = await import('../../core/task-manager.js')
    try {
      const task = await tm.getTask(id)
      const report = task.result_report
      if (!report?.not_done?.length) {
        sendError(res, 409, 'not_partial', `"${task.title}" (${task.id}) has no not-done items to settle`)
        return
      }
      // What a close left for the user is settled by a session only with a note saying how, as a
      // forced close needs a reason (core/sessions/owed-to-user.ts).
      const { openOwed } = await import('../../core/peers/structured-reply.js')
      if (by !== 'human' && openOwed(report) && (note ?? '').length < 10) {
        sendError(res, 409, 'owed_to_user', `"${task.title}" (${task.id}) still holds what a close left for the user: ${openOwed(report)!.items.join('; ')}. Settle them with a note (10+ characters) saying how they were handled.`)
        return
      }
      const settled = { at: new Date().toISOString(), by, how: b.how as 'taken' | 'dropped', ...(note ? { note } : {}) }
      // Against the stored row: a new result written meanwhile is not overwritten with the old one.
      // What a close left for the user (sessions/owed-to-user.ts) is settled with it: its Needs you ends.
      const withOwed = (r: NonNullable<typeof report>) => ({ ...r, settled, ...(r.owed && !r.owed.settled ? { owed: { ...r.owed, settled } } : {}) })
      const updated = await tm.updateTaskRaw(task.id, (cur) => (cur.result_report?.at === report.at ? { result_report: withOwed(cur.result_report) } : null), { source: 'result-report', push: false })
      log.web.info('not-done items settled', { taskId: task.id, how: b.how, by })
      if (updated?.task) bus.emit(EventNames.TASK_UPDATED, { task: updated.task }, ['web-ui'], { source: 'result-report' })
      res.json({ task: updated?.task ?? { ...task, result_report: withOwed(report) } })
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/ask-answer/withdraw { ask?, reason? } → { task, withdrawn, needsAgain }: an
// answer given in the user's place (task_send answers_ask) is taken back, and the ask goes back on
// his Needs you while the task still asks it (core/sessions/ask-withdraw.ts).
taskV1Router.post('/tasks/:id/ask-answer/withdraw', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>
    const rawActor = req.headers['x-walnut-caller-sid']
    const actorSid = (Array.isArray(rawActor) ? rawActor[0] : rawActor)?.trim() || undefined
    let callerTaskId: string | null = null
    if (actorSid) {
      const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
      const caller = await resolveCaller(actorSid).catch(() => null)
      if (caller?.kind === 'session' && caller.record.taskId) callerTaskId = caller.record.taskId
      else if (caller?.kind === 'session' || caller?.kind === 'external') {
        sendError(res, 409, 'not_above', 'Only a task\'s session or the user takes back an answer given in the user\'s place')
        return
      }
    }
    const { withdrawAskAnswer, AskWithdrawError } = await import('../../core/sessions/ask-withdraw.js')
    try {
      const out = await withdrawAskAnswer(callerTaskId, paramStr(req.params.id), {
        ...(typeof b.ask === 'string' ? { ask: b.ask } : {}),
        ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
      })
      res.json(out)
    } catch (err) {
      if (err instanceof AskWithdrawError) { sendError(res, err.status, err.code, err.message); return }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/team-stop { when?: 'now' | 'turn_end', include_self?, sessions?: 'stop' | 'keep' } → TeamStopResult:
// stop every open task under it (its own session too unless include_self is false; never the
// caller's own), pause their armed triggers and take off their wake clocks (core/sessions/team-stop.ts).
// POST /api/v1/tasks/:id/team-resume → TeamResumeResult: turn those triggers and clocks back on.
async function callerBy(req: Request): Promise<{ by: string; callerSid?: string }> {
  const raw = req.headers['x-walnut-caller-sid']
  const callerSid = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined
  if (!callerSid) return { by: 'human' }
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(callerSid).catch(() => null)
  return { by: caller?.kind === 'session' && caller.record.taskId ? `task:${caller.record.taskId}` : 'human', callerSid }
}

taskV1Router.post('/tasks/:id/team-stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (role() === 'replica') { sendError(res, 501, 'not_supported_cloud', 'A team stop runs on the primary box'); return }
    const b = (req.body ?? {}) as Record<string, unknown>
    if (b.when !== undefined && b.when !== 'now' && b.when !== 'turn_end') { sendError(res, 400, 'bad_request', "when must be 'now' or 'turn_end'"); return }
    if (b.sessions !== undefined && b.sessions !== 'stop' && b.sessions !== 'keep') { sendError(res, 400, 'bad_request', "sessions must be 'stop' or 'keep'"); return }
    const { stopTeam } = await import('../../core/sessions/team-stop.js')
    try {
      const out = await stopTeam(paramStr(req.params.id), {
        ...(await callerBy(req)), when: b.when as 'now' | 'turn_end' | undefined, includeRoot: b.include_self !== false,
        keepSessions: b.sessions === 'keep',
      })
      res.json(out)
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/tasks/:id/wake-sources?team=0|1 (default 1) → WakeSources: the routines and
// triggers aimed at the task (and every open task under it), paused or not, and the clocks that
// would wake one. Read only (core/sessions/team-stop.ts wakeSourcesOf).
taskV1Router.get('/tasks/:id/wake-sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { wakeSourcesOf } = await import('../../core/sessions/team-stop.js')
    try {
      res.json(await wakeSourcesOf(paramStr(req.params.id), { team: req.query.team !== '0' && req.query.team !== 'false' }))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

taskV1Router.post('/tasks/:id/team-resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (role() === 'replica') { sendError(res, 501, 'not_supported_cloud', 'A team resume runs on the primary box'); return }
    const { resumeTeam } = await import('../../core/sessions/team-stop.js')
    try {
      res.json(await resumeTeam(paramStr(req.params.id), { by: (await callerBy(req)).by }))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/report { state, ask?, waiting_on?, waiting_kind?, next? } → { task, phase }: the
// task's own line set from outside its turn, by its lead, VP, Main or a person (core/sessions/report-set.ts).
taskV1Router.put('/tasks/:id/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (role() === 'replica') { sendError(res, 501, 'not_supported_cloud', 'A task report is set on the primary box'); return }
    const { setTaskReport, ReportChangeError } = await import('../../core/sessions/report-set.js')
    const { by, callerSid } = await callerBy(req)
    let setter: import('../../core/sessions/report-set.js').ReportSetter | null = null
    if (by.startsWith('task:')) {
      const callerTaskId = by.slice('task:'.length)
      const { getTask } = await import('../../core/task-manager.js')
      // callerBy resolved callerSid to this task's session, so it is the writer's own session id.
      setter = { taskId: callerTaskId, title: (await getTask(callerTaskId).catch(() => null))?.title, ...(callerSid ? { sessionId: callerSid } : {}) }
    } else if (callerSid) {
      // A caller header Walnut could not resolve is no person: stored as an unknown writer.
      setter = { unknown: true }
    }
    try {
      res.json(await setTaskReport(paramStr(req.params.id), req.body, setter))
    } catch (err) {
      if (err instanceof ReportChangeError) { sendError(res, err.status, err.code, err.message); return }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

taskV1Router.post('/tasks/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Class C on a REPLICA: the cloud box has no session-runner/daemon, so the
    // SESSION_START emit would be a silent 200 no-op. POST /sessions already
    // relays launches over the bridge — point callers there.
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud',
        'Starting a session for a task runs on the primary box only — use POST /api/v1/sessions, which relays over the bridge')
      return
    }
    const id = paramStr(req.params.id)
    const b = (req.body ?? {}) as Record<string, unknown>
    const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string) ? b[k] as string : undefined)
    if (b.engine !== undefined && !isKnownEngine(b.engine)) {
      sendError(res, 400, 'bad_request', `engine must be one of: ${SESSION_ENGINE_IDS.join(', ')}`)
      return
    }
    if (b.start_attempt_id !== undefined && !(typeof b.start_attempt_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.start_attempt_id))) {
      sendError(res, 400, 'bad_request', 'start_attempt_id must be a UUID')
      return
    }
    const ws = b.workspace
    if (ws !== undefined && (!ws || typeof ws !== 'object' || Array.isArray(ws) || typeof (ws as { provider?: unknown }).provider !== 'string')) {
      sendError(res, 400, 'bad_request', 'workspace must be { provider, inputs? }')
      return
    }
    const workspace = ws as { provider: string; inputs?: unknown } | undefined
    const rawSid = req.headers['x-walnut-caller-sid']
    const callerSid = (Array.isArray(rawSid) ? rawSid[0] : rawSid ?? '').trim() || undefined
    const { startSessionForTask, SessionExistsError } = await import('../../core/sessions/task-start.js')
    const { QuickStartError } = await import('../../core/sessions/quick-start.js')
    const { SubtaskLimitError } = await import('../../core/sessions/subtask-limits.js')
    const { HostsFullError } = await import('../../core/sessions/host-admission.js')
    const { launchErrorCode } = await import('../../core/sessions/mobile-launch.js')
    try {
      const started = await startSessionForTask({
        taskIdPrefix: id,
        message: str('message'),
        cwd: str('cwd'),
        host: typeof b.host === 'string' ? b.host : undefined,
        model: str('model'),
        mode: str('mode'),
        effort: str('effort') as SessionEffort | undefined,
        userRequest: str('user_request'),
        ...(b.create_cwd === true ? { createCwd: true } : {}),
        ...(workspace ? { workspace } : {}),
        engine: b.engine,
        // Tri-state, NOT `=== true`: omitting the flag must reach the core as
        // `undefined` so it can apply the session-caller default (on).
        expectReply: typeof b.expect_reply === 'boolean' ? b.expect_reply : undefined,
        replyTimeoutSecs: typeof b.reply_timeout === 'number' ? b.reply_timeout : undefined,
        handsOn: str('hands_on'),
        callerSid,
        startAttemptId: str('start_attempt_id'),
        source: 'api-v1',
        // An agent's start answers once its session is up or the start failed (a sync call,
        // 2026-11-06, the user): never a start left to come up later unseen.
        ...(callerSid ? { answerWithinMs: AGENT_START_ANSWER_MS } : {}),
      })
      // One of the starter's Threads goes with the work it handed on (core/org/thread-follow.ts),
      // also when the start is still coming up: the work went there either way.
      const { handOffThread } = await import('../../core/org/thread-follow.js')
      const threadHandoff = await handOffThread({ callerSid, target: started.taskId, threadId: str('thread'), handsOn: !!str('hands_on') })
      // An agent's start is a sync call (2026-11-06, the user: "if it did not start, it must be an
      // error"): one whose session did not confirm in time answers an error, never a 202 the caller
      // reads as started. The start itself goes on: it may still come up.
      if (callerSid && started.started !== true && !started.continued && !started.preparing) {
        sendError(res, 504, 'start_unconfirmed', `Task ${started.taskId} did not confirm it started within `
          + `${Math.round(AGENT_START_ANSWER_MS / 1000)} seconds. Do not start it again: task_get shows it running once it is up`
          + (started.requestId ? `, and Walnut tells you when it shows nothing for 10 minutes (${started.requestId}).` : '.'), {
          detail: { taskId: started.taskId, sessionId: started.sessionId, ...(started.requestId ? { requestId: started.requestId } : {}), ...(threadHandoff ? { thread_handoff: threadHandoff } : {}) },
        })
        return
      }
      res.status(202).json(threadHandoff ? { ...started, thread_handoff: threadHandoff } : started)
    } catch (err) {
      if (err instanceof SessionExistsError) {
        // What to do instead, never a dead end: the caller's own open ask to it, or how to send (session-exists-hint.ts).
        const { sessionExistsHint } = await import('../../core/sessions/session-exists-hint.js')
        const hint = err.taskId && err.head ? await sessionExistsHint(err.taskId, callerSid) : null
        sendError(res, 409, 'session_exists', hint ? `${err.head} ${hint.line}` : err.message, {
          existing_session_id: err.existingSessionId,
          ...(hint?.openRequest ? { open_request: hint.openRequest } : {}),
        })
        return
      }
      if (err instanceof QuickStartError) {
        // A lead that handed its project over: its own code and where to send instead (org/retired-lead.ts).
        const { code, ...detail } = err.body ?? {}
        if (code === 'lead_handed_over' || code === 'no_capable_host' || code === 'bad_selector' || code === 'org_off') sendError(res, err.statusCode, code, err.message, detail)
        else sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
        return
      }
      if (err instanceof HostsFullError) {
        // Additive: the host, its words and why, for a client that reads more than the message.
        sendError(res, err.statusCode, err.code, err.message, { detail: err.detail })
        return
      }
      if (err instanceof SubtaskLimitError) {
        sendError(res, err.statusCode, err.code, err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/tasks/:id/start-queue: cancel a start queued for a free host slot
// (core/sessions/start-queue.ts), so Walnut does not start the task by itself. task_stop on a
// task that never started calls it. Answers whether there was one to cancel.
taskV1Router.delete('/tasks/:id/start-queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    let task
    try {
      task = await getTask(paramStr(req.params.id))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
    const { clearStartQueue, cancelQueuedStartByPerson } = await import('../../core/sessions/start-queue.js')
    // `by=person`: the user's Cancel on the task's page, which the task records for its asker.
    const cleared = req.query.by === 'person' ? await cancelQueuedStartByPerson(task.id) : await clearStartQueue(task.id, 'cancelled')
    res.json({ taskId: task.id, cleared })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/start-queue/start: the user's Start now on a queued start. It runs the
// start as it was asked (its asker still gets the reply) as the user's own start, which never
// waits for a host slot. 404 when nothing is queued for the task.
taskV1Router.post('/tasks/:id/start-queue/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    let task
    try {
      task = await getTask(paramStr(req.params.id))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
    const { startQueuedNow } = await import('../../core/sessions/start-queue.js')
    const { SessionExistsError } = await import('../../core/sessions/task-start.js')
    const { QuickStartError } = await import('../../core/sessions/quick-start.js')
    try {
      const started = await startQueuedNow(task.id)
      if (!started) {
        sendError(res, 404, 'not_queued', `Task ${task.id} has no queued start.`)
        return
      }
      res.status(202).json(started)
    } catch (err) {
      if (err instanceof SessionExistsError) {
        sendError(res, 409, 'session_exists', err.message, { existing_session_id: err.existingSessionId })
        return
      }
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, 'start_failed', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/star — RETIRED no-op kept for the frozen contract.
//
// The starred flag was removed from the product (pin + focus_tier is the working
// set). This endpoint stays mounted, still resolves the id (so a bad id is still
// a 404/400), and still answers the documented `{ task, starred }` shape — but
// `starred` is always false and nothing is written. An older iOS build whose
// decoder requires the field keeps working instead of failing the request; its
// star control simply never latches. Any stored `starred: true` on disk is inert.
taskV1Router.post('/tasks/:id/star', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const { getTask } = await import('../../core/task-manager.js')
    try {
      const task = await getTask(id)
      res.json({ task, starred: false })
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

/** Shared body gate for the content-setter endpoints below. */
function requireContent(req: Request, res: Response): string | null {
  const content = (req.body ?? {}).content
  if (typeof content !== 'string') {
    sendError(res, 400, 'bad_request', 'content (string) is required')
    return null
  }
  return content
}

// POST /api/v1/tasks/:id/notes — append a timestamped note entry.
taskV1Router.post('/tasks/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { addNote } = await import('../../core/task-manager.js')
    try {
      res.json(await addNote(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/note — replace the entire note.
taskV1Router.put('/tasks/:id/note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateNote } = await import('../../core/task-manager.js')
    try {
      res.json(await updateNote(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/description
taskV1Router.put('/tasks/:id/description', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateDescription } = await import('../../core/task-manager.js')
    try {
      res.json(await updateDescription(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/summary
taskV1Router.put('/tasks/:id/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateSummary } = await import('../../core/task-manager.js')
    const { trustedCallerSessionId } = await import('../../core/sessions/session-send-core.js')
    const raw = req.headers['x-walnut-caller-sid']
    // A resolved session caller is the writer; a person or an unresolved header leaves it unknown.
    const sessionId = await trustedCallerSessionId((Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined)
    try {
      res.json(await updateSummary(id, content, { sessionId }))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/depends-on { depends_on: string[] } — set dependencies.
taskV1Router.put('/tasks/:id/depends-on', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const dependsOn = (req.body ?? {}).depends_on
    if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === 'string')) {
      sendError(res, 400, 'bad_request', 'depends_on must be an array of strings')
      return
    }
    const tm = await import('../../core/task-manager.js')
    try {
      res.json(await tm.updateTask(id, { set_depends_on: dependsOn }, { source: 'api' }))
    } catch (err) {
      if (err instanceof tm.CircularDependencyError) {
        sendError(res, 409, 'conflict', err.message, { task_id: err.taskId, dep_id: err.depId })
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ─── Reorder + batch ─────────────────────────────────────────────────────────

// PATCH /api/v1/tasks/reorder { project, taskIds } — reorder within ONE project
// group. project '' = Inbox (valid), so the guard is a type check.
// NOTE: Express matches routes in registration order per-router; this router
// only has explicit paths (no bare /tasks/:id PATCH), so no reorder-vs-id clash.
taskV1Router.patch('/tasks/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { project, taskIds } = (req.body ?? {}) as { project?: unknown; taskIds?: unknown }
    if (typeof project !== 'string') {
      sendError(res, 400, 'bad_request', "project must be a string ('' = Inbox)")
      return
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id) => typeof id === 'string')) {
      sendError(res, 400, 'bad_request', 'taskIds must be a non-empty array of strings')
      return
    }
    const { reorderTasks } = await import('../../core/task-manager.js')
    await reorderTasks(project, taskIds as string[])
    bus.emit(EventNames.TASK_REORDERED, { project, taskIds }, ['web-ui'], { source: 'api-v1' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/** Validate a batch body's task_ids. Returns ids or null after replying 400. */
function batchIds(req: Request, res: Response): string[] | null {
  const taskIds = (req.body ?? {}).task_ids
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id: unknown) => typeof id === 'string')) {
    sendError(res, 400, 'bad_request', 'task_ids must be a non-empty array of strings')
    return null
  }
  return taskIds as string[]
}

// POST /api/v1/tasks/batch/phase { task_ids, phase } — partial success by
// design: always 200 with { changed, failed, syncFailed }.
taskV1Router.post('/tasks/batch/phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const phase = (req.body ?? {}).phase
    const { VALID_PHASES } = await import('../../core/phase.js')
    if (typeof phase !== 'string' || !VALID_PHASES.has(phase as TaskPhase)) {
      sendError(res, 400, 'bad_request', `phase must be one of: ${[...VALID_PHASES].join(', ')}`)
      return
    }
    const { setPhaseBulk } = await import('../../core/task-manager.js')
    // A session parks only on a wait outside Walnut and the user (core/sessions/outside-wait.ts).
    const { splitSessionParks, callerSidOf } = await import('../../core/sessions/outside-wait.js')
    const gate = await splitSessionParks(taskIds, phase, callerSidOf(req.headers))
    // ...and closes no task that still holds something for the user (core/sessions/owed-to-user.ts).
    const { splitSessionCloses } = await import('../../core/sessions/owed-to-user.js')
    const closes = await splitSessionCloses(gate.ids, phase, callerSidOf(req.headers))
    const { settleBatch } = await import('../../core/sessions/owed-to-user.js')
    const bulk = closes.ids.length ? await settleBatch(closes.settles, () => setPhaseBulk(closes.ids, phase as TaskPhase)) : { changed: [], failed: [], syncFailed: [] }
    const { changed, syncFailed } = bulk
    const failed = [...bulk.failed, ...gate.refused, ...closes.refused]
    // A person's NEED_ACTION is their own ask (core/sessions/person-needs.ts).
    const { markPersonNeeds } = await import('../../core/sessions/person-needs.js')
    await markPersonNeeds(changed.map((t) => t.id), phase, callerSidOf(req.headers))
    log.web.info('tasks batch phase via api-v1', { count: taskIds.length, changed: changed.length, failed: failed.length, phase })
    // Per-task events so every surface (and the cloud outbox) reconciles the
    // same way it does for a single-task change.
    const eventName = phase === 'COMPLETE' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED
    const fields = phase === 'COMPLETE'
      ? ['status', 'phase', 'completed_at'] // completion no longer touches pin fields (2026-08-26)
      : ['status', 'phase']
    for (const task of changed) {
      bus.emit(eventName, { task, fields }, ['web-ui'], { source: 'api-v1' })
    }
    res.json({ changed, failed, syncFailed })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/batch/delete { task_ids, force? } — partial success:
// always 200 with { deleted, failed }. POST (not DELETE) because the id list
// travels in the body.
taskV1Router.post('/tasks/batch/delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const force = (req.body ?? {}).force === true || req.query.force === 'true'
    const { deleteTasksByIds } = await import('../../core/task-manager.js')
    const { deleted, failed } = await deleteTasksByIds(taskIds, { force })
    log.web.info('tasks batch delete via api-v1', { count: taskIds.length, deleted: deleted.length, failed: failed.length, force })
    for (const task of deleted) {
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'api-v1' })
    }
    res.json({ deleted, failed })
  } catch (err) {
    next(err)
  }
})

// ─── Focus bar (pins + tiers) ────────────────────────────────────────────────

// GET /api/v1/focus/tasks — full tier split (pinned + built-in + custom buckets).
taskV1Router.get('/focus/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTierSplit } = await import('../../core/task-manager.js')
    res.json(await getTierSplit())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/focus/tasks/:id — pin (idempotent). → { pinned_tasks }
taskV1Router.post('/focus/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = await resolveTaskIdPrefix(res, paramStr(req.params.id))
    if (!taskId) return
    const { getPinnedTasks, togglePin } = await import('../../core/task-manager.js')
    const current = await getPinnedTasks()
    if (current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    try {
      const result = await togglePin(taskId)
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
      res.json({ pinned_tasks: result.pinned_tasks })
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot pin a completed task')) {
        sendError(res, 409, 'conflict', err.message)
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/focus/tasks/:id — unpin (idempotent). → { pinned_tasks }
taskV1Router.delete('/focus/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = await resolveTaskIdPrefix(res, paramStr(req.params.id))
    if (!taskId) return
    const { getPinnedTasks, togglePin } = await import('../../core/task-manager.js')
    const current = await getPinnedTasks()
    if (!current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/focus/reorder { task_ids } — reorder pins. Returns the FULL
// TierResult (a pinned-only payload historically made clients wipe tiers).
taskV1Router.put('/focus/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = (req.body ?? {}).task_ids
    if (!Array.isArray(taskIds) || !taskIds.every((id: unknown) => typeof id === 'string')) {
      sendError(res, 400, 'bad_request', 'task_ids must be an array of strings')
      return
    }
    const { reorderPins } = await import('../../core/task-manager.js')
    const result = await reorderPins(taskIds as string[])
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    // pins:true → the REPLICA outbox subscriber relays this as a
    // 'reorder-pins' op (reorderPins itself is emit-silent).
    bus.emit(EventNames.TASK_REORDERED, { pins: true, taskIds: taskIds as string[] }, ['web-ui'], { source: 'api-v1' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

const BUILTIN_TIERS: readonly string[] = PIN_TIER_POLICY.map((entry) => entry.tier)

// PUT /api/v1/focus/tasks/:id/tier { tier } — move a pinned task between tiers.
// A retired built-in name ('backlog', still sent by older phone builds) is
// accepted and lands in its successor.
taskV1Router.put('/focus/tasks/:id/tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = await resolveTaskIdPrefix(res, paramStr(req.params.id))
    if (!taskId) return
    const tier = (req.body ?? {}).tier
    const { getCustomTiers, setFocusTier } = await import('../../core/task-manager.js')
    const customIds = (await getCustomTiers()).map((t) => t.id)
    if (typeof tier !== 'string' || (!BUILTIN_TIERS.includes(migrateFocusTier(tier)) && !customIds.includes(tier))) {
      sendError(res, 400, 'bad_request', `tier must be one of: ${[...BUILTIN_TIERS, ...customIds].join(', ')}`)
      return
    }
    try {
      res.json(await setFocusTier(taskId, tier))
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('Task not found') || err.message.startsWith('Task is not pinned'))) {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/focus/tiers — the registered custom tiers (ordered).
taskV1Router.get('/focus/tiers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getCustomTiers } = await import('../../core/task-manager.js')
    res.json({ tiers: await getCustomTiers() })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
taskV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // A host replica's refusal of a store it only holds a copy of, or a host link that
  // failed: the app's error handler answers it 503 (needs_leader with its why, or
  // host_reconnecting), never a 500 card (middleware/link-failure-answer.ts).
  if (handsToAppErrorHandler(err) && !res.headersSent) { _next(err); return }
  logRouteError(err, 'api-v1 task route error', res)
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
