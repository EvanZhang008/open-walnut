import { z } from 'zod'
import { SESSION_ENGINE_IDS, SESSION_MODE_IDS } from '../core/types.js'
import { engineCaps } from '../core/agents/engine-registry.js'
import type { WalnutOp } from './registry.js'
import { REPLY_ARRIVES_HINT, withOutcome } from './outcome.js'

type Call = Parameters<NonNullable<WalnutOp['handler']>>[1]

export const TASK_START_INPUT = {
  message: z.string().trim().min(1).optional().describe('Instruction for the task; defaults to its description or title'),
  cwd: z.string().startsWith('/').optional().describe('Absolute working directory; omit to inherit task/project defaults'),
  host: z.string().optional().describe('Execution host alias; omit to inherit task/project defaults'),
  model: z.string().optional().describe('Model id or provider model value'),
  mode: z.enum(SESSION_MODE_IDS).optional().describe('Permission mode'),
  engine: z.enum(SESSION_ENGINE_IDS).optional().describe('Coding engine; default claude'),
  expect_reply: z.boolean().optional().describe('Report back to the caller; defaults to true for a tracked caller. false opts out'),
  reply_timeout: z.number().int().min(60).max(86_400).optional().describe('Seconds before a no-reply notification (default 3600)'),
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
    session_history_count, session_status_unavailable, ...fields } = task
  return { ...fields, execution: taskExecution(task) }
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
    state === 'running' ? `Task ${started.taskId} started.`
      : `Start accepted for task ${started.taskId}; execution is not yet confirmed.`,
    typeof started.requestId === 'string'
      ? `Reply request: ${started.requestId}. ${REPLY_ARRIVES_HINT}`
      : `Read task_get for its execution state. Add context with task_send using task id ${started.taskId}.`,
  )
}
