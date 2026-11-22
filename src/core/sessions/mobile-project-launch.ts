/**
 * The phone's start from a project (POST /api/v1/sessions `fromProject: true`): the project's
 * code source names the folder, the host and the workspace (workspaces/project-source.ts), and the
 * launch goes through the same workspace step as the web quick-start (workspaces/launch.ts
 * workspaceLaunchPlan): the task is filed at once and its session starts once the workspace is
 * ready, so the answer is `{ taskId, title, preparing: true }` with no session id.
 */

import type { Task } from '../types.js'
import type { MobileLaunchInput, MobileLaunchResult } from './mobile-launch.js'
import type { QuickStartWorkspacePlan } from '../workspaces/launch.js'
import { QuickStartError } from './quick-start.js'

export interface MobileProjectStart {
  /** The launch with the project's folder, host and canonical name. */
  input: MobileLaunchInput
  /** The workspace step's plan; `defer` files the task without starting it. */
  plan: QuickStartWorkspacePlan | null
  /** After quickStartSession: make the workspace with the start waiting in it, count the values used. */
  finish(task: Task, start: {
    message: string; model?: string; mode?: string; effort?: string; engine?: string; engineDecided?: boolean
    sessionId?: string; source: string; callerSid?: string; callerUnproven?: boolean
  }): Promise<MobileLaunchResult | null>
}

/** The body's `fromProject` companions, shape-checked (validateLaunchBody): `project` names it. */
export function checkProjectStartBody(project: unknown, workspaceInputs: unknown): { fromProject: true; workspaceInputs?: Record<string, unknown> } {
  if (typeof project !== 'string' || !project.trim()) throw new QuickStartError('fromProject needs project (the project to start from)', 400)
  if (workspaceInputs !== undefined && workspaceInputs !== null && (typeof workspaceInputs !== 'object' || Array.isArray(workspaceInputs))) {
    throw new QuickStartError('workspaceInputs must be an object of the provider\'s field values', 400)
  }
  return { fromProject: true, ...(workspaceInputs && typeof workspaceInputs === 'object' ? { workspaceInputs: workspaceInputs as Record<string, unknown> } : {}) }
}

export async function mobileProjectStart(input: MobileLaunchInput): Promise<MobileProjectStart> {
  const { resolveProjectStart, refusalOf, recordStartUse } = await import('../workspaces/project-source.js')
  let start
  try {
    start = await resolveProjectStart(input.project ?? '', {
      ...(input.host !== undefined ? { host: input.host } : {}), ...(input.workspaceInputs ? { inputs: input.workspaceInputs } : {}),
    })
  } catch (err) {
    const refusal = refusalOf(err)
    if (refusal) throw new QuickStartError(refusal.body.error, refusal.status, refusal.body)
    throw err
  }
  const host = start.host === '__local__' ? undefined : start.host
  const { workspaceLaunchPlan } = await import('../workspaces/launch.js')
  const plan = await workspaceLaunchPlan({ workspace: start.workspace }, { cwd: start.cwd, host, existingTaskId: input.taskId, isWalnutAgent: false })
  if (plan?.refuse) {
    const body = plan.refuse.body as { error?: unknown; code?: unknown }
    throw new QuickStartError(typeof body.error === 'string' ? body.error : 'The workspace cannot be made.', plan.refuse.status, { error: String(body.error ?? ''), code: String(body.code ?? 'bad-request') })
  }
  return {
    input: { ...input, cwd: plan?.cwd ?? start.cwd, host, project: start.project },
    plan,
    async finish(task, s) {
      if (!plan?.begin) return null
      const answer = await plan.begin(task, {
        message: s.message, ...(s.model ? { model: s.model } : {}), ...(s.mode ? { mode: s.mode } : {}), ...(s.effort ? { effort: s.effort } : {}),
        ...(s.engine ? { engine: s.engine } : {}), ...(s.engineDecided ? { engine_decided: true } : {}), ...(s.sessionId ? { session_id: s.sessionId } : {}),
        source: s.source, ...(s.callerSid ? { caller_sid: s.callerSid } : {}), ...(s.callerUnproven ? { caller_unproven: true as const } : {}),
      })
      const preparing = answer.preparing === true
      recordStartUse(start.project, answer)
      return {
        taskId: task.id, title: task.title, preparing,
        ...(typeof answer.workspaceError === 'string' ? { workspaceError: answer.workspaceError } : {}),
      }
    },
  }
}
