/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { listSessions, getRecentSessions, getSessionSummaries, getSessionsForTask, getSessionByClaudeId, updateSessionRecord, isTriageSession } from '../../core/session-tracker.js'
import { readSessionHistory, extractPlanContent, rewriteHistoryRemoteImages } from '../../core/session-history.js'
import { listTasks, getTask } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import { isProcessAlive } from '../../utils/process.js'
import { readPlanFromSession, buildPlanExecutionMessage } from '../../utils/plan-message.js'
import type { SessionRecord, Task, WorkStatus } from '../../core/types.js'

/** Recompute process_status live via PID check (for GET responses). */
function enrichWithLiveStatus(sessions: SessionRecord[]): SessionRecord[] {
  for (const s of sessions) {
    // Embedded/SDK sessions have no OS process — trust the stored status
    if (s.provider === 'embedded' || s.provider === 'sdk') continue

    if (s.pid != null) {
      if (s.process_status === 'running' || s.process_status === 'idle') {
        // Verify PID liveness for sessions the DB thinks are alive (running or idle).
        // This catches processes that died without triggering normal shutdown.
        const processName = s.host ? 'ssh' : 'claude'
        if (!isProcessAlive(s.pid, processName)) {
          s.process_status = 'stopped'
        }
      }
      // If DB says 'stopped', trust it — it was set explicitly by session-end,
      // health-monitor, reconciler, or user action. Don't re-check PID because
      // the process may be orphaned/zombie (still alive but session is done).
      // When a session resumes, createSessionRecord() sets process_status='running'
      // in the DB before any API response, so there's no "Stopped + Completed" regression.
    } else if (s.work_status === 'completed' || s.work_status === 'error') {
      // No PID to check and work is done — safe to force stopped
      s.process_status = 'stopped'
    }
  }
  return sessions
}

/** Resolve host aliases to full hostnames from config (for tooltip display). */
async function enrichWithHostnames(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  const hostsNeeded = sessions.some(s => s.host && !s.hostname)
  if (!hostsNeeded) return sessions
  try {
    const config = await getConfig()
    const hosts = config.hosts
    if (!hosts) return sessions
    for (const s of sessions) {
      if (s.host && !s.hostname) {
        const def = hosts[s.host]
        if (def) {
          s.hostname = def.hostname ?? (def as Record<string, unknown>).ssh as string | undefined
        }
      }
    }
  } catch { /* config read failure — non-critical */ }
  return sessions
}

export const sessionsRouter = Router()

