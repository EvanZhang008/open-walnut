import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { updateSession } from '@/api/sessions';
import { updateTask } from '@/api/tasks';
import { useTasksContextSafe } from '@/contexts/TasksContext';

interface EditableSessionTitleProps {
  sessionId: string;
  /** When set, editing renames the task (global) instead of the session title. */
  taskId?: string;
  /** Display text — task title when a task is linked, otherwise the session title. */
  title: string;
  className?: string;
  /** Called after a successful save so parents can refresh. */
  onSaved?: () => void;
}

/**
 * Inline-editable session header title. Renames the linked task when present
 * (so the change propagates everywhere the task shows up); falls back to the
 * session's own title for orphan sessions with no task.
 */
export function EditableSessionTitle({ sessionId, taskId, title, className, onSaved }: EditableSessionTitleProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tasks = useTasksContextSafe();

  useEffect(() => { setValue(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }
    // Store path: the rename lands in the shared task store synchronously, so
    // the board row and this header change in the same frame; the store owns
    // the REST call, its retry, and the error banner. Nothing to await.
    if (taskId && tasks && tasks.tasks.some((t) => t.id === taskId)) {
      tasks.update(taskId, { title: trimmed });
      setEditing(false);
      onSaved?.();
      return;
    }
    setSaving(true);
    const req = taskId
      ? updateTask(taskId, { title: trimmed })
      : updateSession(sessionId, { title: trimmed });
    req
      .then(() => { setEditing(false); onSaved?.(); })
      .catch(() => { setValue(title); setEditing(false); })
      .finally(() => setSaving(false));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { setValue(title); setEditing(false); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="session-panel-title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        disabled={saving}
        maxLength={500}
      />
    );
  }

  // The tooltip leads with the FULL title: the header truncates with an ellipsis,
  // so hover is the only way to read a long title. The rename hint follows on a
  // second line rather than replacing it (it used to be the whole tooltip, which
  // made a truncated title unreadable).
  const hint = taskId ? 'Click to rename task' : 'Click to rename session';

  return (
    <span
      className={`${className ?? ''} session-panel-title-editable`.trim()}
      onClick={() => setEditing(true)}
      title={`${title}\n\n${hint}`}
    >
      {title}
    </span>
  );
}
