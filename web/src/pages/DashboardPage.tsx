import { useState, useMemo, useCallback } from 'react';
import { useTasksContext } from '@/contexts/TasksContext';
import { useOrdering } from '@/hooks/useOrdering';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { createProject } from '@/api/projects';
import { TasksPageRail, type RailProjectItem } from '@/components/tasks/TasksPageRail';
import { TasksPageTable } from '@/components/tasks/TasksPageTable';
import { TaskForm, type TaskFormData } from '@/components/tasks/TaskForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { TpSort } from '@/components/tasks/tasks-page-sort';
import '@/styles/tasks-page.css';

const LS_SORT = 'walnut-tasks-page-sort';
const LS_GROUPED = 'walnut-tasks-page-grouped';
const LS_COLLAPSED = 'walnut-tasks-page-collapsed';

function readSort(): TpSort | null {
  try {
    const raw = localStorage.getItem(LS_SORT);
    if (!raw) return null;
    const v = JSON.parse(raw) as TpSort;
    if (v && typeof v.key === 'string' && (v.dir === 'asc' || v.dir === 'desc')) return v;
  } catch { /* ignore */ }
  return null;
}

function readGrouped(): boolean {
  try { return localStorage.getItem(LS_GROUPED) !== '0'; } catch { return true; }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

/** /tasks — dense two-pane workspace: project rail (left) + task table (right). */
export function DashboardPage() {
  const { tasks, loading, error, toggleComplete, create, deleteTask, update, star } = useTasksContext();
  const { projectOrder, reorderProjects } = useOrdering();
  const { projectNames, sourceByName, favoriteByName, refresh: refreshRegistry } = useProjectRegistry();

  // null = All Tasks, '' = Inbox, otherwise a project name.
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [showTodo, setShowTodo] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [filterP0, setFilterP0] = useState(false);
  const [filterP1, setFilterP1] = useState(false);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  // ── table view state (persisted) ──
  const [sort, setSort] = useState<TpSort | null>(readSort);
  const [grouped, setGrouped] = useState(readGrouped);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const handleSortChange = useCallback((s: TpSort | null) => {
    setSort(s);
    try {
      if (s) localStorage.setItem(LS_SORT, JSON.stringify(s));
      else localStorage.removeItem(LS_SORT);
    } catch { /* ignore */ }
  }, []);

  const handleGroupedToggle = useCallback(() => {
    setGrouped((v) => {
      try { localStorage.setItem(LS_GROUPED, v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }, []);

  const persistCollapsed = (next: Set<string>) => {
    try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next])); } catch { /* ignore */ }
  };

  const handleToggleGroup = useCallback((project: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      persistCollapsed(next);
      return next;
    });
  }, []);

  // ── rail data: registry projects (incl. zero-task ones) ∪ task-derived names,
  //    ordered projectOrder-first then alphabetical. Inbox is separate/last. ──
  const openCountByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === 'done') continue;
      const key = (t.project || '').toLowerCase();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [tasks]);

  const railProjects = useMemo<RailProjectItem[]>(() => {
    // Union registry names with task-derived ones (case-insensitive; registry
    // spelling is canonical when both exist).
    const byLower = new Map<string, string>();
    for (const name of projectNames) byLower.set(name.toLowerCase(), name);
    for (const t of tasks) {
      const p = t.project || '';
      if (p && !byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
    }
    const names = Array.from(byLower.values());
    const orderIndex = new Map(projectOrder.map((name, i) => [name.toLowerCase(), i]));
    names.sort((a, b) => {
      const ai = orderIndex.get(a.toLowerCase());
      const bi = orderIndex.get(b.toLowerCase());
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b);
    });
    return names.map((name) => ({
      name,
      source: sourceByName.get(name.toLowerCase()),
      favorite: favoriteByName.has(name.toLowerCase()),
      openCount: openCountByProject.get(name.toLowerCase()) ?? 0,
    }));
  }, [projectNames, tasks, projectOrder, sourceByName, favoriteByName, openCountByProject]);

  const allOpenCount = useMemo(
    () => tasks.filter((t) => t.status !== 'done').length,
    [tasks],
  );

  // All projects currently visible in the grouped table ('' excluded) — the
  // Collapse-all target set and the reorder baseline.
  const visibleProjectKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const t of tasks) keys.add(t.project || '');
    return keys;
  }, [tasks]);

  const allGroupsCollapsed = useMemo(
    () => [...visibleProjectKeys].every((k) => collapsed.has(k)),
    [visibleProjectKeys, collapsed],
  );

  const handleCollapseExpandAll = useCallback(() => {
    setCollapsed(() => {
      const next = allGroupsCollapsed ? new Set<string>() : new Set(visibleProjectKeys);
      persistCollapsed(next);
      return next;
    });
  }, [allGroupsCollapsed, visibleProjectKeys]);

  // ── right pane data ──
  const inScope = useMemo(() => {
    if (activeProject === null) return tasks;
    const key = activeProject.toLowerCase();
    return tasks.filter((t) => (t.project || '').toLowerCase() === key);
  }, [tasks, activeProject]);

  const stats = useMemo(() => ({
    todo: inScope.filter((t) => t.status !== 'done').length,
    done: inScope.filter((t) => t.status === 'done').length,
  }), [inScope]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inScope.filter((t) => {
      const done = t.status === 'done';
      if (done && !showDone) return false;
      if (!done && !showTodo) return false;
      if ((filterP0 || filterP1)
        && !((filterP0 && t.priority === 'immediate') || (filterP1 && t.priority === 'important'))) return false;
      if (q && !t.title.toLowerCase().includes(q) && !(t.project ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inScope, showTodo, showDone, filterP0, filterP1, search]);

  // ── actions ──
  const toggleStatusChip = useCallback((which: 'todo' | 'done') => {
    // At least one of Todo/Done stays active (an empty status set shows nothing).
    if (which === 'todo') {
      const next = !showTodo;
      setShowTodo(next);
      if (!next && !showDone) setShowDone(true);
    } else {
      const next = !showDone;
      setShowDone(next);
      if (!next && !showTodo) setShowTodo(true);
    }
  }, [showTodo, showDone]);

  const handleGhostCreate = useCallback(async (title: string, project?: string) => {
    // Grouped ghost rows pass their own project; the top ghost falls back to
    // the rail selection. '' stays '' (Inbox).
    const target = project !== undefined ? project : (activeProject || '');
    await create({ title, priority: 'none', project: target || undefined });
  }, [create, activeProject]);

  const handleCreateProject = useCallback(async (name: string) => {
    // Select the CANONICAL spelling: project identity is case-insensitive and an
    // existing row's spelling wins, so selecting the raw input could highlight
    // nothing in the rail and file ghost-created tasks under the wrong casing.
    const res = await createProject(name);
    refreshRegistry();
    setActiveProject(res.name);
  }, [refreshRegistry]);

  const handleFormCreate = useCallback(async (data: TaskFormData) => {
    await create({
      title: data.title,
      priority: data.priority,
      project: data.project || undefined,
      due_date: data.due_date || undefined,
    });
    setShowForm(false);
  }, [create]);

  const handleReorderProjects = useCallback((order: string[]) => {
    void reorderProjects(order);
  }, [reorderProjects]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  const boardTitle = activeProject === null ? 'All Tasks' : (activeProject || 'Inbox');
  const isAll = activeProject === null;

  return (
    <div className="tasks-page">
      <TasksPageRail
        projects={railProjects}
        allOpenCount={allOpenCount}
        inboxOpenCount={openCountByProject.get('') ?? 0}
        activeKey={activeProject}
        onSelect={setActiveProject}
        onCreateProject={handleCreateProject}
        onReorderProjects={handleReorderProjects}
      />

      <main className="tp-board">
        <div className="tp-toolbar">
          <span className="tp-title" title={boardTitle}>{boardTitle}</span>
          <span className="tp-stats">{stats.todo} todo · {stats.done} done</span>
          <button type="button" className={`tp-chip${showTodo ? ' on' : ''}`} onClick={() => toggleStatusChip('todo')}>
            ○ Todo
          </button>
          <button type="button" className={`tp-chip${showDone ? ' on' : ''}`} onClick={() => toggleStatusChip('done')}>
            ✓ Done
          </button>
          <button type="button" className={`tp-chip${filterP0 ? ' on' : ''}`} onClick={() => setFilterP0((v) => !v)}>
            <span className="tp-p-dot p0" />P0
          </button>
          <button type="button" className={`tp-chip${filterP1 ? ' on' : ''}`} onClick={() => setFilterP1((v) => !v)}>
            <span className="tp-p-dot p1" />P1
          </button>
          {isAll && (
            <>
              <button
                type="button"
                className={`tp-chip${grouped ? ' on' : ''}`}
                title={grouped ? 'Grouped by project — click for a flat list' : 'Flat list — click to group by project'}
                onClick={handleGroupedToggle}
              >
                ⊟ Group
              </button>
              {grouped && (
                <button
                  type="button"
                  className="tp-chip"
                  title={allGroupsCollapsed ? 'Expand all projects' : 'Collapse all projects'}
                  onClick={handleCollapseExpandAll}
                >
                  {allGroupsCollapsed ? '⌃⌃ Expand all' : '⌄⌄ Collapse all'}
                </button>
              )}
            </>
          )}
          <input
            className="tp-search"
            type="search"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="tp-newtask-btn" onClick={() => setShowForm(true)}>＋ Task</button>
        </div>

        <TasksPageTable
          tasks={filtered}
          activeProject={activeProject}
          sourceByName={sourceByName}
          onToggleComplete={toggleComplete}
          onDelete={deleteTask}
          onCreate={handleGhostCreate}
          onUpdate={update}
          onStar={star}
          sort={sort}
          onSortChange={handleSortChange}
          grouped={grouped}
          collapsed={collapsed}
          onToggleGroup={handleToggleGroup}
          projectOrder={projectOrder}
        />
      </main>

      {showForm && (
        <TaskForm
          initial={activeProject ? { project: activeProject } : undefined}
          projects={railProjects.map((p) => p.name)}
          onSubmit={handleFormCreate}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
