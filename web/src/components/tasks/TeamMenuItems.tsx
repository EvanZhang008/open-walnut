import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { CHEVRON_GLYPH } from '@/components/common/Icons';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { AdoptWorkerFlyout } from './AdoptWorkerFlyout';
import { ReleaseWorkerFlyout } from './ReleaseWorkerFlyout';
import { resolveParent } from './adopt-candidates';
import { subtasksOf } from './subtask-index';
import { teamRowSummary } from './team-menu-model';
import '@/styles/subtask-pill.css';

const NO_INDEX: ReadonlyMap<string, Task> = new Map();

const ICON_TEAM = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="6" cy="5.5" r="2.2" />
    <path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8" />
    <circle cx="11.5" cy="6.5" r="1.7" />
    <path d="M11 9.4c1.8 0 3 1.3 3 3.1" />
  </svg>
);

/**
 * The task kebab's Team row, collapsed by default (2026-10-05 user call: team
 * changes are rare, so they sit behind one row and expand on click, like the
 * date rows). The collapsed row says where the task stands in its team, in the
 * pills' own words; expanded it offers:
 *
 *   - "Adopt a worker…" on every task (a portalled picker, AdoptWorkerFlyout);
 *   - "Release a worker…" on a leader (ReleaseWorkerFlyout: one of its workers
 *     leaves the team and keeps running on its own);
 *   - "Leave leader “X”" on a worker.
 *
 * All three write through the store's `reparentTask`, so the Worker and Leader
 * pills follow at once. Rendered only inside a TasksProvider (a pop-out window
 * has none). A picker hangs off its own row and the menu stays open under it,
 * like the Project picker; the host menus' outside-click closers exempt
 * `.adopt-worker-flyout`, which the Release picker carries too.
 */
export function TeamMenuItems({ task, afterAction }: {
  task: Pick<Task, 'id' | 'title' | 'parent_task_id' | 'project'>;
  /** Close the host menu. */
  afterAction: () => void;
}) {
  const store = useTasksContextSafe();
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<'adopt' | 'release' | null>(null);
  const adoptRef = useRef<HTMLButtonElement>(null);
  const releaseRef = useRef<HTMLButtonElement>(null);
  const hasWorkers = store ? subtasksOf(store.tasks, task.id).length > 0 : false;
  // The last worker left (released elsewhere): forget the picker, or a later
  // adopt would bring the Release picker back by itself.
  useEffect(() => {
    if (!hasWorkers) setPicker((p) => (p === 'release' ? null : p));
  }, [hasWorkers]);
  if (!store) return null;
  const leader = task.parent_task_id ? resolveParent(store.tasks, NO_INDEX, task.parent_task_id) : null;
  const summary = teamRowSummary(store.tasks, task, leader?.title ?? null);
  const toggle = (which: 'adopt' | 'release') => setPicker((p) => (p === which ? null : which));
  return (
    <>
      <div className="task-kebab-divider" />
      <div className={`task-kebab-team${expanded ? ' open' : ''}`} data-testid="kebab-team">
        <button
          type="button"
          className="task-kebab-item task-kebab-team-toggle"
          data-testid="kebab-team-toggle"
          aria-expanded={expanded}
          title={summary ? `Team: ${summary}` : 'Team: adopt a worker'}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
            setPicker(null);
          }}
        >
          <span className="task-kebab-icon">{ICON_TEAM}</span>
          <span className="task-kebab-team-label">
            Team{summary ? <>: <b>{summary}</b></> : ''}
          </span>
          <span className={`task-kebab-team-caret${expanded ? ' open' : ''}`} aria-hidden="true">{CHEVRON_GLYPH}</span>
        </button>
        {expanded && (
          <div className="task-kebab-team-rows">
            <button
              ref={adoptRef}
              type="button"
              className={`task-kebab-item${picker === 'adopt' ? ' task-kebab-item-active' : ''}`}
              data-testid="kebab-adopt-worker"
              aria-haspopup="dialog"
              aria-expanded={picker === 'adopt'}
              onClick={(e) => { e.stopPropagation(); toggle('adopt'); }}
            >
              <span className="task-kebab-icon" aria-hidden="true">+</span>
              <span>Adopt a worker…</span>
            </button>
            {hasWorkers && (
              <button
                ref={releaseRef}
                type="button"
                className={`task-kebab-item${picker === 'release' ? ' task-kebab-item-active' : ''}`}
                data-testid="kebab-release-worker"
                aria-haspopup="dialog"
                aria-expanded={picker === 'release'}
                onClick={(e) => { e.stopPropagation(); toggle('release'); }}
              >
                <span className="task-kebab-icon" aria-hidden="true">−</span>
                <span>Release a worker…</span>
              </button>
            )}
            {task.parent_task_id && (
              <button
                type="button"
                className="task-kebab-item"
                data-testid="kebab-leave-leader"
                onClick={(e) => {
                  e.stopPropagation();
                  log.info('tasks', 'worker left its leader', { workerTaskId: task.id, leaderTaskId: leader?.id ?? task.parent_task_id ?? '' });
                  store.reparentTask(task.id, null);
                  afterAction();
                }}
              >
                <span className="task-kebab-icon" aria-hidden="true">↰</span>
                <span className="task-kebab-team-leave">Leave leader &ldquo;{leader?.title ?? 'its leader'}&rdquo;</span>
              </button>
            )}
          </div>
        )}
      </div>
      <AdoptWorkerFlyout
        open={expanded && picker === 'adopt'}
        anchorRef={adoptRef}
        leader={task}
        onClose={() => setPicker((p) => (p === 'adopt' ? null : p))}
        onPicked={afterAction}
      />
      <ReleaseWorkerFlyout
        open={expanded && picker === 'release'}
        anchorRef={releaseRef}
        leader={task}
        onClose={() => setPicker((p) => (p === 'release' ? null : p))}
        onPicked={afterAction}
      />
    </>
  );
}
