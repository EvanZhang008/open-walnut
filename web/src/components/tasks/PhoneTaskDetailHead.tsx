/**
 * The top of task detail on a phone: the title as a 16 px field (renaming lives
 * here since a title tap on the home row always opens; C59) and the phase
 * choice (PhonePhaseSheet, C58). A save shows `Saving...`, then `Saved`; a
 * failure puts the old title back and says `Couldn't save. Try again.`, or, on a
 * host replica's console with the Mac away, the refusal's own words ("Needs your
 * Mac. ..."). A phase change that fails says the same.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { updateTask as apiUpdateTask } from '@/api/tasks';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { isLeaderWords } from '@/api/leader-presence';
import { PhonePhaseSheet } from './PhonePhaseSheet';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

const SAVE_TEXT: Record<Exclude<SaveState, 'idle'>, string> = {
  saving: 'Saving...',
  saved: 'Saved',
  failed: "Couldn't save. Try again.",
};

const SAVED_SHOW_MS = 1500;

/** What a failed save says: the replica's plain words about the Mac as they are, else the generic line. */
export function saveFailedText(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return isLeaderWords(message) ? message : SAVE_TEXT.failed;
}

export function PhoneTaskDetailHead({ task }: { task: Task }) {
  const store = useTasksContextSafe();
  const [draft, setDraft] = useState(task.title);
  const [save, setSave] = useState<SaveState>('idle');
  const [failedText, setFailedText] = useState<string>(SAVE_TEXT.failed);
  const editingRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the task (WS rename, another task opened) unless the user is typing.
  useEffect(() => { if (!editingRef.current) setDraft(task.title); }, [task.title, task.id]);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const commit = useCallback(async () => {
    editingRef.current = false;
    const next = draft.trim();
    if (!next || next === task.title) { setDraft(task.title); return; }
    setSave('saving');
    try {
      await apiUpdateTask(task.id, { title: next });
      // The list row follows at once; the WS echo confirms it.
      if (store?.tasks.some((t) => t.id === task.id)) store.patchTasksLocal({ [task.id]: { title: next } });
      setSave('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSave('idle'), SAVED_SHOW_MS);
    } catch (err) {
      log.warn('phone-task-detail', 'title save failed', { taskId: task.id, error: String(err) });
      setDraft(task.title);
      setFailedText(saveFailedText(err));
      setSave('failed');
    }
  }, [draft, store, task.id, task.title]);

  const setPhase = useCallback((phase: string) => {
    if (store?.tasks.some((t) => t.id === task.id)) { store.setPhase(task.id, phase); return; }
    void apiUpdateTask(task.id, { phase }).catch((err) => {
      log.warn('phone-task-detail', 'phase save failed', { taskId: task.id, error: String(err) });
      setFailedText(saveFailedText(err));
      setSave('failed');
    });
  }, [store, task.id]);

  return (
    <div className="phone-detail-head" data-testid="phone-detail-head">
      <label className="phone-detail-title-label" htmlFor={`phone-detail-title-${task.id}`}>Title</label>
      <textarea data-no-draft="autosave"
        id={`phone-detail-title-${task.id}`}
        className="phone-detail-title"
        value={draft}
        rows={2}
        enterKeyHint="done"
        onFocus={() => { editingRef.current = true; setSave('idle'); }}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); editingRef.current = false; setDraft(task.title); (e.target as HTMLTextAreaElement).blur(); }
        }}
      />
      {save !== 'idle' && (
        <p className={`phone-detail-save is-${save}`} role={save === 'failed' ? 'alert' : 'status'}>{save === 'failed' ? failedText : SAVE_TEXT[save]}</p>
      )}
      <PhonePhaseSheet task={task} onSetPhase={setPhase} />
    </div>
  );
}
