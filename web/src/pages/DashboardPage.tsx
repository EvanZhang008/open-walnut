import { useState, useMemo, useCallback } from 'react';
import { useTasksContext } from '@/contexts/TasksContext';
import { useOrdering } from '@/hooks/useOrdering';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { createProject } from '@/api/projects';
import { TasksPageRail, type RailProjectItem } from '@/components/tasks/TasksPageRail';
import { TasksPageTable } from '@/components/tasks/TasksPageTable';
import { TaskForm, type TaskFormData } from '@/components/tasks/TaskForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import '@/styles/tasks-page.css';

/** /tasks — dense two-pane workspace: project rail (left) + task table (right). */
export function DashboardPage() {
  const { tasks, loading, error, toggleComplete, create, deleteTask } = useTasksContext();
  const { projectOrder } = useOrdering();
  const { projectNames, sourceByName, favoriteByName, refresh: refreshRegistry } = useProjectRegistry();

  // null = All Tasks, '' = Inbox, otherwise a project name.
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [showTodo, setShowTodo] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [filterP0, setFilterP0] = useState(false);
  const [filterP1, setFilterP1] = useState(false);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

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

  const handleGhostCreate = useCallback(async (title: string) => {
    await create({ title, priority: 'none', project: activeProject || undefined });
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

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  const boardTitle = activeProject === null ? 'All Tasks' : (activeProject || 'Inbox');

  return (
    <div className="tasks-page">
      <TasksPageRail
        projects={railProjects}
        allOpenCount={allOpenCount}
        inboxOpenCount={openCountByProject.get('') ?? 0}
        activeKey={activeProject}
        onSelect={setActiveProject}
        onCreateProject={handleCreateProject}
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
