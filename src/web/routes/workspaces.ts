/**
 * Task workspaces (src/core/workspaces/).
 *
 *   GET  /api/workspaces/providers?cwd=&host=        the providers that can isolate this folder
 *   POST /api/workspaces/task/:taskId                { provider, inputs?, host? } → make one now
 *   POST /api/workspaces/task/:taskId/retry          a failed creation, or a session that could not start
 *   GET  /api/workspaces/task/:taskId/removal        what "Remove workspace…" would delete and keep
 *   POST /api/workspaces/task/:taskId/remove         remove it (after the confirm dialog)
 *   POST /api/workspaces/task/:taskId/setup          { allow?, expect_hash? } run its setup script again (allow: and its walnut.json from now on)
 *   POST /api/workspaces/task/:taskId/start-anyway   a failed setup held the session: start it anyway
 *   GET  /api/workspaces/scripts?session=|task=|project=&cwd=&host=&ref=
 *                                                    the project's and the repository's scripts (scripts.ts)
 *   PUT  /api/workspaces/scripts/project/:project    { scripts } → save the project's own list
 *   POST /api/workspaces/scripts/trust               { key } → let that walnut.json (the view's file.key) run its setup and teardown by itself
 *
 * Thin edges: creation and removal are host jobs that answer at once; their
 * progress rides task:updated. The remove route never probes: the host probes
 * again before it deletes and refuses when anything would be lost. Every route
 * that reaches a daemon has a deadline and degrades (a provider list without the
 * host's verdicts, a preview that says it could not check in time).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { WorkspaceError } from '../../core/workspaces/daemon-client.js'
import { DETECT_BUDGET_MS, workspaceCandidates } from '../../core/workspaces/candidates.js'
import { cancelPendingStart, managerDeps, requestWorkspace, retryWorkspace, removalPreview, removeWorkspaceManually, PREVIEW_RPC_MS } from '../../core/workspaces/manager.js'
import { rerunSetup, sanitizeProjectScripts, scriptsFor, startAnyway, type ScriptsView } from '../../core/workspaces/scripts.js'
import { isLaunchReady } from '../../core/workspaces/decisions.js'
import { role } from '../../core/server-role.js'

export const workspacesRouter = Router()

/** Above the preview's own RPC budget, below the browser's 30s patience for it. */
const PREVIEW_DEADLINE_MS = PREVIEW_RPC_MS + 5_000
const ACTION_DEADLINE_MS = 30_000

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
  if (err instanceof WorkspaceError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.data ?? {}) })
    return
  }
  if (err instanceof RouteDeadline) {
    res.status(504).json({ error: 'The host took too long to answer. Try again.', code: 'timeout' })
    return
  }
  next(err)
}

function hostOf(raw: unknown): string {
  return typeof raw === 'string' && raw && raw !== 'local' ? raw : '__local__'
}

workspacesRouter.get('/providers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : ''
    const host = hostOf(req.query.host)
    const answer = await workspaceCandidates(cwd, host, DETECT_BUDGET_MS)
    res.json({ cwd, host, candidates: answer.candidates, ...(answer.degraded ? { degraded: answer.degraded } : {}) })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.post('/task/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { provider?: unknown; inputs?: unknown; host?: unknown }
    if (typeof body.provider !== 'string' || !body.provider) {
      res.status(400).json({ error: 'provider is required', code: 'bad-request' })
      return
    }
    const task = await within(ACTION_DEADLINE_MS, requestWorkspace(String(req.params.taskId), {
      provider: body.provider, inputs: body.inputs, ...(typeof body.host === 'string' ? { host: body.host } : {}),
    }))
    res.json({ task })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.post('/task/:taskId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ task: await within(ACTION_DEADLINE_MS, retryWorkspace(String(req.params.taskId))) })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.get('/task/:taskId/removal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { probe, decision } = await within(PREVIEW_DEADLINE_MS, removalPreview(String(req.params.taskId)))
    res.json({ probe, decision })
  } catch (err) {
    // A host that answers too slowly is a "could not check, try again", never a hang or a bare 504.
    if (err instanceof RouteDeadline || (err instanceof WorkspaceError && err.code === 'host-timeout')) {
      res.json({ degraded: 'timeout', error: 'Walnut could not check the workspace in time. Try again in a moment.' })
      return
    }
    sendError(res, err, next)
  }
})

workspacesRouter.post('/task/:taskId/remove', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ task: await within(ACTION_DEADLINE_MS, removeWorkspaceManually(String(req.params.taskId))) })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.post('/task/:taskId/setup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    res.json({ task: await within(ACTION_DEADLINE_MS, rerunSetup(String(req.params.taskId), {
      allow: body.allow === true, ...(typeof body.expect_hash === 'string' ? { expectHash: body.expect_hash } : {}),
    })) })
  } catch (err) {
    sendError(res, err, next)
  }
})

function insideDir(root: string, p: string): boolean {
  const strip = (s: string) => s.replace(/\/+$/, '') || '/'
  const r = strip(root)
  const t = strip(p)
  return t === r || t.startsWith(r + '/')
}

