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
 * session has no task draws neither.
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
 * A panel that adopts its session's canonical id (a deep link names it by a
 * prefix) is replaced by a new panel under the full id, which would start with
 * no memory of what the old one drew. The old panel hands its drawn slots
 * over here; the new one takes them on its first frame.
 */
const carriedSlots = new Set<string>();

export function carryTaskSlots(sessionId: string): void {
  carriedSlots.add(sessionId);
}

/** Whether a panel replaced for this id drew the slots (read on mount, never cleared by a read). */
export function hasCarriedTaskSlots(sessionId: string): boolean {
  return carriedSlots.has(sessionId);
}

/** The new panel took the hand-over (called once it has mounted). */
export function releaseCarriedTaskSlots(sessionId: string): void {
  carriedSlots.delete(sessionId);
}

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
