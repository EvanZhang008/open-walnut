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
 *   GET  /org/settings        → { name, founderTitle, defaultInstructions }  the org's name, the user's role, Walnut's default core instructions
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
import { createOrgNode, editOrgNode, editProjectVp, type OrgWriter } from '../../core/org/org-node-edit.js'
import { orgDisplayTitle } from '../../core/org/org-tree.js'

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

/**
 * The contact already has a conversation: a message goes into it, never a start. The task's
 * own slot can lag its session records (a slot link that lost a lock race leaves the record
 * naming the task while the task names nothing; the task routes repair this the same way,
 * tasks.ts enrichTasksWithSessionStatus), and a start of a task whose session runs answers
 * 409 session_exists (2026-10-29: org_send to a running task did, the way task_send never would).
 */
async function hasSession(task: Task): Promise<boolean> {
  if (task.session_id || task.exec_session_id) return true
  // The start's own test of a conversation (rows that never held one do not count).
  const { taskConversation } = await import('../../core/sessions/task-session-claim.js')
  return !!(await taskConversation(task.id))
}

orgV1Router.get('/org', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ tree: await getOrgTree() })
  } catch (err) {
    sendError(res, next, err)
  }
})

// GET /api/v1/org/status-check: every open task whose stored status is not what its facts say
// (core/status-consistency.ts). Read-only; answers 503 rather than hang past its deadline, and
// callers at once share one pass (it reads every task).
let statusCheckFlight: Promise<Awaited<ReturnType<typeof import('../../core/status-consistency.js').checkStatuses>>> | null = null
orgV1Router.get('/org/status-check', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { checkStatuses } = await import('../../core/status-consistency.js')
    const checkedAt = new Date().toISOString()
    const flight = statusCheckFlight ??= checkStatuses().finally(() => { statusCheckFlight = null })
    const result = await Promise.race([
      flight,
      new Promise<null>((r) => { const t = setTimeout(() => r(null), 15_000); t.unref?.() }),
    ])
    if (!result) { res.status(503).json({ error: 'status check timed out', checkedAt }); return }
    res.json({ checkedAt, mismatches: result })
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
    // Who asks decides whether a lead that handed over is passed by (org/retired-lead.ts).
    const rawSid = req.headers['x-walnut-caller-sid']
    const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
    const caller = await resolveCaller(Array.isArray(rawSid) ? rawSid[0] : rawSid)
    const askerTaskId = caller.kind === 'human' ? undefined : caller.kind === 'session' ? caller.record.taskId ?? '' : ''
    const contact = await resolveOrgContact(to, { askerTaskId })
    // `task`: more for a task the contact already gave this work to, sent to it directly; the contact
    // reads it in its next team note (team-asks.ts) instead of spending a turn passing it on.
    const named = typeof req.body?.task === 'string' ? req.body.task.trim() : ''
    if (named) {
      const target = await teamTaskOf(contact, named)
      res.json({
        task: brief(target), kind: 'task', project: contact.project, started: await hasSession(target),
        via: { ...brief(contact.task), kind: contact.kind },
        ...(contact.handedOverBy ? { handedOverBy: contact.handedOverBy } : {}),
      })
      return
    }
    const started = await hasSession(contact.task)
    const launch = contact.kind === 'lead' && !started ? await contactLaunch(contact.task) : undefined
    res.json({
      task: brief(contact.task), kind: contact.kind, project: contact.project, started,
      ...(launch ? { launch } : {}), ...(contact.handedOverBy ? { handedOverBy: contact.handedOverBy } : {}),
    })
  } catch (err) {
    sendError(res, next, err)
  }
})

