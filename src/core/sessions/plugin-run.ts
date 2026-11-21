/**
 * A program's run that a plugin runs inside Walnut (types.ts PLUGIN_RUN_TAG), one task per unit of its
 * work. Such a task reads and reports exactly like an imported program run (isProgramRunTask) while
 * nobody but that program has written to it. No op takes a flag for it: the tag and the caller say it,
 * so a plugin works the same against a server or a follower that knows nothing of it (one stores the
 * tag as a plain tag, and the follower's away starts and sends take no new key).
 *
 * The program is a program's call with no session and no person behind it (isProgramCall):
 *   - a call that names its plugin: its server half's (server-api.ts callPluginOp: `plugin:<id>`) or a
 *     job's on its host's own replica (an outside caller with `x-walnut-plugin-id`);
 *   - the daemon gateway's anonymous caller, the literal sid `external` with no sender label. Online, a
 *     job's `walnut.ops.call` reaches the leader only as that: the host's daemon tells the job's identity
 *     to its own replica alone (daemon-connection.ts handleGatewayRequest, journal-actor.ts).
 * Not the program: an unknown sid or a session an engine switch replaced (they resolve to an outside
 * caller, under a sid of their own), a script on the Mac that names itself (messages-v1.ts callerLabel),
 * a session, a person.
 *
 *   task_create with the tag in `tags`   the task is born with the marker; from anyone else the
 *     (or walnut.tasks.create)           create is refused (POST /tasks; task-manager.ts addTask)
 *   task_send / task_start from the      the program's own message (phase.ts PROGRAM_RUN_SEND_SOURCE,
 *     program into a program run         programSendSource): never adopts; into an imported program run
 *                                        it takes the run over (external-session-import.ts adoptImportedTask)
 *   anyone else's message                adopts it (phase.ts inputAdoptsPluginRun): the marker comes off
 *                                        (adoptPluginRun) and it is a regular task from then on
 *
 * No tag write can put the marker on or take it off (types.ts keepPluginRunMarker).
 *
 * Known edges, until a host's daemon tells the leader who made a call: a `walnut` typed in a host's
 * terminal and a trigger's check reach the leader as the same anonymous `external`, so their message
 * into a program run is the program's too (it never adopts, and into an imported program run it takes
 * it over); any plugin's own call counts, so one plugin's message into another plugin's run does not
 * adopt it either; and a host's replayed delivery with no sender into a plugin's run counts as the
 * program's (programRunDelivery), so a person's message from the phone while the Mac was away does not
 * adopt it.
 */
import { log } from '../../logging/index.js'
import { PLUGIN_RUN_TAG, isPluginRunTask, isProgramRunTask, type Task } from '../types.js'
import { PROGRAM_RUN_SEND_SOURCE } from '../phase.js'
import { EXTERNAL_CALLER_SID } from '../../providers/gateway-core.js'
import type { CallerIdentity } from './session-send-core.js'

/** The refusal a create with the marker gets from anyone but a program's own call (isProgramCall). */
export const PROGRAM_RUN_SESSION_REFUSAL =
  'The walnut:plugin-run tag marks a plugin\'s own run: only a program\'s own call (a plugin\'s job or its server half, with no session or person behind it) can create a task with it. A session, a person or a script that names itself cannot, and no one can put it on or take it off later. Nothing was done; call again without that tag.'

/** Who made a call, beside its resolved caller: the raw caller sid, the plugin it names, its sender label. */
export interface CallOrigin { sid?: string; pluginId?: string; label?: string }

/**
 * A program's call with no session and no person behind it (see the head of this file): an outside
 * caller that names its plugin (`plugin:<id>`, caller.app; or `x-walnut-plugin-id`), or the daemon
 * gateway's anonymous caller (the literal EXTERNAL_CALLER_SID) that names no sender.
 */
