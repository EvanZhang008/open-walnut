/**
 * Commands on another host for a task's session (core/hosts/host-exec.ts), and
 * the user's grants for them (core/hosts/exec-grants.ts). Additive to v1.
 *
 *   POST   /api/v1/hosts/:host/exec                  { command | argv, cwd?, timeout_ms?, background? } → the run
 *   GET    /api/v1/hosts/:host/exec/:jobId?offset=&wait_ms= → the job's output
 *   POST   /api/v1/hosts/:host/exec/:jobId/stop      → stops it
 *   GET    /api/v1/host-exec/grants                  → { grants, denied } (live grants, ?all=1 adds revoked; the user's Denies)
 *   POST   /api/v1/host-exec/grants                  { task_id, host } → a grant (a person only)
 *   DELETE /api/v1/host-exec/grants/:id              → revoked (a person only)
 *   PUT    /api/v1/host-exec/hosts/:host             { closed } → the hard stop for that host (a person only)
 *
 * The caller is the session in `x-walnut-caller-sid`; a grant is the user's
 * word, so only the person at this computer makes or revokes one
 * (expose.ts isPersonAtThisMachine: no session id, a local origin). Known limit, the
 * same as the expose routes': a process on this Mac that leaves the session header
 * off passes as the person; a session on another host never does (its gateway
 * stamps it).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { isPersonAtThisMachine } from './expose.js'

export const hostExecV1Router = Router()

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = Array.isArray(raw) ? raw[0] : raw
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined
}

function leaderOnly(res: Response): boolean {
  if (!isFollower()) return false
  res.status(404).json({ error: 'Commands on other hosts run through the Mac', code: 'leader_only' })
  return true
}

async function answer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { HostExecError } = await import('../../core/hosts/host-exec.js')
    if (err instanceof HostExecError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.data })
      return
    }
    next(err)
  }
}

/** A route param as one string (express 5 types allow an array). */
function param(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

hostExecV1Router.post('/hosts/:host/exec', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(res, next, async () => (await import('../../core/hosts/host-exec.js')).execOnHost({
    host: param(req.params.host),
    ...(typeof b.command === 'string' ? { command: b.command } : {}),
    ...(Array.isArray(b.argv) ? { argv: b.argv.map(String) } : {}),
    ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
    background: b.background === true,
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/exec/:jobId', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => (await import('../../core/hosts/host-exec.js')).readHostJob({
    host: param(req.params.host), job_id: param(req.params.jobId), offset: num(req.query.offset), wait_ms: num(req.query.wait_ms),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/exec/:jobId/stop', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => (await import('../../core/hosts/host-exec.js')).stopHostJob({
    host: param(req.params.host), job_id: param(req.params.jobId),
  }, callerSid(req)))
})

hostExecV1Router.get('/host-exec/grants', async (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  try {
    const { listGrants, listDenied, closedHosts } = await import('../../core/hosts/exec-grants.js')
    const { getTask } = await import('../../core/task-manager.js')
    const grants = listGrants({ all: req.query.all === '1' })
    const denied = listDenied()
    const titles = new Map<string, string>()
    for (const t of [...grants, ...denied]) {
      if (!titles.has(t.taskId)) titles.set(t.taskId, (await getTask(t.taskId).catch(() => undefined))?.title ?? '')
    }
    res.json({
      grants: grants.map((g) => ({ ...g, taskTitle: titles.get(g.taskId) || null })),
      denied: denied.map((a) => ({ taskId: a.taskId, host: a.host, askedAt: a.askedAt, answeredAt: a.answeredAt ?? null, taskTitle: titles.get(a.taskId) || null })),
      closedHosts: closedHosts(),
    })
  } catch (err) { next(err) }
})

/** A grant is the user's word: only the person at this computer (no session id, a local origin) makes or revokes one. */
function humanOnly(req: Request, res: Response): boolean {
  if (isPersonAtThisMachine(req)) return false
  res.status(403).json({ error: 'Only the user, at this computer, grants or revokes a task\'s commands on another host', code: 'human_only' })
  return true
}

