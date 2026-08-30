import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, TaskPriority } from '@open-walnut/core';
import { useConfirm } from '@/hooks/useConfirm';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { createPortal } from 'react-dom';
import { DatePicker, isOverdue } from '../common/DatePicker';
import { ProjectSourceBadge } from './ProjectSourceBadge';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { TaskSessionPill } from './SessionPill';
import { SyncIndicator, type TaskListProjection } from './TaskCard';
import { TaskKebabMenu } from './TaskKebabMenu';
import { ProjectKebabMenu, ProjectPlusMenu } from './ProjectHeaderMenus';
import { openSessionOnHome, openDraftSessionOnHome } from '@/utils/open-session';
import { sortTasks, groupTasksByProject, type TpSort, type TpSortKey } from './tasks-page-sort';
import * as ICONS from '../common/Icons';
import '@/styles/walnut-agent.css';

interface TasksPageTableProps {
  tasks: Task[];
  /** null = All Tasks (renders the PROJECT column), '' = Inbox, else a project name. */
  activeProject: string | null;
  /** lowercased project name → provider source, for the PROJECT column badges. */
  sourceByName: Map<string, string>;
  onToggleComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: (title: string, project?: string) => void | Promise<void>;
  /** Inline cell edits (priority / due / project move) — TasksContext.update. */
  onUpdate: (id: string, updates: { priority?: string; due_date?: string | null; start_date?: string | null; project?: string }) => void;
  /** lowercased favorite project names — group-header kebab state. */
  favoriteByName: Set<string>;
  onToggleFavorite: (project: string) => void;
  /** A project menu rename/delete landed — host refreshes registry/selection. */
  onProjectChanged: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
  /** Column sort — null = server/manual order. Lifted so the toolbar can show it. */
  sort: TpSort | null;
  onSortChange: (sort: TpSort | null) => void;
  /** Group-by-project (All Tasks view only). */
  grouped: boolean;
  /** Collapsed project keys ('' = Inbox) — lifted for Collapse/Expand all. */
  collapsed: Set<string>;
  onToggleGroup: (project: string) => void;
  projectOrder: string[];
  onOpenTask?: (taskId: string) => void;
}

const PRIORITY_META: Record<string, { dot: string; labelCls: string; label: string }> = {
  immediate: { dot: 'p0', labelCls: ' lp0', label: 'P0 · urgent' },
  important: { dot: 'p1', labelCls: ' lp1', label: 'P1 · high' },
  backlog: { dot: 'p2', labelCls: '', label: 'P2 · normal' },
};

const PRIORITY_PICK: { value: TaskPriority; label: string; dot?: string }[] = [
  { value: 'immediate', label: 'P0 · urgent', dot: 'p0' },
  { value: 'important', label: 'P1 · high', dot: 'p1' },
  { value: 'backlog', label: 'P2 · normal', dot: 'p2' },
  { value: 'none', label: 'None' },
];

