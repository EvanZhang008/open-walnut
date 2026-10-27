import { useRef, type FormEvent } from 'react';
import type { Task, TaskPriority } from '@open-walnut/core';
import { BoxMic, type BoxMicHandle } from '../common/BoxMic';
import { useShowPriority } from '@/hooks/useShowPriority';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';

export interface TaskFormData {
  title: string;
  priority: TaskPriority;
  /** '' = Inbox (no project). */
  project: string;
  due_date: string;
  note: string;
}

interface TaskFormProps {
  initial?: Partial<Task>;
  projects: string[];
  /** A promise that rejects keeps the form's draft (the create did not land). */
  onSubmit: (data: TaskFormData) => void | Promise<unknown>;
  onCancel: () => void;
}

export function TaskForm({ initial, projects, onSubmit, onCancel }: TaskFormProps) {
  const showPriority = useShowPriority();
  // The whole form is one draft of this task (or of a new one): closing the dialog keeps
  // it, Save or Add drops it, and so does Cancel.
  const form = useDraftValue<TaskFormData>(draftKey('task-form', initial?.id ?? 'new'), {
    title: initial?.title ?? '', priority: initial?.priority ?? 'none', project: initial?.project ?? '',
    due_date: initial?.due_date ?? '', note: '',
  });
  const { title, priority, project, due_date: dueDate, note } = form.value;
  const field = <K extends keyof TaskFormData>(k: K) => (v: TaskFormData[K]) => form.setValue((f) => ({ ...f, [k]: v }));
  const setTitle = field('title');
  const setPriority = field('priority');
  const setProject = field('project');
  const setDueDate = field('due_date');
  const setNote = field('note');
  const cancel = () => { form.clear(); onCancel(); };
  const titleBox = useRef<HTMLInputElement | null>(null);
  const titleMic = useRef<BoxMicHandle | null>(null);
  const noteBox = useRef<HTMLTextAreaElement | null>(null);
  const noteMic = useRef<BoxMicHandle | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    titleMic.current?.clear();
    noteMic.current?.clear();
    const sentKey = form.key;
    void Promise.resolve(onSubmit({
      title: title.trim(),
      priority,
      project: project.trim(),
      due_date: dueDate,
      note: note.trim(),
    })).then(() => form.clear(sentKey), () => {});
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 className="mb-4">{initial ? 'Edit Task' : 'Add Task'}</h2>

        <div className="form-group">
          <label htmlFor="task-title">Title</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              ref={titleBox}
              id="task-title"
              type="text"
              data-draft-key={form.key ?? undefined}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              required
              autoFocus
              style={{ flex: 1 }}
            />
            <BoxMic boxRef={titleBox} text={title} setText={setTitle} handleRef={titleMic} />
          </div>
        </div>

        <div className="form-row">
          {showPriority && (
            <div className="form-group">
              <label htmlFor="task-priority">Priority</label>
              <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                <option value="none">None (untriaged)</option>
                <option value="backlog">Backlog</option>
                <option value="important">Important</option>
                <option value="immediate">Immediate</option>
              </select>
            </div>
          )}

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

        <div className="form-group">
          <label htmlFor="task-project">Project</label>
          <input
            id="task-project"
            type="text"
            data-draft-key={form.key ?? undefined}
            value={project}
            onChange={(e) => setProject(e.target.value)}
            list="projects-list"
            placeholder="Leave empty for Inbox"
          />
          <datalist id="projects-list">
            {projects.map((p) => <option key={p} value={p} />)}
          </datalist>
        </div>

        {!initial && (
          <div className="form-group">
            <label htmlFor="task-note">Note</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <textarea
                ref={noteBox}
                id="task-note"
                data-draft-key={form.key ?? undefined}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note..."
                rows={3}
                style={{ flex: 1 }}
              />
              <BoxMic boxRef={noteBox} text={note} setText={setNote} handleRef={noteMic} />
            </div>
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">{initial ? 'Save' : 'Add Task'}</button>
        </div>
      </form>
    </div>
  );
}