/** The task `id` names, when it is the contact or works under it: in its team, or below it. */
async function teamTaskOf(contact: { task: Task; kind: string; project?: string }, id: string): Promise<Task> {
  const { listTasks } = await import('../../core/task-manager.js')
  const tasks = await listTasks()
  const exact = tasks.find((t) => t.id === id)
  const byPrefix = exact ? [exact] : tasks.filter((t) => t.id.startsWith(id))
  if (byPrefix.length !== 1) throw new OrgError('task_not_found', 404, byPrefix.length ? `"${id}" names more than one task: give the whole id.` : `No task "${id}".`)
  const target = byPrefix[0]!
  if (target.id === contact.task.id) return target
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  const seen = new Set<string>()
  for (let t: Task | undefined = target; t?.parent_task_id && !seen.has(t.id); t = byId.get(t.parent_task_id)) {
    seen.add(t.id)
    if (t.parent_task_id === contact.task.id) return target
  }
  const { teamOf } = await import('../../core/org/team-asks.js')
  if (contact.task.org_role === 'lead' && teamOf(tasks, target)?.lead.id === contact.task.id) return target
  throw new OrgError('task_outside_contact', 400,
    `"${target.title}" (${target.id}) is not in ${contact.project ? `the ${contact.project} team` : 'that team'}: send it there yourself with task_send, or leave out \`task\`.`)
}

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

// Make a project with its own VP, or a VP to put projects under, and name or instruct a VP or
// the CEO (src/core/org/org-node-edit.ts; the org chart's "+ New VP", "+ New project" and ⋯).
// The user or any agent may (2026-10-27, the user: "all human action can be done by agent also"):
// a create names what it makes, so it brings a deleted project back for either; the instructions
// record who wrote them, which the Org page shows.
async function nodeCaller(req: Request): Promise<{ human: boolean; writer: OrgWriter }> {
  const sid = header(req, 'x-walnut-caller-sid')
  if (!sid) return { human: true, writer: { by: 'human' } }
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(sid)
  const taskId = caller.kind === 'session' ? caller.record.taskId : undefined
  if (!taskId) return { human: true, writer: { by: 'agent', byName: 'an agent' } }
  const { getTask } = await import('../../core/task-manager.js')
  const task = await getTask(taskId).catch(() => null)
  return { human: true, writer: { by: `task:${taskId}`, byName: writerName(task) } }
}

/** An agent's task as the user reads it on the Org page: "the CEO", "the Growth VP", the task's title. */
function writerName(task: Task | null): string {
  if (!task) return 'an agent'
  // One line of at most 60 characters: a lead with no name of its own reads by its title, which grows.
  const cap = (raw: string) => { const one = raw.replace(/\s+/g, ' ').trim(); return one.length > 60 ? `${one.slice(0, 59)}…` : one }
  if (task.org_role === 'main' || task.org_role === 'lead') return `the ${cap(orgDisplayTitle(task))}`
  return `the task "${cap(task.title) || 'untitled'}"`
}

/** A node as the chart's form reads it back: the name the server kept, for its done line, and
 *  its instructions' stamp (who wrote them, when). */
function nodeBrief(task: Task): Record<string, unknown> {
  return {
    ...brief(task), ...(task.org_name ? { org_name: task.org_name } : {}), ...(task.org_vp_only ? { org_vp_only: true } : {}),
    ...(task.org_instructions ? { org_instructions: task.org_instructions } : {}),
  }
}

orgV1Router.post('/org/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A project is made')
    const lead = await createOrgNode({ name: req.body?.name, vpName: req.body?.vpName, instructions: req.body?.instructions, overrideUser: req.body?.override_user }, false, await nodeCaller(req))
    res.status(201).json({ task: nodeBrief(lead) })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.post('/org/vps', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A VP is made')
    const lead = await createOrgNode({ name: req.body?.name, instructions: req.body?.instructions, overrideUser: req.body?.override_user }, true, await nodeCaller(req))
    res.status(201).json({ task: nodeBrief(lead) })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgV1Router.put('/org/nodes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A VP or the CEO is changed')
    const { writer } = await nodeCaller(req)
    const task = await editOrgNode(String(req.params.id), { name: req.body?.name, instructions: req.body?.instructions, overrideUser: req.body?.override_user }, writer)
    res.json({ task: nodeBrief(task) })
  } catch (err) {
    sendError(res, next, err)
  }
})

// A project's VP, made first when the project has none yet (one team, never talked to).
orgV1Router.put('/org/projects/:project/vp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A VP is changed')
    const { writer } = await nodeCaller(req)
    const task = await editProjectVp(String(req.params.project), { name: req.body?.name, instructions: req.body?.instructions, overrideUser: req.body?.override_user }, writer)
    res.json({ task: nodeBrief(task) })
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
