/**
 * Transfer a task to another engine or host, and the host profiles that make
 * a transfer start well (core/transfer/, core/hosts/host-profile.ts).
 *
 *   GET   /tasks/:id/transfer-options   what the task can move to (blocked pairs carry a reason)
 *   POST  /tasks/:id/transfer           do it: a new task beside this one takes the work (waits up
 *                                       to wait_ms, default 20s, then 202 with the transfer id)
 *   GET   /transfers/:id                that transfer: 200 result, its error, 202 still running, or 200
 *                                       unconfirmed (a restart lost it while its new task was pending)
 *   GET   /hosts/:host/profile          what Walnut knows about a host (+ a few-line summary)
 *   PATCH /hosts/:host/profile          the user names the host's kind or leaves a note
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { ENGINE_REGISTRY, isKnownEngine } from '../../core/agents/engine-registry.js'
import { TransferError, transferOptions, LOCAL_HOST, normalizeHost } from '../../core/transfer/planner.js'
import type { HostKind } from '../../core/hosts/host-profile.js'
import type { SessionEffort, SessionEngine, SessionMode } from '../../core/types.js'
import type { TransferJob } from '../../core/transfer/transfer-jobs.js'
import { placement } from '../../core/server-role.js'

export const transferV1Router = Router()

const KINDS: readonly HostKind[] = ['laptop', 'public-cloud-vm', 'private-cloud-vm', 'dev-box', 'unknown']

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = Array.isArray(raw) ? raw[0] : raw
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined
}

function sendError(res: Response, err: unknown, next: NextFunction): void {
  const status = (err as { status?: number }).status
  if (err instanceof TransferError || typeof status === 'number') {
    res.status(status ?? 500).json({ error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code })
    return
  }
  next(err)
}

async function enabledHosts(): Promise<string[]> {
  const { getConfig } = await import('../../core/config-manager.js')
  const hosts = (await getConfig()).hosts ?? {}
  return Object.entries(hosts).filter(([, h]) => (h as { enabled?: boolean }).enabled !== false).map(([alias]) => alias)
}

transferV1Router.get('/tasks/:id/transfer-options', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    const task = await getTask(String(req.params.id)).catch(() => null)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }
    const { taskConversation } = await import('../../core/sessions/task-session-claim.js')
    const session = await taskConversation(task.id)
    const hosts = await enabledHosts()
    const engines = [...ENGINE_REGISTRY.values()].map((c) => ({ id: c.id, displayName: c.displayName }))
    const { readHostProfile } = await import('../../core/hosts/host-profile.js')
    const { getConfig } = await import('../../core/config-manager.js')
    const { hostDisplayName } = await import('../../core/hosts/host-display-name.js')
    const hostRows = (await getConfig()).hosts ?? {}
    const profiles = await Promise.all([LOCAL_HOST, ...hosts].map(async (alias) => {
      const p = await readHostProfile(alias).catch(() => null)
      // The name a person knows the host by (the cloud box's alias is internal).
      const label = alias === LOCAL_HOST ? undefined : hostDisplayName(alias, (hostRows[alias] as { label?: unknown } | undefined)?.label)
      return { alias, ...(label && label !== alias ? { label } : {}), kind: p?.kind ?? 'unknown', probedAt: p?.probed?.probedAt ?? null }
    }))
    res.json({
      taskId: task.id,
      source: session ? {
        sessionId: session.claudeSessionId,
        engine: session.engine ?? 'claude',
        host: normalizeHost(session.host),
        cwd: session.cwd ?? task.cwd ?? null,
        // What the new session starts with unless the person picks otherwise.
        model: session.cliModel || session.model || null,
        // The model it runs on, for a label when `model` is the CLI's own 'default'.
        runningModel: session.model ?? null,
        effort: session.effort ?? null,
        permissionMode: session.mode ?? null,
      } : null,
      engines,
      hosts: profiles,
      options: transferOptions(engines.map((e) => e.id), hosts),
    })
  } catch (err) { next(err) }
})

/** One answer shape for POST and GET: 200 the result, the job's error status, or 202 still running. */
function sendJob(res: Response, job: TransferJob): void {
  if (job.state === 'done') { res.json({ transferId: job.id, state: job.state, ...job.result }); return }
  if (job.state === 'unconfirmed') {
    res.json({ transferId: job.id, state: job.state, sourceTaskId: job.taskId, taskId: job.newTaskId, ...(job.error ? { error: job.error.message } : {}) })
    return
  }
  if (job.state === 'error') {
    res.status(job.error?.status ?? 500).json({ transferId: job.id, state: job.state, error: job.error?.message, code: job.error?.code })
    return
  }
  res.status(202).json({ transferId: job.id, state: job.state, sourceTaskId: job.taskId, startedAt: job.startedAt })
}

