/**
 * One project on a VP card of the org chart (OrgChartSheet.tsx): its name and counts, and,
 * opened, the tasks in it with where each stands (the user's status, in the task's own words).
 * A task opens beside the Org page. Every VP card lists its projects, its own included, so the
 * user always sees which projects a VP leads.
 */
import { useState, type DragEvent, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { teamNews, type OrgTaskNode, type TeamNewsItem, type TeamNewsTask } from '@open-walnut/org-tree';
import { USER_STATE_LABELS, stateCountLabel } from '@open-walnut/user-status';
import type { VpProject } from './org-chart-model';

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
      out.push({ id: item.taskId, title: item.title, state: item.state, words: item.words, depth: Math.min(depth, 1) });
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
  /** The ⋯ move menu, when the project can move. */
  menu: ReactNode;
}

export function OrgChartProject({ project: p, tasks, dragging, onDragStart, onDragEnd, onOpenTask, menu }: Props) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const lines = open ? projectTasks(p, tasks) : [];
  const shown = all ? lines : lines.slice(0, PROJECT_TASKS_SHOWN);
  const listId = `oc-tasks-${p.key}`;
  return (
    <li
      className={`oc-project${dragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`}
      data-testid="org-chart-project"
      data-key={p.key}
      data-project={p.project}
      draggable={!!p.project}
      onDragStart={(e) => onDragStart(e, p)}
      onDragEnd={onDragEnd}
    >
      <div className="oc-project-row">
        {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
        <div
          className="oc-project-btn"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-controls={listId}
          data-testid="org-chart-project-toggle"
          title={open ? `Hide the tasks in ${p.name}` : `Show the tasks in ${p.name}`}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
          }}
        >
          <span className="oc-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="oc-project-name">{p.name}</span>
          <span className="oc-project-line" data-testid="org-chart-project-line" title={p.news ? `${p.news}\n${p.line}` : p.line}>{p.line}</span>
          {p.needsYou > 0 && <span className="oc-badge is-small" title={needsTitle(p.needsYou)}>{p.needsYou}</span>}
        </div>
        {menu}
      </div>
      {open && (
        <ul className="oc-tasks" id={listId} data-testid="org-chart-tasks">
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
      )}
    </li>
  );
}