/** The project's registry name, or null when there is no such project (Inbox has none). */
async function projectNamed(raw: unknown): Promise<string | null> {
  const name = String(raw ?? '').trim()
  if (!name) return null
  const { getProjectRecord } = await import('../../core/task-manager.js')
  return (await getProjectRecord(name).catch(() => null))?.name ?? null
}

workspacesRouter.post('/task/:taskId/cancel-start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ task: await within(ACTION_DEADLINE_MS, cancelPendingStart(String(req.params.taskId))) })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.post('/task/:taskId/start-anyway', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ task: await within(ACTION_DEADLINE_MS, startAnyway(String(req.params.taskId))) })
  } catch (err) {
    sendError(res, err, next)
  }
})

/** Where a script runs and with what: the folder, its host, the task's project and workspace. */
async function scriptsPlace(q: Request['query']): Promise<{ project?: string; host: string; dir?: string; taskId?: string; workspaceRoot?: string } | string> {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const sessionId = str(q.session)
  let taskId = str(q.task)
  let cwd = str(q.cwd)
  let host = hostOf(q.host)
  if (sessionId) {
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const s = await getSessionByClaudeId(sessionId)
    if (!s) return 'session not found'
    taskId = s.taskId || taskId
    cwd = s.cwd ?? cwd
    host = hostOf(s.host)
  }
  let project = str(q.project)
  let workspaceRoot: string | undefined
  if (taskId) {
    const { getTask } = await import('../../core/task-manager.js')
    const task = await getTask(taskId).catch(() => null)
    if (!task) return 'task not found'
    project = task.project || project
    const ws = task.workspace
    // A session of the task inside its workspace runs scripts at the workspace root
    // (one in the source folder itself stays there).
    if (ws && isLaunchReady(ws) && ws.root && (!cwd || insideDir(ws.root, cwd))) {
      workspaceRoot = ws.root
      cwd = ws.root
      host = ws.host
    } else if (!cwd) {
      cwd = task.cwd
    }
  }
  if (!cwd && project && !taskId) {
    const { getProjectMetadata } = await import('../../core/task-manager.js')
    const meta = await getProjectMetadata(project).catch(() => null)
    if (typeof meta?.default_host === 'string' && !str(q.host)) host = hostOf(meta.default_host)
    // The project's folder only on the host it names: another machine has no such folder.
    const { defaultCwdOnHost } = await import('../../core/sessions/launch-place.js')
    cwd = defaultCwdOnHost(meta, host)
  }
  const dir = cwd && (cwd.startsWith('/') || cwd.startsWith('~/')) ? cwd : undefined
  return { ...(project ? { project } : {}), host, ...(dir ? { dir } : {}), ...(taskId ? { taskId } : {}), ...(workspaceRoot ? { workspaceRoot } : {}) }
}

workspacesRouter.get('/scripts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const place = await scriptsPlace(req.query)
    if (typeof place === 'string') {
      res.status(404).json({ error: place, code: 'not-found' })
      return
    }
    // A replica cannot reach the hosts: the project's list only.
    const view: ScriptsView = await within(ACTION_DEADLINE_MS, scriptsFor({
      project: place.project, host: place.host, ...(role() === 'replica' ? {} : { dir: place.dir }),
      // A draft asks for the file as committed: what the new worktree will hold.
      ...(typeof req.query.ref === 'string' && req.query.ref ? { ref: req.query.ref } : {}),
    }))
    res.json({ ...view, ...(place.workspaceRoot ? { workspace_root: place.workspaceRoot } : {}), ...(place.dir && !view.dir ? { dir: place.dir } : {}) })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.put('/scripts/project/:project', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (role() === 'replica') {
      res.status(409).json({ error: 'Project scripts are saved by the Walnut on your Mac.', code: 'cloud' })
      return
    }
    // A typo must not make a project: only an existing one keeps scripts.
    const project = await projectNamed(req.params.project)
    if (!project) {
      res.status(404).json({ error: `No project "${String(req.params.project ?? '')}".`, code: 'bad-project' })
      return
    }
    const clean = sanitizeProjectScripts((req.body ?? {}).scripts)
    if (typeof clean === 'string') {
      res.status(400).json({ error: clean, code: 'bad-scripts' })
      return
    }
    const { setProjectMetadata } = await import('../../core/task-manager.js')
    try {
      await setProjectMetadata(project, { scripts: clean })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(/^No project /.test(message) || /Inbox/.test(message) ? 404 : 400).json({ error: message, code: 'bad-project' })
      return
    }
    res.json({ project, scripts: clean })
  } catch (err) {
    sendError(res, err, next)
  }
})

workspacesRouter.post('/scripts/trust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (role() === 'replica') {
      res.status(409).json({ error: 'Scripts are allowed on the Walnut on your Mac.', code: 'cloud' })
      return
    }
    const key = (req.body ?? {}).key
    if (typeof key !== 'string' || !/^[a-f0-9]{16,64}$/.test(key)) {
      res.status(400).json({ error: 'key must be the file key the scripts view gave', code: 'bad-key' })
      return
    }
    await managerDeps().allowScriptsFile(key)
    res.json({ allowed: key })
  } catch (err) {
    sendError(res, err, next)
  }
})
