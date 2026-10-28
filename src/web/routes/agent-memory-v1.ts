/**
 * A task's own MEMORY.md (src/core/sessions/agent-memory.ts): the working memory Main, a lead or a
 * leader keeps for itself.
 *
 *   GET  /api/v1/tasks/:id/agent-memory   { task_id, title, memory: {text, at} | null, chars, soft_limit, limit }
 *   PUT  /api/v1/tasks/:id/agent-memory   { content, mode?: 'append' (default) | 'replace' }
 *
 * Anyone may read it (the agent, a view that shows it folded). Its own session writes it, and so
 * may a person (no caller header) and another task's session, a lead noting a deadline for its
 * worker, say (2026-10-27, the user: "all human action can be done by agent also"). A write by
 * anyone but its own session records its writer on the file (`by`, `by_name`, `by_at`), so the
 * owner reading it back is told who else wrote in it; the owner's appends keep that, only its
 * replacing the whole file clears it. A write from another task's session is logged too. A write
 * past the limit is refused whole
 * (413 agent_memory_too_long), never cut; a completed task's is not written (409 task_complete:
 * the write would announce the completion again).
 */
import { Router, type Request, type Response } from 'express'
import { role } from '../../core/server-role.js'
import {
  AGENT_MEMORY_MAX_CHARS, AGENT_MEMORY_SOFT_CHARS, AgentMemoryTooLongError, agentMemoryWriterAfter, agentMemoryWriterName,
  nextAgentMemory, type AgentMemory, type AgentMemoryWriterStamp,
} from '../../core/sessions/agent-memory.js'
import { resolveCaller } from '../../core/sessions/session-send-core.js'
import { getTask, updateTaskRaw } from '../../core/task-manager.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const agentMemoryV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof AgentMemoryTooLongError) {
        return sendError(res, 413, err.code, err.message, { chars: err.chars, limit: AGENT_MEMORY_MAX_CHARS })
      }
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

agentMemoryV1Router.get('/tasks/:id/agent-memory', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const memory = task.agent_memory ?? null
  res.json({
    task_id: task.id, title: task.title, memory,
    chars: memory?.text.length ?? 0, soft_limit: AGENT_MEMORY_SOFT_CHARS, limit: AGENT_MEMORY_MAX_CHARS,
  })
}))

agentMemoryV1Router.put('/tasks/:id/agent-memory', route(async (req, res) => {
  if (role() === 'replica') throw new RouteError(501, 'not_supported_cloud', 'A task\'s MEMORY.md is written on the primary box')
  const task = await resolveTask(param(req.params.id))
  const sid = header(req, 'x-walnut-caller-sid')
  const b = body(req)
  if (typeof b.content !== 'string') throw new RouteError(400, 'bad_request', 'content (string) is required')
  const mode = b.mode === 'replace' ? 'replace' as const : 'append' as const
  // Who writes: its own session (stamp null), the user, or another task.
  const caller = sid ? await resolveCaller(sid).catch(() => null) : null
  const callerTaskId = caller?.kind === 'session' ? caller.record.taskId ?? null : null
  const own = !!sid && callerTaskId === task.id
  let stamp: AgentMemoryWriterStamp | null = null
  if (!sid) stamp = { by: 'human' }
  else if (!own) {
    const writer = callerTaskId ? await getTask(callerTaskId).catch(() => undefined) : undefined
    stamp = writer ? { by: `task:${writer.id}`, by_name: agentMemoryWriterName(writer) } : { by: 'agent', by_name: agentMemoryWriterName(undefined) }
  }
  const now = new Date().toISOString()
  let written: AgentMemory = { text: '', at: now }
  let complete = false
  // Read-modify-write under the row lock: an append racing a turn-end answer keeps both.
  await updateTaskRaw(task.id, (current) => {
    const text = nextAgentMemory(current.agent_memory?.text ?? '', b.content as string, mode, now)
    written = { text, at: now, ...agentMemoryWriterAfter(current.agent_memory, mode, stamp, now) }
    return { agent_memory: written }
  }, {
    emitEvent: true, source: 'agent-memory',
    shouldUpdate: (current) => { complete = current.phase === 'COMPLETE'; return !complete },
  })
  if (complete) throw new RouteError(409, 'task_complete', `"${task.title}" is complete: its MEMORY.md is kept as it was. Reopen the task to change it.`)
  if (sid && !own) {
    log.task.info('agent memory written by another task\'s session', { taskId: task.id, mode, callerSid: sid, callerTaskId, chars: written.text.length })
  }
  res.json({
    task_id: task.id, title: task.title, memory: written,
    chars: written.text.length, soft_limit: AGENT_MEMORY_SOFT_CHARS, limit: AGENT_MEMORY_MAX_CHARS,
  })
}))
