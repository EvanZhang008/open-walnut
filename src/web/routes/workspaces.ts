/**
 * Task workspaces (src/core/workspaces/).
 *
 *   GET  /api/workspaces/providers?cwd=&host=        the providers that can isolate this folder
 *   POST /api/workspaces/task/:taskId                { provider, inputs?, host? } → make one now
 *   POST /api/workspaces/task/:taskId/retry          a failed creation, or a session that could not start
 *   GET  /api/workspaces/task/:taskId/removal        what "Remove workspace…" would delete and keep
 *   POST /api/workspaces/task/:taskId/remove         remove it (after the confirm dialog)
 *
 * Thin edges: creation and removal are host jobs that answer at once; their
 * progress rides task:updated. The remove route never probes: the host probes
 * again before it deletes and refuses when anything would be lost. Every route
 * that reaches a daemon has a deadline and degrades (a provider list without the
 * host's verdicts, a preview that says it could not check in time).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { WorkspaceError, workspaceRpc } from '../../core/workspaces/daemon-client.js'
import { workspaceProviderCatalog } from '../../core/workspaces/registry.js'
import { requestWorkspace, retryWorkspace, removalPreview, removeWorkspaceManually, PREVIEW_RPC_MS } from '../../core/workspaces/manager.js'
import type { WorkspaceCandidate } from '../../core/workspaces/types.js'

export const workspacesRouter = Router()

const DETECT_BUDGET_MS = 15_000
const DETECT_DEADLINE_MS = 22_000
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
    const catalog = await workspaceProviderCatalog()
    const base = (reason: string): WorkspaceCandidate[] => catalog.providers.map((p) => ({
      provider: p.id, displayName: p.displayName, priority: p.priority, builtin: p.builtin,
      // A plugin provider stays pickable without the host's verdict; git needs a repository.
      claimed: false, reason, ...(p.inputSchema ? { inputSchema: p.inputSchema } : {}),
    }))
    if (!cwd || (!cwd.startsWith('/') && !cwd.startsWith('~/'))) {
      res.json({ cwd, host, candidates: base('Pick a folder first'), degraded: 'no-folder' })
      return
    }
    if (process.env.WALNUT_CLOUD_MODE === '1') {
      res.json({ cwd, host, candidates: base('Isolated workspaces are made by the Walnut on your Mac'), degraded: 'cloud' })
      return
    }
    let reply: Record<string, unknown>
    try {
      reply = await within(DETECT_DEADLINE_MS, workspaceRpc(host, 'workspace.detect', { anchor: cwd, budgetMs: DETECT_BUDGET_MS }, DETECT_DEADLINE_MS - 1_000))
    } catch (err) {
      const reason = err instanceof WorkspaceError ? err.message : err instanceof RouteDeadline ? 'The host took too long to look at this folder' : String(err)
      res.json({ cwd, host, candidates: base(reason), degraded: err instanceof WorkspaceError ? err.code : 'timeout' })
      return
    }
    if (!reply.ok) {
      res.json({ cwd, host, candidates: base(String(reply.error ?? 'The host could not look at this folder')), degraded: 'detect-failed' })
      return
    }
    const byId = new Map(catalog.providers.map((p) => [p.id, p]))
    const found = (Array.isArray(reply.candidates) ? reply.candidates : []) as Array<Record<string, unknown>>
    const candidates: WorkspaceCandidate[] = found
      .filter((c) => typeof c.provider === 'string' && byId.has(c.provider))
      .map((c) => {
        const info = byId.get(String(c.provider))!
        return {
          provider: info.id, displayName: info.displayName, priority: info.priority, builtin: info.builtin,
          claimed: c.claimed === true,
          ...(typeof c.root === 'string' ? { root: c.root } : {}),
          ...(typeof c.branch === 'string' ? { branch: c.branch } : {}),
          ...(typeof c.reason === 'string' ? { reason: c.reason } : {}),
          ...(info.inputSchema ? { inputSchema: info.inputSchema } : {}),
        }
      })
    // A provider the daemon did not report (an older allowlist) is still offered, unclaimed.
    for (const p of catalog.providers) {
      if (!candidates.some((c) => c.provider === p.id)) candidates.push(...base('Not checked on this host').filter((c) => c.provider === p.id))
    }
    candidates.sort((a, b) => Number(b.claimed) - Number(a.claimed) || b.priority - a.priority)
    res.json({ cwd, host, candidates })
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
