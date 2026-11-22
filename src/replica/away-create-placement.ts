/**
 * Where a create made on this host while the leader is away is filed: the leader's own rules,
 * run here on this host's copy of the caller's task, so the answer, the journaled record, this
 * host's row of the task and its away start all see the place the leader's drain gives it.
 *
 *   caller   journal-actor.ts createCaller (the drain's): a session's own placement read through
 *            the copy plus this host's pending writes, a plugin job an outside caller's, a device
 *            a person's
 *   place    caller-placement.ts decidePlacement and create-rules.ts applyCreateRules, as the
 *            leader's create route (api-v1.ts POST /tasks) and its drain (apply-v2.ts createTask):
 *            a session's create with no project lands in its caller's project as its subtask, in its
 *            board tier; another project the user did not name is refused (project_elsewhere), and
 *            so is a subtask past the depth cap
 *
 * The record keeps only keys every leader's drain already reads (placement.project, parentTaskId,
 * groupId, tier; the field `pinned`), plus `inheritedProject`, which every drain ignores. A project
 * the create NAMED is `project`, checked again at the drain; one taken from the caller is
 * `inheritedProject`, for this host's own row and its away start alone: the drain files the task under
 * its caller where the caller is THEN, so a caller moved to another project meanwhile (on the leader, or
 * a lagging copy here) takes its new subtask along, never a refusal of a create this host answered 201
 * (review 2026-11-22). The caller's FOLDER is never
 * journaled: the leader files the task beside its caller under its store lock (join, a subfolder, or
 * a new folder: task-manager.ts placeInFolderBeside), and a folder named in the record would be filed
 * flat instead. Only a folder the create named rides the record, as before.
 */

import type { CallerPlacement } from '../core/sessions/caller-placement.js'
import type { FoldPlacement } from '../core/offline-merge/task-row-fold.js'

/** The daemon capability whose follower.op task_create keeps `inherited_project` (placement.inheritedProject). */
export const INHERITED_PROJECT_CAP = 'follower-create-inherited-v1'

export type AwayCreatePlaced =
  | { refused: { code: string; message: string } }
  | {
    /** The record's placement (the keys a drain reads). */
    placement: FoldPlacement
    /** Fields the caller rule adds to the record: the pin a session's subtask inherits. */
    fields: Record<string, unknown>
    /** What the answer's `placement` says, in the leader's shape (api-v1.ts POST /tasks). */
    answer: Record<string, unknown>
  }

/** Who an actor is when no copy can say (no reader wired): a device is a person, anyone else unknown. */
export function plainCaller(actor: { kind: string }): CallerPlacement {
  return actor.kind === 'device' ? { kind: 'human' } : { kind: 'unknown' }
}

/**
 * Place an away create. `all`: the create's inputs (title and the placement keys among them);
 * `namedParent`: a paired device's own parent, which wins as the drain lets it.
 */
export async function placeAwayCreate(all: Record<string, unknown>, caller: CallerPlacement, namedParent: string | undefined): Promise<AwayCreatePlaced> {
  const { decidePlacement } = await import('../core/sessions/caller-placement.js')
  const { applyCreateRules, ProjectElsewhereError } = await import('../core/sessions/create-rules.js')
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const req = {
    ...(typeof all.project === 'string' ? { project: all.project } : {}),
    ...(typeof all.group_id === 'string' ? { group_id: all.group_id } : {}),
  }
  const decision = decidePlacement(req, caller)
  let tier: { pinned: boolean; focus_tier?: string } | undefined
  try {
    // A copy: an ask's default project is the leader's config, which its drain applies.
    const rules = await applyCreateRules({
      title: typeof all.title === 'string' ? all.title : '', pinned: all.pinned, focus_tier: all.focus_tier,
      ...(typeof all.project === 'string' ? { project: all.project } : {}),
    }, caller, { ...decision })
    if (rules.tierInherited) tier = rules.tier
  } catch (err) {
    if (err instanceof ProjectElsewhereError) return { refused: { code: err.code, message: err.message } }
    const { SubtaskLimitError } = await import('../core/sessions/subtask-limits.js')
    if (err instanceof SubtaskLimitError) return { refused: { code: err.code, message: err.message } }
    throw err
  }
  const parent = namedParent ?? decision.parentTaskId
  const named = str(all.focus_tier)
  const placement: FoldPlacement = {
    ...(parent ? { parentTaskId: parent } : {}),
    ...(typeof decision.project === 'string' ? { [typeof all.project === 'string' ? 'project' : 'inheritedProject']: decision.project } : {}),
    ...(decision.group_id ? { groupId: decision.group_id } : {}),
    ...(tier?.focus_tier ? { tier: tier.focus_tier } : named ? { tier: named } : {}),
  }
  const { projectOrInbox } = await import('../core/inbox-project.js')
  const answer: Record<string, unknown> = {
    project: projectOrInbox(placement.project ?? placement.inheritedProject),
    ...(placement.groupId ? { group_id: placement.groupId } : {}),
    folder_created: false,
    ...(decision.inheritedFrom ? { inherited_from: decision.inheritedFrom } : {}),
    ...(parent ? { parent_task_id: parent } : {}),
    ...(tier ? { tier: !tier.pinned ? 'unpinned' : tier.focus_tier || 'satellite' } : {}),
  }
  return { placement, fields: tier ? { pinned: tier.pinned } : {}, answer }
}
