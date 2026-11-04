/**
 * Commands on another host for a task's session (core/hosts/host-exec.ts), and
 * the user's grants for them (core/hosts/exec-grants.ts). Additive to v1.
 *
 *   POST   /api/v1/hosts/:host/exec                  { command | argv, cwd?, timeout_ms?, background?, allow_prompts?, strict?, job_id? } → the run
 *   GET    /api/v1/hosts/:host/exec                  → { jobs } this task's runs there, running and recent
 *   GET    /api/v1/hosts/:host/exec/:jobId?offset=&wait_ms= → the job's output
 *   POST   /api/v1/hosts/:host/exec/:jobId/stop      → stops it
 *   POST   /api/v1/hosts/:host/daemon-update         → the host's daemon updated to this build (same grant)
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

/**
 * The work's answer, or its refusal with its code. When the host the caller named is a found
 * twin of a joined machine, the work went to the joined row (host-exec.ts targetHost) and the
 * answer says so in `note`, the run's and the refusal's alike. The work runs under the caller's
 * deadline when its self-call carries one (src/lib/answer-by.ts: a session on another host,
 * whose gateway gives up at 20 s), so a hold lets go in time for the answer to get back.
 */
async function answer(req: Request, res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  const [{ HostExecError, sameMachineNote }, { ANSWER_BY_HEADER, parseAnswerBy, withAnswerBy }] = await Promise.all([
    import('../../core/hosts/host-exec.js'), import('../../lib/answer-by.js'),
  ])
  const asked = param(req.params.host)
  // Read while the work runs: [its note when it ran, its note when it was refused].
  const notes: Promise<[string | null, string | null]> = asked
    ? Promise.all([sameMachineNote(asked), sameMachineNote(asked, true)]).catch(() => [null, null])
    : Promise.resolve([null, null])
  const note = async (refused: boolean) => (await notes)[refused ? 1 : 0]
  try {
    // The header is this request's whole deadline: nothing ambient from another request counts.
    const body = await withAnswerBy(parseAnswerBy(req.headers[ANSWER_BY_HEADER]), work, { fresh: true })
    const said = await note(false)
    res.json(said && body && typeof body === 'object' && !Array.isArray(body) ? { note: said, ...body } : body)
  } catch (err) {
    if (err instanceof HostExecError) {
      const said = await note(true)
      res.status(err.status).json({ error: err.message, code: err.code, ...err.data, ...(said ? { note: said } : {}) })
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
  void answer(req, res, next, async () => (await import('../../core/hosts/host-exec.js')).execOnHost({
    host: param(req.params.host),
    ...(typeof b.command === 'string' ? { command: b.command } : {}),
    ...(Array.isArray(b.argv) ? { argv: b.argv.map(String) } : {}),
    ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
    background: b.background === true,
    allow_prompts: b.allow_prompts === true,
    strict: b.strict === true,
    ...(typeof b.job_id === 'string' ? { job_id: b.job_id } : {}),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/exec', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(req, res, next, async () => (await import('../../core/hosts/host-exec-jobs.js')).listHostJobs({
    host: param(req.params.host),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/exec/:jobId', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(req, res, next, async () => (await import('../../core/hosts/host-exec-jobs.js')).readHostJob({
    host: param(req.params.host), job_id: param(req.params.jobId), offset: num(req.query.offset), wait_ms: num(req.query.wait_ms),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/exec/:jobId/stop', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(req, res, next, async () => (await import('../../core/hosts/host-exec-jobs.js')).stopHostJob({
    host: param(req.params.host), job_id: param(req.params.jobId),
  }, callerSid(req)))
})

/**
 * POST /api/v1/hosts/:host/daemon-update → the host's daemon updated to this build now
 * (core/hosts/host-daemon-update.ts): a session under the host_exec grant, else only
 * the person at this computer.
 */
hostExecV1Router.post('/hosts/:host/daemon-update', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const sid = callerSid(req)
  if (!sid && !isPersonAtThisMachine(req)) {
    res.status(403).json({ error: 'A task\'s session or the user at this computer asks for a daemon update', code: 'human_only' })
    return
  }
  void answer(req, res, next, async () => (await import('../../core/hosts/host-daemon-update.js')).requestHostDaemonUpdate(param(req.params.host), sid))
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
  void answer(req, res, next, async () => (await import('../../core/hosts/host-mcp.js')).listHostMcp({
    host: param(req.params.host), ...(str(req.query.cwd) ? { cwd: str(req.query.cwd) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/mcp/:server/tools', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(req, res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpTools({
    host: param(req.params.host), server: param(req.params.server), ...(str(req.query.cwd) ? { cwd: str(req.query.cwd) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/mcp/:server/call', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(req, res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpCall({
    host: param(req.params.host), server: param(req.params.server), tool: typeof b.tool === 'string' ? b.tool : '',
    ...(b.arguments !== undefined ? { arguments: b.arguments as Record<string, unknown> } : {}),
    ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
  }, callerSid(req)))
})

hostExecV1Router.get('/hosts/:host/mcp-calls/:callId', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(req, res, next, async () => (await import('../../core/hosts/host-mcp.js')).hostMcpResult({
    host: param(req.params.host), call_id: param(req.params.callId), wait_ms: num(req.query.wait_ms),
  }, callerSid(req)))
})

hostExecV1Router.post('/hosts/:host/http', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(req, res, next, async () => (await import('../../core/hosts/host-http.js')).httpOnHost({
    host: param(req.params.host), url: typeof b.url === 'string' ? b.url : '',
    ...(typeof b.method === 'string' ? { method: b.method } : {}),
    ...(b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers) ? { headers: b.headers as Record<string, string> } : {}),
    ...(typeof b.body === 'string' ? { body: b.body } : {}),
    ...(typeof b.body_base64 === 'string' ? { body_base64: b.body_base64 } : {}),
    ...(num(b.timeout_ms) !== undefined ? { timeout_ms: num(b.timeout_ms) } : {}),
  }, callerSid(req)))
})
