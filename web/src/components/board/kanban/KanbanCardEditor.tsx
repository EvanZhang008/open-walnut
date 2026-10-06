/**
 * Edit a card's summary or its waiting on, in the card (spec 6.1, G31). The
 * summary is a textarea with an `n/300` count, the waiting on one line of at
 * most 80 (`A CR, a team, a person`). Enter saves, Shift+Enter is a new line,
 * Escape cancels, leaving the field saves. While it saves the field is read
 * only; a failure puts the old text back and says `Couldn't save: <reason>`.
 * The draft lives here, never in the payload, so a reload cannot wipe it; the
 * save names the `*_at` seen when the editor opened, and if someone wrote the
 * field since, it asks: `The leader changed this while you were editing.`
 * with Keep mine (write again without the check) or Use theirs (drop the draft).
 * An empty summary clears the card's own, so the task's summary shows again.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { MAX_SUMMARY, MAX_WAITING_ON } from '../../../../../src/core/boards/board-lanes';
import type { KanbanCardEditorProps, SetCardResult } from './kanban-contract';
import { cutTitle } from './kanban-changes-model';

/** `The leader`, a writer task's title, or `Someone` (another window of the user). */
export function conflictWriter(by: string, ownerId: string | undefined, titleOf: (id: string) => string): string {
  if (!by.startsWith('task:')) return 'Someone';
  const id = by.slice(5);
  if (ownerId && id === ownerId) return 'The leader';
  return cutTitle(titleOf(id) || 'Another task');
}

export function KanbanCardEditor({ field, card, openedAt, api, onClose }: KanbanCardEditorProps) {
  const isSummary = field === 'summary';
  const original = isSummary ? card.summary?.text ?? '' : card.waiting?.text ?? '';
  const max = isSummary ? MAX_SUMMARY : MAX_WAITING_ON;
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ current: string; by: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(false);
  const store = useTasksContextSafe();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const write = async (checkSince: boolean) => {
    const value = draft.trim();
    if (value === original.trim() && checkSince) { done.current = true; onClose(); return; }
    setSaving(true);
    setError('');
    const res: SetCardResult = await api.setCard(card.taskId, { [field]: value }, checkSince ? openedAt ?? '' : undefined);
    setSaving(false);
    if (res.ok) {
      done.current = true;
      log.info('board', 'kanban card field saved', { cardTaskId: card.taskId, field, length: value.length });
      onClose();
      return;
    }
    if ('conflict' in res) {
      setConflict({ current: res.conflict.current, by: res.conflict.by });
      return;
    }
    log.warn('board', 'kanban card field save failed', { cardTaskId: card.taskId, field, error: res.error });
    setDraft(original);
    setError(res.error || 'the server did not answer');
  };

  const save = () => { if (!saving && !conflict && !done.current) void write(true); };
  const cancel = () => { done.current = true; onClose(); };
  const useTheirs = () => { done.current = true; onClose(); };

  const titleOf = (id: string) => store?.tasks.find((t) => t.id === id)?.title ?? '';
  const ownerId = store?.tasks.find((t) => t.id === card.taskId)?.parent_task_id;
  const common = {
    value: draft,
    readOnly: saving,
    maxLength: max,
    'aria-label': isSummary ? 'Card summary' : 'Waiting on',
    'aria-invalid': error ? true : undefined,
    onChange: (e: { target: { value: string } }) => { setDraft(e.target.value); if (error) setError(''); },
    onKeyDown: (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
      if (e.key === 'Enter' && !(isSummary && e.shiftKey)) { e.preventDefault(); save(); }
    },
    onBlur: () => { if (!conflict) save(); },
    onClick: (e: MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: PointerEvent) => e.stopPropagation(),
  };
  return (
    <div className="kanban-editor" data-testid={`kanban-card-${isSummary ? 'summary' : 'waiting'}-editor`} data-saving={saving || undefined}>
      {isSummary ? (
        <textarea ref={ref} className="kanban-editor-input is-summary" data-testid="kanban-card-summary-input" rows={4} {...common} />
      ) : (
        <input ref={ref} className="kanban-editor-input" data-testid="kanban-card-waiting-input" placeholder="A CR, a team, a person" {...common} />
      )}
      <div className="kanban-editor-foot">
        {saving && <span className="kanban-spinner" data-testid="kanban-editor-saving" aria-label="Saving" />}
        {isSummary && <span className="kanban-editor-count" data-testid="kanban-card-summary-count">{draft.length}/{max}</span>}
      </div>
      {error && <div className="kanban-editor-error" data-testid="kanban-editor-error" role="alert">Couldn't save: {error}</div>}
      {conflict && (
        <div className="kanban-editor-conflict" data-testid="kanban-editor-conflict" role="alert">
          <span>{conflictWriter(conflict.by, ownerId, titleOf)} changed this while you were editing.</span>{' '}
          <button type="button" className="kanban-text-btn" data-testid="kanban-editor-keep-mine"
            onMouseDown={(e) => e.preventDefault()} onClick={() => { setConflict(null); void write(false); }}>Keep mine</button>{' '}
          <button type="button" className="kanban-text-btn" data-testid="kanban-editor-use-theirs"
            onMouseDown={(e) => e.preventDefault()} onClick={useTheirs}>Use theirs</button>
        </div>
      )}
    </div>
  );
}