export function isProgramCall(caller: CallerIdentity, from: CallOrigin): boolean {
  if (caller.kind !== 'external') return false
  if (caller.app || from.pluginId?.trim()) return true
  return from.sid?.trim() === EXTERNAL_CALLER_SID && !from.label?.trim()
}

/** PROGRAM_RUN_SESSION_REFUSAL unless the call is a program's own (isProgramCall), else null. */
export async function programRunRefusal(from: CallOrigin): Promise<string | null> {
  const { resolveCaller } = await import('./session-send-core.js')
  const caller = await resolveCaller(from.sid).catch(() => null)
  return caller && isProgramCall(caller, from) ? null : PROGRAM_RUN_SESSION_REFUSAL
}

/**
 * The source an op-level send or start goes with when it is the program's own (PROGRAM_RUN_SEND_SOURCE):
 * a program's call (isProgramCall) that names no source of its own, into a task that is a program run.
 * Else null, and the send keeps the source it has today ('peer', which adopts). `named`: the source the
 * caller gave (the router's 'api-agent'); a start's route source is not one (programStartSource).
 */
export async function programSendSource(caller: CallerIdentity, from: CallOrigin, named: string | undefined, taskId: string | undefined): Promise<string | null> {
  // A start the route already found to be the program's own (programStartSource) keeps that source as it
  // continues the run's conversation, where the caller's plugin no longer rides; never for a session or a person.
  if (named === PROGRAM_RUN_SEND_SOURCE) return caller.kind === 'external' ? PROGRAM_RUN_SEND_SOURCE : null
  if (!isProgramCall(caller, from) || named || !taskId) return null
  const { getTask } = await import('../task-manager.js')
  const task = await getTask(taskId).catch(() => null)
  return task && isProgramRunTask(task) ? PROGRAM_RUN_SEND_SOURCE : null
}

/** programSendSource for a start through POST /tasks/:id/start, whose own source only says an agent called. */
export async function programStartSource(from: CallOrigin, taskId: string | undefined): Promise<string | null> {
  if (!from.sid?.trim()) return null
  const { resolveCaller } = await import('./session-send-core.js')
  const caller = await resolveCaller(from.sid).catch(() => null)
  return caller ? programSendSource(caller, from, undefined, taskId) : null
}

/**
 * A host's recorded delivery made while the Walnut that leads was away (offline-handover.ts) is the
 * program's own by the sender the host recorded:
 *   - `external` or `plugin:<id>`: as online (isProgramCall), into any program run;
 *   - '' (follower.send: a person's message from the phone, or a job's sent through its host's replica;
 *     the record cannot tell them apart): the program's only in a plugin's run (PLUGIN_RUN_TAG), where
 *     nearly everything written while the Mac was away is that job's follow-up; in an imported program
 *     run it is someone else's and adopts, as on main;
 *   - a session's sid or an unknown one: someone else's.
 */
export async function programRunDelivery(fromSessionId: string | undefined, task: Task): Promise<boolean> {
  const sid = fromSessionId?.trim() ?? ''
  if (!sid) return isPluginRunTask(task)
  if (!isProgramRunTask(task)) return false
  const { resolveCaller } = await import('./session-send-core.js')
  const caller = await resolveCaller(sid).catch(() => null)
  return !!caller && isProgramCall(caller, { sid })
}

/**
 * A person or another task wrote to the program's run: it is theirs, a regular task from now on.
 * Idempotent; a no-op for a task without the marker. Called from applySessionPhase's session:input
 * only (phase.ts), beside the importer's adoption.
 */
export async function adoptPluginRun(taskId: string, via: string): Promise<boolean> {
  const { getTask, updateTask } = await import('../task-manager.js')
  const task = await getTask(taskId).catch(() => null)
  if (!task || !isPluginRunTask(task)) return false
  await updateTask(taskId, { remove_tags: [PLUGIN_RUN_TAG] }, { source: 'plugin-run-adopt', pluginRunMarker: true })
  log.session.info('a program run was written to: it is a regular task now', { taskId, via })
  return true
}
