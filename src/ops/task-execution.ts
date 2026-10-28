import { z } from 'zod'
import { SESSION_EFFORT_IDS, SESSION_ENGINE_IDS, SESSION_MODE_IDS } from '../core/types.js'
import { engineCaps } from '../core/agents/engine-registry.js'
import type { WalnutOp } from './registry.js'
import { REPLY_ARRIVES_HINT, SUBTASK_WATCH_HINT, withOutcome } from './outcome.js'

type Call = Parameters<NonNullable<WalnutOp['handler']>>[1]

export const TASK_START_INPUT = {
  message: z.string().trim().min(1).optional().describe('Instruction for the task; defaults to its description or title'),
  cwd: z.string().startsWith('/').optional().describe('Absolute working directory; omit to inherit task/project defaults'),
  host: z.string().optional().describe('Execution host alias; omit to inherit task/project defaults'),
  model: z.string().optional().describe('Model id or provider model value'),
  mode: z.enum(SESSION_MODE_IDS).optional().describe('Permission mode. Leave it out for a new coding task: never plan except when the user asks for plan; the owner writes its own plan and carries on.'),
  engine: z.enum(SESSION_ENGINE_IDS).optional().describe('Coding engine; default: the default engine (Settings > Engines), claude when none is set'),
  effort: z.enum(SESSION_EFFORT_IDS as [typeof SESSION_EFFORT_IDS[number], ...typeof SESSION_EFFORT_IDS[number][]]).optional().describe('Reasoning effort, the draft picker\'s Effort row (claude engine only; xhigh and max only on models that offer them). Omit for the model default'),
  user_request: z.string().trim().min(10).optional().describe('The user\'s own words asking for this start now, quoted. Only when the user asked: it lets the start past the 8-running-subtask brake (up to 16). Never for work you decided on yourself'),
  create_cwd: z.boolean().optional().describe('Create cwd on its host first, the folder picker\'s "Create folder & start". Default false: a missing folder fails the start'),
  workspace: z.object({
    provider: z.string().min(1).describe('Provider id from workspace_providers'),
    inputs: z.record(z.string(), z.unknown()).optional().describe('The provider\'s inputs, as workspace_providers describes them'),
  }).strict().optional().describe('Start in an isolated workspace (the draft\'s "Isolated workspace" row): Walnut makes it on the host, then starts the session in it; the answer says preparing'),
  expect_reply: z.boolean().optional().describe('Report back to the caller; defaults to true for a tracked caller. false opts out'),
  reply_timeout: z.number().int().min(60).max(86_400).optional().describe('Seconds before a no-reply notification (default 3600)'),
  hands_on: z.string().regex(/^rq-[a-f0-9]{6,}$/).optional().describe('A request you owe (rq-…) that you hand to this task instead of answering it now: its asker waits for this task\'s answer and is told where the work went. Answer it yourself once the work is back'),
  start_attempt_id: z.string().uuid().optional().describe('Stable attempt identity for a confirmed launch'),
}

export function taskExecution(task: Record<string, unknown>): Record<string, unknown> {
  const slot = task.session_status ?? task.exec_session_status
  const status = slot && typeof slot === 'object' ? slot as Record<string, unknown> : undefined
  const sessionId = task.session_id || task.exec_session_id
  const attempt = task.last_start as { at?: string; state?: string; session_id?: string; error?: string } | undefined
  const beganAfterAttempt = !!attempt?.at && sessionId !== attempt.session_id
    && typeof status?.startedAt === 'string' && status.startedAt > attempt.at
  const confirmed = !!status && (!attempt || attempt.session_id === sessionId || beganAfterAttempt)
    && (typeof status.pid === 'number' && status.pid > 1
    || (SESSION_ENGINE_IDS.includes(status.engine as typeof SESSION_ENGINE_IDS[number])
      && engineCaps(status.engine as typeof SESSION_ENGINE_IDS[number]).idProvisioning === 'provider-issued'))
  const currentAttempt = attempt && !beganAfterAttempt && (!sessionId || !attempt.session_id || attempt.session_id === sessionId
    || attempt.state === 'starting')
  if (currentAttempt && !confirmed) {
    if (attempt.state === 'failed') return { state: 'error', error: attempt.error }
    if (attempt.state === 'unconfirmed') return { state: 'unknown', error: attempt.error }
    if (attempt.state === 'starting') return { state: 'starting' }
  }
  const state = task.session_status_unavailable ? 'unknown'
    : status?.process_status === 'error' ? 'error'
    : status?.status_reason === 'awaiting_spawn' && !confirmed ? 'starting'
    : status?.pendingPermissionTool ? 'waiting'
    : ['running', 'idle', 'stopped'].includes(String(status?.process_status)) ? status!.process_status
    : sessionId || (Array.isArray(task.session_ids) && task.session_ids.length) ? 'unknown'
    : typeof task.session_history_count === 'number' && task.session_history_count > 0 ? 'stopped'
    : attempt ? 'unknown' : Array.isArray(task.session_ids) ? 'not_started' : 'unknown'
  return { state, ...(status?.errorMessage ? { error: status.errorMessage } : {}) }
}

