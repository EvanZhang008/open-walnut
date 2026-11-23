/**
 * Who made a journaled record, and what that means when this Mac drains it (apply-v2.ts):
 * the per-actor rules in ONE place, so a new kind of actor is one entry here instead of a
 * kind check in every apply function.
 *
 *   session     a session's `walnut` call: exactly its op's input, the session gates (a
 *               park, a close), the caller rules of its create (caller-placement.ts), and
 *               replayed as that session.
 *   device      a paired phone or browser: the routes' whole queueable set, a close that
 *               settles a hold (the person's own word), the person's create defaults and a
 *               touch, replayed with paired-device rights.
 *   trigger     a trigger's own write: the whole queueable set, no gate, the person's create
 *               defaults (pinned by default), replayed as a caller on its host.
 *   plugin-job  a plugin's job on the host, while the Mac was away. Online its
 *               `walnut.ops.call` reaches the server as the anonymous outside caller
 *               `external` (the daemon's sendPluginJobGatewayRequest), so: exactly its op's
 *               input, no session or device gate, and an outside caller's create. Online,
 *               decidePlacement, applyCreateRules and inheritedTier treat `external` as they
 *               treat a person: no parent, folder or tier from a caller, pinned by default,
 *               no depth cap, no title brake. Never a person's touch. Replayed as a caller
 *               on its host, as a trigger is.
 */

import { RefusedWrite } from './patch-check.js';
import type { CallerPlacement, CallerTaskRow } from '../sessions/caller-placement.js';

export type JournalActorLike =
  | { kind: 'session'; sid: string }
  | { kind: 'device'; deviceId: string; name?: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'plugin-job'; plugin: string; job: string };

export interface ActorRules {
  /** Its writes take exactly what its op takes online (opWriteFields); else the whole queueable set. */
  opStrict: boolean;
  /** The session whose own gates its writes meet (a queued park, a close it still owes). */
  sessionSid?: string;
  /** A queued close is checked for what the task still holds for the user: a session's, or a person's (settles a hold). */
  checksClose: boolean;
  /** A person made it (a paired device): a create of theirs is their touch. */
  person: boolean;
}

/** The rules of a record's actor (no actor: a v1-shaped record, as a trigger's). */
export function actorRules(actor: JournalActorLike | undefined): ActorRules {
  switch (actor?.kind) {
    case 'session': return { opStrict: true, sessionSid: actor.sid, checksClose: true, person: false };
    case 'device': return { opStrict: false, checksClose: true, person: true };
    case 'plugin-job': return { opStrict: true, checksClose: false, person: false };
    default: return { opStrict: false, checksClose: false, person: false };
  }
}

/**
 * The caller an away create is placed as, the one the same create online has (api-v1.ts
 * POST /tasks): a session's own placement; a plugin job an outside caller's, and when its
 * plugin keeps its tasks to its own view (plugin-task-visibility.ts) no caller at all and
 * the task stamped `plugin_only`, as `walnut.ops.call` naming the plugin gets online.
 * The Mac's drain and a host's follower (replica/write-port.ts, reading its copy through
 * `readTask`) both place an away create by it, so the two agree.
 */
export async function createCaller(
  actor: JournalActorLike | undefined,
  opts: { readTask?: (id: string) => Promise<CallerTaskRow | null | undefined> } = {},
): Promise<{ caller: CallerPlacement; pluginOnly?: string }> {
  if (actor?.kind === 'session') {
    const { resolveCallerPlacement } = await import('../sessions/caller-placement.js');
    return { caller: await resolveCallerPlacement(actor.sid, opts).catch(() => ({ kind: 'unknown' as const })) };
  }
  if (actor?.kind === 'plugin-job') {
    const { pluginOnlyForCaller } = await import('../plugins/plugin-task-visibility.js');
    const pluginOnly = pluginOnlyForCaller(undefined, actor.plugin);
    return pluginOnly ? { caller: { kind: 'unknown' }, pluginOnly } : { caller: { kind: 'external' } };
  }
  return { caller: { kind: 'human' } };
}

/** The op caller a record's actor replays as: a device with paired-device rights, a session as itself, the rest as a caller on its host. */
export async function actorOptions(hostKey: string, actor: JournalActorLike | undefined): Promise<{ callerSid?: string; callerHost?: string; origin: string }> {
  const { hostOrigin, REMOTE_HTTP_ORIGIN } = await import('../../lib/caller-origin.js');
  if (actor?.kind === 'device') return { origin: REMOTE_HTTP_ORIGIN };
  if (actor?.kind === 'session') return { callerSid: actor.sid, callerHost: hostKey, origin: hostOrigin(hostKey) };
  return { callerHost: hostKey, origin: hostOrigin(hostKey) };
}

/**
 * Task fields another op writes online that the away host journals as a task_update record
 * (replica/away-writes.ts: task_note_write's PUT /tasks/:id/note, task_pin_set's /focus/tasks/:id),
 * each with the op that writes it. 2026-11-23: a session's task_note_write while the Mac was away
 * was answered "Task note replaced", then refused on the drain as "task_update does not take
 * note". tests/core/offline-merge/away-op-fields.test.ts reads every field the away host writes
 * this way from its source, so a new one fails until it names its op here.
 */
export const TASK_FIELDS_OF_OTHER_OPS: Readonly<Record<string, string>> = { note: 'task_note_write', pinned: 'task_pin_set' };

/**
 * An op-strict actor's away write takes exactly what its op takes online (executor.ts parses
 * the op's input strictly, after dropping its retired fields): task_update its own fields and
 * the fields its sibling ops write (TASK_FIELDS_OF_OTHER_OPS), task_complete the phase alone,
 * task_create its own fields. Anything else (status, summary, unread, pin_order, depends_on,
 * ...) refuses the whole record, the answer the same call online gets. A device or a trigger
 * writes the whole queueable set, as the routes it stands for do.
 */
export async function opWriteFields<T>(record: { kind: string; op?: unknown; actor?: JournalActorLike }, fields: Record<string, T>): Promise<Record<string, T>> {
  if (!actorRules(record.actor).opStrict) return fields;
  const name = record.kind === 'task-create' ? 'task_create' : record.op === 'task_complete' ? 'task_complete' : 'task_update';
  const { getOp } = await import('../../ops/index.js');
  const op = getOp(name);
  const allowed = name === 'task_complete' ? new Set(['phase'])
    : new Set([...Object.keys(op?.input ?? {}).filter((k) => k !== 'id'), ...(name === 'task_update' ? Object.keys(TASK_FIELDS_OF_OTHER_OPS) : [])]);
  // waiting_on is the park gate's words, no task field (sessions/outside-wait.ts).
  const retired = new Set([...(op?.retiredInput ?? []), 'waiting_on']);
  const out: Record<string, T> = {};
  const bad: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (retired.has(k)) continue;
    if (allowed.has(k)) out[k] = v; else bad.push(k);
  }
  if (bad.length) throw new RefusedWrite(`${name} does not take ${bad.join(', ')}; nothing of this write was applied`);
  return out;
}
