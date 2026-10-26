/**
 * Answer one "Needs you" row of the Org page where it is (2026-10-26, the user: "click answer and
 * it show drop down and user can just answer there"). The dropdown takes the ask's own shape, never
 * a guess: a live prompt shows its own controls (Allow / Deny, a question's options), a decision
 * letter its actions, a Board choice its options, and an ask with no structure (the session's own
 * words, a failed session) a line that goes to that task's session. A yes/no is two buttons side by
 * side because the ask has two options, not because a word reads like a question.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { apiGet, apiPut } from '@/api/client';
import { answerLetter } from '@/api/human-inbox';
import { retrySession } from '@/api/sessions';
import { KanbanCardPrompt } from '@/components/board/kanban/KanbanCardPrompt';
import { getLetterSnapshot, loadLetters, patchLetter, subscribeLetters } from '@/components/inbox/letter-store';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { useSessionSend } from '@/hooks/useSessionSend';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import { answerShape, openLetterFor } from './org-answer-shape';
import type { OrgAlertView } from './org-channels-model';

function Options({ options, recommended, busy, onPick, testId }: {
  options: ReadonlyArray<{ value: string; label: string; title?: string }>;
  recommended?: string;
  busy: boolean;
  onPick: (value: string) => void;
  testId: string;
}) {
  // Two options read as a yes/no: side by side. More: one per line.
  return (
    <div className={`org-answer-options${options.length <= 2 ? ' is-pair' : ''}`} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn btn-sm${o.value === recommended ? ' btn-primary' : ''}`}
          data-testid="org-answer-option"
          data-value={o.value}
          title={o.title ?? (o.value === recommended ? 'Recommended' : undefined)}
          disabled={busy}
          onClick={() => onPick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/** A line in the user's own words, for an ask with no structure or beside one that has it. */
function WordsField({ placeholder, busy, onSend, sendLabel = 'Send', autoFocus }: {
  placeholder: string;
  busy: boolean;
  onSend: (text: string) => void;
  sendLabel?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const send = () => { const t = text.trim(); if (t && !busy) onSend(t); };
  return (
    <div className="org-answer-words">
      <textarea
        className="org-answer-input"
        data-testid="org-answer-input"
        rows={2}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape closes the dropdown (its overlay layer); Enter sends, Shift+Enter breaks the line.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <button type="button" className="btn btn-sm btn-primary" data-testid="org-answer-send" disabled={busy || !text.trim()} onClick={send}>{sendLabel}</button>
    </div>
  );
}

function LetterAnswer({ alert, onDone, onWords }: { alert: OrgAlertView; onDone: () => void; onWords: () => void }) {
  const snap = useSyncExternalStore(subscribeLetters, getLetterSnapshot, getLetterSnapshot);
  // The store follows new letters only while an inbox is on screen: read it now, and take the
  // line instead only when this read has no letter either (a held copy shows at once).
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadLetters().finally(() => { if (alive) setFresh(true); });
    return () => { alive = false; };
  }, []);
  const letter = useMemo(() => openLetterFor(snap.letters, alert.taskId), [snap.letters, alert.taskId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (fresh && !letter) onWords(); }, [fresh, letter, onWords]);
  if (!letter) return <div className="org-answer-note" role="status">{fresh ? '' : 'Loading the letter…'}</div>;
  const pick = async (actionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await answerLetter(letter.id, actionId, note.trim() || undefined);
      if (result.letter) patchLetter(letter.id, { answered: result.letter.answered, read: true });
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, actionId, delivery: result.delivery });
      onDone();
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 409 ? 'Already answered somewhere else.' : 'Not sent. Try again.');
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, error: String(err) });
      if (status === 409) onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="org-answer-q" title={letter.subject}>{letter.subject}</div>
      <Options
        testId="org-answer-letter"
        busy={busy}
        options={letter.actions!.map((a) => ({ value: a.id, label: a.label, ...(a.description ? { title: a.description } : {}) }))}
        onPick={(v) => { void pick(v); }}
      />
      <input
        className="org-answer-input org-answer-note-input"
        data-testid="org-answer-note"
        value={note}
        placeholder="Add a note (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div className="org-answer-error" role="alert">{error}</div>}
    </>
  );
}

interface ChoiceFound { owner: string; id: string; title: string; options: Array<{ value: string; label: string }>; recommended?: string }

