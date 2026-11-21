/**
 * What a host's own server does, while the Mac is away, with a call that touches a task the Mac
 * keeps local (core/replication/host-private.ts: this host's copies hold none of it; the ids
 * only, kinds/local-tasks.ts). local-calls.ts asks it before the call runs.
 *
 *   its subject is the kept task    refused: `needs_leader {why:'task_kept_local', final}`, the
 *                                   caller's answer (the daemon's own away answer never takes it;
 *                                   the Mac answers once it is back). The call names the task or
 *                                   one of its sessions (an id, a prefix of 6 or more, a path
 *                                   segment), or it is a call of the task's own session that falls
 *                                   back on its own task when it names none (OWN_TASK_OPS)
 *   a trigger of it                 refused the same way: a trigger call naming one of its triggers
 *                                   (away-triggers.ts hostTriggers keptTrigger, asked by local-calls.ts)
 *   a message to it                 runs: away-sends.ts holds it for the Mac (the daemon's held op,
 *                                   the target named by id), delivered once when the Mac is back
 *   anything else                   runs, the kept task's own session's calls too (a search, a
 *                                   skill, a message to another task, a trigger not about it)
 *
 * While the Mac answers, only a same-host send reaches this server: one that touches the kept task
 * (its session's, or one naming it) goes to the Mac as before (not final: the daemon relays it).
 */
import type { RelayedCall } from '../core/peers/gateway-answer.js'
import { namesKeptLocal, type LocalTasksHere } from '../core/replication/kinds/local-tasks.js'

/**
 * The ops that act on the caller's own task (or its team's board, its own session) when none of
 * the listed arguments names another: their routes ask GET /me or the caller's placement. An
 * empty list: always the caller's own (a task_create is filed under it). Guarded by
 * tests/replica/kept-local-calls.test.ts against the op registry.
 */
export const OWN_TASK_OPS: Readonly<Record<string, readonly string[]>> = {
  task_create: [],
  task_dir: [],
  open_items: ['of'],
  folder_create: ['project'],
  agent_memory_read: ['task'],
  agent_memory_write: ['task'],
  agent_skill_read: ['task'],
  agent_skill_write: ['task'],
  brief_read: ['task'],
  brief_write: ['task'],
  board_get: ['task'],
  board_set: ['task'],
  board_edit: ['task'],
  board_post: ['task'],
  board_post_delete: ['task'],
  board_project_set: ['task'],
  board_remind: ['task'],
  board_lanes_set: ['task'],
  board_card_set: ['task'],
  thread_list: ['task'],
  thread_update: ['task'],
  thread_create: ['task'],
  thread_split: ['task'],
  thread_file: ['task'],
  thread_move: ['task'],
  org_get: ['of'],
  org_report: ['of'],
  task_watch: ['for'],
  trigger_create: ['session'],
}

/** The trigger calls that name one trigger by `id` (a kept-local task's is refused: away-triggers.ts). */
const TRIGGER_ID_OPS = ['trigger_pause', 'trigger_resume', 'trigger_delete', 'trigger_update', 'trigger_test']

/** The trigger a call names by id, when it is one of TRIGGER_ID_OPS (local-calls.ts asks whether it is kept). */
export function triggerIdOf(call: RelayedCall): string | null {
  const { name, args } = opOf(call)
  const id = TRIGGER_ID_OPS.includes(name) && args && typeof args === 'object' ? (args as { id?: unknown }).id : undefined
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

/** The messages away-sends.ts holds for the Mac when their target is kept. */
const SEND_OPS = ['task_send', 'session_send']
/** A message's own words: never read as naming a task. */
const SEND_WORDS = new Set(['text', 'title'])

/** Whether `v` (an op's args, walked a few levels down) names a kept task or session. */
function namesKept(v: unknown, here: LocalTasksHere, skip?: ReadonlySet<string>, depth = 0): boolean {
  if (typeof v === 'string') return namesKeptLocal(v, here)
  if (depth >= 3 || !v || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some((x) => namesKept(x, here, undefined, depth + 1))
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (depth === 0 && skip?.has(k)) continue
    if (namesKept(x, here, undefined, depth + 1)) return true
  }
  return false
}

/** The words a call uses for "my own" (trigger_create's `session: "this"`): not another task. */
const SELF_WORDS = new Set(['this', 'self', 'me'])
const given = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && (!v.trim() || SELF_WORDS.has(v.trim().toLowerCase())))

/** The call's op and arguments (a tool call), or the payload itself (another capability). */
function opOf(call: RelayedCall): { name: string; args: unknown } {
  const p = call.payload as { name?: unknown; args?: unknown } | null
  if (call.capability === 'tools.call' && p && typeof p.name === 'string') return { name: p.name, args: p.args ?? {} }
  return { name: '', args: p?.args ?? p }
}

/** Said of every final refusal: the call left nothing behind, so the caller runs it again later. */
const NOT_SAVED = 'Nothing was done or saved; run it again once your Mac is back.'

function refusal(call: RelayedCall, about: 'own' | 'task' | 'trigger', final: boolean): Record<string, unknown> {
  const what = about === 'own'
    ? 'this session\'s task is kept local on your Mac, so this host\'s copies leave it out and your Mac answers this call.'
    : about === 'trigger'
      ? 'that trigger belongs to a task kept local on your Mac, so this host does not show or change it.'
      : 'that task is kept local on your Mac, so this host keeps no copy of it and your Mac answers this call.'
  // Not final, the daemon relays it to the Mac, which answers it now: nothing to run again.
  const error = final ? `${what} ${NOT_SAVED}` : what
  return { relayId: call.relayId, errorCode: 'needs_leader', error, detail: { why: 'task_kept_local', ...(final ? { final: true } : {}) } }
}

/**
 * The refusal of a call about a task the Mac keeps local, or null (it runs). `online`: a same-host
 * send while the Mac answers. `triggerKept`: the trigger the call names (triggerIdOf) is such a task's.
 */
export function keptLocalRefusal(call: RelayedCall, here: LocalTasksHere, online = false, opts: { triggerKept?: boolean } = {}): Record<string, unknown> | null {
  if (here.tasks.size === 0 || call.capability === 'tools.list') return null
  const byCaller = here.sessions.has(call.callerSid)
  const { name, args } = opOf(call)
  // The Mac answers: a send of the kept task's session, or naming it, is the Mac's, as before.
  if (online) return byCaller || namesKept(args, here) ? refusal(call, byCaller ? 'own' : 'task', false) : null
  if (opts.triggerKept && TRIGGER_ID_OPS.includes(name)) return refusal(call, 'trigger', true)
  const send = SEND_OPS.includes(name)
  // A message's target is held (away-sends.ts), its words are words: only another field counts.
  if (namesKept(args, here, send ? new Set([...SEND_WORDS, 'to']) : undefined)) return refusal(call, 'task', true)
  const own = OWN_TASK_OPS[name]
  if (!byCaller || !own) return null
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  return own.some((k) => given(a[k])) ? null : refusal(call, 'own', true)
}
