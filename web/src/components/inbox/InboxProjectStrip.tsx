/**
 * The Inbox's per-project status strip (2026-10-29, the user: in the Inbox, "where I
 * take action, I can also see whether each project still has tasks pending"). One
 * compact line per project with open work: how many need the user, are working, and
 * are waiting or snoozed, read from the same one user status every surface uses.
 * A click opens the project's line to its tasks that need the user (and, with none,
 * its working ones); a task opens where the panel locates it.
 */
import { useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import * as ICONS from '../common/Icons';
import { isHiddenFromTaskLists } from '@open-walnut/org-tree';
import { projectRuns, sortSectionTasks, stateSectionOf } from '../tasks/status-sections';
import '@/styles/status-sections.css';

/** Lines before "N more projects": the ones that need the user sort first. */
const STRIP_LINES = 6;

interface ProjectLine { project: string; needs: Task[]; working: Task[]; waiting: number }

export function projectLines(tasks: readonly Task[]): ProjectLine[] {
  const now = Date.now();
  const snoozed = (t: Task) => !!t.start_date && new Date(t.start_date).getTime() > now;
  const open = tasks.filter((t) => t.status !== 'done' && t.phase !== 'COMPLETE' && !isHiddenFromTaskLists(t));
  const lines = projectRuns(sortSectionTasks('needs', open)).map(({ project, tasks: rows }) => {
    const line: ProjectLine = { project, needs: [], working: [], waiting: 0 };
    for (const t of rows) {
      const s = stateSectionOf(t, snoozed);
      if (s === 'needs') line.needs.push(t);
      else if (s === 'working') line.working.push(t);
      else if (s === 'waiting') line.waiting += 1;
    }
    return line;
  });
  return lines.sort((a, b) => b.needs.length - a.needs.length || b.working.length - a.working.length || a.project.localeCompare(b.project));
}

export function InboxProjectStrip() {
  const store = useTasksContextSafe();
  const lines = useMemo(() => projectLines(store?.tasks ?? []), [store?.tasks]);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (!store || lines.length === 0) return null;
  const pending = lines.reduce((n, l) => n + l.needs.length, 0);
  return (
    <section className="inbox-project-strip" aria-label="Projects" data-testid="inbox-project-strip">
      <div className="inbox-project-strip-head">
        <span>Projects</span>
        <span className="inbox-project-strip-sum">{pending} {pending === 1 ? 'needs' : 'need'} you</span>
      </div>
      {(all ? lines : lines.slice(0, STRIP_LINES)).map((l) => {
        const isOpen = openProject === l.project;
        const rows = l.needs.length ? l.needs : l.working;
        const title = `${l.needs.length} need you, ${l.working.length} working, ${l.waiting} waiting or snoozed`;
        return (
          <div key={l.project} className={`inbox-project-line${l.needs.length ? ' has-needs' : ''}`}>
            <button type="button" className="inbox-project-line-btn" aria-expanded={isOpen} title={title}
              data-testid="inbox-project-line" data-project={l.project}
              onClick={() => setOpenProject(isOpen ? null : l.project)}>
              <span className="inbox-project-name">{l.project || 'Inbox'}</span>
              <span className="project-status-counts">
                {l.needs.length > 0 && <span className="project-status-count project-status-count-needs"><span className="project-status-count-icon" aria-hidden="true">{ICONS.ICON_ATTENTION}</span>{l.needs.length}</span>}
                {l.working.length > 0 && <span className="project-status-count"><span className="project-status-count-icon" aria-hidden="true">{ICONS.ICON_PHASE_IN_PROGRESS}</span>{l.working.length}</span>}
                {l.waiting > 0 && <span className="project-status-count"><span className="project-status-count-icon" aria-hidden="true">{ICONS.ICON_PHASE_WAITING}</span>{l.waiting}</span>}
              </span>
            </button>
            {isOpen && (
              <ul className="inbox-project-tasks">
                {rows.slice(0, 8).map((t) => (
                  <li key={t.id}>
                    <button type="button" className="inbox-project-task" title={t.title}
                      onClick={() => window.dispatchEvent(new CustomEvent('main:locate-task', { detail: { taskId: t.id, openSession: true } }))}>
                      {l.needs.length > 0 && <span className="task-unread-dot task-attention-dot" aria-hidden="true" />}
                      <span className="inbox-project-task-title">{t.title}</span>
                    </button>
                  </li>
                ))}
                {rows.length > 8 && <li className="inbox-project-more">{rows.length - 8} more</li>}
              </ul>
            )}
          </div>
        );
      })}
      {lines.length > STRIP_LINES && (
        <button type="button" className="inbox-project-more-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `${lines.length - STRIP_LINES} more projects`}
        </button>
      )}
    </section>
  );
}