hostExecV1Router.post('/host-exec/grants', async (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res) || humanOnly(req, res)) return
  try {
    const b = (req.body ?? {}) as Record<string, unknown>
    const taskId = typeof b.task_id === 'string' ? b.task_id.trim() : ''
    const host = typeof b.host === 'string' ? b.host.trim() : ''
    if (!taskId || !host) { res.status(400).json({ error: 'task_id and host are required', code: 'bad_request' }); return }
    const { grant } = await import('../../core/hosts/exec-grants.js')
    res.json({ grant: await grant(taskId, host, 'settings') })
  } catch (err) { next(err) }
})

hostExecV1Router.delete('/host-exec/grants/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res) || humanOnly(req, res)) return
  try {
    const { revokeGrant } = await import('../../core/hosts/exec-grants.js')
    const g = await revokeGrant(param(req.params.id))
    if (!g) { res.status(404).json({ error: 'No live grant with that id', code: 'not_found' }); return }
    res.json({ grant: g })
  } catch (err) { next(err) }
})

hostExecV1Router.put('/host-exec/hosts/:host', async (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res) || humanOnly(req, res)) return
  try {
    const host = param(req.params.host)
    const closed = (req.body as { closed?: unknown } | undefined)?.closed
    if (typeof closed !== 'boolean') { res.status(400).json({ error: 'closed (true or false) is required', code: 'bad_request' }); return }
    const { isOwnHost } = await import('../../core/hosts/host-exec.js')
    if (!(await isOwnHost(host))) { res.status(404).json({ error: `Unknown host: ${host}`, code: 'unknown_host' }); return }
    const { setHostClosed } = await import('../../core/hosts/exec-grants.js')
    res.json({ closedHosts: await setHostClosed(host, closed) })
  } catch (err) { next(err) }
})

/*
 * MCP servers and web services on another host (core/hosts/host-mcp.ts, host-http.ts),
 * under the same grant as its commands:
 *
 *   GET  /api/v1/hosts/:host/mcp?cwd=                    → { servers } (names only, no grant)
 *   GET  /api/v1/hosts/:host/mcp/:server/tools?cwd=      → { tools } or { running, callId }
 *   POST /api/v1/hosts/:host/mcp/:server/call            { tool, arguments?, cwd?, timeout_ms? } → the answer or { running, callId }
 *   GET  /api/v1/hosts/:host/mcp-calls/:callId?wait_ms=  → a call's answer
 *   POST /api/v1/hosts/:host/http                        { url, method?, headers?, body? | body_base64?, timeout_ms? } → the response
 */
function str(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s ? s : undefined
}

hostExecV1Router.get('/hosts/:host/mcp', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => (await import('../../core/hosts/host-mcp.js')).listHostMcp({
    host: param(req.params.host), ...(str(req.query.cwd) ? { cwd: str(req.query.cwd) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/mcp/:server/tools', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpTools({
    host: param(req.params.host), server: param(req.params.server), ...(str(req.query.cwd) ? { cwd: str(req.query.cwd) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/mcp/:server/call', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpCall({
    host: param(req.params.host), server: param(req.params.server), tool: typeof b.tool === 'string' ? b.tool : '',
    ...(b.arguments !== undefined ? { arguments: b.arguments as Record<string, unknown> } : {}),
    ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/mcp-calls/:callId', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpResult({
    host: param(req.params.host), call_id: param(req.params.callId), wait_ms: num(req.query.wait_ms),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/http', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(res, next, async () => (await import('../../core/hosts/host-http.js')).httpOnHost({
    host: param(req.params.host), url: typeof b.url === 'string' ? b.url : '',
    ...(typeof b.method === 'string' ? { method: b.method } : {}),
    ...(b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers) ? { headers: b.headers as Record<string, string> } : {}),
    ...(typeof b.body === 'string' ? { body: b.body } : {}),
    ...(typeof b.body_base64 === 'string' ? { body_base64: b.body_base64 } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
  }, callerSid(req)))
})
