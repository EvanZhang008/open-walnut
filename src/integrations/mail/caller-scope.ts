/**
 * Which session a mail step runs for, so a step that goes ahead with approvals off names it.
 *
 * Settings, General lists every step that went ahead unasked (core/approvals/ask-me.ts
 * recordUnasked), and a row that says only "this computer" cannot tell the person which task
 * sent a mail or left a list (2026-11-26 review of issue #23's fix). The mail ops, the mail tools
 * and the routes an agent calls each run their work inside `withMailCaller`, and the switch's
 * record reads it back with `mailStepRequester`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import type { ApprovalRequester } from '../../core/approvals/types.js'

const scope = new AsyncLocalStorage<{ sessionId: string }>()

/** Run `fn` as work for `sessionId` (no scope for none, or for the CLI's outside caller). */
export function withMailCaller<T>(sessionId: string | undefined, fn: () => T): T {
  const sid = sessionId?.trim()
  return sid && sid !== 'external' ? scope.run({ sessionId: sid }, fn) : fn()
}

export function mailCallerSession(): string | undefined {
  return scope.getStore()?.sessionId
}

/** Who a mail step that went ahead unasked was for: this computer, and the session and its task when known. */
export async function mailStepRequester(): Promise<ApprovalRequester> {
  const out: ApprovalRequester = { host: os.hostname() || 'this computer', local: true }
  const sid = mailCallerSession()
  if (!sid) return out
  out.sessionId = sid
  try {
    const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
    const caller = await resolveCaller(sid)
    if (caller.kind === 'session') {
      out.taskId = caller.record.taskId
      const { getTask } = await import('../../core/task-manager.js')
      out.taskTitle = (await getTask(caller.record.taskId)).title
    }
  } catch { /* the session id alone still names it */ }
  return out
}