export function taskView(task: Record<string, unknown>): Record<string, unknown> {
  const { status, session_status, exec_session_status, plan_session_status,
    session_id, exec_session_id, plan_session_id, session_ids, last_start,
    session_history_count, session_status_unavailable, agent_memory, ...fields } = task
  // Another task's own MEMORY.md is not task_get material: its size only; agent_memory_read reads it.
  const memoryChars = (agent_memory as { text?: string } | undefined)?.text?.length
  // A completed task is verified: Done, with none of its last open words (as the v1 projection).
  if (fields.phase === 'COMPLETE' || status === 'done') {
    delete fields.status_report
    fields.user_status = { state: 'done' }
  }
  return { ...fields, ...(memoryChars ? { agent_memory_chars: memoryChars } : {}), execution: taskExecution(task) }
}

/** Launch fields newer than the oldest server this op may reach; the server names each one it honoured in `applied`. */
const NEWER_LAUNCH_FIELDS = ['effort', 'create_cwd', 'workspace'] as const

/**
 * What a start did NOT apply of the launch settings it was given: a continued
 * conversation keeps the settings it runs with (task_session_set changes them),
 * and a server older than a field answers without `applied` (it ignored it).
 */
function launchSettingsNote(body: Record<string, unknown>, started: Record<string, unknown>): string {
  const given = (k: string) => body[k] !== undefined && body[k] !== false && body[k] !== ''
  if (started.continued === true) {
    const kept = ['model', 'mode', 'effort'].filter(given)
    return kept.length ? ` Its running session keeps its own ${kept.join(', ')}; change them with task_session_set.` : ''
  }
  const asked = NEWER_LAUNCH_FIELDS.filter(given)
  if (!asked.length) return ''
  if (!Array.isArray(started.applied)) return ` This Walnut server is older and ignored ${asked.join(', ')}.`
  const missed = asked.filter((k) => !(started.applied as unknown[]).includes(k))
  return missed.length ? ` Not applied: ${missed.join(', ')} (the session does not run with it; task_get shows where it runs).` : ''
}

export async function startTask(id: string, body: Record<string, unknown>, call: Call): Promise<Record<string, unknown>> {
  const started = await call('POST', `/tasks/${encodeURIComponent(id)}/start`, body) as Record<string, unknown> | undefined
  if (!started || typeof started.taskId !== 'string') {
    throw new Error(`Start response was incomplete. Read task_get for ${id} before retrying; do not create another task.`)
  }
  // Old servers only confirm that the request was accepted; a pre-assigned id does not prove the process has started.
  const state = started.started === true ? 'running' : 'starting'
  return withOutcome(
    { ...started, execution: { state } },
    (started.continued === true
      ? `Task ${started.taskId} already had its conversation; the message continued it (a task keeps one session).`
      : started.preparing === true ? `Task ${started.taskId}'s isolated workspace is being made; its session starts in it once the workspace is ready.`
      : state === 'running' ? `Task ${started.taskId} started.`
      : `Start accepted for task ${started.taskId}; execution is not yet confirmed.`) + launchSettingsNote(body, started),
    typeof started.requestId === 'string'
      ? `Reply request: ${started.requestId}. ${REPLY_ARRIVES_HINT} ${SUBTASK_WATCH_HINT}`
      : `Read task_get for its execution state. Add context with task_send using task id ${started.taskId}.`,
  )
}
