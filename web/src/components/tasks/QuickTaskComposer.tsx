import { useCallback, useEffect, useRef, useState } from 'react';
import { quickParseTask, type QuickTaskParse } from '@/api/tasks';
import { QuickTaskConfirm, type ConfirmDraft, type ConfirmField } from './QuickTaskConfirm';

/** Built-in tier name or a custom tier id (`ct_*`). */
type PinTier = string;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Flat list of existing project names, for the form's datalist. */
  projectOptions: string[];
  /**
   * Pre-seeded dates (e.g. the calendar slot the user clicked, or a drag-
   * selected start→end range). They pre-fill the form; an AI-parsed date still
   * overwrites them — typing "call mom tomorrow 3pm" beats the clicked slot.
   * Never badged as AI.
   */
  initialDates?: { start?: string; end?: string; due?: string };
  onCreate: (input: {
    title: string;
    priority: string;
    project?: string;
    due_date?: string;
    start_date?: string;
    end_date?: string;
    pinnedTier?: PinTier;
  }) => Promise<unknown>;
}

/**
 * ONE panel, two sections, no stages: a natural-language sentence input on
 * top, the full task form always visible below. The AI parse runs in the
 * background and back-fills form fields when it lands (✦-badged); it never
 * gates anything — Enter/Create at any moment persists exactly what the form
 * shows, and typing straight into the form needs no sentence at all.
 */
