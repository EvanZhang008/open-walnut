import { useState, useMemo, useCallback } from 'react';
import { useTasks } from '@/hooks/useTasks';
import { useOrdering } from '@/hooks/useOrdering';
import { TaskStats } from '@/components/tasks/TaskStats';
import { TaskList } from '@/components/tasks/TaskList';
import { TaskFilters } from '@/components/tasks/TaskFilters';
import { ProjectTabs } from '@/components/tasks/ProjectTabs';
import { TaskForm, type TaskFormData } from '@/components/tasks/TaskForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

export function DashboardPage() {
  const { tasks, loading, error, toggleComplete, star, create } = useTasks();
  const { categoryOrder } = useOrdering();
  const [statusFilter, setStatusFilter] = useState('todo');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [showForm, setShowForm] = useState(false);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.category) set.add(t.category);
    const names = Array.from(set);
    if (categoryOrder.length === 0) return names.sort();
    const indexMap = new Map(categoryOrder.map((name, i) => [name, i]));
    return names.sort((a, b) => {
      const ai = indexMap.get(a);
      const bi = indexMap.get(b);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b);
    });
  }, [tasks, categoryOrder]);

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.project) set.add(t.project);
    return Array.from(set).sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (priorityFilter && t.priority !== priorityFilter) return false;
      if (activeCategory && t.category !== activeCategory) return false;
      if (searchFilter) {
        const q = searchFilter.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !t.project.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [tasks, statusFilter, priorityFilter, activeCategory, searchFilter]);

  const stats = useMemo(() => ({
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    done: tasks.filter((t) => t.status === 'done').length,
  }), [tasks]);

  const handleCreate = useCallback(async (data: TaskFormData) => {
    await create({
      title: data.title,
      priority: data.priority,
      category: data.category || undefined,
      project: data.project || undefined,
      due_date: data.due_date || undefined,
    });
    setShowForm(false);
  }, [create]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-subtitle">Manage your tasks and projects</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ Add Task</button>
      </div>

      <TaskStats total={stats.total} todo={stats.todo} done={stats.done} />

      <ProjectTabs projects={categories} active={activeCategory} onChange={setActiveCategory} />

      <TaskFilters
        status={statusFilter}
        priority={priorityFilter}
        search={searchFilter}
        onStatusChange={setStatusFilter}
        onPriorityChange={setPriorityFilter}
        onSearchChange={setSearchFilter}
      />

      <TaskList
        tasks={filtered}
        onComplete={toggleComplete}
        onStar={star}
        onAdd={() => setShowForm(true)}
      />

      {showForm && (
        <TaskForm
          categories={categories}
          projects={projects}
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
