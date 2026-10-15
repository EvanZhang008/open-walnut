/**
 * The words a phone row shows that a desktop row says with color or a tooltip
 * (spec 4.2, 4.7 Home; C67, C68). Renders nothing on the desktop.
 *
 * - `Needs you: <tool>`: the row's session is blocked on a prompt (the words
 *   the desktop keeps in a tooltip), else `Needs you`: the task waits on the
 *   user (NEED_ACTION). Either wins over the unread dot (phone-pages.css hides
 *   the dot then): the dot alone is a color.
 * - `<n> need you`: a collapsed parent whose open subtasks wait on the user.
 *   A tap expands the parent and brings the first such subtask into view with
 *   a 1 s highlight.
 */
import { useCallback } from 'react';
import type { Task } from '@open-walnut/core';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useSessionStatus, useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { phoneSessionLabel } from '@/utils/phone-session-label';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import { descendantsNeedingYou, needYouLabel } from './needs-you';
import { useHomeTasksById } from './phone-row-behavior';

const HIGHLIGHT_MS = 1000;
const FIND_ROW_FOR_MS = 1500;

/** Blocked on a prompt right now (the live session-status store). */
export function taskWaitsOnPrompt(task: Task): boolean {
  const sid = resolveTaskSessionId(task);
  if (!sid) return false;
  const s = sessionStatusStore.getStatus(sid);
  return !!s?.pendingPermissionTool && (s.process_status === 'running' || s.process_status === 'idle');
}

/** Expand happened; wait for the child row to render, then show it. */
export function revealRow(taskId: string): void {
  const started = Date.now();
  const tick = () => {
    const row = document.querySelector<HTMLElement>(`.todo-panel [data-task-id="${CSS.escape(taskId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('phone-row-highlight');
      setTimeout(() => row.classList.remove('phone-row-highlight'), HIGHLIGHT_MS);
      return;
    }
    if (Date.now() - started < FIND_ROW_FOR_MS) requestAnimationFrame(tick);
    else log.warn('phone-home', 'need-you child row never rendered', { taskId });
  };
  requestAnimationFrame(tick);
}

export interface PhoneRowExtrasProps {
  task: Task;
  needsAction: boolean;
  childCount?: number;
  isExpanded?: boolean;
  onToggleExpand?: (taskId: string) => void;
}

export function PhoneRowExtras({ task, needsAction, childCount, isExpanded, onToggleExpand }: PhoneRowExtrasProps) {
  const phone = usePhoneLayout();
  const own = useSessionStatus(phone ? resolveTaskSessionId(task) : null);
  if (!phone) return null;
  const ownPrompt = !!own?.pendingPermissionTool && (own.process_status === 'running' || own.process_status === 'idle');
  const open = task.status !== 'done' && task.phase !== 'COMPLETE';
  return (
    <>
      {open && ownPrompt ? (
        <span className="phone-row-needs-you" data-kind="prompt">{phoneSessionLabel(own)}</span>
      ) : needsAction ? (
        <span className="phone-row-needs-you">Needs you</span>
      ) : null}
      {(childCount ?? 0) > 0 && !isExpanded && (
        <ParentNeedYouPill task={task} isExpanded={!!isExpanded} onToggleExpand={onToggleExpand} />
      )}
    </>
  );
}

/** Mounted only on collapsed parents, so only they follow every status change. */
function ParentNeedYouPill({ task, isExpanded, onToggleExpand }: { task: Task; isExpanded: boolean; onToggleExpand?: (taskId: string) => void }) {
  const tasksById = useHomeTasksById();
  useSessionStatusEpoch(); // re-read the prompt state of the subtasks
  const waiting = descendantsNeedingYou(task, tasksById, { isWaiting: taskWaitsOnPrompt });
  const first = waiting[0]?.id;
  const onTap = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!first) return;
    if (!isExpanded) onToggleExpand?.(task.id);
    revealRow(first);
  }, [first, isExpanded, onToggleExpand, task.id]);
  if (waiting.length === 0) return null;
  return (
    <button
      type="button"
      className="phone-row-need-you-parent"
      onClick={onTap}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`${needYouLabel(waiting.length)}: show the first one`}
    >
      {needYouLabel(waiting.length)}
    </button>
  );
}