export function QuickTaskComposer({ open, onClose, onCreate, projectOptions, initialDates }: Props) {
  // Refs before state: the draft initializer below reads the seed ref.
  const initialDatesRef = useRef(initialDates);
  initialDatesRef.current = initialDates;

  const emptyDraft = useCallback((): ConfirmDraft => ({
    title: '',
    aiFields: new Set(),
    start: initialDatesRef.current?.start,
    end: initialDatesRef.current?.end,
    due: initialDatesRef.current?.due,
  }), []);

  const [text, setText] = useState('');
  const [draft, setDraft] = useState<ConfirmDraft>(emptyDraft);
  const [parseInFlight, setParseInFlight] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  const draftRef = useRef(draft);
  const submittingRef = useRef(false);
  const requestNonceRef = useRef(0);
  // Fields the user hand-edited — neither the sentence mirror nor a late AI
  // result may overwrite these.
  const userEditedRef = useRef(new Set<ConfirmField>());

  textRef.current = text;
  draftRef.current = draft;
  submittingRef.current = submitting;

  const reset = useCallback(() => {
    requestNonceRef.current += 1;
    userEditedRef.current = new Set();
    textRef.current = '';
    draftRef.current = emptyDraft();
    setText('');
    setDraft(draftRef.current);
    setParseInFlight(false);
  }, [emptyDraft]);

  const close = useCallback(() => {
    if (submittingRef.current) return;
    reset();
    onClose();
  }, [onClose, reset]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (open) return;
    reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (submittingRef.current) return;
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) close();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [close, open]);

  // Merge a landed parse into the form: fill only what the user hasn't taken
  // over, badge each filled field ✦. The title is special — a raw-fallback
  // response echoes the input and isn't a suggestion.
  const applyParse = useCallback((result: QuickTaskParse, rawText: string) => {
    const edited = userEditedRef.current;
    setDraft((cur) => {
      const next: ConfirmDraft = { ...cur, aiFields: new Set(cur.aiFields) };
      const parsedTitle = result.title?.trim() || rawText;
      if (!edited.has('title') && parsedTitle !== rawText.trim()) {
        next.title = parsedTitle;
        next.aiFields.add('title');
      }
      if (result.due_date && !edited.has('due')) { next.due = result.due_date; next.aiFields.add('due'); }
      if (result.start_date && !edited.has('start')) { next.start = result.start_date; next.aiFields.add('start'); }
      if (result.end_date && !edited.has('end')) { next.end = result.end_date; next.aiFields.add('end'); }
      if (result.pinTier && !edited.has('pin')) { next.pin = result.pinTier; next.aiFields.add('pin'); }
      if (result.priority && !edited.has('priority')) { next.priority = result.priority; next.aiFields.add('priority'); }
      const project = result.project?.trim();
      if (project && !edited.has('project')) {
        next.project = project;
        next.projectIsNew = !!result.project_is_new;
        next.aiFields.add('project');
      }
      draftRef.current = next;
      return next;
    });
  }, []);

  // Debounced background parse of the sentence. Purely additive — nothing
  // waits on it, and a stale response (nonce or text moved on) is dropped.
  useEffect(() => {
    if (!open) return;
    const requestedText = text.trim();
    if (!requestedText) {
      requestNonceRef.current += 1;
      setParseInFlight(false);
      return;
    }
    const nonce = ++requestNonceRef.current;
    setParseInFlight(true);
    const timer = setTimeout(() => {
      quickParseTask(requestedText)
        .then((result) => {
          if (nonce !== requestNonceRef.current || requestedText !== textRef.current.trim()) return;
          applyParse(result, requestedText);
        })
        .catch(() => {})
        .finally(() => {
          if (nonce === requestNonceRef.current) setParseInFlight(false);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [applyParse, open, text]);

  const handleTextChange = useCallback((value: string) => {
    textRef.current = value;
    setText(value);
    const edited = userEditedRef.current;
    const seed = initialDatesRef.current;
    setDraft((cur) => {
      const next: ConfirmDraft = { ...cur };
      const ai = cur.aiFields;
      // AI contributions belong to the OLD sentence — revert any the user
      // hasn't taken over (dates fall back to the seeded slot, not to blank).
      if (ai.size) {
        if (ai.has('due') && !edited.has('due')) next.due = seed?.due;
        if (ai.has('start') && !edited.has('start')) next.start = seed?.start;
        if (ai.has('end') && !edited.has('end')) next.end = seed?.end;
        if (ai.has('pin') && !edited.has('pin')) next.pin = undefined;
        if (ai.has('priority') && !edited.has('priority')) next.priority = undefined;
        if (ai.has('project') && !edited.has('project')) { next.project = undefined; next.projectIsNew = false; }
      }
      // Live mirror: the form always shows exactly what Enter would create.
      if (!edited.has('title')) next.title = value;
      next.aiFields = new Set();
      draftRef.current = next;
      return next;
    });
  }, []);

  const handleDraftChange = useCallback((patch: Partial<ConfirmDraft>) => {
    setDraft((current) => {
      const aiFields = new Set(current.aiFields);
      for (const key of Object.keys(patch)) {
        if (key === 'aiFields') continue;
        const field = key as ConfirmField;
        aiFields.delete(field);
        // Clearing the title hands it back to the sentence mirror; anything
        // else marks the field user-owned so AI/mirror won't overwrite it.
        if (field === 'title' && !(patch.title ?? '').trim()) userEditedRef.current.delete('title');
        else userEditedRef.current.add(field);
      }
      const next = { ...current, ...patch, aiFields };
      // A hand-typed project is no longer the AI's invention.
      if ('project' in patch) next.projectIsNew = false;
      draftRef.current = next;
      return next;
    });
  }, []);

  const create = useCallback((source: ConfirmDraft) => {
    if (submittingRef.current || !source.title.trim()) return;
    // Set the ref synchronously — the render-time mirror lands too late to stop
    // a second Enter/click in the same tick from double-creating the task.
    submittingRef.current = true;
    const project = source.project?.trim() || undefined;
    setSubmitting(true);
    Promise.resolve(onCreate({
      title: source.title.trim(),
      priority: source.priority ?? 'none',
      ...(source.due ? { due_date: source.due } : {}),
      ...(source.start ? { start_date: source.start } : {}),
      ...(source.end && source.start ? { end_date: source.end } : {}),
      ...(source.pin ? { pinnedTier: source.pin } : {}),
      ...(project ? { project } : {}),
    }))
      .then(() => reset())
      .catch(() => {})
      .finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), 0);
      });
  }, [onCreate, reset]);

  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab') {
      // Contain focus while the dialog is open — Tab must not reach background controls.
      const focusables = popoverRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (event.key === 'Enter') {
      if ((event.target as HTMLElement).tagName === 'BUTTON') return;
      event.preventDefault();
      create(draftRef.current);
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, [close, create]);

  if (!open) return null;

  return (
    <div
      className="quick-task-composer"
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add a task"
      onKeyDown={handleContainerKeyDown}
    >
      <div className="qtc-header">
        <span className="qtc-header-title">Add a task</span>
      </div>
      <input
        ref={inputRef}
        className="qtc-input"
        value={text}
        maxLength={500}
        autoFocus={open}
        disabled={submitting}
        placeholder="✦ One sentence — AI fills the form below…"
        onChange={(event) => handleTextChange(event.target.value)}
      />
      <div className="qtc-input-status" aria-live="polite">
        {text.trim() && parseInFlight && <span className="qtc-parsing">✦ Analyzing…</span>}
        {text.trim() && !parseInFlight && draft.aiFields.size > 0 && (
          <span className="qtc-parsed">✦ Suggestions applied — edit anything below</span>
        )}
      </div>
      <div className="qtc-divider" role="separator" />
      <QuickTaskConfirm
        draft={draft}
        rawText={text}
        projectOptions={projectOptions}
        submitting={submitting}
        onChange={handleDraftChange}
        onCreate={() => create(draftRef.current)}
      />
    </div>
  );
}
