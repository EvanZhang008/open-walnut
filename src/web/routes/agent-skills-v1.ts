/**
 * An agent's own skills (src/core/sessions/agent-skills.ts) and what a node reads back at a new
 * conversation and after a compaction (src/core/sessions/own-readback.ts).
 *
 *   GET    /api/v1/tasks/:id/agent-skills          { task_id, title, own: [...], org: [...] } (no text)
 *   GET    /api/v1/tasks/:id/agent-skills/:name    { task_id, scope, skill } (its own first, then the org's)
 *   PUT    /api/v1/tasks/:id/agent-skills/:name    { description?, content?, scope?: 'own' | 'org' }
 *   DELETE /api/v1/tasks/:id/agent-skills/:name?scope=own|org
 *   GET    /api/v1/me/own-readback?hook=startup|compact   { text } for the calling session's task
 *
 * As with MEMORY.md, anyone may read and write them: the task's own session, a person (no caller
 * header), another task's session; a write by anyone but the scope's own task records who made it,
 * and so does every write to the org's. A completed task's own are not written (409 task_complete).
 */
import { Router, type Request, type Response } from 'express'
import { agentMemoryWriterName, type AgentMemoryWriterStamp } from '../../core/sessions/agent-memory.js'
import {
  AGENT_SKILLS_MAX, AgentSkillError, deleteAgentSkill, findAgentSkill, listAgentSkills, writeAgentSkill,
  type AgentSkill, type AgentSkillScope,
} from '../../core/sessions/agent-skills.js'
import { resolveCaller } from '../../core/sessions/session-send-core.js'
import { getTask } from '../../core/task-manager.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const agentSkillsV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof AgentSkillError) return sendError(res, err.status, err.code, err.message)
      if (sendLinkFailure(req, res, err)) return
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

const listed = (s: AgentSkill) => ({ name: s.name, description: s.description, chars: s.text.length, at: s.at, ...(s.by_name ? { by_name: s.by_name } : {}) })

function scopeOf(v: unknown): AgentSkillScope {
  if (v === undefined || v === null || v === '' || v === 'own') return 'own'
  if (v === 'org') return 'org'
  throw new RouteError(400, 'bad_request', 'scope is "own" or "org"')
}

/** Who writes: null for the scope's own task writing its own; else the person, another task, or an agent. */
async function stampOf(req: Request, taskId: string, scope: AgentSkillScope): Promise<{ stamp: AgentMemoryWriterStamp | null; sid?: string; callerTaskId: string | null }> {
  const sid = header(req, 'x-walnut-caller-sid')
  const caller = sid ? await resolveCaller(sid).catch(() => null) : null
  const callerTaskId = caller?.kind === 'session' ? caller.record.taskId ?? null : null
  if (!sid) return { stamp: { by: 'human' }, callerTaskId }
  if (scope === 'own' && callerTaskId === taskId) return { stamp: null, sid, callerTaskId }
  const writer = callerTaskId ? await getTask(callerTaskId).catch(() => undefined) : undefined
  return {
    stamp: writer ? { by: `task:${writer.id}`, by_name: agentMemoryWriterName(writer) } : { by: 'agent', by_name: agentMemoryWriterName(undefined) },
    sid, callerTaskId,
  }
}

agentSkillsV1Router.get('/tasks/:id/agent-skills', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const [own, org] = await Promise.all([listAgentSkills('own', task.id), listAgentSkills('org', task.id)])
  res.json({ task_id: task.id, title: task.title, own: own.map(listed), org: org.map(listed), max: AGENT_SKILLS_MAX })
}))

agentSkillsV1Router.get('/tasks/:id/agent-skills/:name', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const name = param(req.params.name)
  const found = await findAgentSkill(task.id, name)
  if (!found) throw new RouteError(404, 'no_skill', `No skill "${name}" for "${task.title}" or the org. agent_skill_read with no name lists them.`)
  const { screenDocumentForPrompt } = await import('../../core/memory-safety.js')
  res.json({ task_id: task.id, scope: found.scope, skill: { ...found.skill, text: screenDocumentForPrompt(found.skill.text, `agent skill '${name}'`) } })
}))

agentSkillsV1Router.put('/tasks/:id/agent-skills/:name', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const b = body(req)
  const scope = scopeOf(b.scope)
  if (scope === 'own' && task.phase === 'COMPLETE') {
    throw new RouteError(409, 'task_complete', `"${task.title}" is complete: its skills are kept as they were. Reopen the task to change them.`)
  }
  for (const k of ['description', 'content'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'string') throw new RouteError(400, 'bad_request', `${k} must be a string`)
  }
  const { stamp, sid, callerTaskId } = await stampOf(req, task.id, scope)
  const out = await writeAgentSkill(scope, task.id, {
    name: param(req.params.name),
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
    ...(typeof b.content === 'string' ? { content: b.content } : {}),
  }, stamp)
  log.task.info('agent skill written', { taskId: task.id, scope, name: out.skill.name, created: out.created, chars: out.skill.text.length, callerSid: sid, callerTaskId })
  res.json({ task_id: task.id, title: task.title, scope, created: out.created, count: out.count, max: AGENT_SKILLS_MAX, skill: listed(out.skill) })
}))

agentSkillsV1Router.delete('/tasks/:id/agent-skills/:name', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const scope = scopeOf(req.query.scope)
  if (scope === 'own' && task.phase === 'COMPLETE') {
    throw new RouteError(409, 'task_complete', `"${task.title}" is complete: its skills are kept as they were. Reopen the task to change them.`)
  }
  const name = param(req.params.name)
  const removed = await deleteAgentSkill(scope, task.id, name)
  if (!removed) throw new RouteError(404, 'no_skill', `No ${scope} skill "${name}" to delete.`)
  log.task.info('agent skill deleted', { taskId: task.id, scope, name, callerSid: header(req, 'x-walnut-caller-sid') })
  res.json({ task_id: task.id, scope, name, deleted: true })
}))

agentSkillsV1Router.get('/me/own-readback', route(async (req, res) => {
  const hook = req.query.hook === 'compact' ? 'compact' as const : 'startup' as const
  const sid = header(req, 'x-walnut-caller-sid')
  const { CLOUD_MODE } = await import('../../constants.js')
  let caller = sid && !CLOUD_MODE ? await resolveCaller(sid).catch(() => null) : null
  // A new conversation's hook can run before its record is written (the spawn persists it right
  // after the host confirms the process): give it a few seconds.
  for (let i = 0; sid && !CLOUD_MODE && hook === 'startup' && caller?.kind !== 'session' && i < 8; i++) {
    await new Promise((r) => setTimeout(r, 500))
    caller = await resolveCaller(sid).catch(() => null)
  }
  const taskId = caller?.kind === 'session' ? caller.record.taskId : undefined
  const task = taskId ? await getTask(taskId).catch(() => undefined) : undefined
  if (!task) { res.json({ text: '' }); return }
  const { ownReadbackText } = await import('../../core/sessions/own-readback.js')
  const text = await ownReadbackText(task, hook).catch(() => '')
  if (text) log.session.info('own readback stated', { sessionId: sid, taskId: task.id, hook, chars: text.length })
  res.json({ task_id: task.id, hook, text })
}))
