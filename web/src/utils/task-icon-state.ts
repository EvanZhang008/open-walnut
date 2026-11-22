/**
 * The one status icon state of a task (2026-11-21, the user: "I can't tell if it is working or not
 * started ... if it is working it should blink"). Seven states, each its own shape
 * (components/common/TaskStateIcon.tsx): Needs you, To read, Working, Waiting, Snoozed, Not
 * started, Completed. Pure: every surface that draws a task's status reads it from here, from the
 * task's one user status (taskUserState) and its wait facts (waitFacts), the same reading as the
 * status words (taskStatusLabel). Guard: tests/web/task-state-icon-guard.test.ts.
 */
import type { Task } from '@open-walnut/core';
import { USER_STATE_LABELS, stateWord, type UserState } from '@open-walnut/user-status';
import { NOT_STARTED_LABEL, taskUserState, waitFacts } from './session-status';
import { idleCompactingStore } from '@/stores/idle-compacting-store';

export type TaskIconState = 'needs' | 'read' | 'working' | 'waiting' | 'snoozed' | 'todo' | 'done';

export const TASK_ICON_STATES: readonly TaskIconState[] = ['needs', 'read', 'working', 'waiting', 'snoozed', 'todo', 'done'];

/** Each state's word (the icon's accessible name), from the status words every surface uses. */
export const TASK_ICON_WORDS: Record<TaskIconState, string> = {
  needs: USER_STATE_LABELS.needs,
  read: USER_STATE_LABELS.read,
  working: USER_STATE_LABELS.working,
  waiting: stateWord('waiting'),
  snoozed: stateWord('waiting', true),
  todo: NOT_STARTED_LABEL,
  done: USER_STATE_LABELS.done,
};

/** A user state and what kind of wait it is, as an icon state. */
export function iconStateOf(state: UserState, wait: { snoozed?: boolean; notStarted?: boolean } = {}): TaskIconState {
  if (state !== 'waiting') return state;
  if (wait.snoozed) return 'snoozed';
  return wait.notStarted ? 'todo' : 'waiting';
}

/** A phase alone, where only the phase is known (a phase menu's option, a chat's task context). */
export function phaseIconState(phase: string | undefined): TaskIconState {
  switch (phase) {
    case 'NEED_ACTION': return 'needs';
    case 'IN_PROGRESS': return 'working';
    case 'WAITING': return 'waiting';
    case 'COMPLETE': return 'done';
    default: return 'todo';
  }
}

/** The live status of a task's session, from the session-status store. */
export interface LiveSessionStatus {
  process_status?: string | null;
  pendingPermissionTool?: string | null;
}

type IconTask = Pick<Task, 'phase' | 'status' | 'user_status'>
  & Partial<Pick<Task, 'session_id' | 'start_date' | 'org_role' | 'session_status'>>;

/**
 * A task's icon state. A finished task is Completed first, whatever its session does (its words say
 * Completed; a late turn on it is no work the user waits for). Then the session's status: `live` (the
 * session-status store's entry, when the caller subscribes to it), else the task's own enrichment
 * snapshot (`session_status`), as askState reads it: a prompt waiting on the user is Needs you, a
 * running turn is Working (Walnut's own idle compaction is no work of the task's), and Needs you and
 * To read outrank a turn that runs. With neither the task's user status alone decides, which the
 * server keeps current. `snoozed`: the caller's reading of the start date, for a task the server has
 * not derived yet.
 */
export function taskIconState(task: IconTask, live?: LiveSessionStatus | null, snoozed = false, sessionId?: string | null): TaskIconState {
  const state = taskUserState(task, snoozed);
  if (state === 'done') return 'done';
  const status = live ?? task.session_status ?? null;
  if (status?.pendingPermissionTool) return 'needs';
  if (state === 'needs' || state === 'read') return state;
  const compacting = !!sessionId && idleCompactingStore.has(sessionId);
  if (status?.process_status === 'running' && !compacting) return 'working';
  return iconStateOf(state, waitFacts(task, snoozed));
}

/** A status section's own icon state (its heading, a count of it); null for a section that is no
 *  state (Watching, Background). Section keys: components/tasks/status-sections.ts. */
export function sectionHeadState(section: string): TaskIconState | null {
  switch (section) {
    case 'needs': return 'needs';
    case 'working': return 'working';
    case 'waiting': return 'waiting';
    case 'notstarted': return 'todo';
    case 'done': return 'done';
    default: return null;
  }
}

/**
 * The icon of a row drawn in a status section (Home's sections, the Org rail's): its section's,
 * never its phase's (2026-11-02, the user: rows under Waiting / snoozed wore the needs ring and
 * "looks like they are waiting for my input"); under Needs you a To read keeps its own, under
 * Waiting a snooze and a task nobody started (a view that does not split Not started out), as
 * iOS's BoardStatusSectionModel.iconState. Elsewhere (Watching) the task's own. `snoozed`: the
 * row's own reading of its snooze date.
 */
export function sectionIconState(section: string, own: TaskIconState, snoozed = false): TaskIconState {
  if (own === 'done') return 'done';
  if (section === 'needs' && own === 'read') return 'read';
  if (section === 'waiting' && (snoozed || own === 'snoozed')) return 'snoozed';
  if (section === 'waiting' && own === 'todo') return 'todo';
  return sectionHeadState(section) ?? own;
}
