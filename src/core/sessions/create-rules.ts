/**
 * The rules a new task's create follows by who made it, in ONE place for the two paths
 * that create a task from a caller: the v1 create route (src/web/routes/api-v1.ts) and
 * the offline drain's away create (src/core/offline-merge/apply-v2.ts), so a create
 * replayed from a host's journal lands the way the same call online does.
 *
 *   - a worker that names a project other than its own task's quotes the user's words
 *     naming it (`user_words`, caller-placement.ts projectElsewhereRefusal):
 *     ProjectElsewhereError (409);
 *   - a session's subtask chain has a depth cap (subtask-limits.ts): SubtaskLimitError;
 *   - an ask's create that names no project goes to `defaults.project`, never the ask's
 *     own `Ask ...` project (with a parent set addTask would inherit it);
 *   - a worker's task is born in the caller's board tier unless the create names
 *     `pinned` or a tier; any other create is pinned by default (newTaskPinDefault);
 *   - a session's long title is cut to its head (task-title-brake.ts), and the long form
 *     becomes the description when the create gave none.
 *
 * After the row exists, `placeBesideCaller` files a worker's subtask beside it when the
 * placement decision says so (best-effort, never throws).
 */

import type { CallerPlacement, PlacementDecision } from './caller-placement.js';

export interface CreateRuleInput {
  title: string;
  /** The project the create names (the body's, before any rule fills it in). */
  project?: string;
  /** The user's own words asking for `project`, when it is not the caller's. */
  user_words?: unknown;
  description?: string;
  pinned?: unknown;
  focus_tier?: unknown;
}

export interface CreateRuleOutput {
  title: string;
  /** The session's long title, when it was cut. */
  titleShortenedFrom?: string;
  description?: string;
  /** The board tier the task is born into. */
  tier: { pinned: boolean; focus_tier?: string };
  /** The tier is the caller's (a deleted custom tier falls back to Satellite). */
  tierInherited: boolean;
}

/** A worker named a project other than its own task's without the user's words for it: nothing is created. */
export class ProjectElsewhereError extends Error {
  readonly statusCode = 409;
  readonly code = 'project_elsewhere';
  constructor(message: string, readonly details?: { callerProject: string; requestedProject?: string }) {
    super(message);
    this.name = 'ProjectElsewhereError';
  }
}

/**
 * Apply the create rules for `caller`. Mutates `decision.project` for the ask rule.
 * Throws ProjectElsewhereError for a worker's other project the user did not name, and
 * SubtaskLimitError when the parent sits too deep.
 */
export async function applyCreateRules(
  input: CreateRuleInput, caller: CallerPlacement, decision: PlacementDecision,
): Promise<CreateRuleOutput> {
  const { projectElsewhereRefusal } = await import('./caller-placement.js');
  const elsewhere = projectElsewhereRefusal(
    { ...(typeof input.project === 'string' ? { project: input.project } : {}), user_words: input.user_words }, caller);
  if (elsewhere) {
    throw new ProjectElsewhereError(elsewhere, 'task' in caller
      ? { callerProject: caller.task.project, ...(typeof input.project === 'string' ? { requestedProject: input.project } : {}) }
      : undefined);
  }
  if (caller.kind === 'worker' && typeof input.project === 'string' && typeof input.user_words === 'string'
    && !(await import('./caller-placement.js')).sameProject(input.project, caller.task.project)) {
    const { log } = await import('../../logging/index.js');
    log.session.info('subtask filed in another project as the user asked', {
      parentId: caller.task.id, callerProject: caller.task.project, project: input.project,
      callerSid: caller.session.id, userWords: input.user_words.slice(0, 300),
    });
  }
  // Only a session is limited: a human's (or a device's) create never is.
  if (decision.parentTaskId && 'session' in caller) {
    const { assertSubtaskDepth } = await import('./subtask-limits.js');
    await assertSubtaskDepth(decision.parentTaskId, 'task' in caller ? caller.task.title : undefined);
  }
  if (caller.kind === 'ask' && decision.project === undefined) {
    const { getConfig } = await import('../config-manager.js');
    decision.project = (await getConfig()).defaults?.project ?? '';
  }
  const { inheritedTier } = await import('./caller-placement.js');
  const inherited = inheritedTier({ pinned: input.pinned, focus_tier: input.focus_tier }, caller);
  const { newTaskPinDefault } = await import('../task-manager.js');
  const tier = inherited ?? {
    pinned: newTaskPinDefault(input.pinned),
    ...(typeof input.focus_tier === 'string' ? { focus_tier: input.focus_tier } : {}),
  };
  const { needsShortening, heuristicShortTitle } = await import('./task-title-brake.js');
  let title = input.title.trim();
  let from: string | undefined;
  if ('session' in caller && needsShortening(title)) {
    from = title;
    title = heuristicShortTitle(title);
  }
  // A blank description counts as none: the long form is what the session wrote.
  const description = from && !(typeof input.description === 'string' && input.description.trim())
    ? from
    : input.description;
  return {
    title,
    ...(from ? { titleShortenedFrom: from } : {}),
    ...(description !== undefined ? { description } : {}),
    tier,
    tierInherited: !!inherited,
  };
}

/** Once the task exists: a worker's subtask goes beside it (its folder, a subfolder, or a new one). */
export async function placeBesideCaller(
  decision: PlacementDecision, caller: CallerPlacement, created: { id: string; title: string }, eventSource: string,
): Promise<Awaited<ReturnType<typeof import('./caller-placement.js').joinOrCreateSiblingFolder>> | null> {
  if (!decision.placeBesideCaller || caller.kind !== 'worker') return null;
  // The companion holds no folders: the Mac files it beside its parent when it takes the create.
  const { isCompanion } = await import('../server-role.js');
  if (isCompanion()) return null;
  const { joinOrCreateSiblingFolder } = await import('./caller-placement.js');
  return joinOrCreateSiblingFolder(caller.task, created.id, {
    eventSource, refineTitles: [caller.task.title, created.title], nest: true,
  });
}
