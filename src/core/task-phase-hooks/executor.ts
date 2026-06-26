/**
 * Phase Hook Executor — checks conditions and dispatches actions.
 */

import type { Task, TaskPhase } from '../types.js'
import type { TaskPhaseHookDef } from './types.js'
import { getHooksForPhase } from './registry.js'
import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'

export interface PhaseHookResult {
  hookId: string
  executed: boolean
  skipped?: string
}

/** Run all hooks registered for a phase transition. Called synchronously in the PATCH handler. */
export async function executePhaseHooks(
  task: Task,
  newPhase: TaskPhase,
  oldPhase: TaskPhase,
): Promise<PhaseHookResult[]> {
  if (newPhase === oldPhase) return []

  const hooks = getHooksForPhase(newPhase)
  if (hooks.length === 0) return []

  const results: PhaseHookResult[] = []

  for (const hook of hooks) {
    const result = await executeOneHook(hook, task, oldPhase)
    results.push(result)
  }

  return results
}

async function executeOneHook(
  hook: TaskPhaseHookDef,
  task: Task,
  oldPhase: TaskPhase,
): Promise<PhaseHookResult> {
  // Check fromPhases constraint
  if (hook.fromPhases && !hook.fromPhases.includes(oldPhase)) {
    return { hookId: hook.id, executed: false, skipped: `fromPhases excludes ${oldPhase}` }
  }

  // Check conditions
  if (hook.condition) {
    if (hook.condition.requiresSession && !task.session_id) {
      return { hookId: hook.id, executed: false, skipped: 'no active session' }
    }
    if (hook.condition.predicate && !hook.condition.predicate(task, oldPhase)) {
      return { hookId: hook.id, executed: false, skipped: 'predicate returned false' }
    }
  }

  try {
    switch (hook.action.type) {
      case 'send_message':
        await executeSendMessage(hook, task)
        break
      case 'invoke_agent':
        log.task.warn('invoke_agent hook not yet implemented', { hookId: hook.id })
        break
      case 'schedule_check':
        log.task.warn('schedule_check hook not yet implemented', { hookId: hook.id })
        break
    }
    log.task.info('phase hook executed', { hookId: hook.id, taskId: task.id, phase: task.phase })
    return { hookId: hook.id, executed: true }
  } catch (err) {
    log.task.error('phase hook failed', { hookId: hook.id, taskId: task.id, error: String(err) })
    return { hookId: hook.id, executed: false, skipped: `error: ${String(err)}` }
  }
}

async function executeSendMessage(hook: TaskPhaseHookDef, task: Task): Promise<void> {
  if (hook.action.type !== 'send_message') return
  const { message } = hook.action
  const sessionId = task.session_id!

  const { sendMessageToSession } = await import('../session-message-queue.js')
  await sendMessageToSession(sessionId, message, { source: 'phase-hook', taskId: task.id })
}
