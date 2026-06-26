/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { listSessions, getRecentSessions, getSessionSummaries, getSessionsForTask, getSessionByClaudeId, updateSessionRecord, isTriageSession, isEnvironmentSession } from '../../core/session-tracker.js'
import { readSessionHistory, readSingleSubagentHistory, reconstructWorkflowProgress, extractPlanContent, rewriteHistoryRemoteImages } from '../../core/session-history.js'
import { computeSessionChanges } from '../../core/session-changes.js'
import { computeSessionGitDiff, type GitDiffBase } from '../../core/session-git-diff.js'
import { listTasks, getTask, addTask, updateTask, togglePin, setFocusTier, linkSession, groupTasks, addToGroup, renameGroup } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import fsp from 'node:fs/promises'
import path from 'path'
import { isSessionProcessAlive } from '../../utils/session-liveness.js'
import { readPlanFromSession, buildPlanExecutionMessage } from '../../utils/plan-message.js'
import { injectCompactBoundary, buildCompactSummary } from '../../utils/compact-inject.js'
import { findLocalJsonlPath } from '../../core/session-file-reader.js'
import { getFrequentDirs, compileFromSessions } from '../../core/frequent-dirs.js'
import type { SessionRecord, Task } from '../../core/types.js'
import { VALID_SESSION_MODEL_IDS } from '../../core/types.js'
import type { SessionHistoryMessage } from '../../core/session-history.js'
import { processAndSaveImages, buildSessionImageContext } from './images.js'
import { sessionRunner } from '../../providers/claude-code-session.js'
import { listSideQuestions, addSideQuestion, getSideQuestion, markPromoted, deleteSideQuestion } from '../../core/side-questions.js'
import type { ImagePayload } from './images.js'
import { spillLargePromptToFile } from './quick-start-spill.js'
import { QUICK_START_MESSAGE_HARD_LIMIT } from '../../constants.js'

/** Diagnose message ordering — logs whether user text messages are interleaved or bunched at end. */
function logMessageOrdering(phase: string, sessionId: string, messages: SessionHistoryMessage[], host?: string): void {
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i].text?.trim()) userIndices.push(i)
  }
  if (userIndices.length <= 1) return // no diagnostic needed for 0-1 user messages
  const lastAsst = messages.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1)
  const usersAfterLastAsst = userIndices.filter(i => i > lastAsst).length
  const bunched = usersAfterLastAsst > userIndices.length / 2
  if (!bunched) return // only log anomalies — skip normal cases to reduce production noise
  log.web.warn('session history: user messages bunched at end', {
    phase,
    sessionId: sessionId.substring(0, 8),
    host: host ?? 'local',
    total: messages.length,
    userText: userIndices.length,
    lastAsstIdx: lastAsst,
    usersAfterLastAsst,
  })
}

/** Recompute process_status live via PID check (for GET responses).
 *  Runs all PID checks in parallel to avoid blocking the event loop. */
async function enrichWithLiveStatus(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  // Parallel liveness checks via unified session liveness utility.
  // Routes to local PID check for local sessions, daemon connection check for remote.
  const needsCheck: number[] = []
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    if (s.process_status === 'running' || s.process_status === 'idle') {
      needsCheck.push(i)
    }
  }

  if (needsCheck.length > 0) {
    const results = await Promise.allSettled(
      needsCheck.map(i => isSessionProcessAlive(sessions[i]))
    )
    for (let j = 0; j < needsCheck.length; j++) {
      const r = results[j]
      const alive = r.status === 'fulfilled' && r.value === true
      if (!alive) {
        sessions[needsCheck[j]].process_status = 'stopped'
      }
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
          s.hostname = def.hostname
        }
      }
    }
  } catch { /* config read failure — non-critical */ }
  return sessions
}

export const sessionsRouter = Router()

// GET /api/sessions/working-dirs — deduplicated working directories from persistent store
sessionsRouter.get('/working-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    const defaultCat = config.defaults?.category ?? 'Inbox'
    const now = Date.now()

    // Find max age and max count for normalization
    let maxAgeMs = 1
    let maxCount = 1
    for (const d of dirs) {
      const age = now - new Date(d.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (d.count > maxCount) maxCount = d.count
    }

    // Compute score, hostLabel, resolved category at read time
    const entries = dirs.map(d => {
      // Majority vote for category
      let bestCat = defaultCat
      let bestCount = 0
      for (const [cat, cnt] of Object.entries(d.categoryVotes)) {
        if (cnt > bestCount) { bestCat = cat; bestCount = cnt }
      }

      const hostLabel = d.host ? hosts[d.host]?.label ?? d.host : undefined
      const ageMs = now - new Date(d.lastUsed).getTime()
      const recencyScore = 1 - (ageMs / maxAgeMs)
      const freqScore = d.count / maxCount
      const score = freqScore * 0.3 + recencyScore * 0.7

      return {
        cwd: d.cwd,
        host: d.host,
        hostLabel,
        category: bestCat,
        count: d.count,
        lastUsed: d.lastUsed,
        score,
      }
    })

    entries.sort((a, b) => b.score - a.score)
    const result = entries.map(({ score: _s, ...rest }) => rest)
    res.json({ dirs: result })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/working-dirs/recompile — rebuild frequent-directories.json from sessions
sessionsRouter.post('/working-dirs/recompile', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // compileFromSessions imported statically at top
    await compileFromSessions()
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    res.json({ status: 'ok', count: dirs.length })
  } catch (err) {
    next(err)
  }
})

// In-memory cache for SSH directory listings (avoid re-SSHing for 60s)
const dirCache = new Map<string, { dirs: string[]; ts: number }>()
const DIR_CACHE_TTL = 60_000

