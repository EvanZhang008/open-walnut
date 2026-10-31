/**
 * Move a task to another host in one step (core/sessions/engine-switch.ts, `move`), and
 * read every host's load (core/hosts/placement.ts).
 *
 *   POST /tasks/:id/move   { host, text?, engine?, model?, team?, wait_ms?, user_request? }
 *                          → 200 done (same task id, its new session, what moved), 202 pending
 *                          (its turn ends first) or moving (still copying after wait_ms).
 *                          `team: true` moves every open task under it with it, one after another.
 *   GET  /hosts/load       { hosts: [...] } each host's numbers, whether it is over a cap and why
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { placement } from '../../core/server-role.js'
import type { SessionEngine, Task } from '../../core/types.js'
import { log } from '../../logging/index.js'

export const taskMoveV1Router = Router()

const DEFAULT_TEXT = 'Your task moved to this host. Check that its work is set up here (the move note above says where), then carry on where it stood. If it was waiting on someone, say so and stop.'

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

taskMoveV1Router.use('/tasks/:id/move', (req: Request, res: Response, next: NextFunction) => {
  if (placement() !== 'cloud') { next(); return }
  res.status(501).json({ error: 'A move runs on your Mac only', code: 'not_supported_cloud' })
})

/** The open tasks under `root` whose session is not on `host` yet, parents first. */
async function teamToMove(root: Task, host: string): Promise<Task[]> {
  const { listTasks } = await import('../../core/task-manager.js')
  const { teamOf } = await import('../../core/sessions/team-stop.js')
  const { taskConversation } = await import('../../core/sessions/task-session-claim.js')
  const { normalizeHost } = await import('../../core/transfer/planner.js')
  const out: Task[] = []
  for (const t of teamOf(root, await listTasks({}), false)) {
    const s = await taskConversation(t.id).catch(() => null)
    if (s && normalizeHost(s.host) !== host) out.push(t)
  }
  return out
}

taskMoveV1Router.post('/tasks/:id/move', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.host !== 'string' || !body.host.trim()) {
      res.status(400).json({ error: 'host names where the task goes (a host alias, or "local" for this Mac)', code: 'host_required' }); return
    }
    const { normalizeHost } = await import('../../core/transfer/planner.js')
    const host = normalizeHost(body.host.trim())
    const text = typeof body.text === 'string' && body.text.trim() ? body.text : DEFAULT_TEXT
    const { getTask } = await import('../../core/task-manager.js')
    const task = await getTask(String(req.params.id)).catch(() => null)
    if (!task) { res.status(404).json({ error: 'Task not found', code: 'not_found' }); return }
    const { taskConversation } = await import('../../core/sessions/task-session-claim.js')
    const conversation = await taskConversation(task.id)
    if (!conversation) {
      res.status(409).json({ error: 'This task has no session yet: start it with task_start and host instead', code: 'no_conversation' }); return
    }
    const { resolveEngine, isKnownEngine } = await import('../../core/agents/engine-registry.js')
    const engine = typeof body.engine === 'string' && isKnownEngine(body.engine) ? body.engine as SessionEngine : resolveEngine(conversation.engine)
    const { requestEngineSwitch } = await import('../../core/sessions/engine-switch.js')
    const caller = callerSid(req)
    const userWords = typeof body.user_request === 'string' ? body.user_request : undefined
    const ask = (id: string) => requestEngineSwitch({
      taskId: id, engine, host, message: text, ...(userWords ? { userWords } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      callerSid: caller, source: 'api',
    })
    const team = body.team === true ? await teamToMove(task, host) : []
    const waitFor = Math.min(Math.max(Number(body.wait_ms ?? 25_000) || 0, 0), 180_000)
    const work = normalizeHost(conversation.host) === host && team.length > 0 ? null : ask(task.id)
    // The team follows one at a time: each move packs and copies on the same two hosts.
    const followers = team.length ? (async () => {
      if (work) await work.catch(() => {})
      const results: Array<{ taskId: string; state?: string; error?: string }> = []
      for (const t of team) {
        try {
          const r = await requestEngineSwitch({
            taskId: t.id, engine: resolveEngine((await taskConversation(t.id))?.engine), host, message: text,
            ...(userWords ? { userWords } : {}), callerSid: caller, source: 'api',
          })
          results.push({ taskId: t.id, state: r.state })
        } catch (err) {
          results.push({ taskId: t.id, error: err instanceof Error ? err.message : String(err) })
          log.session.warn('task move: a team member did not move', { root: task.id, taskId: t.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return results
    })() : null
    followers?.catch(() => {})
    if (!work) {
      res.status(202).json({ state: 'moving', taskId: task.id, host, team: team.map((t) => ({ taskId: t.id, title: t.title })) })
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      work.then((r) => ({ r }), (e: unknown) => ({ e })),
      new Promise<{ late: true }>((resolve) => { timer = setTimeout(() => resolve({ late: true }), waitFor) }),
    ])
    if (timer) clearTimeout(timer)
    const teamField = team.length ? { team: team.map((t) => ({ taskId: t.id, title: t.title })) } : {}
    if ('late' in outcome) {
      work.catch(() => {})
      res.status(202).json({ state: 'moving', taskId: task.id, host, ...teamField })
      return
    }
    if ('e' in outcome) { sendError(res, outcome.e, next); return }
    res.status(outcome.r.state === 'pending' ? 202 : 200).json({ ...outcome.r, ...teamField })
  } catch (err) { sendError(res, err, next) }
})

taskMoveV1Router.get('/hosts/load', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { hostLoads, placementCaps } = await import('../../core/hosts/placement.js')
    res.json({ hosts: await hostLoads(), caps: placementCaps() })
  } catch (err) { next(err) }
})