/** Inline priority cell — click opens a portalled picker (useMenuPlacement). */
function PriorityCell({ task, onUpdate }: { task: Task; onUpdate: TasksPageTableProps['onUpdate'] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { onAnchorLost: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);

  const pri = PRIORITY_META[task.priority];
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tp-cell-edit-btn"
        title="Set priority"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {pri ? (
          <span className={`tp-cell-pri${pri.labelCls}`}>
            <span className={`tp-p-dot ${pri.dot}`} />
            {pri.label}
          </span>
        ) : (
          <span className="tp-cell-empty">–</span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="tp-pri-popover"
          style={menuPlacementStyle(placement)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {PRIORITY_PICK.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`tp-pri-opt${task.priority === p.value ? ' active' : ''}`}
              onClick={() => { onUpdate(task.id, { priority: p.value }); setOpen(false); }}
            >
              {p.dot ? <span className={`tp-p-dot ${p.dot}`} /> : <span className="tp-p-dot none" />}
              {p.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Inline project cell — click opens a portalled project picker (move task). */
function ProjectCell({ task, sourceByName, onUpdate }: {
  task: Task;
  sourceByName: Map<string, string>;
  onUpdate: TasksPageTableProps['onUpdate'];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { projectNames } = useProjectRegistry();
  const placement = useMenuPlacement(open, btnRef, menuRef, { minHeight: 160, onAnchorLost: () => setOpen(false) });
  const project = task.project || '';

  useEffect(() => {
    if (!open) return;
    setFilter('');
    const close = (e: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);

  // The task's own project may be missing from the registry (race, legacy
  // data) — include it so the list always shows the true current value.
  const options = project && !projectNames.includes(project)
    ? [...projectNames, project].sort((a, b) => a.localeCompare(b))
    : projectNames;
  const q = filter.trim().toLowerCase();
  const shown = q ? options.filter((n) => n.toLowerCase().includes(q)) : options;

  const pick = (name: string) => {
    if (name !== project) onUpdate(task.id, { project: name });
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tp-cell-edit-btn"
        title="Move to project"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="tp-proj-pill">
          {project ? '📁' : '📥'}
          <span className="tp-proj-name">{project || 'Inbox'}</span>
          <ProjectSourceBadge source={project ? sourceByName.get(project.toLowerCase()) : undefined} />
        </span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="tp-proj-popover"
          style={menuPlacementStyle(placement)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {options.length > 6 && (
            <input
              className="tp-proj-filter"
              placeholder="Filter projects…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
          )}
          {(!q || 'inbox'.includes(q)) && (
            <button type="button" className={`tp-pri-opt${project === '' ? ' active' : ''}`} onClick={() => pick('')}>
              📥 Inbox
            </button>
          )}
          {shown.map((name) => (
            <button
              key={name}
              type="button"
              className={`tp-pri-opt${project === name ? ' active' : ''}`}
              onClick={() => pick(name)}
            >
              📁 {name}
            </button>
          ))}
          {q && shown.length === 0 && <div className="tp-proj-empty">No matching project</div>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Column header cell — click cycles asc → desc → off. */
function Th({ label, k, sort, onSortChange }: {
  label: string;
  k: TpSortKey;
  sort: TpSort | null;
  onSortChange: (s: TpSort | null) => void;
}) {
  const active = sort?.key === k;
  const arrow = !active ? '' : sort!.dir === 'asc' ? '▲' : '▼';
  const cycle = () => {
    if (!active) onSortChange({ key: k, dir: 'asc' });
    else if (sort!.dir === 'asc') onSortChange({ key: k, dir: 'desc' });
    else onSortChange(null);
  };
  return (
    <button type="button" className={`tp-th${active ? ' on' : ''}`} onClick={cycle} title={`Sort by ${label}`}>
      {label}
      {arrow && <span className="tp-th-arrow">{arrow}</span>}
    </button>
  );
}

/** Dense Asana-style task table: sticky sortable header, inline-editable cells,
 *  optional project grouping with per-group ghost add rows. */
export function TasksPageTable({
  tasks,
  activeProject,
  sourceByName,
  onToggleComplete,
  onDelete,
  onCreate,
  onUpdate,
  favoriteByName,
  onToggleFavorite,
  onProjectChanged,
  sort,
  onSortChange,
  grouped,
  collapsed,
  onToggleGroup,
  projectOrder,
  onOpenTask,
}: TasksPageTableProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const openTask = useCallback((taskId: string) => {
    if (onOpenTask) onOpenTask(taskId);
    else navigate(`/tasks/${taskId}`);
  }, [navigate, onOpenTask]);
  const isAll = activeProject === null;
  const showGroups = isAll && grouped;
  const cols = isAll ? 'tp-cols-5' : 'tp-cols-4';

  // ── ghost add-row state (keyed by group so only one ghost is editing) ──
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingIn !== null) inputRef.current?.focus();
  }, [addingIn]);

  const handleGhostKey = (e: KeyboardEvent<HTMLInputElement>, project: string | undefined) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setAddingIn(null);
      setDraft('');
    } else if (e.key === 'Enter') {
      const title = draft.trim();
      if (!title) return;
      setDraft('');
      void onCreate(title, project);
      inputRef.current?.focus(); // re-arm for rapid entry
    }
  };

  const confirmDelete = useCallback(async (task: Task) => {
    if (await confirm({ title: `Delete task “${task.title}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
      onDelete(task.id);
    }
  }, [confirm, onDelete]);

  const handleDelete = useCallback((e: MouseEvent, task: Task) => {
    e.stopPropagation();
    void confirmDelete(task);
  }, [confirmDelete]);

  const openSession = useCallback((sessionId: string) => {
    openSessionOnHome(sessionId, navigate);
  }, [navigate]);

  // Group-header "+" — sessions live ONLY on the home columns, so /tasks can't open
  // one in place. Same bridge the session pills use one line up: dispatch, then
  // navigate home where MainPage (always mounted) has already grown the draft.
  const openDraftForProject = useCallback((project: string) => {
    openDraftSessionOnHome(project, navigate);
  }, [navigate]);

  const sorted = useMemo(() => sortTasks(tasks, sort), [tasks, sort]);
  const groups = useMemo(
    () => (showGroups ? groupTasksByProject(sorted, projectOrder) : null),
    [showGroups, sorted, projectOrder],
  );

  const ghostRow = (project: string | undefined, keySuffix: string) => {
    const scopeLabel = project === undefined
      ? (isAll || activeProject === '' ? 'Inbox' : activeProject)
      : (project || 'Inbox');
    const ghostKey = `ghost:${keySuffix}`;
    const editing = addingIn === ghostKey;
    return (
      <div
        key={ghostKey}
        className={`tp-ghost ${cols}${editing ? ' editing' : ''}`}
        data-testid="tasks-ghost-row"
        onClick={() => { if (!editing) { setAddingIn(ghostKey); setDraft(''); } }}
      >
        <span className="tp-cell-title">
          <span className="tp-gplus">＋</span>
          {editing ? (
            <input
              ref={inputRef}
              className="tp-ghost-input"
              placeholder="Task title — Enter to create"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => handleGhostKey(e, project)}
              onBlur={() => { if (!draft.trim()) { setAddingIn(null); setDraft(''); } }}
            />
          ) : (
            <span className="tp-ghost-text">New task… ({scopeLabel})</span>
          )}
        </span>
      </div>
    );
  };

  const row = (t: Task) => {
    return (
      <div key={t.id} className={`tp-row ${cols}${t.status === 'done' ? ' done' : ''}`} data-task-id={t.id}>
        <span className="tp-cell-title">
          <button
            type="button"
            className="tp-status-circle"
            title={t.status === 'done' ? 'Mark as todo' : 'Mark as done'}
            onClick={() => onToggleComplete(t.id)}
          >
            {t.status === 'done' ? '✓' : ''}
          </button>
          <button
            type="button"
            className={`tp-row-title${t.walnut_agent ? ' walnut-task-title' : ''}`}
            onClick={() => openTask(t.id)}
          >
            {t.title}
          </button>
          <SyncIndicator task={t as TaskListProjection} />
          {/* hover quick actions — delete / kebab. Session opens via its pill. */}
          <span className="tp-row-acts">
            <button
              type="button"
              className="tp-act-btn tp-act-del"
              title="Delete task"
              onClick={(e) => void handleDelete(e, t)}
            >
              {ICONS.ICON_TRASH}
            </button>
            {/* Shared task menu — the ⋮ button AND the row's right-click (it
                self-attaches to the [data-task-id] ancestor, replacing the
                browser context menu — same one-menu-two-paths pattern as the
                home panel rows). Only HEAD-stable props are passed. */}
            <TaskKebabMenu
              task={t}
              isFocused={false}
              isPinned={false}
              isDone={t.status === 'done'}
              onExpandDetail={(task) => openTask(task.id)}
              onSetPriority={(id, p) => onUpdate(id, { priority: p })}
              onOpenSession={openSession}
              onSetDate={(id, d) => onUpdate(id, { due_date: d ?? '' })}
              // `?? ''` is the clear convention the store understands (task-manager
              // does `updates.start_date || undefined`); forwarding the picker's raw
              // null stored a null instead of deleting the field, and diverged from
              // MainPage's handleSetStartDate + this menu's own due-date handler.
              onSetStartDate={(id, d) => onUpdate(id, { start_date: d ?? '' })}
              onDelete={() => void confirmDelete(t)}
            />
          </span>
        </span>
        <span><PriorityCell task={t} onUpdate={onUpdate} /></span>
        <span className={`tp-cell-due${isOverdue(t.due_date) && t.status !== 'done' ? ' overdue' : ''}`}>
          {/* DatePicker popover handles flip/clamp; trigger inherits cell style */}
          <span className="tp-due-picker" onClick={(e) => e.stopPropagation()}>
            <DatePicker
              date={t.due_date}
              onChange={(d) => onUpdate(t.id, { due_date: d ?? '' })}
              ghostWhenEmpty
            />
          </span>
        </span>
        <span className="tp-cell-session">
          {/* Shared pill — same status text/classes as every other surface
              (specs assert .task-session-pill contains Running/Idle here).
              Clickable: one click opens the session on the home columns. */}
          <TaskSessionPill task={t} onOpenSession={openSession} />
        </span>
        {isAll && (
          <span><ProjectCell task={t} sourceByName={sourceByName} onUpdate={onUpdate} /></span>
        )}
      </div>
    );
  };

  let body: ReactNode;
  if (groups) {
    body = groups.map(({ project, tasks: groupTasks }) => {
      const isCollapsed = collapsed.has(project);
      return (
        <Fragment key={`grp:${project || '·inbox·'}`}>
          <div
            className={`tp-group-header${isCollapsed ? ' closed' : ''}`}
            data-testid="tasks-group-header"
            data-project={project}
            data-group-project={project}
            onClick={() => onToggleGroup(project)}
          >
            <span className="tp-group-chevron">▾</span>
            <span className="tp-group-icon">{project ? '📁' : '📥'}</span>
            <span className="tp-group-name">{project || 'Inbox'}</span>
            {project && <ProjectSourceBadge source={sourceByName.get(project.toLowerCase())} />}
            <span className="tp-group-count">{groupTasks.length}</span>
            {/* One-click "+" → a draft session in this project, the same control (and
                the same aria-label) as the home panel's project header. Named
                projects only, for the same reason as the kebab below: the launch
                seeds the project's default folder and Inbox has no registry row.
                Wrapped so the hover-reveal CSS can address it alongside the kebab. */}
            {project && (
              <span className="tp-group-plus-wrap">
                <ProjectPlusMenu project={project} onAddSession={openDraftForProject} />
              </span>
            )}
            {/* Same project menu as the rail (⋮ + right-click). Inbox has no
                registry row to rename/delete, so named projects only. */}
            {project && (
              <ProjectKebabMenu
                project={project}
                isFavorite={favoriteByName.has(project.toLowerCase())}
                onToggleFavorite={onToggleFavorite}
                onChanged={onProjectChanged}
                rowSelector="[data-group-project]"
                wrapClassName="tp-group-kebab-wrap"
                btnClassName="tp-rail-kebab-btn"
              />
            )}
          </div>
          {!isCollapsed && groupTasks.map(row)}
          {!isCollapsed && ghostRow(project, project || '·inbox·')}
        </Fragment>
      );
    });
    if (groups.length === 0) {
      body = <div className="tp-empty">Nothing here — use "＋ Task" to create one.</div>;
    }
  } else {
    body = (
      <>
        {ghostRow(undefined, 'top')}
        {sorted.length === 0
          ? <div className="tp-empty">Nothing here — use the "＋ New task…" row above or "＋ Task".</div>
          : sorted.map(row)}
      </>
    );
  }

  return (
    <div className="tp-table-scroll" data-testid="tasks-table">
      <div className={`tp-thead ${cols}`}>
        <Th label="Title" k="title" sort={sort} onSortChange={onSortChange} />
        <Th label="Priority" k="priority" sort={sort} onSortChange={onSortChange} />
        <Th label="Due" k="due" sort={sort} onSortChange={onSortChange} />
        <Th label="Session" k="session" sort={sort} onSortChange={onSortChange} />
        {isAll && <Th label="Project" k="project" sort={sort} onSortChange={onSortChange} />}
      </div>
      {body}
    </div>
  );
}
