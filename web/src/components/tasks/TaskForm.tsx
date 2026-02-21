import { useState, type FormEvent } from 'react';
import type { Task, TaskPriority } from '@walnut/core';

export interface TaskFormData {
  title: string;
  priority: TaskPriority;
  category: string;
  project: string;
  due_date: string;
  note: string;
}

interface TaskFormProps {
  initial?: Partial<Task>;
  categories: string[];
  projects: string[];
  onSubmit: (data: TaskFormData) => void;
  onCancel: () => void;
}

export function TaskForm({ initial, categories, projects, onSubmit, onCancel }: TaskFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [priority, setPriority] = useState<TaskPriority>(initial?.priority ?? 'none');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [dueDate, setDueDate] = useState(initial?.due_date ?? '');
  const [note, setNote] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      priority,
      category: category.trim(),
      project: project.trim(),
      due_date: dueDate,
      note: note.trim(),
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 className="mb-4">{initial ? 'Edit Task' : 'Add Task'}</h2>

        <div className="form-group">
          <label htmlFor="task-title">Title</label>
          <input
            id="task-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            required
            autoFocus
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="task-priority">Priority</label>
            <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              <option value="none">None (untriaged)</option>
              <option value="backlog">Backlog</option>
              <option value="important">Important</option>
              <option value="immediate">Immediate</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="task-due">Due Date</label>
            <input
              id="task-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="task-category">Category</label>
            <input
              id="task-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="categories-list"
              placeholder="e.g., Work"
            />
            <datalist id="categories-list">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div className="form-group">
            <label htmlFor="task-project">Project</label>
            <input
              id="task-project"
              type="text"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              list="projects-list"
              placeholder="e.g., Walnut"
            />
            <datalist id="projects-list">
              {projects.map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>
        </div>

        {!initial && (
          <div className="form-group">
            <label htmlFor="task-note">Note</label>
            <textarea
              id="task-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note..."
              rows={3}
            />
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">{initial ? 'Save' : 'Add Task'}</button>
        </div>
      </form>
    </div>
  );
}
