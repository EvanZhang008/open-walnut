/**
 * /api/v1/org: the org above the work (src/core/org/).
 *
 *   GET  /org                 → { tree }              the whole org, for the org chart
 *   GET  /org/reports[?of=id] → { of, rows }          one node's direct reports, compact (org_get);
 *                                                     `of` defaults to the calling session's task
 *   POST /org/main            → { task }              the main agent's task, made on first use
 *   POST /org/contact { to }  → { task, kind, project, started, launch? }
 *                                                     who `to` (a project or a task) means; a
 *                                                     project with 2+ teams gets its lead here;
 *                                                     `launch` = where a lead with no session
 *                                                     would start ({ cwd, host }), read only
 *   POST /org/vp { project, vp } → { project, vp, lead?, closed, moved, unchanged? }
 *                                                     put a project under another project's VP
 *                                                     (its lead), or back under its own (vp '');
 *                                                     no task changes project
 *   GET  /org/settings        → { name, founderTitle }  the org's name and the user's role
 *   PUT  /org/settings { name?, founderTitle? } → the same, after the change (blank = default)
 *
 * Reads work anywhere; the writes make or change org tasks, so they run on the primary
 * only (501 on a replica, like every other task create).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { role } from '../../core/server-role.js'
import type { Task } from '../../core/types.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { getOrgSettings, setOrgSettings } from '../../core/org/org-settings.js'
import {
  OrgError, contactLaunch, ensureMainTask, getOrgTree, orgReportsOf, resolveOrgContact, setProjectVp,
} from '../../core/org/org-store.js'

export const orgV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.trim() || undefined
}

function sendError(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof OrgError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  next(err)
}

function brief(task: Task): Record<string, unknown> {
  return {
    id: task.id, title: task.title, project: task.project ?? '', phase: task.phase,
    ...(task.org_role ? { org_role: task.org_role } : {}),
  }
}

/** Org nodes are tasks only the leader makes: a replica making its own would split the org. */
function primaryOnly(what: string): void {
  if (role() !== 'leader') throw new OrgError('not_supported_cloud', 501, `${what} on the primary box`)
}

function hasSession(task: Task): boolean {
  return !!(task.session_id || task.exec_session_id)
}

orgV1Router.get('/org', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ tree: await getOrgTree() })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.get('/org/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    const ofParam = typeof req.query.of === 'string' ? req.query.of.trim() : ''
    let of: Task | undefined
    if (ofParam) {
      of = await getTask(ofParam).catch(() => undefined)
      if (!of) throw new OrgError('unknown_task', 404, `No task "${ofParam}".`)
    } else {
      const sid = header(req, 'x-walnut-caller-sid')
      if (sid) {
        const { resolveCallerPlacement } = await import('../../core/sessions/caller-placement.js')
        const me = await resolveCallerPlacement(sid)
        if ('task' in me && me.task) of = await getTask(me.task.id).catch(() => undefined)
      }
    }
    res.json(await orgReportsOf(of))
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.post('/org/main', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('The main agent is made')
    res.json({ task: await ensureMainTask() })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.post('/org/contact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('Org contacts are resolved')
    const to = typeof req.body?.to === 'string' ? req.body.to : ''
    const contact = await resolveOrgContact(to)
    const started = hasSession(contact.task)
    const launch = contact.kind === 'lead' && !started ? await contactLaunch(contact.task) : undefined
    res.json({ task: brief(contact.task), kind: contact.kind, project: contact.project, started, ...(launch ? { launch } : {}) })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.post('/org/vp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A project\'s VP is changed')
    const project = typeof req.body?.project === 'string' ? req.body.project : ''
    const vp = req.body?.vp
    if (vp !== undefined && typeof vp !== 'string') throw new OrgError('bad_vp', 400, '`vp` is a project name, or "" for the project\'s own.')
    res.json(await setProjectVp(project, vp ?? ''))
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.get('/org/settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getOrgSettings())
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.put('/org/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('The org\'s names are changed')
    const body = (req.body ?? {}) as { name?: unknown; founderTitle?: unknown }
    for (const k of ['name', 'founderTitle'] as const) {
      if (body[k] !== undefined && typeof body[k] !== 'string') throw new OrgError('bad_name', 400, `\`${k}\` is a string.`)
    }
    const settings = await setOrgSettings(body)
    // Every other window (and the Mac app) reads the new names at once.
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'org' }, ['web-ui'], { source: 'api' })
    res.json(settings)
  } catch (err) {
    sendError(res, next, err)
  }
})
