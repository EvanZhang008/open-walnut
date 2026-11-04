/**
 * The edits of the task details popup (TaskDetailPane) that the old task page held:
 * Complete / Reopen and Delete, the task's dependencies, and a line added to its note.
 *
 * The separate task page is gone (utils/task-path.ts; 2026-11-02, the user: "don't have
 * this stupid page, for ever"), so everything it could change is changed here, on Home.
 * Writes go through the shared task store when it carries the row (the board row moves in
 * the same frame); REST is the fallback for a row it does not carry.
 */
import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { dependsOnThrough } from '../../../../src/lib/dependency-loop';
import { addDependency, addNote, deleteTask, fetchTasks, removeDependency, toggleCompleteTask, type TaskDetail, type TaskDependencyReference } from '@/api/tasks';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { lookupTaskLabel, resolveTaskToken } from '@/stores/entity-label-store';
import { projectDisplayName } from '@/utils/project-display';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useTaskUndo } from '@/undo/TaskUndoContext';
import { useConfirm } from '@/hooks/useConfirm';
import { useDraft } from '@/hooks/useDraft';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { draftKey } from '@/utils/drafts';
import { PHASE_LABELS } from '@/utils/session-status';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import type { TaskPhase } from '@open-walnut/core';
import { Section } from './TaskDetailRows';
import { orgDisplayTitle } from '@open-walnut/org-tree';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Complete / Reopen and Delete, in the popup's header. */
export function TaskDetailActions({ task, onDeleted, onError }: {
  task: Task;
  onDeleted?: () => void;
  onError: (message: string) => void;
}) {
  const store = useTasksContextSafe();
  const undo = useTaskUndo();
  const confirm = useConfirm();
  const inStore = !!store?.tasks.some((t) => t.id === task.id);
  const done = task.status === 'done' || task.phase === 'COMPLETE';

  // In the app both go through the Undo stack, as from every other place: a toast with Undo and
  // mod+z. The REST fallback (a row the store does not carry, a pop-out) has no Undo.
  const complete = async () => {
    if (inStore && undo) { undo.toggleComplete(task.id); return; }
    if (inStore) { store!.toggleComplete(task.id); return; }
    try { await toggleCompleteTask(task.id); } catch (e) { onError(errText(e)); }
  };
  const remove = async () => {
    // Held for its Undo window, so no confirm: the popup closes and the toast offers Undo.
    if (inStore && undo) { undo.deleteTask(task.id); onDeleted?.(); return; }
    const ok = await confirm({ title: `Delete task “${orgDisplayTitle(task)}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    // The store removes the row optimistically and reports the outcome (its banner says why a
    // refusal happened), so the popup closes only once the server accepted it.
    if (inStore) { if (await store!.deleteTask(task.id)) onDeleted?.(); return; }
    try { await deleteTask(task.id); onDeleted?.(); } catch (e) { onError(errText(e)); }
  };

  return (
    <div className="tdp-actions">
      <button type="button" className="tdp-action tdp-action-primary" data-testid="task-detail-complete" onClick={() => void complete()}>
        {done ? 'Reopen' : 'Complete'}
      </button>
      <button type="button" className="tdp-action tdp-action-danger" data-testid="task-detail-delete" onClick={() => void remove()}>
        Delete
      </button>
    </div>
  );
}

/** What the task waits on and what waits on it, with add and remove. */
export function TaskDependencies({ task, detail, onChanged, onOpenTask, onError }: {
  task: Task;
  /** The detail read: the only one that carries the resolved titles and the dependents. */
  detail: TaskDetail | null;
  onChanged: () => void;
  onOpenTask: (taskId: string) => void;
  onError: (message: string) => void;
}) {
  useEntityLabelsVersion();
  const displayTitle = (reference: TaskDependencyReference) => {
    const live = lookupTaskLabel(reference.id);
    if (live) return live.title;
    const project = resolveTaskToken(reference.id)?.label.project;
    return project && projectDisplayName(reference.title).toLowerCase() === project.toLowerCase() ? project : reference.title;
  };
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Task[]>([]);
  /** What the last finished search left out because picking it would make a loop (null: none ran). */
  const [loopHidden, setLoopHidden] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const dependsOn = detail?.depends_on ?? task.depends_on ?? [];
  const resolved = detail?.resolved_dependencies;
  const dependents = detail?.dependents ?? [];

  const search = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setLoopHidden(null); return; }
    timer.current = setTimeout(async () => {
      try {
        const all = await fetchTasks();
        const needle = q.toLowerCase();
        const matching = all.filter((t) => t.id !== task.id && !dependsOn.includes(t.id)
          && (t.title.toLowerCase().includes(needle) || orgDisplayTitle(t).toLowerCase().includes(needle)
            || t.id.startsWith(needle)));
        // A task that already depends on this one, directly or through others, would make a loop.
        const pickable = matching.filter((t) => !dependsOnThrough(all, t.id, task.id));
        setResults(pickable.slice(0, 10));
        setLoopHidden(matching.length - pickable.length);
      } catch { /* the picker stays as it was */ }
    }, 300);
  };
  const pickDependency = async (depId: string) => {
    try {
      await addDependency(task.id, depId);
      setPicking(false); setQuery(''); setResults([]); setLoopHidden(null);
      onChanged();
    } catch (e) { onError(errText(e)); }
  };
  const remove = async (depId: string) => {
    try { await removeDependency(task.id, depId); onChanged(); } catch (e) { onError(errText(e)); }
  };

  const rows = resolved ?? dependsOn.map((id) => ({ id, title: id, phase: '' }));
  return (
    <Section label="Depends on" count={dependsOn.length || undefined} className="tdp-deps">
      {detail?.is_blocked && <span className="tdp-blocked">blocked</span>}
      {rows.map((dep) => (
        <div key={dep.id} className="tdp-row tdp-dep-row" data-testid="task-detail-dependency">
          <div className="tdp-row-line">
            <button type="button" className="tdp-dep-title" onClick={() => onOpenTask(dep.id)} title={displayTitle(dep)}>{displayTitle(dep)}</button>
            {dep.phase && <span className="tdp-row-end">{PHASE_LABELS[dep.phase as TaskPhase] ?? dep.phase}</span>}
            <button type="button" className="tdp-dep-remove" aria-label="Remove dependency" title="Remove dependency" onClick={() => void remove(dep.id)}>&times;</button>
          </div>
        </div>
      ))}
      {picking ? (
        <div className="tdp-dep-picker">
          <input
            data-no-draft="search"
            type="text"
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder="Search tasks to depend on..."
            autoFocus
          />
          {results.map((t) => (
            <button type="button" key={t.id} className="tdp-dep-result" onClick={() => void pickDependency(t.id)}>{orgDisplayTitle(t)}</button>
          ))}
          {results.length === 0 && loopHidden !== null && query.trim() && (
            <div className="tdp-dep-empty" data-testid="task-detail-dependency-empty">
              {loopHidden > 0
                ? `No task to add: ${loopHidden === 1 ? 'the one match already depends' : `the ${loopHidden} matches already depend`} on this task, so picking it would make a loop.`
                : 'No matching task.'}
            </div>
          )}
          <button type="button" className="tdp-link" onClick={() => { setPicking(false); setQuery(''); setResults([]); setLoopHidden(null); }}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="tdp-link" data-testid="task-detail-add-dependency" onClick={() => setPicking(true)}>+ Dependency</button>
      )}
      {dependents.length > 0 && (
        <div className="tdp-dependents">
          <div className="tdp-label tdp-dependents-label">Waiting on this task <span className="tdp-label-count">{dependents.length}</span></div>
          {dependents.map((dep) => (
            <button type="button" key={dep.id} className="tdp-dep-title" onClick={() => onOpenTask(dep.id)}>{displayTitle(dep)}</button>
          ))}
        </div>
      )}
    </Section>
  );
}

/** One line added to the end of the task's note, kept as a draft until it is added. */
export function TaskNoteAdd({ taskId, onAdded, onError }: {
  taskId: string;
  onAdded: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const draft = useDraft(draftKey('task-note-line', taskId));
  const box = useRef<HTMLInputElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  const add = async () => {
    const line = draft.text.trim();
    if (!line) return;
    const sentKey = draft.key;
    try {
      onAdded(await addNote(taskId, line));
      draft.clear(sentKey);
      mic.current?.clear();
    } catch (e) { onError(errText(e)); }
  };
  // Add (button or Enter) while the mic records waits for its last words.
  const gate = useSendAfterDictation([mic], () => { void add(); });
  return (
    <div className="tdp-note-add">
      <input
        ref={box}
        type="text"
        data-draft-key={draft.key ?? undefined}
        value={draft.text}
        onChange={(e) => draft.setText(e.target.value)}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') gate.send(); }}
        placeholder="Add to note..."
      />
      <BoxMic boxRef={box} text={draft.text} setText={draft.setText} handleRef={mic} />
      <button type="button" className="tdp-action" onClick={gate.send} {...dictationWaitProps(gate)}>Add</button>
    </div>
  );
}
