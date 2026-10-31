/**
 * A phone's empty tier (nitpick N22): the desktop leaves an empty tier blank
 * (its "Drag tasks here" shows only during a drag), which on a phone read as a
 * blank first screen. One line says it is empty and one 44 px button goes to
 * the Recent tab, where rows that need the user say "Needs you". The tab bar
 * listens for PHONE_SHOW_SECTION_EVENT (TodoSectionTabs), so this needs no
 * callback threaded through the panel. Renders nothing on the desktop.
 */
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';
import { useHomeTasksById } from './phone-row-behavior';

export const PHONE_SHOW_SECTION_EVENT = 'phone:show-section';

/** How many open tasks need the user: their one user status (a snoozed task never does),
 *  the phase only for a task the server has not derived yet. */
export function countNeedingYou(tasks: Iterable<Pick<Task, 'phase' | 'status' | 'user_status'>>): number {
  let n = 0;
  for (const t of tasks) if (taskUserState(t) === 'needs') n++;
  return n;
}

export function phoneTierEmptyHint(needYou: number): string {
  if (needYou === 1) return '1 task needs you.';
  return needYou > 1 ? `${needYou} tasks need you.` : '';
}

export function PhoneTierEmpty() {
  const phone = usePhoneLayout();
  const tasksById = useHomeTasksById();
  if (!phone) return null;
  const hint = phoneTierEmptyHint(countNeedingYou(tasksById.values()));
  return (
    <div className="phone-tier-empty" data-testid="phone-tier-empty">
      <p className="phone-tier-empty-line">Nothing here yet.{hint ? ` ${hint}` : ''}</p>
      <button
        type="button"
        className="phone-tier-empty-btn"
        onClick={() => window.dispatchEvent(new CustomEvent(PHONE_SHOW_SECTION_EVENT, { detail: { section: 'recent' } }))}
      >
        Show recent tasks
      </button>
    </div>
  );
}
