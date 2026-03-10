/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { listSessions, getRecentSessions, getSessionSummaries, getSessionsForTask, getSessionByClaudeId, updateSessionRecord, isTriageSession } from '../../core/session-tracker.js'
import { readSessionHistory, extractPlanContent, rewriteHistoryRemoteImages } from '../../core/session-history.js'
import { listTasks, getTask, addTask, updateTask } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import path from 'path'
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

// GET /api/sessions/working-dirs — deduplicated working directories from session history
sessionsRouter.get('/working-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await listSessions()
    const tasks = await listTasks()
    const config = await getConfig()

    // Build taskId → category map
    const taskCategoryMap = new Map<string, string>()
    for (const t of tasks) {
      taskCategoryMap.set(t.id, t.category)
    }

    // Aggregate (cwd, host) pairs with frequency + recency + category votes
    interface DirAgg {
      cwd: string
      host: string | null
      count: number
      lastUsed: string
      categoryVotes: Map<string, number>
    }

    const dirMap = new Map<string, DirAgg>()

    for (const s of sessions) {
      if (!s.cwd) continue
      if (isTriageSession(s)) continue
      if (s.archived) continue

      const key = `${s.cwd}::${s.host ?? '__local__'}`
      const existing = dirMap.get(key)
      const category = s.taskId ? taskCategoryMap.get(s.taskId) : undefined

      if (existing) {
        existing.count++
        if (s.startedAt > existing.lastUsed) existing.lastUsed = s.startedAt
        if (category) existing.categoryVotes.set(category, (existing.categoryVotes.get(category) ?? 0) + 1)
      } else {
        const votes = new Map<string, number>()
        if (category) votes.set(category, 1)
        dirMap.set(key, {
          cwd: s.cwd,
          host: s.host ?? null,
          count: 1,
          lastUsed: s.startedAt,
          categoryVotes: votes,
        })
      }
    }

    // Resolve majority-vote category and host labels
    const hosts = config.hosts ?? {}
    const now = Date.now()
    const entries: Array<{
      cwd: string
      host: string | null
      hostLabel?: string
      category: string
      count: number
      lastUsed: string
      score: number
    }> = []

    // Find max age and max count for normalization
    let maxAgeMs = 1
    let maxCount = 1
    for (const agg of dirMap.values()) {
      const age = now - new Date(agg.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (agg.count > maxCount) maxCount = agg.count
    }

    for (const agg of dirMap.values()) {
      // Majority vote for category
      let bestCat = config.defaults?.category ?? 'Inbox'
      let bestCount = 0
      for (const [cat, cnt] of agg.categoryVotes) {
        if (cnt > bestCount) { bestCat = cat; bestCount = cnt }
      }

      // Host label from config
      const hostLabel = agg.host ? hosts[agg.host]?.label ?? agg.host : undefined

      // Score: normalized frequency * 0.3 + recency * 0.7 (both in [0,1])
      const ageMs = now - new Date(agg.lastUsed).getTime()
      const recencyScore = 1 - (ageMs / maxAgeMs)
      const freqScore = agg.count / maxCount
      const score = freqScore * 0.3 + recencyScore * 0.7

      entries.push({
        cwd: agg.cwd,
        host: agg.host,
        hostLabel,
        category: bestCat,
        count: agg.count,
        lastUsed: agg.lastUsed,
        score,
      })
    }

    // Sort by score descending
    entries.sort((a, b) => b.score - a.score)

    // Strip score from response
    const dirs = entries.map(({ score: _s, ...rest }) => rest)
    res.json({ dirs })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/quick-start — create task + start session in one step
sessionsRouter.post('/quick-start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cwd, host, message, category, model, mode } = req.body as {
      cwd: string
      host?: string
      message: string
      category?: string
      model?: string
      mode?: string
    }

    if (!cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd is required' })
      return
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' })
      return
    }

    if (mode) {
      const validModes = ['bypass', 'accept', 'default', 'plan']
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
        return
      }
    }

    // Length limits
    if (cwd.length > 4096) {
      res.status(400).json({ error: 'cwd too long (max 4096 chars)' })
      return
    }
    if (message.length > 50000) {
      res.status(400).json({ error: 'message too long (max 50000 chars)' })
      return
    }

    const config = await getConfig()
    const taskCategory = category || config.defaults?.category || 'Inbox'
    const title = `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`

    // Create task in "Quick Start" project under the determined category
    const { task } = await addTask({
      title,
      category: taskCategory,
      project: 'Quick Start',
    })

    // Star the task and set cwd
    await updateTask(task.id, { starred: true, cwd })

    // Re-read to get updated fields
    const updatedTask = await getTask(task.id)

    bus.emit(EventNames.TASK_CREATED, { task: updatedTask }, ['web-ui', 'main-agent'], { source: 'quick-start' })

    // Build system prompt hint for session AI
    const appendSystemPrompt = [
      '<quick_start_task>',
      'This task was created via Quick Start. When your work is complete:',
      '1. Update the task title to be descriptive (replace the generic "Session: ..." title) using update_task',
      `2. If "${taskCategory} / Quick Start" is not the right project, move the task to the correct project within the same category "${taskCategory}" using update_task with the project field`,
      '</quick_start_task>',
    ].join('\n')

    // Emit SESSION_START event
    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message,
      cwd,
      project: 'Quick Start',
      mode,
      model,
      host,
      appendSystemPrompt,
    }, ['session-runner'], { source: 'quick-start' })

    log.web.info('quick-start: created task + started session', { taskId: task.id, cwd, host, category: taskCategory })

    res.json({ taskId: task.id, task: updatedTask })
  } catch (err) {
    next(err)
  }
})

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
// ?source=streams — fast path: read local streams file only (skip SSH), ~1ms
sessionsRouter.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const source = req.query.source as string | undefined

    // Look up session record to get cwd
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd

    if (source === 'streams') {
      // Fast path: host=undefined forces local-only reads (canonical local + streams fallback).
      // Skips SSH entirely — ideal for instant first paint of FocusDock cards.
      const messages = await readSessionHistory(sessionId, cwd, undefined, record?.outputFile)
      res.json({ messages })
      return
    }

    // Full path: reads from source of truth (SSH for remote sessions)
    let messages = await readSessionHistory(sessionId, cwd, record?.host, record?.outputFile)
    if (messages.length === 0 && !record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Rewrite remote image paths to local paths for remote sessions
    if (record?.host) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd)
    }

    // Fork-aware: prepend source session history when this session was forked.
    // Follows the fork chain (A forked from B forked from C) with cycle detection.
    let forkedFromSessionId: string | undefined
    if (record?.forkedFromSessionId) {
      forkedFromSessionId = record.forkedFromSessionId
      try {
        const forkChainMessages: typeof messages[] = []
        const visited = new Set<string>([sessionId])
        let currentForkId: string | undefined = record.forkedFromSessionId

        while (currentForkId && !visited.has(currentForkId)) {
          visited.add(currentForkId)
          const sourceRecord = await getSessionByClaudeId(currentForkId)
          if (!sourceRecord) break

          let sourceMessages = await readSessionHistory(
            currentForkId, sourceRecord.cwd, sourceRecord.host, sourceRecord.outputFile,
          )
          if (sourceRecord.host) {
            sourceMessages = await rewriteHistoryRemoteImages(sourceMessages, sourceRecord.host, currentForkId, sourceRecord.cwd)
          }
          if (sourceMessages.length > 0) {
            forkChainMessages.unshift(sourceMessages)
          }
          currentForkId = sourceRecord.forkedFromSessionId
        }

        if (forkChainMessages.length > 0) {
          const allSourceMessages = forkChainMessages.flat()
          const separator: typeof messages[0] = {
            role: 'assistant',
            text: `--- Forked from session ${record.forkedFromSessionId.slice(0, 16)}... ---`,
            timestamp: record.startedAt ?? new Date().toISOString(),
          }
          messages = [...allSourceMessages, separator, ...messages]
        }
      } catch (err) {
        log.web.warn('failed to load fork source history', {
          sessionId, forkedFrom: record.forkedFromSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    res.json({ messages, ...(forkedFromSessionId ? { forkedFromSessionId } : {}) })
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

// POST /api/sessions/:sessionId/fork — fork a session to a different task
sessionsRouter.post('/:sessionId/fork', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceSessionId = req.params.sessionId as string
    const { task_id, create_child_task, child_title, message, title, model } = req.body as {
      task_id?: string
      create_child_task?: boolean
      child_title?: string
      message?: string
      title?: string
      model?: string
    }

    if (!task_id && !create_child_task) {
      res.status(400).json({ error: 'Either task_id or create_child_task is required' })
      return
    }
    if (task_id && create_child_task) {
      res.status(400).json({ error: 'task_id and create_child_task are mutually exclusive' })
      return
    }

    // Look up source session
    const sourceRecord = await getSessionByClaudeId(sourceSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Source session not found' })
      return
    }

    // Validate source session has a working directory BEFORE creating any child tasks
    if (!sourceRecord.cwd) {
      res.status(400).json({ error: 'Source session has no working directory — cannot fork' })
      return
    }

    let task: Task | undefined
    let childTaskCreated = false

    if (create_child_task) {
      // Auto-create a child task under the source session's task
      if (!sourceRecord.taskId) {
        res.status(400).json({ error: 'Source session has no task — cannot create child task' })
        return
      }
      let parentTask: Task
      try {
        parentTask = await getTask(sourceRecord.taskId)
      } catch {
        res.status(404).json({ error: `Parent task "${sourceRecord.taskId}" not found` })
        return
      }
      const newTitle = child_title ?? `Fork of ${parentTask.title}`
      const { task: newChild } = await addTask({
        title: newTitle,
        category: parentTask.category,
        project: parentTask.project,
        parent_task_id: parentTask.id,
        source: parentTask.source,
      })
      bus.emit(EventNames.TASK_CREATED, { task: newChild }, ['web-ui', 'main-agent'], { source: 'fork' })
      task = newChild
      childTaskCreated = true
    } else {
      // Look up target task by provided task_id
      task = await getTask(task_id!)
      if (!task) {
        res.status(404).json({ error: `Task "${task_id}" not found` })
        return
      }
    }

    // Check 1-session-per-task
    const existingSessions = await getSessionsForTask(task.id)
    const activeSessions = existingSessions.filter(s => !s.archived)
    if (activeSessions.length > 0) {
      res.status(409).json({
        error: 'Target task already has a session',
        existing_session_id: activeSessions[0].claudeSessionId,
      })
      return
    }

    // Build fork context from source session history
    const { formatForkHistory } = await import('../../core/session-history.js')
    const sourceMessages = await readSessionHistory(
      sourceSessionId, sourceRecord.cwd, sourceRecord.host, sourceRecord.outputFile,
    )
    let appendSystemPrompt: string | undefined
    if (sourceMessages.length > 0) {
      const historyText = formatForkHistory(sourceMessages)
      appendSystemPrompt = `<forked_session_context>\nThis session was forked from session ${sourceSessionId}.\nBelow is the conversation history from the source session:\n\n${historyText}\n</forked_session_context>`
    }

    const forkMessage = message ?? `Continue working. This session was forked from a previous session to focus on task: ${task.title}`

    // Wait for the new session to start (up to 30s)
    const WAIT_TIMEOUT_MS = 30_000
    const subName = `fork-wait-${sourceSessionId}`
    const newSessionPromise = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subName)
        resolve(undefined)
      }, WAIT_TIMEOUT_MS)

      bus.subscribe(subName, (event) => {
        if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
        const d = eventData<'session:status-changed'>(event)
        if (d.forkedFromSessionId === sourceSessionId && d.sessionId) {
          clearTimeout(timer)
          bus.unsubscribe(subName)
          resolve(d.sessionId)
        }
      }, { global: true })
    })

    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: forkMessage,
      cwd: sourceRecord.cwd,
      project: task.project ?? '',
      mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
      model,
      title: title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`,
      host: sourceRecord.host,
      appendSystemPrompt,
      forkedFromSessionId: sourceSessionId,
    }, ['session-runner'], { source: 'web-api' })

    const newSessionId = await newSessionPromise

    res.json({
      status: 'started',
      sourceSessionId,
      taskId: task.id,
      ...(childTaskCreated ? { childTaskCreated: true } : {}),
      ...(newSessionId ? { sessionId: newSessionId } : {}),
      ...(sourceRecord.host ? { host: sourceRecord.host } : {}),
    })
  } catch (err) {
    next(err)
  }
})
