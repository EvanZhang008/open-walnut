/**
 * The ✦ search's result rows — ONE component, both surfaces.
 *
 * The list renders in the AI card above the task search AND inside the adopted
 * search session's transcript (SearchAnswerCard): the same answer must look the
 * same in both places, and a second copy of this markup would drift the moment
 * one of them gets a tweak.
 *
 * One line per result, the same shape as a board row (circle, title that
 * ellipsizes, muted project on the right; COMPLETE struck through, NEED_ACTION
 * tinted). The model's evidence phrase lives in the hover title — it was a second
 * and third line before, and a five-row list pushed the board below the fold
 * (user, 2026-09-05).
 *
 * All model-derived strings render as React text children (auto-escaped) — no
 * markdown, no dangerouslySetInnerHTML, no injection surface.
 */

import { binaryPhaseIcon } from '@/components/common/Icons';
import { PHASE_LABELS } from '@/utils/session-status';
import type { TaskPhase } from '@/types/session';

export interface SearchResultRowView {
  taskId: string;
  /** Live title from the task table. Absent while it is still being resolved. */
  title?: string;
  phase?: string;
  project?: string;
  evidence?: string;
  /** The id resolves to no task any more (deleted): shown, never clickable. */
  missing?: boolean;
}

/** Same circle colours as the board rows (utils/session-status taskCircleClass),
 *  from the phase alone — an agent result is not a Task, and IN_PROGRESS /
 *  NEED_ACTION already imply a session exists. */
function circleClassForPhase(phase: string | undefined): string {
  if (phase === 'COMPLETE') return 'task-circle-done';
  if (phase === 'IN_PROGRESS' || phase === 'NEED_ACTION') return 'task-circle-session';
  return 'task-circle-todo';
}

function rowTooltip(row: SearchResultRowView): string {
  const where = [row.phase ? (PHASE_LABELS[row.phase as TaskPhase] ?? row.phase) : '', row.project || 'Inbox']
    .filter(Boolean).join(' · ');
  return [row.title ?? row.taskId, row.evidence ? `“${row.evidence}”` : '', where].filter(Boolean).join('\n');
}

export function AgentSearchResultRows({ rows, onOpenTask, className }: {
  rows: readonly SearchResultRowView[];
  onOpenTask: (taskId: string) => void;
  /** Extra class on the <ul>, so a surface can scope its own spacing. */
  className?: string;
}) {
  return (
    <ul className={`agent-search-results${className ? ` ${className}` : ''}`}>
      {rows.map((row) => {
        const isDone = row.phase === 'COMPLETE';
        // An unresolvable id is still worth showing: it is what the search
        // answered, and "the task is gone" is information. It just cannot be a
        // button, because there is nothing to open.
        if (row.missing) {
          return (
            <li key={row.taskId}>
              <span
                className="agent-search-row is-missing"
                data-task-id={row.taskId}
                title={row.evidence ? `${row.taskId}\n“${row.evidence}”` : row.taskId}
              >
                {/* An empty circle slot, not a missing one: without it this row's
                    title sits 18px left of every other row's and the list reads
                    as two lists. */}
                <span className="task-phase-icon-btn agent-search-row-circle agent-search-row-circle-empty" aria-hidden="true" />
                <span className="agent-search-row-title">{row.taskId}</span>
                <span className="agent-search-row-project">no longer exists</span>
              </span>
            </li>
          );
        }
        return (
          <li key={row.taskId}>
            <button
              type="button"
              className={`agent-search-row${isDone ? ' is-done' : ''}${row.phase === 'NEED_ACTION' ? ' is-needs-action' : ''}`}
              data-task-id={row.taskId}
              title={rowTooltip(row)}
              onClick={() => onOpenTask(row.taskId)}
            >
              <span className={`task-phase-icon-btn agent-search-row-circle ${circleClassForPhase(row.phase)}`} aria-hidden="true">
                {binaryPhaseIcon(isDone)}
              </span>
              <span className="agent-search-row-title">{row.title ?? row.taskId}</span>
              <span className="agent-search-row-project">{row.project || 'Inbox'}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
