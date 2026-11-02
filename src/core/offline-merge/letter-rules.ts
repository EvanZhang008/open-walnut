/**
 * Which conflicts of a drain's log the letter lists, and the links it holds (letter.ts).
 * No words here: the letter's text, in each letter language, is the `offline-conflict`
 * kind (human-inbox/walnut-letters/offline-conflict.ts), which builds the body from these.
 */

import type { ConflictEntry } from './conflict-log.js';
import { TEXT_TASK_FIELDS } from './task-fields.js';

/** Largest letter body; the full values stay in the conflict log the letter links to. */
export const LETTER_BODY_MAX = 16 * 1024;

/** Where the full entry `n` of a drain's log is served. */
export function conflictEntryLink(drainId: string, n: number): string {
  return `/api/v1/offline-conflicts/${encodeURIComponent(drainId)}#${n}`;
}

export function taskLink(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

/** MEMORY.md or USER.md, for an entry about a memory record (its conflict, or its refusal). */
export function memoryDocName(e: ConflictEntry): string | undefined {
  if (e.kind === 'memory' && e.field) return e.field;
  if (e.recordKind !== 'memory') return undefined;
  const doc = (e.record as { doc?: unknown } | undefined)?.doc;
  return doc === 'user' ? 'USER.md' : 'MEMORY.md';
}

/** A note in the console (the Notes page opens it by its vault path, `/notes?path=`). */
export function noteLink(rel: string): string {
  return `/notes?path=${encodeURIComponent(rel)}`;
}

/** The session that made the write, when a session did: an op's caller, or a v2 record's actor. */
export function writerSessionId(e: ConflictEntry): string | undefined {
  const rec = e.record as { kind?: unknown; callerSid?: unknown; actor?: unknown } | undefined;
  if (rec?.kind === 'op' && typeof rec.callerSid === 'string' && rec.callerSid) return rec.callerSid;
  const actor = (e.actor ?? rec?.actor) as { kind?: unknown; sid?: unknown } | undefined;
  return actor?.kind === 'session' && typeof actor.sid === 'string' && actor.sid ? actor.sid : undefined;
}

/**
 * A session's own write the Mac refused (validation, a guard: the answer the same call
 * online gets). The drain already tells that session what was not applied and why
 * (offline-handover.ts tellCallers); the user can do nothing with it, so it is no letter.
 * 2026-10-30: an agent on clouddev called task_update with a `note` field while the Mac
 * slept, and the user's inbox got "1 change made while your Mac was away did not merge
 * cleanly". A person's own refused write, and every content conflict, still letter.
 */
export function refusedBySession(e: ConflictEntry): boolean {
  return e.kind === 'refused' && writerSessionId(e) !== undefined;
}

/** Task fields that hold words someone wrote: the merged texts, the title, the tags. */
const WORD_TASK_FIELDS = new Set([...TEXT_TASK_FIELDS, 'title', 'tags']);

/**
 * Does this conflict need the user? A setting both sides changed (a phase, a priority, a
 * date, a pin) is settled by the merge's own rule, the newer change wins, and stays in the
 * log with no letter (2026-10-28: two letters for phase conflicts the merge had already
 * settled). Words one side wrote that were not kept, a move the Mac would not take, and
 * every other kind (a refusal, a drop, a delete that beat an edit, a note, a memory, a
 * chat name) still need the user, except a session's own write the Mac refused, which
 * goes back to that session alone (refusedBySession).
 */
export function conflictNeedsUser(e: ConflictEntry): boolean {
  if (refusedBySession(e)) return false;
  if (e.kind !== 'task-field') return true;
  if (e.why === 'invalid-pair') return true;
  return e.field === undefined || WORD_TASK_FIELDS.has(e.field);
}
