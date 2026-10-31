/**
 * The session header controls that need the session's task (Fork, Board,
 * Locate), decided so the tool row never moves when the record lands.
 *
 * 2026-10-11: Fork rendered nothing until the record named the task, then
 * appeared in front of Changed and Files and pushed them right, so a click
 * aimed at Files opened Changed. And a control that cannot act must not sit
 * on the row for good either: the row is precious, and in a narrow column a
 * dead chip sends a live one into "...".
 *
 * So whether the three EXIST is decided on the first frame, from what this
 * browser already knows about the session (headerTaskPresence), and only
 * whether they can ACT waits for the record (recordGateReason). Once drawn,
 * they never leave the row while the panel shows the session (taskControlSlot).
 */

/** Whether the session has a task: known yes, known no, or not known yet. */
export type HeaderTaskPresence = 'task' | 'none' | 'unknown';

/**
 * What the header knows about the session's task on this frame.
 *
 * `record` is the panel's resolved record (null until it loads, and when the
 * load failed); once it is here it decides, and it already carries the status
 * store's view of the task (resolveSessionRecordStatus), so the chips follow
 * the same task the rest of the panel shows. Before it, `status` is the
 * session-status store's entry, seeded on this page by every list that names
 * the session: the task list (each task's session slots), the session finder
 * and recent lists, the per-session status hydration, and status events.
 *
 * A versioned entry (statusRevision set) is the server's own snapshot and
 * always names the task, null meaning none. An unversioned entry that never
 * heard a task holds its default null, which says nothing, so it counts as
 * unknown; an explicit '' still means none.
 */
export function headerTaskPresence(
  record: { taskId?: string | null } | null | undefined,
  status: { taskId: string | null; statusRevision: number | null } | null | undefined,
): HeaderTaskPresence {
  if (record) return record.taskId ? 'task' : 'none';
  if (!status) return 'unknown';
  if (status.taskId) return 'task';
  return status.taskId === '' || status.statusRevision != null ? 'none' : 'unknown';
}

/**
 * How the row draws Fork, Board and Locate on this frame: as the controls,
 * as spacers, or not at all.
 *
 * Drawn ('live') while the session has a task or may have one. Once a panel
 * drew them, a later "no task" (the record of a session nothing on the page
 * had named, or the task deleted while the panel is open) keeps their places
 * as spacers for the rest of that panel's life (per session: a panel handed
 * another session starts over): the same elements, the same
 * width, invisible and inert. Removing them moved Changed and Files left by
 * Fork's width and Terminal onto Files' place, so a click aimed at Files
 * opened Terminal (2026-10-11). A panel that knew from its first frame that the
 * session has no task draws neither. The panel's memory of what it drew,
 * including across a prefix id's replacement, is useTaskControlSlot.
 */
export type TaskControlSlot = 'live' | 'spacer' | 'absent';

export function taskControlSlot(presence: HeaderTaskPresence, drawnBefore: boolean): TaskControlSlot {
  if (presence !== 'none') return 'live';
  return drawnBefore ? 'spacer' : 'absent';
}

/** The tool row ids of the three (their `data-header-id`). */
export const TASK_SLOT_IDS: ReadonlySet<string> = new Set(['fork', 'board', 'locate']);

/**
 * What a spacer adds to the element it stands in for. CSS makes it invisible
 * and unclickable (`[data-header-spacer]`, session-header-fit.css); it is out
 * of the tab order and of the accessibility tree; it carries no name, no
 * title and no handler. It keeps its `data-header-id`, so the row's fit
 * measures and folds it exactly as it did the control, and the "..." menu
 * leaves it out of its rows and its count (SessionHeaderMoreMenu).
 */
export const TASK_SLOT_SPACER = {
  'aria-hidden': true,
  tabIndex: -1,
  disabled: true,
  'data-header-spacer': 'true',
} as const;

/**
 * Why a control that needs the record cannot act yet, or null once it can.
 * The control is drawn while it waits (presence 'task' or 'unknown'), so this
 * becomes its title: assistive tech reads it as the disabled button's
 * description, and the row's "..." menu shows it for a control folded there.
 */
export function recordGateReason(
  name: string,
  record: { taskId?: string | null } | null | undefined,
  loading: boolean,
): string | null {
  if (record) return null;
  return loading
    ? `${name} becomes available once the session has loaded`
    : `${name} is unavailable because this session's details did not load`;
}

/**
 * The plan facts the header decides Plan from on this frame: the record once it
 * is here, before it the session-status store's entry (the finder, the task list
 * and status events seed `planCompleted` and `mode`). Plan sits after the chips
 * every session has, but in a row with no room left its "..." took a window
 * button's place when the record landed (2026-10-31, CI at 300px: Open in new tab
 * left the row), so a plan the page already knows of is drawn from the first frame.
 */
export function headerPlanFacts(
  record: { planCompleted?: boolean; mode?: string; fromPlanSessionId?: string | null } | null | undefined,
  status: { planCompleted?: boolean; mode?: string } | null | undefined,
): { hasPlan: boolean; isFromPlan: boolean; planMode: boolean } {
  if (record) {
    return { hasPlan: !!record.planCompleted, isFromPlan: !!record.fromPlanSessionId, planMode: record.mode === 'plan' };
  }
  return { hasPlan: !!status?.planCompleted, isFromPlan: false, planMode: status?.mode === 'plan' };
}