function ChoiceAnswer({ alert, onDone, onWords }: { alert: OrgAlertView; onDone: () => void; onWords: () => void }) {
  const [found, setFound] = useState<ChoiceFound | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // The server finds it by the rule the task's status counts by: on any Board, not only the
    // task's own team Board (a lead's Board asks about its project's tasks).
    apiGet<{ choice: ChoiceFound | null }>(`/api/v1/tasks/${encodeURIComponent(alert.taskId)}/board/open-choice`)
      .then((res) => { if (alive) setFound(res.choice ?? null); })
      .catch((err: unknown) => {
        log.warn('org-page', 'org alert choice read failed', { taskId: alert.taskId, error: String(err) });
        if (alive) setFound(null);
      });
    return () => { alive = false; };
  }, [alert.taskId]);
  useEffect(() => { if (found === null) onWords(); }, [found, onWords]);
  if (!found) return <div className="org-answer-note" role="status">{found === undefined ? 'Loading the choice…' : ''}</div>;
  const answer = async (body: { option?: string; text?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await apiPut(`/api/v1/tasks/${encodeURIComponent(found.owner)}/board/choices/${encodeURIComponent(found.id)}`, body);
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'choice', owner: found.owner, choiceId: found.id, option: body.option ?? '' });
      onDone();
    } catch (err) {
      // A replica answers 501 to every Board write.
      setError((err as { status?: number }).status === 501 ? 'Boards are read only here. Answer it from the main Walnut.' : 'Not saved. Try again.');
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'choice', error: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {found.title && <div className="org-answer-q" title={found.title}>{found.title}</div>}
      {found.options.length > 0 && (
        <Options testId="org-answer-choice" busy={busy} options={found.options} {...(found.recommended ? { recommended: found.recommended } : {})} onPick={(v) => { void answer({ option: v }); }} />
      )}
      {/* A choice with no options is answered in words, on its Board all the same. */}
      <WordsField
        placeholder={found.options.length ? 'Or say it in your words' : 'Your answer'}
        busy={busy}
        onSend={(t) => { void answer({ text: t }); }}
        autoFocus={!found.options.length}
      />
      {error && <div className="org-answer-error" role="alert">{error}</div>}
    </>
  );
}

function WordsAnswer({ alert, sessionId, onDone }: { alert: OrgAlertView; sessionId: string | null; onDone: () => void }) {
  const { send } = useSessionSend(sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sessionId) return <div className="org-answer-note">It has no session to answer. Open it to start one.</div>;
  const reply = async (text: string) => {
    setBusy(true);
    setError(null);
    const ok = await send(sessionId, text).catch(() => false);
    setBusy(false);
    log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'words', sessionId, ok });
    if (ok) onDone(); else setError('Not sent. Try again.');
  };
  const retry = async () => {
    setBusy(true);
    try {
      await retrySession(sessionId);
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'retry', sessionId });
      onDone();
    } catch (err) {
      setError('Retry failed.');
      log.warn('org-page', 'org alert retry failed', { taskId: alert.taskId, sessionId, error: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {alert.ask && <div className="org-answer-q" title={alert.ask}>{alert.ask}</div>}
      {alert.kind === 'error' && (
        <Options testId="org-answer-retry" busy={busy} options={[{ value: 'retry', label: 'Retry', title: 'Start the failed session again' }]} onPick={() => { void retry(); }} />
      )}
      <WordsField placeholder={alert.kind === 'error' ? 'Or tell it what to do' : 'Your answer'} busy={busy} onSend={(t) => { void reply(t); }} autoFocus />
      {error && <div className="org-answer-error" role="alert">{error}</div>}
    </>
  );
}

/** The Answer button and its dropdown. `onAnswered` fires once the answer was taken. */
export function OrgAlertAnswer({ alert, task, onAnswered }: {
  alert: OrgAlertView;
  task: Task | undefined;
  onAnswered: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // A letter or a choice this browser cannot find takes the words form instead.
  const [wordsOnly, setWordsOnly] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 140, onAnchorLost: () => setOpen(false) });
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { setOpen(false); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  const sessionId = task ? resolveTaskSessionId(task) : null;
  const shape = wordsOnly ? 'words' : answerShape(alert);
  const done = () => { setOpen(false); onAnswered(alert.taskId); };
  const toWords = useMemo(() => () => setWordsOnly(true), []);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm btn-primary org-alert-answer"
        data-testid="org-alert-answer"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setWordsOnly(false); setOpen((v) => !v); }}
      >Answer <span aria-hidden="true">▾</span></button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu"
          role="dialog"
          aria-label={`Answer ${alert.title}`}
          data-testid="org-answer-menu"
          data-shape={shape}
          data-task-id={alert.taskId}
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {shape === 'prompt' && sessionId ? (
            <KanbanCardPrompt
              request={{ sessionId, toolName: alert.kind === 'question' ? 'AskUserQuestion' : alert.tool ?? '' }}
              onAnswered={done}
            />
          ) : shape === 'letter' ? (
            <LetterAnswer alert={alert} onDone={done} onWords={toWords} />
          ) : shape === 'choice' ? (
            <ChoiceAnswer alert={alert} onDone={done} onWords={toWords} />
          ) : (
            <WordsAnswer alert={alert} sessionId={sessionId} onDone={done} />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
