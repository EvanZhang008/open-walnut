/**
 * The words both halves of lean event frames share: the server's shaper
 * (src/web/ws/lean-frames.ts) and the web client's cache (web/src/api/ws-lean.ts).
 * Pure and isomorphic, like ws-bearer-protocol.ts.
 */

/** Protocol version, carried in every `lean` block. */
export const LEAN_VERSION = 1;

/** A task field whose JSON is at least this long is left out while unchanged; smaller ones always ride. */
export const LEAN_FIELD_MIN_BYTES = 512;

/** The background ledger snapshot, sent as the rows that changed. */
export const LEAN_BACKGROUND_EVENT = 'session:background-tasks';

/**
 * Events whose payload carries a whole task as `task` (event-types.ts): its large
 * fields that did not change since this socket last heard them are left out.
 * tests/web/ws-lean-frames.test.ts fails on an event with a whole task that is not
 * here or in LEAN_TASK_EXEMPT.
 */
export const LEAN_TASK_EVENTS: readonly string[] = [
  'task:created',
  'task:updated',
  'task:completed',
  'task:phase-changed',
  'task:unblocked',
];

/** Events with a whole task that ride whole, and why. */
export const LEAN_TASK_EXEMPT: Readonly<Record<string, string>> = {
  'task:deleted': 'the last word on a task: both sides forget what they keep for it, nothing to leave out',
};

/** At most this many tasks and background ledgers are kept per socket, the least recently sent going first. */
export const LEAN_MAX_TASKS = 500;
export const LEAN_MAX_SESSIONS = 100;

/**
 * What the client asks for (`/ws?lean=<signature>`): the version, the event list and the
 * limits in one short hash. A server whose rules differ (a deploy changed the list while a
 * window stayed open) sees another signature and sends that socket whole frames, so an
 * older page never meets a lean frame it does not know how to rebuild.
 */
export const LEAN_SIGNATURE: string = (() => {
  const text = [LEAN_VERSION, LEAN_FIELD_MIN_BYTES, LEAN_MAX_TASKS, LEAN_MAX_SESSIONS, LEAN_BACKGROUND_EVENT, ...LEAN_TASK_EVENTS].join('|');
  let h = 0x811c9dc5; // FNV-1a, 32 bits
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${LEAN_VERSION}-${h.toString(36)}`;
})();

/** Moves `key` to the newest end of a map used as a least-recently-sent list, dropping the oldest past `max`. */
export function touchLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** Ends what both sides keep for a task. */
export const LEAN_FORGET_EVENT = 'task:deleted';

/** The id a task:deleted names. */
export function deletedTaskId(data: unknown): string | undefined {
  const d = data as { id?: unknown; taskId?: unknown; task?: { id?: unknown } | null } | null;
  return [d?.id, d?.taskId, d?.task?.id].find((x): x is string => typeof x === 'string' && x.length > 0);
}
