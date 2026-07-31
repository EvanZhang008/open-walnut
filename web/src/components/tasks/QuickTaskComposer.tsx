import { useCallback, useEffect, useRef, useState } from 'react';
import { listCategories, quickParseTask, type CategorySummary, type QuickTaskParse } from '@/api/tasks';
import { QuickTaskConfirm, type ConfirmDraft, type ConfirmField } from './QuickTaskConfirm';

type Stage = 'input' | 'confirm';
type PinTier = 'focus' | 'satellite' | 'wait';

interface Props {
  open: boolean;
  onClose: () => void;
  projectOptions: Record<string, string[]>;
  onCreate: (input: {
    title: string;
    priority: string;
    category?: string;
    project?: string;
    due_date?: string;
    start_date?: string;
    starred?: boolean;
    pinnedTier?: PinTier;
  }) => Promise<unknown>;
}

interface ActiveParseRequest {
  nonce: number;
  text: string;
  start: () => Promise<QuickTaskParse>;
}

function draftFromParse(parse: QuickTaskParse, rawText: string): ConfirmDraft {
  const category = parse.category?.trim() || undefined;
  const project = parse.project?.trim() || undefined;
  const aiFields = new Set<ConfirmField>();
  const title = parse.title.trim() || rawText;
  // Badge the title only when the AI actually changed it — a raw-fallback
  // response (parse failure/timeout) echoes the input and isn't an AI suggestion.
  if (title !== rawText.trim()) aiFields.add('title');
  if (parse.due_date) aiFields.add('due');
  if (parse.start_date) aiFields.add('start');
  if (parse.pinTier) aiFields.add('pin');
  if (parse.priority) aiFields.add('priority');
  if (parse.starred !== undefined) aiFields.add('star');
  if (category) aiFields.add('category');
  if (project) aiFields.add('project');
  return {
    title,
    due: parse.due_date,
    start: parse.start_date,
    pin: parse.pinTier,
    priority: parse.priority,
    starred: !!parse.starred,
    category,
    project,
    aiFields,
  };
}

function fallbackDraft(rawText: string): ConfirmDraft {
  return { title: rawText, starred: false, aiFields: new Set() };
}