// GET /api/sessions/list-dirs — list subdirectories on a host (local or daemon) for path auto-complete
// Remote hosts use DaemonConnection for fast directory listing.
sessionsRouter.get('/list-dirs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prefix = String(req.query.prefix ?? '/')
    const host = req.query.host as string | undefined
    const depth = Math.min(Number(req.query.depth) || 2, 4) // preload depth, default 2, max 4

    if (prefix.length > 4096) {
      res.status(400).json({ error: 'prefix too long' })
      return
    }

    // Sanitize: no shell metacharacters allowed in prefix
    if (/[;&|`$(){}!<>]/.test(prefix)) {
      res.status(400).json({ error: 'invalid characters in prefix' })
      return
    }

    // Expand ~ to home directory
    let expandedPrefix = prefix
    if (expandedPrefix === '~' || expandedPrefix.startsWith('~/')) {
      if (host) {
        // Remote: keep ~ as-is — the daemon's fs.ls handles ~ expansion on the remote host
      } else {
        const os = await import('node:os')
        const home = os.homedir()
        // Preserve trailing slash: ~/ → /Users/me/, ~/foo → /Users/me/foo
        expandedPrefix = home + expandedPrefix.slice(1)
      }
    }

    // Find the parent directory to list.
    // Partial matching is handled by the frontend's filterChildren — backend returns all entries.
    const dir = expandedPrefix.endsWith('/') ? expandedPrefix : path.dirname(expandedPrefix)

    if (host) {
      // Remote: resolve host from config and use DaemonConnection for directory listing
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef) {
        res.status(400).json({ error: `Unknown host: ${host}` })
        return
      }
      const hostname = hostDef.hostname
      if (!hostname) {
        res.status(400).json({ error: `Host "${host}" has no hostname` })
        return
      }

      // Check in-memory cache first
      const cacheKey = `${host}::${dir}::${depth}`
      const cached = dirCache.get(cacheKey)
      if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
        res.json({ dirs: cached.dirs, parent: dir, cached: true })
        return
      }

      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
      // Race against a 15s timeout to cap HTTP request wait time.
      // The failure cache in daemon-connection.ts prevents retries for 60s after a failure.
      let timeoutId: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), 15_000)
      })
      const conn = await Promise.race([
        getDaemonConnection(host, sshTarget),
        timeoutPromise,
      ]).finally(() => clearTimeout(timeoutId!))

      // Recursive BFS directory listing via daemon's fs.ls command.
      // The daemon's fs.ls expands ~ to the remote home directory.
      const entries: string[] = []
      let resolvedDir = dir

      // First call resolves ~ and gives us the real base path
      const rootResult = await conn.send('fs.ls', { path: dir })
      if (!rootResult.ok) {
        res.status(400).json({ error: `Cannot list directory: ${rootResult.error ?? dir}` })
        return
      }
      if (rootResult.resolvedPath && typeof rootResult.resolvedPath === 'string') {
        resolvedDir = (rootResult.resolvedPath as string).endsWith('/')
          ? rootResult.resolvedPath as string
          : rootResult.resolvedPath + '/'
      }

      // Process root entries, then BFS walk
      const queue: { dirPath: string; currentDepth: number }[] = []
      const rootEntries = rootResult.entries as Array<{ name: string; type: string }>
      for (const e of rootEntries) {
        if (e.type !== 'dir' || e.name.startsWith('.')) continue
        const fullPath = resolvedDir.endsWith('/')
          ? `${resolvedDir}${e.name}`
          : `${resolvedDir}/${e.name}`
        entries.push(fullPath)
        if (depth > 1) {
          queue.push({ dirPath: fullPath, currentDepth: 1 })
        }
      }

      while (queue.length > 0 && entries.length < 500) {
        const batch = queue.splice(0, queue.length)
        for (const item of batch) {
          if (entries.length >= 500) break
          try {
            const result = await conn.send('fs.ls', { path: item.dirPath })
            if (!result.ok) continue
            const lsEntries = result.entries as Array<{ name: string; type: string }>
            for (const e of lsEntries) {
              if (entries.length >= 500) break
              if (e.type !== 'dir' || e.name.startsWith('.')) continue
              const fullPath = `${item.dirPath}/${e.name}`
              entries.push(fullPath)
              if (item.currentDepth + 1 < depth) {
                queue.push({ dirPath: fullPath, currentDepth: item.currentDepth + 1 })
              }
            }
          } catch {
            // Directory unreadable or daemon error — skip
          }
        }
      }

      // Cache results
      const resolvedCacheKey = `${host}::${resolvedDir}::${depth}`
      dirCache.set(cacheKey, { dirs: entries, ts: Date.now() })
      if (resolvedCacheKey !== cacheKey) {
        dirCache.set(resolvedCacheKey, { dirs: entries, ts: Date.now() })
      }

      res.json({ dirs: entries, parent: resolvedDir })
    } else {
      // Local filesystem — also preload multiple levels (async to avoid blocking event loop)
      const entries: string[] = []
      const walkLocal = async (d: string, currentDepth: number) => {
        if (currentDepth > depth || entries.length >= 500) return
        try {
          const dirents = await fsp.readdir(d, { withFileTypes: true })
          for (const dirent of dirents) {
            if (entries.length >= 500) break
            // Skip hidden directories
            if (dirent.name.startsWith('.')) continue
            if (dirent.isDirectory()) {
              const full = path.join(d, dirent.name)
              entries.push(full)
              if (currentDepth < depth) await walkLocal(full, currentDepth + 1)
            }
          }
        } catch { /* dir doesn't exist or is unreadable */ }
      }
      await walkLocal(dir, 1)

      res.json({ dirs: entries, parent: dir })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // SSH failures return 400, not 500
    res.status(400).json({ error: msg })
  }
})

// POST /api/sessions/quick-start — create task + start session in one step
sessionsRouter.post('/quick-start', async (req: Request, res: Response, next: NextFunction) => {
  const requestTs = Date.now()
  try {
    const { cwd, host, message, model: rawModel, mode, images, taskId: existingTaskId, taskMeta } = req.body as {
      cwd: string
      host?: string
      message: string
      model?: string
      mode?: string
      images?: ImagePayload[]
      taskId?: string // retry mode: reuse existing task instead of creating a new one
      taskMeta?: {
        starred?: boolean
        needs_attention?: boolean
        priority?: 'immediate' | 'important' | 'backlog' | 'none'
        pinTier?: 'focus' | 'satellite' | 'wait'
      }
    }

    if (!cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd is required' })
      return
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' })
      return
    }

    // Normalize model against the SESSION_MODELS allowlist (same as the session:start
    // RPC). Unknown/absent → undefined = Auto: send() falls back to config/CLI default.
    const model = typeof rawModel === 'string' && VALID_SESSION_MODEL_IDS.has(rawModel) ? rawModel : undefined

    if (mode) {
      const validModes = ['bypass', 'accept', 'default', 'plan']
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
        return
      }
    }

    // Whitelist enum values from taskMeta — these flow into updateTask/setFocusTier
    // and would corrupt task state if arbitrary strings were accepted.
    if (taskMeta?.priority !== undefined && taskMeta.priority !== null) {
      const validPriorities = ['immediate', 'important', 'backlog', 'none']
      if (!validPriorities.includes(taskMeta.priority)) {
        res.status(400).json({ error: `Invalid taskMeta.priority: ${taskMeta.priority}. Must be one of: ${validPriorities.join(', ')}` })
        return
      }
    }
    if (taskMeta?.pinTier !== undefined && taskMeta.pinTier !== null) {
      const validTiers = ['focus', 'satellite', 'wait']
      if (!validTiers.includes(taskMeta.pinTier)) {
        res.status(400).json({ error: `Invalid taskMeta.pinTier: ${taskMeta.pinTier}. Must be one of: ${validTiers.join(', ')}` })
        return
      }
    }

    // Length limits
    if (cwd.length > 4096) {
      res.status(400).json({ error: 'cwd too long (max 4096 chars)' })
      return
    }
    if (message.length > QUICK_START_MESSAGE_HARD_LIMIT) {
      res.status(400).json({ error: `message too long (max ${QUICK_START_MESSAGE_HARD_LIMIT} chars)` })
      return
    }

    // Spill-to-disk: messages above the inline limit are saved to a temp file and
    // replaced with a short pointer prompt so Claude reads the full context via the Read tool.
    let spilledMessage = message
    let largePromptFile: { localPath: string; originalLength: number } | undefined
    const spill = spillLargePromptToFile(message)
    if (spill) {
      spilledMessage = spill.promptWithPointer
      largePromptFile = { localPath: spill.filePath, originalLength: spill.originalLength }
      log.web.info('quick-start: spilled large prompt to file', {
        filePath: spill.filePath,
        originalLength: spill.originalLength,
        host,
      })
    }

    // Process attached images — save to disk and build session-friendly context
    let sessionMessage = spilledMessage
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) {
        const imageContext = buildSessionImageContext(processed.savedImages)
        sessionMessage = imageContext + spilledMessage
      }
    }

    // Quick Start tasks always go to the built-in 'Local' category (source=local,
    // hard-reserved via config.local.categories so no sync plugin can claim it).
    // The session AI will move the task to the correct category/project after completion.
    const taskCategory = 'Local'

    let updatedTask: Task

    if (existingTaskId) {
      // Retry mode: reuse existing task, archive error sessions.
      // Note: footer taskMeta picks (starred/needs_attention/priority/pinTier) are
      // intentionally IGNORED on retry — we preserve the original task's metadata.
      updatedTask = await getTask(existingTaskId)
      if (!updatedTask) {
        res.status(404).json({ error: `Task "${existingTaskId}" not found` })
        return
      }
      // Archive all error/stopped sessions under this task to free the slot
      const existingSessions = await getSessionsForTask(updatedTask.id)
      for (const s of existingSessions) {
        if (!s.archived && (s.process_status === 'error' || s.process_status === 'stopped')) {
          await updateSessionRecord(s.claudeSessionId, { archived: true, archive_reason: 'retry' })
          try {
            const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
            await clearSession(updatedTask.id, s.claudeSessionId)
            await clearSessionSlot(updatedTask.id, s.claudeSessionId)
          } catch { /* task may not exist */ }
        }
      }
    } else {
      // Normal mode: create new task
      const title = `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`
      const { task } = await addTask({
        title,
        category: taskCategory,
        project: 'Quick Start',
        source: 'local',
      })
      // Merge taskMeta into initial update; `starred` defaults to true for quick-start.
      const updates: Partial<Task> = {
        starred: taskMeta?.starred ?? true,
        cwd,
      }
      if (taskMeta?.needs_attention) updates.needs_attention = true
      // 'none' is a sentinel meaning "don't write priority" — lets a future retry
      // branch or other caller omit the field without clearing an existing value.
      // For freshly-created tasks the distinction is moot, but we keep the contract
      // consistent across code paths.
      if (taskMeta?.priority && taskMeta.priority !== 'none') updates.priority = taskMeta.priority
      await updateTask(task.id, updates, { source: 'quick-start' })
      // Pin + tier — only for new tasks, only when user picked a tier.
      //
      // Sequencing matters: setFocusTier() throws if the task isn't pinned, so
      // togglePin() MUST run first. The two calls are separate write-lock
      // operations (non-atomic), but that's safe here because the task was just
      // created above and no other code references it yet.
      //
      // Best-effort: if either call fails, we log and let the session start anyway
      // rather than rolling back the task — the user can pin manually later.
      if (taskMeta?.pinTier) {
        try {
          await togglePin(task.id)
          await setFocusTier(task.id, taskMeta.pinTier)
        } catch (err) {
          log.web.warn('quick-start: failed to apply pin/tier', {
            taskId: task.id,
            tier: taskMeta.pinTier,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      updatedTask = await getTask(task.id)
    }

    if (!existingTaskId) {
      bus.emit(EventNames.TASK_CREATED, { task: updatedTask }, ['web-ui', 'main-agent'], { source: 'quick-start' })
    }

    // No system-prompt hint is injected for quick-start sessions. (We used to
    // tell the session to rename/recategorize the task on completion, but that
    // pushed sessions into unrelated task-management side-quests.) Extension
    // point: pass an `appendSystemPrompt` on SESSION_START below if a future
    // need arises.

    // A quick-start (incl. its retry) to a remote host is a deliberate human action —
    // forget any cached connection failure so we reconnect fresh rather than fast-fail.
    if (host) {
      const { clearDaemonFailureCache } = await import('../../providers/daemon-connection.js')
      clearDaemonFailureCache(host)
    }

    // Emit SESSION_START event (sessionMessage includes image path annotations if images were attached)
    bus.emit(EventNames.SESSION_START, {
      taskId: updatedTask.id,
      message: sessionMessage,
      cwd,
      project: 'Quick Start',
      mode,
      model,
      host,
      largePromptFile,
      requestTs,
    }, ['session-runner'], { source: 'quick-start' })

    log.web.info('quick-start: created task + started session', { taskId: updatedTask.id, cwd, host, category: taskCategory, retry: !!existingTaskId })

    res.json({ taskId: updatedTask.id, task: updatedTask })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/tree — sessions grouped by task hierarchy
sessionsRouter.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hideCompleted = req.query.hideCompleted === 'true'
    const sessions = await enrichWithHostnames(await enrichWithLiveStatus(await listSessions()))
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
      // Environment sessions (triage, hook, cron, embedded subagent) are system housekeeping —
      // exclude from session tree. Non-embedded subagent sessions (user-created) are shown.
      if (isEnvironmentSession(s)) continue
      if (s.archived) continue
      // hideCompleted now uses task.phase (checked at display layer) — sessions no longer carry work_status
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
    const sessions = all.filter(s => !isEnvironmentSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/recent
sessionsRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const all = await getRecentSessions(limit)
    const sessions = all.filter(s => !isEnvironmentSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
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
    // Exclude environment sessions (archived sessions kept — frontend needs them for collapsed section)
    const sessions = all.filter(s => !isEnvironmentSession(s))
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
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
    const [enriched] = await enrichWithHostnames(await enrichWithLiveStatus([session]))
    // Include live pending permissions from the in-memory session (if running)
    const liveSession = sessionRunner.findByClaudeId(String(req.params.sessionId))
    const pendingPermissions = liveSession?.hasPendingPermission
      ? liveSession.getPendingPermissionRequests()
      : []
    res.json({ session: enriched, pendingPermissions })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/sessions/:sessionId
sessionsRouter.patch('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, activity, human_note, archived, archive_reason, mode } = req.body as { title?: string; activity?: string; human_note?: string; archived?: boolean; archive_reason?: string; mode?: string }

    if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
      res.status(400).json({ error: 'title must be a string (max 500 chars)' })
      return
    }

    if (human_note !== undefined && (typeof human_note !== 'string' || human_note.length > 50000)) {
      res.status(400).json({ error: 'human_note must be a string (max 50000 chars)' })
      return
    }

    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }

    const VALID_MODES = ['bypass', 'accept', 'default', 'plan'] as const
    if (mode !== undefined && !VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
      res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` })
      return
    }

    const sessionId = String(req.params.sessionId)

    // Archive/unarchive: validate session is in a terminal state before archiving
    if (archived === true) {
      const existing = await getSessionByClaudeId(sessionId)
      if (!existing) {
        res.status(404).json({ error: 'session not found' })
        return
      }
      if (existing.process_status !== 'stopped' && existing.process_status !== 'error') {
        res.status(400).json({ error: 'Stop session before archiving' })
        return
      }
    }

    // Read existing record for mode-change slot promotion logic
    const existingRecord = mode !== undefined ? await getSessionByClaudeId(sessionId) : undefined

    const updates: Partial<SessionRecord> = {}
    if (title !== undefined) updates.title = title
    if (activity !== undefined) updates.activity = activity
    if (human_note !== undefined) updates.human_note = human_note
    if (mode !== undefined) updates.mode = mode as SessionMode
    if (archived !== undefined) {
      updates.archived = archived
      if (archived && archive_reason) updates.archive_reason = archive_reason
      if (!archived) updates.archive_reason = undefined  // clear reason on unarchive
    }

    const updated = await updateSessionRecord(sessionId, updates)
    log.web.info('session updated via REST', { sessionId, fields: Object.keys(updates) })

    // Sync mode to in-memory session so emitStatusChanged() uses the new value.
    // Also set pendingMode so the next message forces --resume instead of FIFO write.
    // FIFO stdin doesn't carry permission-mode — only --resume spawn applies it.
    if (mode !== undefined && existingRecord?.mode !== mode) {
      const liveSession = sessionRunner.findByClaudeId(sessionId)
      if (liveSession) {
        liveSession._mode = mode as SessionMode
      }
      // Set pendingMode so processNext() knows to skip FIFO and use --resume
      // with the new --permission-mode flag. Without this, a FIFO session would
      // silently keep running in the old mode until the process dies.
      if (updated.process_status !== 'stopped') {
        await updateSessionRecord(sessionId, { pendingMode: mode })
      }
    }

    // Emit status change so frontend updates in real time
    if (archived !== undefined || mode !== undefined) {
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId,
        taskId: updated.taskId,
        process_status: updated.process_status,
        activity: updated.activity,
        mode: updated.mode,
        ...(updated.planCompleted ? { planCompleted: true } : {}),
        ...(archived !== undefined ? { archived } : {}),
      }, ['web-ui'])
    }

    // Mode change: promote/demote task session slot when switching to/from plan
    if (mode !== undefined && existingRecord && updated.taskId && existingRecord.mode !== mode) {
      try {
        const { getTask, linkSessionSlot, clearSessionSlot } = await import('../../core/task-manager.js')
        const task = await getTask(updated.taskId)
        if (mode === 'plan') {
          // Promote to plan slot (if plan slot is free)
          if (!task.plan_session_id || task.plan_session_id === sessionId) {
            if (task.exec_session_id === sessionId) await clearSessionSlot(updated.taskId, sessionId, 'exec')
            await linkSessionSlot(updated.taskId, sessionId, 'plan')
            const updatedTask = await getTask(updated.taskId)
            bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' })
          }
        } else {
          // Demote from plan slot to exec
          if (task.plan_session_id === sessionId) {
            await clearSessionSlot(updated.taskId, sessionId, 'plan')
            if (!task.exec_session_id) await linkSessionSlot(updated.taskId, sessionId, 'exec')
            const updatedTask = await getTask(updated.taskId)
            bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' })
          }
        }
      } catch { /* task not found or lock contention — ignore */ }
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
// ?source=streams — fast path: local-only reads (skip SSH).
// Local sessions: reads canonical JSONL (~1ms, same result as full path).
// Remote sessions: returns empty (no local files exist for remote sessions).
sessionsRouter.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const source = req.query.source as string | undefined
    const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined

    // Look up session record to get cwd
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd

    if (source === 'streams') {
      // Fast path: host=undefined forces local-only reads (canonical JSONL + streams fallback).
      // Skips SSH entirely. For local sessions this returns full data (~1ms).
      //
      // Remote sessions have no local streams file — readSessionHistory would still
      // walk the local filesystem and return empty. Short-circuit before even calling
      // it so the hook's Phase 1 doesn't waste an event loop tick (and doesn't race
      // with the Phase 2 SSH round-trip).
      if (record?.host) {
        res.json({ messages: [], total: 0 })
        return
      }
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand
      const messages = await readSessionHistory(sessionId, cwd, undefined, record?.outputFile, { skipSubagents: true })
      logMessageOrdering('P1:streams', sessionId, messages, record?.host)
      const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
      res.json({ messages: sliced, total: messages.length })
      return
    }

    // Full path: reads from source of truth (SSH for remote sessions)
    let messages: Awaited<ReturnType<typeof readSessionHistory>>
    try {
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand
      messages = await readSessionHistory(sessionId, cwd, record?.host, record?.outputFile, { skipSubagents: true })
    } catch (err) {
      // Surface remote read errors (SSH auth, daemon connection, etc.) to the frontend
      const msg = err instanceof Error ? err.message : String(err)
      log.web.warn('session history read failed', { sessionId, host: record?.host, error: msg })
      res.status(502).json({ error: msg })
      return
    }
    logMessageOrdering('P2:full', sessionId, messages, record?.host)
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
    let forkBoundaryIndex: number | undefined
    if (record?.forkedFromSessionId) {
      forkedFromSessionId = record.forkedFromSessionId
      try {
        // Two-phase to avoid serializing SSH round-trips:
        //  1) Walk the fork pointers (getSessionByClaudeId — a LOCAL, now-cached
        //     SQLite lookup) to collect ancestor records in chain order. The
        //     next id depends on the current record, so this walk stays serial
        //     but is cheap.
        //  2) Fetch + image-rewrite every ancestor's history in PARALLEL (the
        //     expensive SSH/JSONL part). Previously this was a serial
        //     await-per-ancestor loop, so a 3-deep remote chain meant 3
        //     sequential SSH pulls (~24s); parallel collapses that to ~1 pull.
        const MAX_FORK_DEPTH = 5 // backstop against pathological/cyclic chains
        const ancestors: import('../../core/types.js').SessionRecord[] = []
        const visited = new Set<string>([sessionId])
        let currentForkId: string | undefined = record.forkedFromSessionId
        while (currentForkId && !visited.has(currentForkId) && ancestors.length < MAX_FORK_DEPTH) {
          visited.add(currentForkId)
          const sourceRecord = await getSessionByClaudeId(currentForkId)
          if (!sourceRecord) break
          ancestors.push(sourceRecord)
          currentForkId = sourceRecord.forkedFromSessionId
        }

        // ancestors[0] is the immediate parent … ancestors[n-1] the root.
        // History order must be root-first (oldest → newest), so reverse.
        const ordered = [...ancestors].reverse()
        const fetched = await Promise.all(
          ordered.map(async (sourceRecord) => {
            let sourceMessages = await readSessionHistory(
              sourceRecord.claudeSessionId, sourceRecord.cwd, sourceRecord.host, sourceRecord.outputFile, { skipSubagents: true },
            )
            if (sourceRecord.host) {
              sourceMessages = await rewriteHistoryRemoteImages(sourceMessages, sourceRecord.host, sourceRecord.claudeSessionId, sourceRecord.cwd)
            }
            return sourceMessages
          }),
        )

        const allSourceMessages = fetched.flat()
        if (allSourceMessages.length > 0) {
          messages = [...allSourceMessages, ...messages]
          forkBoundaryIndex = allSourceMessages.length
        }
      } catch (err) {
        log.web.warn('failed to load fork source history', {
          sessionId, forkedFrom: record.forkedFromSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const total = messages.length
    const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
    // Adjust forkBoundaryIndex for the sliced window
    const adjustedForkBoundary = forkBoundaryIndex != null && tail && tail > 0
      ? (forkBoundaryIndex >= total - tail ? forkBoundaryIndex - (total - tail) : undefined)
      : forkBoundaryIndex
    res.json({
      messages: sliced,
      total,
      ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
      ...(adjustedForkBoundary != null ? { forkBoundaryIndex: adjustedForkBoundary } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/subagent/:agentId/history — lazy-load a single subagent's messages
sessionsRouter.get('/:sessionId/subagent/:agentId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const agentId = req.params.agentId as string

    // Validate agentId format: hex strings (Task subagents) or name@team (Team agents)
    if (!/^[a-zA-Z0-9_@.-]+$/.test(agentId)) {
      res.status(400).json({ error: 'Invalid agentId format' })
      return
    }

    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd
    // ?workflow=1 → scan the nested subagents/workflows/<runId>/ layout (dynamic
    // workflow subagents); otherwise the flat Task/Team layout.
    const isWorkflow = req.query.workflow === '1' || req.query.workflow === 'true'

    let messages = await readSingleSubagentHistory(sessionId, agentId, cwd, record?.host, isWorkflow)

    // Rewrite remote image paths for remote sessions
    if (record?.host && messages.length > 0) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd)
    }

    res.json({ messages })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/workflow — reconstruct the dynamic-workflow progress
// panel from the on-disk run manifest. Lets the panel survive page reload / server
// restart, when the live in-memory session state is gone. 204 = no workflow ran.
sessionsRouter.get('/:sessionId/workflow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    const payload = await reconstructWorkflowProgress(sessionId, record?.cwd, record?.host)
    if (!payload) {
      res.status(204).end()
      return
    }
    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/changes — the files this session changed, with
// reconstructed before/after content for a GitHub-style diff view.
//
// ?base= selects what to compare AGAINST:
//   (absent) / 'session' → JSONL-only, this session's OWN edits (default; the only
//                           mode that can attribute concurrent edits to a session).
//   'uncommitted'         → `git diff HEAD` (working tree vs last commit)
//   'previous'            → `git diff HEAD~1` (incl. last commit, vs the one before)
//   'remote'              → `git diff @{upstream}` (unpushed vs remote)
//
// ?base= chooses the comparison baseline; ?scope= selects WHICH of the session's
// touched repos' files to show. Both git and session modes are scoped to what
// THIS session actually edited (never the cwd repo wholesale):
//   base=session (default) → JSONL replay of the session's own edits (no git).
//   base=uncommitted|previous|remote → git diff of the repos the session touched,
//     against HEAD / HEAD~1 / @{upstream}, with:
//       scope=session (default) → only the files this session edited.
//       scope=all               → every change in those touched repos.
// scope is ignored for base=session (already session-scoped by definition).
// ?refresh=1 bypasses the mtime cache.
const GIT_BASES: ReadonlySet<string> = new Set(['uncommitted', 'previous', 'remote'])
sessionsRouter.get('/:sessionId/changes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    const base = typeof req.query.base === 'string' ? req.query.base : 'session'
    const scope = req.query.scope === 'all' ? 'all' : 'session'
    const noCache = req.query.refresh === '1' || req.query.refresh === 'true'
    let result
    try {
      if (GIT_BASES.has(base)) {
        // Repo universe + (for scope=session) file set both come from the session's
        // own edits — computeSessionGitDiff diffs only the repos it touched.
        result = await computeSessionGitDiff(sessionId, base as GitDiffBase, record.cwd, record.host, scope, record.outputFile, { noCache })
      } else {
        result = await computeSessionChanges(sessionId, record.cwd, record.host, record.outputFile, { noCache })
      }
    } catch (err) {
      // Surface remote read errors (SSH/daemon) + git failures to the frontend like /history does.
      const msg = err instanceof Error ? err.message : String(err)
      log.web.warn('session changes read failed', { sessionId, host: record.host, base, scope, error: msg })
      res.status(502).json({ error: msg })
      return
    }
    res.json(result)
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

    // Exec sessions can re-enter plan mode via execute-continue, creating their own plan.
    // When that happens, the session's own plan is newer/fresher and takes priority over
    // the original source plan (which is now stale). planCompleted alone is sufficient —
    // planFile may be absent if the plan was only in ExitPlanMode.input.plan (no Write to
    // ~/.claude/plans/), but readPlanFromSession's JSONL slug and extractPlanContent
    // strategies can still find it.
    // See also: POST /execute-continue which uses the same !planCompleted check (~line 1009).
    const hasOwnPlan = !!record.planCompleted
    const planSessionId = hasOwnPlan ? sessionId : (record.fromPlanSessionId ?? sessionId)
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
    // Allows plan sessions (planCompleted=true) and execution sessions (fromPlanSessionId set, planCompleted never true on exec records)
    if (!session.planCompleted && !session.fromPlanSessionId) {
      res.status(400).json({ error: 'Not a plan or execution session' })
      return
    }
    // Update mode to bypass for execution
    await updateSessionRecord(session.claudeSessionId, { mode: 'bypass' })

    // If session process is alive (running or idle), stop it first
    // so it restarts with bypass permissions via --resume
    const needsInterrupt = session.process_status !== 'stopped'

    const message = 'Execute the plan. Implement all steps as planned.'
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    await sendMessageToSession(session.claudeSessionId, message, {
      source: 'web-api',
      taskId: session.taskId,
      mode: 'bypass',
      interrupt: needsInterrupt || undefined,
    })

    log.web.info('execute-continue: resuming plan session with bypass', { sessionId: session.claudeSessionId })

    res.json({ status: 'started', sessionId: session.claudeSessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/permission — resolve a pending permission request
sessionsRouter.post('/:sessionId/permission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const { requestId, allow, message: denyMessage } = req.body as {
      requestId: string
      allow: boolean
      message?: string
    }
    if (!requestId || typeof allow !== 'boolean') {
      res.status(400).json({ error: 'requestId (string) and allow (boolean) are required' })
      return
    }
    const session = sessionRunner.findByClaudeId(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Live session not found' })
      return
    }
    const resolved = session.resolvePermissionRequest(requestId, allow, denyMessage)
    if (!resolved) {
      res.status(404).json({ error: 'Permission request not found or already resolved' })
      return
    }
    res.json({ status: 'resolved', requestId, allow })
  } catch (err) {
    next(err)
  }
})

// ── Side questions ("/btw") ─────────────────────────────────────────────────
// The native Claude Code side_question control_request, run INSIDE the live coding
// session (reuses its own prompt-cache prefix), answer kept OUT of the main
// transcript. See ClaudeCodeSession.askSideQuestion + side-questions.ts store.

// GET /api/sessions/:sessionId/side-questions — history list for the drawer
sessionsRouter.get('/:sessionId/side-questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await listSideQuestions(req.params.sessionId as string)
    res.json({ sideQuestions: list })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/side-question — ask + persist + broadcast
sessionsRouter.post('/:sessionId/side-question', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { question } = req.body as { question?: string }
  try {
    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'question (non-empty string) is required' })
      return
    }
    // Attach-on-demand: findByClaudeId only sees the in-memory map (≈ the sessions
    // the startup reconciler flagged), so a genuinely-alive session the user can
    // chat with would falsely 404 here. getOrAttachLiveSession rehydrates via
    // attachToExisting — same resolution a normal send turn gets in processNext.
    const session = await sessionRunner.getOrAttachLiveSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Live session not found' })
      return
    }
    const answer = await session.askSideQuestion(question.trim())
    const entry = await addSideQuestion(sessionId, question.trim(), answer)
    bus.emit(EventNames.SESSION_SIDE_QUESTION_DONE, {
      sessionId, id: entry.id, question: entry.question, answer: entry.answer, createdAt: entry.createdAt,
    }, ['*'], { source: 'session-runner' })
    res.json({ sideQuestion: entry })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.web.warn('side question failed', { sessionId, error: msg })
    bus.emit(EventNames.SESSION_SIDE_QUESTION_ERROR, {
      sessionId, question: question ?? '', error: msg,
    }, ['*'], { source: 'session-runner' })
    res.status(502).json({ error: msg })
  }
})

// POST /api/sessions/:sessionId/side-question/:id/promote — turn a Q&A into a task
sessionsRouter.post('/:sessionId/side-question/:id/promote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const id = req.params.id as string
    const entry = await getSideQuestion(sessionId, id)
    if (!entry) {
      res.status(404).json({ error: 'Side question not found' })
      return
    }
    // If this session is working on a task, file the promoted Q&A as a SUBTASK of
    // it (addTask inherits the parent's category/project/source). Ad-hoc sessions
    // with no originating task fall back to a top-level task.
    const sessionRecord = await getSessionByClaudeId(sessionId)
    const parentTaskId = sessionRecord?.taskId?.trim() || undefined
    const { task } = await addTask({
      title: entry.question,
      description: entry.answer,
      ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
    })
    // Link the task back to the session so it shows under that session's history.
    await linkSession(task.id, sessionId)
    await markPromoted(sessionId, id, task.id)
    res.json({ taskId: task.id, parentTaskId: task.parent_task_id })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/sessions/:sessionId/side-question/:id — remove a Q&A from history
sessionsRouter.delete('/:sessionId/side-question/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await deleteSideQuestion(req.params.sessionId as string, req.params.id as string)
    if (!ok) {
      res.status(404).json({ error: 'Side question not found' })
      return
    }
    res.json({ status: 'deleted' })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-compact — execute plan by injecting compact boundary
// into the SAME session (clears plan conversation but preserves session ID, slug, and plan file).
// This avoids the "new session loses codebase context" problem while clearing the 200+ plan messages.
sessionsRouter.post('/:sessionId/execute-compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const planSessionId = req.params.sessionId as string
    const { task_id, working_directory, instructions, mode, host } = req.body as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
      host?: string
    }

    const sourceRecord = await getSessionByClaudeId(planSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Follow one hop to the source plan session
    let actualPlanSessionId = planSessionId
    if (sourceRecord.fromPlanSessionId && !sourceRecord.planCompleted) {
      actualPlanSessionId = sourceRecord.fromPlanSessionId
    }

    // Read plan content
    let planResult = await readPlanFromSession(actualPlanSessionId)
    if ('error' in planResult) {
      const planRecord = actualPlanSessionId !== planSessionId
        ? await getSessionByClaudeId(actualPlanSessionId)
        : sourceRecord
      if (planRecord) {
        const extracted = await extractPlanContent(actualPlanSessionId, planRecord.cwd, planRecord.host)
        if (extracted?.trim()) {
          planResult = { content: extracted, planFile: planRecord.planFile ?? `(extracted from session ${actualPlanSessionId} JSONL)` }
        }
      }
    }
    if ('error' in planResult) {
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const taskId = task_id ?? sourceRecord?.taskId
    const cwd = working_directory ?? sourceRecord?.cwd
    if (!cwd) {
      res.status(400).json({ error: 'working_directory is required' })
      return
    }

    const validModes = ['bypass', 'accept', 'default', 'plan']
    if (mode && !validModes.includes(mode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
      return
    }
    const execMode = (mode ?? 'bypass') as 'bypass' | 'accept' | 'default' | 'plan'

    // ── Find the session's JSONL file ──
    const jsonlPath = await findLocalJsonlPath(actualPlanSessionId, cwd)
    if (!jsonlPath) {
      log.web.warn('execute-compact: JSONL not found, use /execute instead', { planSessionId: actualPlanSessionId, cwd })
      res.status(400).json({ error: 'Could not find session JSONL file. Use /execute instead.' })
      return
    }

    // ── Stop the session process if alive (must stop before JSONL injection) ──
    if (sourceRecord.process_status !== 'stopped') {
      log.web.info('execute-compact: stopping session process before injection', { planSessionId: actualPlanSessionId })
      const liveSession = sessionRunner.findByClaudeId(actualPlanSessionId)
      if (liveSession) {
        liveSession.interrupt()
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    // ── Inject compact boundary + plan summary into JSONL ──
    const summary = buildCompactSummary(planResult.content, planResult.planFile)
    const injectResult = await injectCompactBoundary(jsonlPath, summary)
    if (!injectResult) {
      res.status(500).json({ error: 'Failed to inject compact boundary into session JSONL' })
      return
    }

    // ── Update session mode and send execute message ──
    await updateSessionRecord(actualPlanSessionId, { mode: execMode })

    const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, instructions)
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    await sendMessageToSession(actualPlanSessionId, planMessage, {
      source: 'web-api',
      taskId,
      mode: execMode,
    })

    log.web.info('execute-compact: injected boundary and sent execute message', {
      sessionId: actualPlanSessionId,
      boundaryUuid: injectResult.boundaryUuid,
      planFile: planResult.planFile,
    })

    res.json({
      status: 'started',
      sessionId: actualPlanSessionId,
      strategy: 'compact',
      planSessionId: actualPlanSessionId,
      taskId,
      mode: execMode,
      boundaryUuid: injectResult.boundaryUuid,
    })
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

    // Look up session record first to resolve fromPlanSessionId chain
    const sourceRecord = await getSessionByClaudeId(planSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Follow one hop to the source plan session for execution sessions. Exec sessions always point
    // directly to a plan session (never to another exec), so one hop is sufficient.
    let actualPlanSessionId = planSessionId
    if (sourceRecord.fromPlanSessionId && !sourceRecord.planCompleted) {
      actualPlanSessionId = sourceRecord.fromPlanSessionId
    }

    // Read plan file via shared resolver (same logic as agent tool's from_plan path).
    // Fallback: extractPlanContent from JSONL — covers plan sessions where planCompleted flag was never set
    // (e.g. ExitPlanMode event missed by stream handler) but JSONL contains the plan content.
    let planResult = await readPlanFromSession(actualPlanSessionId)
    if ('error' in planResult) {
      const planRecord = actualPlanSessionId !== planSessionId
        ? await getSessionByClaudeId(actualPlanSessionId)
        : sourceRecord
      if (planRecord) {
        const extracted = await extractPlanContent(actualPlanSessionId, planRecord.cwd, planRecord.host)
        if (extracted?.trim()) {
          planResult = { content: extracted, planFile: planRecord.planFile ?? `(extracted from session ${actualPlanSessionId} JSONL)` }
        }
      }
    }
    if ('error' in planResult) {
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const taskId = task_id ?? sourceRecord?.taskId
    const cwd = working_directory ?? sourceRecord?.cwd
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
    const execHost = host ?? sourceRecord?.host

    // ── Start new session FIRST, archive old plan only after confirmation ──
    // This prevents the user from ending up with an archived plan and no execution
    // session if the new session fails to start (e.g. CLI not found, SSH failure).

    // Set up a temporary bus listener BEFORE emitting SESSION_START so we
    // catch the status-changed event that carries the new session's ID,
    // or a SESSION_ERROR if the process dies before init.
    const WAIT_TIMEOUT_MS = 30_000
    const subName = `exec-wait-${planSessionId}`
    const newSessionPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subName)
        reject(new Error('Timed out waiting for execution session to start'))
      }, WAIT_TIMEOUT_MS)

      bus.subscribe(subName, (event) => {
        if (event.name === EventNames.SESSION_STATUS_CHANGED) {
          const d = eventData<'session:status-changed'>(event)
          if (d.fromPlanSessionId === planSessionId && d.sessionId) {
            clearTimeout(timer)
            bus.unsubscribe(subName)
            resolve(d.sessionId)
          }
        }
        // Catch early process death (e.g. exit code 127 — CLI not found)
        if (event.name === EventNames.SESSION_ERROR) {
          const d = eventData<'session:error'>(event)
          if (d.fromPlanSessionId === planSessionId) {
            clearTimeout(timer)
            bus.unsubscribe(subName)
            reject(new Error(d.error ?? 'Execution session failed to start'))
          }
        }
      }, { global: true, interest: ['session:status-changed', 'session:error'] })
    })

    bus.emit(EventNames.SESSION_START, {
      taskId: taskId ?? '',
      message: planMessage,
      cwd,
      project: sourceRecord?.project ?? '',
      mode: execMode,
      title: `Execute plan from ${planSessionId.slice(0, 16)}...`,
      ...(execHost ? { host: execHost } : {}),
      fromPlanSessionId: planSessionId,
    }, ['session-runner'], { source: 'web-api' })

    // Wait for the new session to start (up to 30s). If it fails, the plan
    // session stays intact so the user can retry.
    let newSessionId: string
    try {
      newSessionId = await newSessionPromise
    } catch (waitErr) {
      log.web.error('execute: new session failed to start, plan NOT archived', {
        planSessionId, taskId, error: waitErr instanceof Error ? waitErr.message : String(waitErr),
      })
      res.status(502).json({
        error: waitErr instanceof Error ? waitErr.message : 'Execution session failed to start',
        planSessionId,
        planPreserved: true,
      })
      return
    }

    // ── New session confirmed — now archive the old plan session ──
    const archiveReason = sourceRecord.planCompleted ? 'plan_executed' : 'plan_re_executed'
    if (!sourceRecord.archived) {
      await updateSessionRecord(planSessionId, {
        archived: true,
        archive_reason: archiveReason,
        ...(sourceRecord.planCompleted ? { planContent: planResult.content } : {}),
      })
      log.web.info('execute: archived session', { planSessionId, reason: archiveReason })
    }

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

    res.json({ status: 'started', planSessionId, taskId, mode: execMode, sessionId: newSessionId, ...(execHost ? { host: execHost } : {}) })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/retry — retry a failed session
// Two paths: (1) resume via --resume if claudeSessionId exists (preserves history),
// (2) fallback to archive+new if no claudeSessionId (session failed before init).
sessionsRouter.post('/:sessionId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Only allow retry on failed/stopped sessions
    if (record.process_status !== 'error' && record.process_status !== 'stopped') {
      res.status(400).json({ error: `Session is ${record.process_status}, not retryable` })
      return
    }
    if (!record.taskId) {
      res.status(400).json({ error: 'Session has no associated task' })
      return
    }

    // ── Resume path: session has claudeSessionId → check if process is alive ──
    if (record.claudeSessionId) {
      const alive = await isSessionProcessAlive(record)

      if (alive) {
        // Case 2 — process alive, connection dropped: just clear error state
        await updateSessionRecord(sessionId, { process_status: 'running', errorMessage: undefined, status_reason: 'retry_reconnect', status_changed_by: 'user' } as any)
        bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId, process_status: 'running', taskId: record.taskId })
        log.web.info('session retry: reconnected (process alive)', { sessionId, taskId: record.taskId })
        res.json({ status: 'reconnected', sessionId })
        return
      }

      // Case 1 — process dead: resume via --resume.
      // If the pending queue already holds the user's original message (reverted by
      // settleResumeFailure after a failed spawn), just re-trigger processNext which
      // picks up pending messages. This sends the ORIGINAL text, not "continue".
      // Only fall back to "continue" if the queue is empty (pure idle-dead process).
      const { sendMessageToSession, getQueue } = await import('../../core/session-message-queue.js')
      const pendingMsgs = await getQueue(sessionId)
      if (pendingMsgs.length > 0) {
        // Queue has the user's original message(s) — just kick processNext via SESSION_SEND
        bus.emit(EventNames.SESSION_SEND, {
          sessionId,
          taskId: record.taskId,
        }, ['session-runner'], { source: 'retry' })
        log.web.info('session retry: re-processing pending queue messages', { sessionId, taskId: record.taskId, count: pendingMsgs.length })
        res.json({ status: 'resuming', sessionId, restoredMessages: pendingMsgs.length })
      } else {
        await sendMessageToSession(sessionId, 'continue', {
          source: 'retry',
          taskId: record.taskId,
        })
        log.web.info('session retry: resuming via --resume (no pending messages)', { sessionId, taskId: record.taskId })
        res.json({ status: 'resuming', sessionId })
      }
      return
    }

    // ── Fallback: no claudeSessionId (failed before init) → archive + start new ──
    const task = await getTask(record.taskId)
    if (!task) {
      res.status(404).json({ error: 'Associated task not found' })
      return
    }

    await updateSessionRecord(sessionId, { archived: true, archive_reason: 'retry' })
    try {
      const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
      await clearSession(task.id, sessionId)
      await clearSessionSlot(task.id, sessionId)
    } catch { /* task may not exist */ }

    let retryMessage = 'Retry session'
    try {
      const messages = await readSessionHistory(sessionId, record.cwd, record.host, record.outputFile)
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser?.text) retryMessage = firstUser.text
    } catch { /* history may be unavailable */ }

    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: retryMessage,
      cwd: record.cwd,
      project: task.project ?? '',
      mode: record.mode !== 'default' ? record.mode : undefined,
      model: record.model,
      host: record.host,
    }, ['session-runner'], { source: 'retry' })

    log.web.info('session retry: no claudeSessionId, started new session', {
      oldSessionId: sessionId, taskId: task.id,
    })
    res.json({ status: 'pending', taskId: task.id, oldSessionId: sessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/restart — kill the current CLI and immediately resume.
//
// Flow:
//   1. Kill the running CLI (SessionManager.kill if registered, otherwise SIGTERM to process group).
//   2. Revert any 'processing' messages in the queue back to 'pending' — they were stuck mid-send.
//   3. Reset session record to idle.
//   4. Emit SESSION_SEND to trigger processNext, which spawns a fresh `claude -p --resume` and
//      drains the pending queue. If queue is empty, we skip step 4 (no message means no CLI work,
//      which matches Claude CLI semantics — `claude -p --resume` without stdin input is a no-op).
//
// All log statements prefixed "session restart:" so the full path is greppable when the
// UX appears unresponsive.
sessionsRouter.post('/:sessionId/restart', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const startedAt = Date.now()
  log.web.info('session restart: request received', { sessionId })
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      log.web.warn('session restart: session not found', { sessionId })
      res.status(404).json({ error: 'Session not found' })
      return
    }

    log.web.info('session restart: record loaded', {
      sessionId,
      recordPid: record.pid,
      processStatus: record.process_status,
      host: record.host,
      isRemote: !!record.host,
      taskId: record.taskId,
    })

    // Step 1: Kill the running CLI.
    if (record.pid != null) {
      const { isSessionProcessAlive: isAlive } = await import('../../utils/session-liveness.js')
      const alive = await isAlive(record)
      log.web.info('session restart: liveness check', { sessionId, pid: record.pid, alive })

      if (alive) {
        const { getRegisteredSessionManager } = await import('../../providers/session-manager.js')
        const mgr = getRegisteredSessionManager(sessionId)
        if (mgr) {
          log.web.info('session restart: killing via SessionManager', { sessionId, pid: record.pid, managerKind: mgr.constructor.name })
          mgr.kill()
        } else {
          log.web.info('session restart: killing via process.kill (no manager registered)', { sessionId, pid: record.pid })
          try {
            process.kill(-record.pid, 'SIGTERM')
            log.web.info('session restart: SIGTERM sent to process group', { sessionId, pgid: record.pid })
          } catch (err) {
            log.web.warn('session restart: process.kill failed (likely already dead)', {
              sessionId, pid: record.pid,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } else {
        log.web.info('session restart: CLI already dead, skipping kill', { sessionId, pid: record.pid })
      }
    } else {
      log.web.info('session restart: no pid in record, nothing to kill', { sessionId })
    }

    // Step 2: Revert any in-flight 'processing' messages back to 'pending' so they get
    // re-sent to the new CLI. A message stuck in 'processing' means the old CLI was
    // killed mid-send — without revert it would be lost forever.
    const { getQueue, revertToPending } = await import('../../core/session-message-queue.js')
    const queue = await getQueue(sessionId)
    const stuck = queue.filter((m) => m.status === 'processing')
    log.web.info('session restart: queue state', {
      sessionId,
      queueSize: queue.length,
      pendingCount: queue.filter((m) => m.status === 'pending').length,
      processingCount: stuck.length,
    })
    if (stuck.length > 0) {
      await revertToPending(stuck)
      log.web.info('session restart: reverted processing → pending', {
        sessionId,
        count: stuck.length,
        messageIds: stuck.map((m) => m.id),
      })
    }

    // Step 3: Reset record to idle.
    await updateSessionRecord(sessionId, {
      process_status: 'idle',
      errorMessage: undefined,
      pid: undefined,
    })
    log.web.info('session restart: record reset to idle', { sessionId })

    // Step 4: If there are pending messages, trigger processNext to spawn a fresh CLI.
    const pendingAfterRevert = stuck.length + queue.filter((m) => m.status === 'pending').length
    if (pendingAfterRevert > 0) {
      const { bus, EventNames } = await import('../../core/event-bus.js')
      // handleSend drains the queue via processNext — message body is unused for the
      // non-interrupt path (it reads pending messages from the queue). Pass empty string
      // to avoid confusion in bus event logs.
      bus.emit(EventNames.SESSION_SEND, {
        sessionId,
        taskId: record.taskId,
        message: '',
      }, ['session-runner'], { source: 'restart' })
      log.web.info('session restart: emitted SESSION_SEND to trigger resume', {
        sessionId,
        pendingMessages: pendingAfterRevert,
      })
    } else {
      log.web.info('session restart: no pending messages — CLI will stay idle until next user input', { sessionId })
    }

    log.web.info('session restart: complete', {
      sessionId,
      durationMs: Date.now() - startedAt,
      triggeredResume: pendingAfterRevert > 0,
    })
    res.json({
      status: 'restarted',
      sessionId,
      pendingMessages: pendingAfterRevert,
      resumed: pendingAfterRevert > 0,
    })
  } catch (err) {
    log.web.error('session restart: failed', {
      sessionId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    next(err)
  }
})

// POST /api/sessions/:sessionId/fork — fork a session to a different task
sessionsRouter.post('/:sessionId/fork', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceSessionId = req.params.sessionId as string
    const { task_id, create_child_task, child_title, message, title, model, images } = req.body as {
      task_id?: string
      create_child_task?: boolean
      child_title?: string
      message?: string
      title?: string
      model?: string
      images?: ImagePayload[]
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
      // Fork = create a SIBLING task and visually group it with the source task
      // (NOT a parent/subtask — they have independent lifecycles). The new task
      // inherits the source task's category/project/source but has NO parent; we
      // then put both the source task and the fork into a lightweight virtual
      // group (reusing the source task's existing group if it already has one).
      if (!sourceRecord.taskId) {
        res.status(400).json({ error: 'Source session has no task — cannot create fork task' })
        return
      }
      let sourceTask: Task
      try {
        sourceTask = await getTask(sourceRecord.taskId)
      } catch {
        res.status(404).json({ error: `Source task "${sourceRecord.taskId}" not found` })
        return
      }
      // When the caller didn't supply an explicit child_title, we use a plain
      // `Fork of <source>` placeholder now and (below, after addTask) refine it
      // asynchronously into `<2-4 word summary of the fork prompt> - fork of <source>`.
      // Use `||` (not `??`) so an empty-string child_title also falls back to the
      // placeholder — consistent with `autoTitle = !child_title` below.
      const autoTitle = !child_title
      const newTitle = child_title || `Fork of ${sourceTask.title}`
      // No _skipPluginOps: a fork inherits the source's source (e.g. an external
      // sync plugin) and must pass the same content validation + push as any
      // other task. addTask throws on CJK → surfaced via next(err).
      const { task: newFork } = await addTask({
        title: newTitle,
        category: sourceTask.category,
        project: sourceTask.project,
        source: sourceTask.source,
      })
      // Inherit the source's pin/tier so a fork of a Focus task lands in Focus
      // too — addTask() never sets focus_tier. Best-effort, non-fatal on failure.
      if (sourceTask.pinned && sourceTask.focus_tier) {
        try {
          await togglePin(newFork.id)
          await setFocusTier(newFork.id, sourceTask.focus_tier)
        } catch (err) {
          log.web.warn('fork: failed to inherit pin/tier from source', {
            taskId: newFork.id,
            sourceTaskId: sourceTask.id,
            tier: sourceTask.focus_tier,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      bus.emit(EventNames.TASK_CREATED, { task: newFork }, ['web-ui', 'main-agent'], { source: 'fork' })
      task = newFork
      childTaskCreated = true

      // Visually group the source task + fork. Reuse the source task's existing
      // group if it already belongs to one (continuous forks accrete into one
      // group: source + fork1 + fork2…). Best-effort: a grouping failure must not
      // abort the fork — the fork task still exists standalone.
      let forkGroupId: string | undefined
      try {
        if (sourceTask.group_id) {
          const r = await addToGroup(sourceTask.group_id, [newFork.id])
          forkGroupId = r.group_id
        } else {
          // Seed label with the source title; refined to an AI group name below.
          const r = await groupTasks([sourceTask.id, newFork.id], sourceTask.title)
          forkGroupId = r.group_id
        }
      } catch (err) {
        log.web.warn('fork: failed to group source + fork', {
          sourceTaskId: sourceTask.id,
          forkTaskId: newFork.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Refine the auto-generated title in the background: summarize the fork's new
      // prompt into a few English words → `<words> - fork of <source>`. Fire-and-forget
      // so the fork response is not blocked; failures keep the `Fork of <source>`
      // placeholder. Only runs when the title was auto-generated AND a custom fork
      // message was provided (no point summarizing the "Continue working on:" default).
      if (autoTitle && message?.trim()) {
        const forkId = newFork.id
        const sourceTitle = sourceTask.title
        const placeholderTitle = newTitle
        void (async () => {
          try {
            const { summarizeForkPrompt } = await import('../../core/fork-title.js')
            const label = await summarizeForkPrompt(message)
            if (!label) return
            // Don't clobber a concurrent user rename: only refine if the title is
            // still the `Fork of <source>` placeholder we created moments ago.
            const current = await getTask(forkId)
            if (current.title !== placeholderTitle) {
              log.web.info('fork title refine skipped — title changed since fork', { taskId: forkId })
              return
            }
            const refinedTitle = `${label} - fork of ${sourceTitle}`
            const { task: updated } = await updateTask(forkId, { title: refinedTitle }, { source: 'fork-title' })
            bus.emit(EventNames.TASK_UPDATED, { task: updated }, ['web-ui', 'main-agent'], { source: 'fork-title' })
            log.web.info('fork title refined', { taskId: forkId, title: refinedTitle })
          } catch (err) {
            // Best-effort: a failed refine just leaves the `Fork of <source>` title.
            log.web.warn('fork title refine failed', {
              taskId: forkId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }

      // Refine the GROUP name in the background from both task titles (only when
      // we created a fresh group — an existing group keeps its established name).
      // Best-effort, fire-and-forget; failures keep the source-title placeholder.
      if (forkGroupId && !sourceTask.group_id) {
        const gid = forkGroupId
        const seedTitles = [sourceTask.title, newTitle]
        void (async () => {
          try {
            const { summarizeGroupLabel } = await import('../../core/fork-title.js')
            const label = await summarizeGroupLabel(seedTitles)
            if (!label) return
            await renameGroup(gid, label)
            bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: gid, label }, ['web-ui', 'main-agent'], { source: 'fork' })
            log.web.info('fork group label refined', { groupId: gid, label })
          } catch (err) {
            log.web.warn('fork group label refine failed', {
              groupId: gid,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
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

    // A fork inherits the full parent conversation via --resume, so the model tends
    // to keep grinding on the parent's task. Lead with a focus directive so it treats
    // the fork message as the new mission and only revisits prior work on request.
    const userRequest = message?.trim() || `Continue working on: ${task.title}`
    const FORK_FOCUS_PREFIX =
      'This is a forked session. Focus on the NEW request below — treat it as your primary task. ' +
      'Do not resume or continue the parent session\'s previous work unless the user explicitly asks you to.\n\n'

    // Attached images: save to disk + build a "read these files" annotation (same
    // path-based flow as quick-start, so the CLI can read them as files). The image
    // context sits AFTER the focus directive but BEFORE the request, so the directive
    // stays the first thing the model anchors on.
    let imageContext = ''
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) imageContext = buildSessionImageContext(processed.savedImages)
    }
    const forkMessage = `${FORK_FOCUS_PREFIX}${imageContext}New request:\n${userRequest}`

    // Emit SESSION_START with forkedFromSessionId — handleStart() uses Claude Code's
    // native --resume + --fork-session to transfer conversation context efficiently.
    // No need to read source history or wait for session start; return immediately.
    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: forkMessage,
      cwd: sourceRecord.cwd,
      project: task.project ?? '',
      mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
      model,
      title: title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`,
      host: sourceRecord.host,
      forkedFromSessionId: sourceSessionId,
    }, ['session-runner'], { source: 'web-api' })

    res.json({
      status: 'pending',
      sourceSessionId,
      taskId: task.id,
      ...(childTaskCreated ? { childTaskCreated: true } : {}),
      ...(sourceRecord.host ? { host: sourceRecord.host } : {}),
    })
  } catch (err) {
    next(err)
  }
})