// GET /api/sessions/tree — sessions grouped by task hierarchy
sessionsRouter.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hideCompleted = req.query.hideCompleted === 'true'
    const sessions = await enrichWithHostnames(enrichWithLiveStatus(await listSessions()))
    const tasks = await listTasks()
    const config = await getConfig()
    const favCats: string[] = config.favorites?.categories ?? []
    const favProjs: string[] = config.favorites?.projects ?? []

    // Build taskId → sessions map
    const taskSessionMap = new Map<string, SessionRecord[]>()
    const orphanSessions: SessionRecord[] = []
    const taskMap = new Map<string, Task>()

    for (const t of tasks) {
      taskMap.set(t.id, t)
    }

    for (const s of sessions) {
      // Triage subagent runs are high-volume housekeeping — exclude from session tree.
      // Non-triage embedded sessions (e.g. general agent) are shown.
      if (isTriageSession(s)) continue
      if (s.archived) continue
      if (hideCompleted && s.work_status === 'completed') continue
      if (!s.taskId || !taskMap.has(s.taskId)) {
        orphanSessions.push(s)
      } else {
        const list = taskSessionMap.get(s.taskId) ?? []
        list.push(s)
        taskSessionMap.set(s.taskId, list)
      }
    }

    // Build hierarchy from tasks that have sessions
    interface TreeTask { taskId: string; taskTitle: string; taskStatus: string; taskPriority: string; taskStarred: boolean; sessions: SessionRecord[] }
    interface TreeProject { project: string; tasks: TreeTask[] }
    interface TreeCategory { category: string; projects: TreeProject[]; directTasks: TreeTask[] }

    const categoryMap = new Map<string, { projects: Map<string, TreeTask[]>; directTasks: TreeTask[] }>()

    for (const [taskId, taskSessions] of taskSessionMap) {
      const task = taskMap.get(taskId)!
      const treeTask: TreeTask = {
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        taskPriority: task.priority,
        taskStarred: !!task.starred
          || favCats.some(c => c.toLowerCase() === (task.category || '').toLowerCase())
          || favProjs.some(p => p.toLowerCase() === (task.project || '').toLowerCase()),
        sessions: taskSessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      }

      const cat = task.category || 'Uncategorized'
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { projects: new Map(), directTasks: [] })
      }
      const catEntry = categoryMap.get(cat)!

      if (!task.project || task.project === cat) {
        catEntry.directTasks.push(treeTask)
      } else {
        const projTasks = catEntry.projects.get(task.project) ?? []
        projTasks.push(treeTask)
        catEntry.projects.set(task.project, projTasks)
      }
    }

    // Convert to array
    const tree: TreeCategory[] = []
    for (const [cat, entry] of categoryMap) {
      const projects: TreeProject[] = []
      for (const [proj, projTasks] of entry.projects) {
        projects.push({ project: proj, tasks: projTasks })
      }
      tree.push({ category: cat, projects, directTasks: entry.directTasks })
    }

    // Sort categories alphabetically
    tree.sort((a, b) => a.category.localeCompare(b.category))

    res.json({ tree, orphanSessions })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions
sessionsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await listSessions()
    const sessions = all.filter(s => !isTriageSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/recent
sessionsRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const all = await getRecentSessions(limit)
    const sessions = all.filter(s => !isTriageSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/summaries
sessionsRouter.get('/summaries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const summaries = await getSessionSummaries(limit)
    res.json({ summaries })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/task/:taskId
sessionsRouter.get('/task/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Resolve task ID prefix to full ID (frontend may pass short prefix from URL params)
    let taskId = String(req.params.taskId)
    try {
      const task = await getTask(taskId)
      taskId = task.id
    } catch { /* task not found — use raw param as-is */ }
    const all = await getSessionsForTask(taskId)
    // Exclude triage subagent runs (archived sessions kept — frontend needs them for collapsed section)
    const sessions = all.filter(s => !isTriageSession(s))
    res.json({ sessions: await enrichWithHostnames(enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId
sessionsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionByClaudeId(String(req.params.sessionId))
    if (!session) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const [enriched] = await enrichWithHostnames(enrichWithLiveStatus([session]))
    res.json({ session: enriched })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/sessions/:sessionId
sessionsRouter.patch('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, work_status, activity, human_note, archived, archive_reason } = req.body as { title?: string; work_status?: WorkStatus; activity?: string; human_note?: string; archived?: boolean; archive_reason?: string }

    if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
      res.status(400).json({ error: 'title must be a string (max 500 chars)' })
      return
    }

    if (human_note !== undefined && (typeof human_note !== 'string' || human_note.length > 50000)) {
      res.status(400).json({ error: 'human_note must be a string (max 50000 chars)' })
      return
    }

    if (work_status !== undefined) {
      const allowed: WorkStatus[] = ['await_human_action', 'agent_complete', 'completed']
      if (!allowed.includes(work_status)) {
        res.status(400).json({ error: `work_status must be one of: ${allowed.join(', ')}` })
        return
      }
    }

    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }

    const sessionId = String(req.params.sessionId)

    // Archive/unarchive: validate session is stopped before archiving
    if (archived === true) {
      const existing = await getSessionByClaudeId(sessionId)
      if (!existing) {
        res.status(404).json({ error: 'session not found' })
        return
      }
      if (existing.process_status !== 'stopped') {
        res.status(400).json({ error: 'Stop session before archiving' })
        return
      }
    }

    const updates: Partial<SessionRecord> = {}
    if (title !== undefined) updates.title = title
    if (work_status !== undefined) {
      updates.work_status = work_status
      updates.last_status_change = new Date().toISOString()
      if (work_status === 'completed') updates.activity = undefined
    }
    if (activity !== undefined) updates.activity = activity
    if (human_note !== undefined) updates.human_note = human_note
    if (archived !== undefined) {
      updates.archived = archived
      if (archived && archive_reason) updates.archive_reason = archive_reason
      if (!archived) updates.archive_reason = undefined  // clear reason on unarchive
    }

    const updated = await updateSessionRecord(sessionId, updates)
    log.web.info('session updated via REST', { sessionId, fields: Object.keys(updates) })

    // Emit status change so frontend updates in real time
    if (work_status !== undefined || archived !== undefined) {
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId,
        taskId: updated.taskId,
        process_status: updated.process_status,
        work_status: updated.work_status,
        activity: updated.activity,
        mode: updated.mode,
        ...(updated.planCompleted ? { planCompleted: true } : {}),
        ...(archived !== undefined ? { archived } : {}),
      }, ['web-ui'])
    }

    // Archive: clear task session slot to free it for new sessions
    if (archived === true && updated.taskId) {
      try {
        const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
        await clearSession(updated.taskId, sessionId)
        const { task } = await clearSessionSlot(updated.taskId, sessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-archived' })
      } catch { /* task may not exist */ }
    }

    // When work is marked fully completed (human verification done), clear the task session slot.
    // Only 'completed' (human-set) clears the task session slot.
    if (work_status === 'completed' && updated.taskId) {
      try {
        const { clearSessionSlot } = await import('../../core/task-manager.js')
        const { task } = await clearSessionSlot(updated.taskId, sessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-completed' })
      } catch { /* task may not exist */ }
    }

    res.json({ session: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      res.status(404).json({ error: message })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId/history
sessionsRouter.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string

    // Look up session record to get cwd
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd

    let messages = await readSessionHistory(sessionId, cwd, record?.host, record?.outputFile)
    if (messages.length === 0 && !record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Rewrite remote image paths to local paths for remote sessions
    if (record?.host) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId)
    }

    res.json({ messages })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/plan — read plan content for a plan session (or its source plan session)
sessionsRouter.get('/:sessionId/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // If this is an execution session with fromPlanSessionId, follow the link to the source plan session
    const planSessionId = record.fromPlanSessionId ?? sessionId
    const isFollowedLink = planSessionId !== sessionId

    // Strategy 1: readPlanFromSession (planFile on disk, or JSONL slug → file)
    const planResult = await readPlanFromSession(planSessionId)
    if (!('error' in planResult)) {
      res.json({
        content: planResult.content,
        planFile: planResult.planFile,
        sourceSessionId: isFollowedLink ? planSessionId : undefined,
      })
      return
    }

    // Strategy 2: extractPlanContent from JSONL (Write to plans/ or ExitPlanMode.input.plan)
    const planRecord = isFollowedLink ? await getSessionByClaudeId(planSessionId) : record
    if (planRecord) {
      const extracted = await extractPlanContent(planSessionId, planRecord.cwd, planRecord.host)
      if (extracted) {
        res.json({
          content: extracted,
          planFile: planRecord.planFile ?? undefined,
          sourceSessionId: isFollowedLink ? planSessionId : undefined,
        })
        return
      }
    }

    res.status(404).json({ error: 'No plan content found for this session' })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-continue — resume a completed plan session with bypass permissions
sessionsRouter.post('/:sessionId/execute-continue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const session = await getSessionByClaudeId(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!session.planCompleted) {
      res.status(400).json({ error: 'Not a completed plan session' })
      return
    }
    // Update mode to bypass for execution
    await updateSessionRecord(session.claudeSessionId, { mode: 'bypass' })

    // If session process is alive (running or idle), stop it first
    // so it restarts with bypass permissions via --resume
    const needsInterrupt = session.process_status !== 'stopped'

    // Enqueue message and emit SESSION_SEND (same pattern as send_to_session)
    const message = 'Execute the plan. Implement all steps as planned.'
    const { enqueueMessage } = await import('../../core/session-message-queue.js')
    await enqueueMessage(session.claudeSessionId, message)
    bus.emit(EventNames.SESSION_SEND, {
      sessionId: session.claudeSessionId,
      taskId: session.taskId,
      message,
      mode: 'bypass',
      ...(needsInterrupt ? { interrupt: true } : {}),
    }, ['session-runner'], { source: 'web-api' })

    log.web.info('execute-continue: resuming plan session with bypass', { sessionId: session.claudeSessionId })

    res.json({ status: 'started', sessionId: session.claudeSessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute — execute a completed plan session
sessionsRouter.post('/:sessionId/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const planSessionId = req.params.sessionId as string
    const { task_id, working_directory, instructions, mode, host } = req.body as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
      host?: string
    }

    // Read plan file via shared resolver (same logic as agent tool's from_plan path)
    const planResult = await readPlanFromSession(planSessionId)
    if ('error' in planResult) {
      // Distinguish "session not found" (404) from "session exists but not a plan" (400)
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const record = await getSessionByClaudeId(planSessionId)
    const taskId = task_id ?? record?.taskId
    const cwd = working_directory ?? record?.cwd
    if (!cwd) {
      res.status(400).json({ error: 'working_directory is required (plan session has no stored cwd).' })
      return
    }

    const validModes = ['bypass', 'accept', 'default', 'plan']
    if (mode && !validModes.includes(mode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
      return
    }
    const execMode = mode ?? 'bypass'

    // Build message with plan content + file path reference (survives compaction via re-read).
    const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, instructions)

    // Use host from request body, or inherit from the plan session
    const execHost = host ?? record?.host

    // Archive the plan session (hidden from UI) and preserve planContent
    await updateSessionRecord(planSessionId, {
      archived: true,
      archive_reason: 'plan_executed',
      planContent: planResult.content,
    })
    log.web.info('execute: archived plan session', { planSessionId })

    // Clear task session slot so UI no longer shows archived plan as active
    if (taskId) {
      try {
        const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
        await clearSession(taskId, planSessionId)
        const { task } = await clearSessionSlot(taskId, planSessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-archived' })
      } catch { /* task may not exist */ }
    }

    // Notify frontend about the archive
    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: planSessionId,
      taskId: taskId ?? '',
      archived: true,
    }, ['web-ui'])

    // Set up a temporary bus listener BEFORE emitting SESSION_START so we
    // catch the status-changed event that carries the new session's ID.
    const WAIT_TIMEOUT_MS = 30_000
    const subName = `exec-wait-${planSessionId}`
    const newSessionPromise = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subName)
        resolve(undefined)
      }, WAIT_TIMEOUT_MS)

      bus.subscribe(subName, (event) => {
        if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
        const d = eventData<'session:status-changed'>(event)
        if (d.fromPlanSessionId === planSessionId && d.sessionId) {
          clearTimeout(timer)
          bus.unsubscribe(subName)
          resolve(d.sessionId)
        }
      }, { global: true })
    })

    bus.emit(EventNames.SESSION_START, {
      taskId: taskId ?? '',
      message: planMessage,
      cwd,
      project: record?.project ?? '',
      mode: execMode,
      title: `Execute plan from ${planSessionId.slice(0, 16)}...`,
      ...(execHost ? { host: execHost } : {}),
      fromPlanSessionId: planSessionId,
    }, ['session-runner'], { source: 'web-api' })

    // Wait for the new session to start (up to 30s) so we can return its ID
    const newSessionId = await newSessionPromise

    res.json({ status: 'started', planSessionId, taskId, mode: execMode, ...(newSessionId ? { sessionId: newSessionId } : {}), ...(execHost ? { host: execHost } : {}) })
  } catch (err) {
    next(err)
  }
})