export function QuickTaskComposer({ open, onClose, onCreate, projectOptions }: Props) {
  const [stage, setStage] = useState<Stage>('input');
  const [text, setText] = useState('');
  const [parse, setParse] = useState<QuickTaskParse | null>(null);
  const [parseInFlight, setParseInFlight] = useState(false);
  const [draft, setDraft] = useState<ConfirmDraft | null>(null);
  const [categories, setCategories] = useState<CategorySummary[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skeletonRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  const parseRef = useRef(parse);
  const stageRef = useRef(stage);
  const draftRef = useRef(draft);
  const submittingRef = useRef(false);
  const requestNonceRef = useRef(0);
  const activeRequestRef = useRef<ActiveParseRequest | null>(null);

  textRef.current = text;
  parseRef.current = parse;
  stageRef.current = stage;
  draftRef.current = draft;
  submittingRef.current = submitting;

  const reset = useCallback(() => {
    requestNonceRef.current += 1;
    activeRequestRef.current = null;
    textRef.current = '';
    stageRef.current = 'input';
    draftRef.current = null;
    parseRef.current = null;
    setText('');
    setStage('input');
    setParse(null);
    setParseInFlight(false);
    setDraft(null);
  }, []);

  const close = useCallback(() => {
    if (submittingRef.current) return;
    reset();
    onClose();
  }, [onClose, reset]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    listCategories()
      .then((result) => { if (alive) setCategories(result); })
      .catch(() => { if (alive) setCategories([]); });
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    reset();
    setCategories(null);
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

  useEffect(() => {
    if (!open) return;
    const requestedText = text.trim();
    if (!requestedText) {
      requestNonceRef.current += 1;
      activeRequestRef.current = null;
      setParse(null);
      setParseInFlight(false);
      return;
    }

    const nonce = ++requestNonceRef.current;
    let requestPromise: Promise<QuickTaskParse> | null = null;
    const start = () => {
      if (requestPromise) return requestPromise;
      requestPromise = quickParseTask(requestedText)
        .then((result) => {
          const isCurrent = nonce === requestNonceRef.current && requestedText === textRef.current.trim();
          if (!isCurrent) return result;
          parseRef.current = result;
          setParse(result);
          if (stageRef.current === 'confirm' && draftRef.current === null) {
            const seeded = draftFromParse(result, requestedText);
            draftRef.current = seeded;
            setDraft(seeded);
            setTimeout(() => popoverRef.current?.querySelector<HTMLInputElement>('.qtc-confirm-title')?.focus(), 0);
          }
          return result;
        })
        .catch(() => ({ title: requestedText }))
        .finally(() => {
          if (activeRequestRef.current?.nonce === nonce) activeRequestRef.current = null;
          if (nonce === requestNonceRef.current) setParseInFlight(false);
        });
      return requestPromise;
    };
    activeRequestRef.current = { nonce, text: requestedText, start };
    setParseInFlight(true);
    const timer = setTimeout(() => { start().catch(() => {}); }, 500);
    return () => clearTimeout(timer);
  }, [open, text]);

  useEffect(() => {
    if (stage !== 'confirm' || draft !== null) return;
    const timer = setTimeout(() => {
      if (stageRef.current !== 'confirm' || draftRef.current !== null) return;
      const fallback = fallbackDraft(textRef.current.trim());
      draftRef.current = fallback;
      setDraft(fallback);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [draft, stage]);

  const enterConfirm = useCallback(() => {
    const rawText = textRef.current.trim();
    if (!rawText || submittingRef.current) return;
    const seeded = parseRef.current ? draftFromParse(parseRef.current, rawText) : null;
    stageRef.current = 'confirm';
    draftRef.current = seeded;
    setStage('confirm');
    setDraft(seeded);
    if (!seeded) activeRequestRef.current?.start().catch(() => {});
    setTimeout(() => {
      if (seeded) popoverRef.current?.querySelector<HTMLInputElement>('.qtc-confirm-title')?.focus();
      else skeletonRef.current?.focus();
    }, 0);
  }, []);

  const goBack = useCallback(() => {
    stageRef.current = 'input';
    draftRef.current = null;
    setStage('input');
    setDraft(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleDraftChange = useCallback((patch: Partial<ConfirmDraft>) => {
    setDraft((current) => {
      if (!current) return current;
      const aiFields = new Set(current.aiFields);
      for (const key of Object.keys(patch)) {
        if (key === 'starred') aiFields.delete('star');
        else if (key !== 'aiFields') aiFields.delete(key as ConfirmField);
      }
      if ('category' in patch) aiFields.delete('project');
      const next = { ...current, ...patch, aiFields };
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
    const category = source.category?.trim() || undefined;
    setSubmitting(true);
    Promise.resolve(onCreate({
      title: source.title.trim(),
      priority: source.priority ?? 'none',
      ...(source.due ? { due_date: source.due } : {}),
      ...(source.start ? { start_date: source.start } : {}),
      ...(source.pin ? { pinnedTier: source.pin } : {}),
      ...(source.starred ? { starred: true } : {}),
      ...(category ? { category } : {}),
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
      if (stageRef.current === 'input') enterConfirm();
      else if (draftRef.current) create(draftRef.current);
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (stageRef.current === 'confirm') goBack();
    else close();
  }, [close, create, enterConfirm, goBack]);

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
        <span className="qtc-header-hint">AI can clean up the title and suggest task details before you create it.</span>
      </div>
      {stage === 'input' ? (
        <>
          <input
            ref={inputRef}
            className="qtc-input"
            value={text}
            maxLength={500}
            autoFocus={open}
            disabled={submitting}
            placeholder="Buy milk / file taxes tomorrow / fix login bug…"
            onChange={(event) => {
              requestNonceRef.current += 1;
              activeRequestRef.current = null;
              textRef.current = event.target.value;
              setText(event.target.value);
              setParse(null);
              setParseInFlight(false);
            }}
          />
          {text.trim() && (
            <div className={`qtc-input-status${parseInFlight ? ' qtc-parsing' : ''}`}>
              {parseInFlight ? '✦ Analyzing…' : '✦ AI will structure this — press Enter to review'}
            </div>
          )}
        </>
      ) : (
        <div ref={skeletonRef} tabIndex={draft ? undefined : -1}>
          <QuickTaskConfirm
            draft={draft}
            rawText={text}
            categories={categories}
            projectOptions={projectOptions}
            submitting={submitting}
            onChange={handleDraftChange}
            onCreate={() => { if (draftRef.current) create(draftRef.current); }}
            onBack={goBack}
            onCreateWithoutAi={() => create(fallbackDraft(textRef.current.trim()))}
          />
        </div>
      )}
    </div>
  );
}
