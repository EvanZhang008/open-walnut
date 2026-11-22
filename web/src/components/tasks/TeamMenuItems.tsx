import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { DisclosureChevron } from '@/components/controls';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { apiPost } from '@/api/client';
import { AdoptWorkerFlyout } from './AdoptWorkerFlyout';
import { ReleaseWorkerFlyout } from './ReleaseWorkerFlyout';
import { resolveParent } from './adopt-candidates';
import { subtasksOf } from './subtask-index';
import { directorEntry, teamRowSummary } from './team-menu-model';
import { useExperimental } from '@/hooks/useExperimental';
import { directorWrite, orgDisplayTitle } from '@open-walnut/org-tree';
import '@/styles/subtask-pill.css';
import { ICON_LEAVE, ICON_MINUS, ICON_PLUS, ICON_STAR_EMPTY, ICON_STAR_FILLED, ICON_STOP } from '@/components/common/Icons';

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
 *   - "Leave leader “X”" on a worker;
 *   - "Stop the team" on a leader: every open task under it stops (its sessions, triggers and
 *     wake clocks, core/sessions/team-stop.ts), and "Resume the team" turns those back on;
 *   - with the Directors on (`org_leaders`), on an open task in a project that is no org node:
 *     "Make it a Director" (Task.director 'yes': it shows under its VP on the Org page) or, on one
 *     that is a Director now (team-menu-model directorEntry), "Remove from Directors" ('no').
 *
 * All three write through the store's `reparentTask`, so the Worker and Leader
 * pills follow at once. Rendered only inside a TasksProvider (a pop-out window
 * has none). A picker hangs off its own row and the menu stays open under it,
 * like the Project picker; the host menus' outside-click closers exempt
 * `.adopt-worker-flyout`, which the Release picker carries too.
 */
export function TeamMenuItems({ task, afterAction }: {
  task: Pick<Task, 'id' | 'title' | 'parent_task_id' | 'project' | 'org_role'>;
  /** Close the host menu. */
  afterAction: () => void;
}) {
  const store = useTasksContextSafe();
  const directorsOn = useExperimental('org_leaders');
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
  const row = store.tasks.find((t) => t.id === task.id);
  // The store's row is the current word (a write made from this menu shows at once).
  const director = directorsOn && row ? directorEntry(store.tasks, row) : null;
  const summary = teamRowSummary(store.tasks, task, leader ? orgDisplayTitle(leader) : null, !!director?.isDirector);
  const teamStopped = !!row?.team_stop;
  const setDirector = (yes: boolean) => {
    log.info('tasks', yes ? 'made a director' : 'removed from directors', { taskId: task.id });
    void store.update(task.id, { director: directorWrite(yes, director?.open ?? 0) });
    afterAction();
  };
  const teamAction = (action: 'team-stop' | 'team-resume') => {
    log.info('tasks', action === 'team-stop' ? 'team stop requested' : 'team resume requested', { taskId: task.id });
    apiPost(`/api/v1/tasks/${encodeURIComponent(task.id)}/${action}`, {}, { timeoutMs: 120_000 })
      .then((out) => log.info('tasks', `${action} done`, { taskId: task.id, result: out as Record<string, unknown> }))
      .catch((err) => log.warn('tasks', `${action} failed`, { taskId: task.id, error: err instanceof Error ? err.message : String(err) }));
    afterAction();
  };
  const toggle = (which: 'adopt' | 'release') => setPicker((p) => (p === which ? null : which));
  return (
    <>
      {/* No rule above it: Team is one of the menu's collapsed groups, beside Move & transfer. */}
      <div className={`task-kebab-team${expanded ? ' open' : ''}`} data-testid="kebab-team">
        <button
          type="button"
          className="task-kebab-item task-kebab-team-toggle"
          data-testid="kebab-team-toggle"
          aria-expanded={expanded}
          data-choice-exempt="a menu row that opens its sub-rows in place, with the shared DisclosureChevron"
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
          <DisclosureChevron open={expanded} />
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
              <span className="task-kebab-icon" aria-hidden="true">{ICON_PLUS}</span>
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
                <span className="task-kebab-icon" aria-hidden="true">{ICON_MINUS}</span>
                <span>Release a worker…</span>
              </button>
            )}
            {hasWorkers && !teamStopped && (
              <button
                type="button"
                className="task-kebab-item"
                data-testid="kebab-team-stop"
                title="Stop this task and every open task under it: their sessions, triggers and wake clocks"
                onClick={(e) => { e.stopPropagation(); teamAction('team-stop'); }}
              >
                <span className="task-kebab-icon" aria-hidden="true">{ICON_STOP}</span>
                <span>Stop the team</span>
              </button>
            )}
            {teamStopped && (
              <button
                type="button"
                className="task-kebab-item"
                data-testid="kebab-team-resume"
                title="Turn back on the triggers and clocks the team stop paused; sessions resume on their next message"
                onClick={(e) => { e.stopPropagation(); teamAction('team-resume'); }}
              >
                <span className="task-kebab-icon" aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1.2v7.6L8.6 5z" /></svg>
                </span>
                <span>Resume the team</span>
              </button>
            )}
            {director && (
              <button
                type="button"
                className="task-kebab-item"
                data-testid={director.isDirector ? 'kebab-director-remove' : 'kebab-director-make'}
                title={director.isDirector
                  ? 'No longer listed under its VP on the Org page; its subtasks and chat stay as they are'
                  : 'Listed under its VP on the Org page, with or without subtasks'}
                onClick={(e) => { e.stopPropagation(); setDirector(!director.isDirector); }}
              >
                <span className="task-kebab-icon" aria-hidden="true">{director.isDirector ? ICON_STAR_EMPTY : ICON_STAR_FILLED}</span>
                <span>{director.isDirector ? 'Remove from Directors' : 'Make it a Director'}</span>
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
                <span className="task-kebab-icon" aria-hidden="true">{ICON_LEAVE}</span>
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