/**
 * A transfer moves files between the Mac's daemons and writes the Mac's task
 * store, so the companion never runs one itself. (A host replica forwards every
 * write to the Mac by its route table's default, and answers needs_leader while
 * the Mac is away.)
 */
transferV1Router.use(['/tasks/:id/transfer', '/hosts/:host/profile'], (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' || placement() !== 'cloud') { next(); return }
  res.status(501).json({ error: 'Transfers and host profile changes run on your Mac only', code: 'not_supported_cloud' })
})

function waitMs(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(n) ? n : fallback
}

transferV1Router.post('/tasks/:id/transfer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const engine = body.engine
    if (engine !== undefined && !isKnownEngine(engine)) { res.status(400).json({ error: `Unknown engine: ${String(engine)}` }); return }
    const mode = body.mode
    if (mode !== undefined && mode !== 'carry' && mode !== 'brief') { res.status(400).json({ error: 'mode is carry or brief' }); return }
    const str = (k: string) => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : undefined)
    const { transferTask } = await import('../../core/transfer/transfer.js')
    const jobs = await import('../../core/transfer/transfer-jobs.js')
    const job = jobs.startTransferJob({
      taskId: String(req.params.id),
      ...(engine ? { engine: engine as SessionEngine } : {}),
      ...(str('host') ? { host: str('host') } : {}),
      ...(str('cwd') ? { cwd: str('cwd') } : {}),
      ...(mode ? { mode } : {}),
      ...(str('model') ? { model: str('model') } : {}),
      ...(str('effort') ? { effort: str('effort') as SessionEffort } : {}),
      ...(str('permission_mode') ? { permissionMode: str('permission_mode') as SessionMode } : {}),
      ...(str('message') ? { message: str('message') } : {}),
      keepSource: body.keep_source === true,
      callerSid: callerSid(req),
    }, transferTask)
    sendJob(res, await jobs.waitForTransferJob(job, waitMs(body.wait_ms, 20_000)))
  } catch (err) {
    log.web.warn('transfer failed', { taskId: req.params.id, error: err instanceof Error ? err.message : String(err) })
    sendError(res, err, next)
  }
})

transferV1Router.get('/transfers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = await import('../../core/transfer/transfer-jobs.js')
    const job = jobs.getTransferJob(String(req.params.id)) ?? await jobs.unconfirmedTransferJob(String(req.params.id))
    if (!job) { res.status(404).json({ error: 'No such transfer on this server (it finished over an hour ago, or the server restarted); check the task instead', code: 'transfer_not_found' }); return }
    sendJob(res, await jobs.waitForTransferJob(job, waitMs(req.query.wait_ms, 0)))
  } catch (err) { next(err) }
})

transferV1Router.get('/hosts/:host/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = normalizeHost(String(req.params.host))
    const { readHostProfile, hostProfileSummary } = await import('../../core/hosts/host-profile.js')
    const profile = await readHostProfile(host)
    res.json({ profile, summary: hostProfileSummary(profile, host === LOCAL_HOST ? 'this Mac' : host) })
  } catch (err) { sendError(res, err, next) }
})

transferV1Router.patch('/hosts/:host/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = normalizeHost(String(req.params.host))
    const body = (req.body ?? {}) as { kind?: unknown; user_note?: unknown; refresh?: unknown }
    if (body.kind !== undefined && body.kind !== null && !KINDS.includes(body.kind as HostKind)) {
      res.status(400).json({ error: `kind is one of ${KINDS.join(', ')}` }); return
    }
    const hp = await import('../../core/hosts/host-profile.js')
    if (body.refresh === true) {
      const { probeHostFacts } = await import('../../core/transfer/daemon-transfer-client.js')
      await hp.recordProbedFacts(host, await probeHostFacts(host))
    }
    const profile = await hp.updateHostProfile(host, (p) => {
      if (body.kind === null) {
        p.kindSetByUser = false
        if (p.probed) { const c = hp.classifyHost(p.probed); p.kind = c.kind; p.kindReasons = c.reasons }
      } else if (typeof body.kind === 'string') {
        p.kind = body.kind as HostKind
        p.kindSetByUser = true
        p.kindReasons = ['set by the user']
      }
      if (typeof body.user_note === 'string') p.userNote = body.user_note.trim().slice(0, 600) || undefined
    })
    res.json({ profile })
  } catch (err) { sendError(res, err, next) }
})
