/**
 * Task ops — ported byte-compatible from the original hand-written MCP tools
 * (same names, same descriptions, same result shapes), now declared once for
 * every surface (MCP / CLI / gateway).
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { taskRefTag } from '../utils/entity-refs.js'
import { AGENT_WRITABLE_PHASES } from '../core/phase.js'

const PRIORITY = z.enum(['immediate', 'important', 'backlog', 'none'])
const STATUS = z.enum(['todo', 'in_progress', 'done'])
const AGENT_PHASE = z.enum(AGENT_WRITABLE_PHASES)

const REF_INSTRUCTION =
  'Include the `ref` string verbatim in your reply to the user so Walnut renders a clickable task pill.'

/** Attach the ref tag + paste instruction to a task-mutating result. */
function withRef(task: unknown, extra: Record<string, unknown> = {}): unknown {
  const t = (task ?? {}) as { id?: unknown; title?: unknown }
  const id = typeof t.id === 'string' ? t.id : ''
  const title = typeof t.title === 'string' ? t.title : ''
  return { ...extra, task, ref: taskRefTag(id, title), instruction: REF_INSTRUCTION }
}

defineOp({
  name: 'task_list',
  title: 'List Walnut tasks',
  description:
    'List the user\'s tasks (open tasks + anything completed in the last 14 days). ' +
    'Filters combine: status, project (exact, case-insensitive; "" = Inbox), tag (exact), ' +
    'q (case-insensitive substring on the title). Returns slim task rows plus syncedAt.',
  input: {
    status: STATUS.optional().describe('todo | in_progress | done'),
    project: z.string().optional().describe('Project name; "" for the Inbox'),
    tag: z.string().optional().describe('Exact tag match'),
    q: z.string().optional().describe('Case-insensitive substring on the task title'),
  },
  bind: { method: 'GET', path: '/tasks' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_get',
  title: 'Get one Walnut task',
  description:
    'Full detail for one task — including description, note, summary, session_ids, and ' +
    'dependency/child/parent decorations that the list view omits. The id accepts a unique prefix.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
  },
  bind: { method: 'GET', path: '/tasks/:id' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_create',
  title: 'Create a Walnut task',
  description:
    'Record a task without starting any work or session. Use this only when the user wants tracking ' +
    'without execution; use `delegate` when work should start now. An omitted/empty project means ' +
    'Inbox, and an unknown project name auto-creates its registry row. The result carries a `ref` tag.',
  input: {
    title: z.string().min(1).describe('Task title (required)'),
    project: z.string().optional().describe('Project name; omit or "" for the Inbox'),
    priority: PRIORITY.optional().describe('immediate | important | backlog | none'),
    due_date: z.string().optional().describe('YYYY-MM-DD or a full ISO-8601 datetime'),
    description: z.string().optional().describe('Longer body text (write-only)'),
  },
  bind: { method: 'POST', path: '/tasks' },
  mapResult: ({ body }) => withRef((body as { task?: unknown } | undefined)?.task),
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'task_update',
  title: 'Update a Walnut task',
  description:
    'Patch any supported task fields. Agents hand work back with phase=AGENT_COMPLETE, or ' +
    'phase=AWAIT_HUMAN_ACTION when a person must act. status=done and task_complete are human-only. ' +
    '`tags` is a full replacement ([] clears). Pass "" to clear due_date/start_date.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
    status: STATUS.optional().describe('Legacy status. Agents may use todo or in_progress; done is human-only'),
    phase: AGENT_PHASE.optional().describe('Agent lifecycle phase; use AGENT_COMPLETE or AWAIT_HUMAN_ACTION to hand work back'),
    priority: PRIORITY.optional(),
    due_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    start_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    project: z.string().optional().describe('Project name; "" = Inbox'),
    title: z.string().optional().describe('New title (non-empty, <= 500 chars)'),
    description: z.string().optional().describe('Replaces the description (write-only)'),
    tags: z.array(z.string()).optional().describe('FULL replacement of the task tags'),
  },
  handler: async (args, call) => {
    const { id, ...fields } = args
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v
    }
    if (Object.keys(body).length === 0) {
      throw new Error('task_update needs at least one field to change besides `id`.')
    }
    return call('PATCH', `/tasks/${encodeURIComponent(String(id))}`, body)
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_complete',
  title: 'Complete a Walnut task',
  description:
    'Mark a task done. The id accepts a unique prefix. The result carries a ' +
    '`ref` tag — paste it verbatim in your reply so the user gets a clickable task pill.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
  },
  // POST /complete, NOT PATCH {status:'done'}: only completeTask() semantics
  // auto-unpin from the Focus bar and surface a sync-push failure (the v1
  // PATCH swallows it via asyncPush). Same reasoning as the CLI's `done`.
  bind: { method: 'POST', path: '/tasks/:id/complete' },
  mapResult: ({ body }) => withRef((body as { task?: unknown } | undefined)?.task, { completed: true }),
  tags: { readonly: false, remote: 'deny', destructive: false, humanOnly: true },
})

defineOp({
  name: 'task_delete',
  title: 'Delete a Walnut task',
  description:
    'Permanently delete a task. Only do this when the user explicitly asked for a deletion — ' +
    'completing a task (task_complete) is almost always what is wanted instead. A task with ' +
    'active sessions refuses the delete unless force is true (which stops those sessions first).',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
    force: z.boolean().optional().describe('Stop the task\'s active sessions and delete anyway'),
  },
  handler: async (args, call) => {
    const { id, force } = args
    await call('DELETE', `/tasks/${encodeURIComponent(String(id))}${force ? '?force=true' : ''}`)
    return { deleted: true, id }
  },
  tags: { readonly: false, remote: 'deny', destructive: true },
})
