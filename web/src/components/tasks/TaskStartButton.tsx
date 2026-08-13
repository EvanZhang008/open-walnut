/**
 * TaskStartButton — the one-click task→session verb ("▶"), rendered just before
 * the kebab on EVERY task surface: the main list rows, the Recent cards, and the
 * pinned tier cards (Focus / Satellite / Backlog / Wait / customs).
 *
 * It lives in its own module because both hosts need it and they already import
 * one another in the other direction (TodoPanel → FocusSatelliteCards), so
 * re-exporting it from either would close an import cycle.
 *
 * Returns null (not a disabled button) when the task already owns a session or is
 * done: those rows have open-session affordances instead, and a second launch on
 * the same task is never what the click means.
 */

import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';

export function TaskStartButton({ task, isDone, onStartSession }: {
  task: Task;
  isDone: boolean;
  onStartSession?: (task: Task) => void;
}) {
  if (!onStartSession || isDone || resolveTaskSessionId(task)) return null;
  return (
    <button
      className="task-start-btn"
      // BOTH pointer handlers stop propagation: click alone still lets pointerdown
      // reach useSortable's activator, so launching a session also started dragging
      // the row (same trap the kebab's portal hit — see TaskKebabMenu). keydown too:
      // every host row binds Enter to "focus/open this task", which would otherwise
      // fire alongside the launch when the button is activated from the keyboard.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onStartSession(task); }}
      title="Start a session for this task"
      aria-label="Start a session for this task"
    >
      ▶
    </button>
  );
}
