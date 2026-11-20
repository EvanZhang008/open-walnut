/**
 * The Director switch on a task (Task.director; the rule itself is src/core/org/org-directors.ts).
 * One place reads a write of it, so the web route, API v1, task_update and task_create agree:
 *
 *   'yes' / 'no'     stored as is
 *   'auto' / null    the field is deleted (a task with an open subtask is a Director)
 *   anything else    400 bad_request
 *
 * An org node (Main, a VP, a router) is above the Directors and never stores one: a write naming
 * yes or no on it is refused with OrgNodeDirectorError (400), and 'auto' on it changes nothing.
 */
import type { DirectorChoice, OrgRole, Task } from './types.js';

/** What a write may send for Task.director. */
export type DirectorInput = DirectorChoice | 'auto' | null;

export const DIRECTOR_INPUTS: readonly string[] = ['auto', 'yes', 'no'];

export const DIRECTOR_INPUT_ERROR = 'director must be one of: auto, yes, no (or null for auto)';

/** A body's `director`, checked: undefined when absent, an error when it is no DirectorInput. */
export function parseDirectorInput(value: unknown): { ok: true; value: DirectorInput | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string' && DIRECTOR_INPUTS.includes(value)) return { ok: true, value: value as DirectorInput };
  return { ok: false, error: DIRECTOR_INPUT_ERROR };
}

/** A Director choice on Main, a VP or a router: they are above the Directors. */
export class OrgNodeDirectorError extends Error {
  readonly statusCode = 400;
  readonly code = 'org_node_director';
  constructor(taskId: string, role: OrgRole) {
    super(`Task ${taskId} is an org node (${role === 'main' ? 'the CEO' : role === 'lead' ? 'a VP' : 'a router'}): it is above the Directors and takes no director choice.`);
    this.name = 'OrgNodeDirectorError';
  }
}

/** Would this write be refused on this task (checked before anything is written)? */
export function directorRefusal(task: Pick<Task, 'id' | 'org_role'>, input: DirectorInput | undefined): OrgNodeDirectorError | undefined {
  if (!task.org_role || (input !== 'yes' && input !== 'no')) return undefined;
  return new OrgNodeDirectorError(task.id, task.org_role);
}

/** Apply a write of Task.director in place (throws OrgNodeDirectorError on an org node). */
export function applyDirector(task: Task, input: DirectorInput | undefined): void {
  if (input === undefined) return;
  const refusal = directorRefusal(task, input);
  if (refusal) throw refusal;
  if (input === 'yes' || input === 'no') task.director = input;
  else delete task.director;
}
