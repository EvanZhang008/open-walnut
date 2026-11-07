/**
 * One project on a VP card of the org chart (OrgChartSheet.tsx). Closed, it is its name alone
 * (2026-11-06, the user: "just show the name", "and can expand for more detail"); opened, its
 * counts, what needs the user, its news, the tasks in it with where each stands (the user's
 * status, in the task's own words), and the way to move it under another VP. A task opens
 * beside the Org page. Every VP card lists its projects, its own included, so the user always
 * sees which projects a VP leads. Each row remembers whether it was open (usePageViewOf).
 */
import { useState, type DragEvent } from 'react';
import type { Task } from '@open-walnut/core';
import { teamNews, type OrgTaskNode, type TeamNewsItem, type TeamNewsTask } from '@open-walnut/org-tree';
import { USER_STATE_LABELS, shownState, stateCountLabel } from '@open-walnut/user-status';
import type { VpProject } from './org-chart-model';
import { useChartOpen } from './OrgChartVp';

/** Tasks shown before "Show all". */
export const PROJECT_TASKS_SHOWN = 10;

export interface ProjectTaskLine {
  id: string;
  title: string;
  state: TeamNewsItem['state'];
  words: string;
  /** 0 = a team of the project; 1 = a worker under one. */
  depth: number;
}

/** The project's open tasks, what needs the user first, then the newest; workers under their team. */
export function projectTasks(project: VpProject, byId: ReadonlyMap<string, Task>): ProjectTaskLine[] {
  const line = (n: OrgTaskNode): TeamNewsTask => (byId.get(n.id) as TeamNewsTask | undefined)
    ?? { id: n.id, title: n.title, phase: n.phase };
  const out: ProjectTaskLine[] = [];
  const add = (nodes: readonly OrgTaskNode[], depth: number) => {
    const known = new Map(nodes.map((n) => [n.id, n] as const));
    for (const item of teamNews(nodes.map(line))) {
      // A task with only something to read is drawn and named under Needs you (shownState, 2026-11-03).
      out.push({ id: item.taskId, title: item.title, state: shownState(item.state), words: item.words, depth: Math.min(depth, 1) });
      const node = known.get(item.taskId);
      if (node?.workers.length) add(node.workers, depth + 1);
    }
  };
  add(project.row.node?.teams ?? [], 0);
  return out;
}

const needsTitle = (n: number) => stateCountLabel('needs', n);

interface Props {
  project: VpProject;
  tasks: ReadonlyMap<string, Task>;
  dragging: boolean;
  onDragStart: (e: DragEvent, p: VpProject) => void;
  onDragEnd: () => void;
  onOpenTask: (taskId: string) => void;
  /** Open the menu that moves it under another VP, when it can move (at the control, or where the pointer is). */
  onMove?: (from: HTMLElement, point?: { x: number; y: number }) => void;
}

export function OrgChartProject({ project: p, tasks, dragging, onDragStart, onDragEnd, onOpenTask, onMove }: Props) {
  const [open, toggle] = useChartOpen(p.key);
  const [all, setAll] = useState(false);
  const lines = open ? projectTasks(p, tasks) : [];
  const shown = all ? lines : lines.slice(0, PROJECT_TASKS_SHOWN);
  const detailId = `oc-tasks-${p.key}`;
  const counts = [p.line, p.needsYou > 0 ? needsTitle(p.needsYou) : ''].filter(Boolean).join(' · ');
  return (
    <li
      className={`oc-project${dragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`}
      data-testid="org-chart-project"
      data-key={p.key}
      data-project={p.project}
      draggable={!!p.project}
      onDragStart={(e) => onDragStart(e, p)}
      onDragEnd={onDragEnd}
      // The move menu is a right-click away too, with no control drawn for it.
      onContextMenu={onMove ? (e) => { e.preventDefault(); e.stopPropagation(); onMove(e.currentTarget, { x: e.clientX, y: e.clientY }); } : undefined}
    >
      {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
      <div
        className="oc-project-btn"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailId}
        data-testid="org-chart-project-toggle"
        title={open ? `Hide the detail of ${p.name}` : `Show what is in ${p.name}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        }}
      >
        <span className="oc-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="oc-project-name">{p.name}</span>
      </div>
      {open && (
        <div className="oc-project-detail" id={detailId}>
          <p className={`oc-detail-line${p.needsYou > 0 ? ' is-alert' : ' is-muted'}`} data-testid="org-chart-project-line">{counts}</p>
          {p.news && <p className="oc-detail-news" data-testid="org-chart-project-news">{p.news}</p>}
          <ul className="oc-tasks" data-testid="org-chart-tasks">
            {shown.length === 0 && <li className="oc-task-empty">Nothing open</li>}
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={`oc-task${t.depth ? ' is-worker' : ''}`}
                  data-testid="org-chart-task"
                  data-task-id={t.id}
                  data-state={t.state}
                  title={[t.title, `${USER_STATE_LABELS[t.state]}${t.words ? `: ${t.words}` : ''}`].join('\n')}
                  onClick={() => onOpenTask(t.id)}
                >
                  <span className={`oc-task-dot is-${t.state}`} aria-hidden="true" />
                  <span className="oc-task-text">
                    <span className="oc-task-title">{t.title}</span>
                    <span className="oc-task-state">{USER_STATE_LABELS[t.state]}{t.words ? ` · ${t.words}` : ''}</span>
                  </span>
                </button>
              </li>
            ))}
            {!all && lines.length > PROJECT_TASKS_SHOWN && (
              <li>
                <button type="button" className="oc-task-more" data-testid="org-chart-tasks-more" onClick={() => setAll(true)}>
                  Show all {lines.length}
                </button>
              </li>
            )}
          </ul>
          {onMove && (
            <div className="oc-detail-actions">
              <button type="button" className="oc-detail-btn" data-testid="org-chart-project-menu" onClick={(e) => onMove(e.currentTarget)}>
                Move to another VP…
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
