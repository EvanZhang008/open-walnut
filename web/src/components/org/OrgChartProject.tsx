/**
 * One project on a VP card of the org chart (OrgChartSheet.tsx). Closed, its name and how many
 * it has open; opened, every task in it as a tree (workers under their team), each row its
 * title and its status as an icon in the row (2026-11-08, the user: "just list all the tasks",
 * each task with its status, and the hierarchy is the point; the chart is a glance, not a place
 * to decide, so no counts, asks or status words in it). A task opens on Home (useOpenTask). The
 * move under another VP is a drag or a right-click on the row. Every VP card lists its
 * projects, its own included. Each row remembers whether it was open (usePageViewOf).
 */
import { useRef, type DragEvent, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { teamNews, type OrgTaskNode, type TeamNewsItem, type TeamNewsTask } from '@open-walnut/org-tree';
import { stateWord } from '@open-walnut/user-status';
import * as ICONS from '../common/Icons';
import type { VpProject } from './org-chart-model';
import { useOpenTask } from '@/hooks/useOpenTask';
import { domId, useChartOpen } from './OrgChartVp';

export interface ProjectTaskLine {
  id: string;
  title: string;
  state: TeamNewsItem['state'];
  words: string;
  /** 0 = a team of the project; 1 = a worker under one; 2 = a worker's own worker, ... */
  depth: number;
  /** A waiting task the user snoozed (its icon is the moon, not the hourglass). */
  snoozed: boolean;
}

/** The project's open tasks, what needs the user first, then the newest; workers under their team, at every depth. */
export function projectTasks(project: VpProject, byId: ReadonlyMap<string, Task>): ProjectTaskLine[] {
  const line = (n: OrgTaskNode): TeamNewsTask => (byId.get(n.id) as TeamNewsTask | undefined)
    ?? { id: n.id, title: n.title, phase: n.phase };
  const out: ProjectTaskLine[] = [];
  const add = (nodes: readonly OrgTaskNode[], depth: number) => {
    const known = new Map(nodes.map((n) => [n.id, n] as const));
    for (const item of teamNews(nodes.map(line))) {
      // A task with only something to read sorts with Needs you (teamNews) and wears the task
      // list's page icon there, as its row does under Needs you (sectionRowIcon).
      const snoozed = !!byId.get(item.taskId)?.user_status?.snoozed;
      out.push({ id: item.taskId, title: item.title, state: item.state, words: item.words, depth, snoozed });
      const node = known.get(item.taskId);
      if (node?.workers.length) add(node.workers, depth + 1);
    }
  };
  add(project.row.node?.teams ?? [], 0);
  return out;
}

/** The icon a task's status wears in its row: the same ones the task list's sections wear. */
export function stateIcon(t: Pick<ProjectTaskLine, 'state' | 'snoozed'>): ReactNode {
  switch (t.state) {
    case 'needs': return ICONS.ICON_ATTENTION;
    case 'read': return ICONS.ICON_TO_READ;
    case 'working': return ICONS.ICON_PHASE_IN_PROGRESS;
    case 'waiting': return t.snoozed ? ICONS.ICON_SNOOZE : ICONS.ICON_PHASE_WAITING;
    case 'done': return ICONS.ICON_PHASE_COMPLETE;
  }
}

/** One task's state in a word: "Snoozed" or "Waiting", not the tab's "Waiting / snoozed". */
const stateName = (t: ProjectTaskLine) => stateWord(t.state, t.snoozed);

interface Props {
  project: VpProject;
  tasks: ReadonlyMap<string, Task>;
  dragging: boolean;
  onDragStart: (e: DragEvent, p: VpProject) => void;
  onDragEnd: () => void;
  /** Close the chart: a task clicked here opens on Home, which the sheet would cover. */
  onLeave: () => void;
  /** Open the menu that moves it under another VP, when it can move (at the control, or where the pointer is). */
  onMove?: (from: HTMLElement, point?: { x: number; y: number }) => void;
}

export function OrgChartProject({ project: p, tasks, dragging, onDragStart, onDragEnd, onLeave, onMove }: Props) {
  const openTask = useOpenTask();
  const [open, toggle] = useChartOpen(p.key);
  const lines = open ? projectTasks(p, tasks) : [];
  const detailId = domId('oc-tasks', p.key);
  // A press on one of its tasks is the task's: moving the pointer a little drags no project.
  const onTask = useRef(false);
  return (
    <li
      className={`oc-project${dragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`}
      data-testid="org-chart-project"
      data-key={p.key}
      data-project={p.project}
      draggable={!!p.project}
      // mousedown too: WebKit sends no pointerdown for the first press after a drag.
      onPointerDownCapture={(e) => { onTask.current = !!(e.target as Element).closest('.oc-tasks'); }}
      onMouseDownCapture={(e) => { onTask.current = !!(e.target as Element).closest('.oc-tasks'); }}
      onDragStart={(e) => { if (onTask.current) { e.preventDefault(); return; } onDragStart(e, p); }}
      onDragEnd={onDragEnd}
      // The move menu is a right-click away, with no control drawn for it.
      onContextMenu={onMove ? (e) => {
        // On one of its tasks, the right-click is the task's (the browser's own menu), not the move.
        if ((e.target as Element).closest('.oc-tasks')) return;
        e.preventDefault(); e.stopPropagation(); onMove(e.currentTarget, { x: e.clientX, y: e.clientY });
      } : undefined}
    >
      {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
      <div
        className="oc-project-btn"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailId}
        data-testid="org-chart-project-toggle"
        title={open ? `Hide the tasks of ${p.name}` : `Show the tasks of ${p.name}`}
        onClick={toggle}
        {...(onMove ? { 'aria-keyshortcuts': 'Shift+F10' } : {})}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
          // The move menu from the keyboard, as the right-click opens it (no control is drawn for it).
          else if (onMove && ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) {
            e.preventDefault(); e.stopPropagation(); onMove(e.currentTarget);
          }
        }}
      >
        <span className="oc-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="oc-project-name">{p.name}</span>
        {/* How many it has (none: nothing said); opened, its tasks are there to see instead. */}
        {!open && p.row.counts.open > 0 && <span className="oc-now" data-testid="org-chart-project-now">{p.row.counts.open} open</span>}
      </div>
      {open && (
        <ul className="oc-tasks" id={detailId} data-testid="org-chart-tasks">
          {lines.length === 0 && <li className="oc-task-empty">Nothing open</li>}
          {lines.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="oc-task"
                // Each level 14px further in, until the title would have under half the row.
                style={t.depth ? { paddingLeft: `min(${4 + 14 * t.depth}px, 50%)` } : undefined}
                data-testid="org-chart-task"
                data-task-id={t.id}
                data-state={t.state}
                data-depth={t.depth}
                // The status is the icon; its words are a hover away.
                title={[t.title, `${stateName(t)}${t.words ? `: ${t.words}` : ''}`].join('\n')}
                onClick={() => { onLeave(); openTask(t.id); }}
              >
                <span className={`oc-task-icon is-${t.state}${t.snoozed ? ' is-snoozed' : ''}`} role="img" aria-label={stateName(t)} data-testid="org-chart-task-icon">{stateIcon(t)}</span>
                <span className="oc-task-title">{t.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
