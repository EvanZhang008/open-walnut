/**
 * Where a session that keeps Threads reads a Threads rule at the moment it acts: its always-loaded
 * prompt (the `org-role` block: sessions/session-context.ts threadsLine for Main, a VP and a lead,
 * TASK_THREADS_LINE for a task with Threads on) or the description of the thread op it calls.
 *
 * Until 2026-11-22 every thread op carried a 5 K copy of the prompt's rules, so the first
 * thread_update of a process loaded 16 K (1,718 calls in 7 days); the ops now carry only what no
 * prompt does. The guards (thread-rules-guard, thread-one-place-guard, proof-in-place-rule,
 * thread-options) hold the property that matters: a rule is in the prompt of EVERY role that keeps
 * Threads, or in the op's own description, so it can never vanish from both. The prompt is composed
 * here at test time from the registered blocks, so the check follows the rules' wording wherever
 * it moves (a new experiment's text included, once its fixture is listed below).
 */
import { composeInstructions, type InstructionTask } from '../../../src/core/sessions/session-context.js'
import { keepsThreads, setThreadsForEveryTask, threadsForEveryTask } from '../../../src/core/org/keeps-threads.js'
import { setBriefOff, briefOffNow } from '../../../src/core/org/brief-off.js'
import { listOps, getOp, type WalnutOp } from '../../../src/ops/index.js'
import { groupOfOp } from '../../../src/ops/op-groups.js'

/** Every kind of task that keeps Threads, and the switches that change its prompt. */
const KEEPERS: Array<{ name: string; task: InstructionTask; briefOff?: boolean; everyTask?: boolean }> = [
  { name: 'main', task: { org_role: 'main', project: 'Walnut' } },
  { name: 'lead', task: { org_role: 'lead', project: 'Walnut' } },
  { name: 'vp', task: { org_role: 'lead', project: 'Walnut', org_vp_only: true } },
  { name: 'main, brief off', task: { org_role: 'main', project: 'Walnut' }, briefOff: true },
  { name: 'lead, brief off', task: { org_role: 'lead', project: 'Walnut' }, briefOff: true },
  { name: 'task with Threads on', task: { project: 'Walnut', threads_on: true } },
  { name: 'task, every task keeps Threads', task: { project: 'Walnut' }, everyTask: true },
]

/** The `org-role` block each keeper's prompt carries, composed by the real builder. */
export function keeperPrompts(): Array<{ name: string; keeps: boolean; text: string }> {
  const brief = briefOffNow()
  const every = threadsForEveryTask()
  try {
    return KEEPERS.map((k) => {
      setBriefOff(k.briefOff === true)
      setThreadsForEveryTask(k.everyTask === true)
      const blocks = composeInstructions(k.task, { taskLine: '', taskDir: '', fleet: '' }).blocks
      return { name: k.name, keeps: keepsThreads(k.task), text: blocks.filter((b) => b.id === 'org-role').map((b) => b.text).join('') }
    })
  } finally {
    setBriefOff(brief)
    setThreadsForEveryTask(every)
  }
}

/** The keepers whose always-loaded prompt does not carry `rule` ([] when every one does). */
export function promptsWithout(rule: string): string[] {
  return keeperPrompts().filter((p) => !p.text.includes(rule)).map((p) => p.name)
}

/** Every thread op, from the registry by its group (op-groups.ts `threads`), so a new one is covered. */
export function threadOps(): WalnutOp[] {
  return listOps({ includeDeprecated: true }).filter((op) => groupOfOp(op.name) === 'threads')
}

/**
 * The ops (of `names`, default every thread op) where some keeper reads `rule` nowhere: not in its
 * prompt and not in the op's description. [] is the pass.
 */
export function opsWhereRuleIsUnread(rule: string, names: readonly string[] = threadOps().map((op) => op.name)): string[] {
  const without = promptsWithout(rule)
  if (!without.length) return []
  return names.filter((n) => !getOp(n)?.description.includes(rule)).map((n) => `${n} (and the prompt of: ${without.join(', ')})`)
}
