/**
 * Answer one "Needs you" row of the Org page where it is (2026-10-26, the user: "click answer and
 * it show drop down and user can just answer there"). The dropdown takes the ask's own shape, never
 * a guess: a live prompt shows its own controls (Allow / Deny, a question's options), a decision
 * letter its actions, a Board choice its options, and an ask with no structure (the session's own
 * words, a failed session) a line that goes to that task's session. A yes/no is two buttons side by
 * side because the ask has two options, not because a word reads like a question.
 *
 * The row answers the click, not the server: the dropdown and the row go the moment the answer is
 * sent, and a failure brings the row back with its dropdown open on the reason and the words the
 * user typed (a busy server on the Mac held a 24 ms op for 5 s, 2026-09-29).
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
import { useDraft } from '@/hooks/useDraft';
import { clearDraft, draftKey } from '@/utils/drafts';
import { sessionDraftKey } from '@/utils/composer-insert';
import { boardChoiceDraftKey } from '@/components/board/BoardReplyDock';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import { answerShape, openLetterFor } from './org-answer-shape';
import type { OrgAlertView } from './org-channels-model';

/** Where an answer failed: the reason, and the words the user had typed, to put back. */
export interface AnswerFailure { message: string; draft?: string }
/** Settles an answer sent from a row: no argument once it was taken, a failure to bring the row back. */
export type AnswerSettle = (failure?: AnswerFailure) => void;

function Options({ options, recommended, onPick, testId }: {
  options: ReadonlyArray<{ value: string; label: string; title?: string }>;
  recommended?: string;
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
          onClick={() => onPick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/**
 * A line in the user's own words, for an ask with no structure or beside one that has it. The
 * words are kept under `draftKey` (the same draft the ask's own box keeps: the session's
 * composer, the Board choice's) until the answer is taken; the caller clears it then.
 */
function WordsField({ placeholder, initial = '', draftKey: key, onSend, sendLabel = 'Send', autoFocus }: {
  placeholder: string;
  initial?: string;
  draftKey: string | null;
  onSend: (text: string) => void;
  sendLabel?: string;
  autoFocus?: boolean;
}) {
  const draft = useDraft(key);
  const [plain, setPlain] = useState(initial);
  const text = key ? draft.text : plain;
  const setText = key ? draft.setText : setPlain;
  const send = () => { const t = text.trim(); if (t) { draft.flush(); onSend(t); } };
  return (
    <div className="org-answer-words">
      <textarea
        className="org-answer-input"
        data-testid="org-answer-input"
        data-draft-key={key ?? undefined}
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
      <button type="button" className="btn btn-sm btn-primary" data-testid="org-answer-send" disabled={!text.trim()} onClick={send}>{sendLabel}</button>
    </div>
  );
}

const Failed = ({ failure }: { failure: AnswerFailure | undefined }) =>
  failure ? <div className="org-answer-error" role="alert" data-testid="org-answer-error">{failure.message}</div> : null;

interface FormProps {
  alert: OrgAlertView;
  /** The last try at this ask failed: its reason and the words to put back. */
  failure: AnswerFailure | undefined;
  /** The answer goes now: the dropdown closes and the row with it (the page answers the click
   *  before the server does); settle it with the server's answer. */
  onSend: () => AnswerSettle;
}

function LetterAnswer({ alert, failure, onSend, onWords }: FormProps & { onWords: () => void }) {
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
  // The note with a choice is the letter's own note draft (LetterView keeps the same one).
  const noteDraft = useDraft(letter ? draftKey('letter-note', letter.id) : null);
  const note = noteDraft.text || (noteDraft.key ? '' : failure?.draft ?? '');
  const setNote = noteDraft.setText;
  useEffect(() => { if (fresh && !letter) onWords(); }, [fresh, letter, onWords]);
  if (!letter) return <div className="org-answer-note" role="status">{fresh ? '' : 'Loading the letter…'}</div>;
  const pick = (actionId: string) => {
    const typed = note;
    const noteKey = noteDraft.key;
    noteDraft.flush();
    const settle = onSend();
    answerLetter(letter.id, actionId, typed.trim() || undefined).then((result) => {
      if (result.letter) patchLetter(letter.id, { answered: result.letter.answered, read: true });
      clearDraft(noteKey);
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, actionId, delivery: result.delivery });
      settle();
    }, (err: unknown) => {
      const status = (err as { status?: number }).status;
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, error: String(err) });
      // Answered somewhere else: nothing is left to answer here.
      if (status === 409) settle();
      else settle({ message: 'Not sent. Try again.', draft: typed });
    });
  };
  return (
    <>
      <div className="org-answer-q" title={letter.subject}>{letter.subject}</div>
      <Options
        testId="org-answer-letter"
        options={letter.actions!.map((a) => ({ value: a.id, label: a.label, ...(a.description ? { title: a.description } : {}) }))}
        onPick={pick}
      />
      <input
        className="org-answer-input org-answer-note-input"
        data-testid="org-answer-note"
        data-draft-key={noteDraft.key ?? undefined}
        value={note}
        placeholder="Add a note (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      <Failed failure={failure} />
    </>
  );
}

interface ChoiceFound { owner: string; id: string; title: string; options: Array<{ value: string; label: string }>; recommended?: string }

function ChoiceAnswer({ alert, failure, onSend, onWords }: FormProps & { onWords: () => void }) {
  const [found, setFound] = useState<ChoiceFound | null | undefined>(undefined);
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
  const wordsKey = boardChoiceDraftKey(found.owner, found.id);
  const answer = (body: { option?: string; text?: string }) => {
    const settle = onSend();
    apiPut(`/api/v1/tasks/${encodeURIComponent(found.owner)}/board/choices/${encodeURIComponent(found.id)}`, body).then(() => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'choice', owner: found.owner, choiceId: found.id, option: body.option ?? '' });
      if (body.text) clearDraft(wordsKey);
      settle();
    }, (err: unknown) => {
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'choice', error: String(err) });
      // A replica answers 501 to every Board write.
      const message = (err as { status?: number }).status === 501 ? 'Boards are read only here. Answer it from the main Walnut.' : 'Not saved. Try again.';
      settle({ message, ...(body.text ? { draft: body.text } : {}) });
    });
  };
  return (
    <>
      {found.title && <div className="org-answer-q" title={found.title}>{found.title}</div>}
      {found.options.length > 0 && (
        <Options testId="org-answer-choice" options={found.options} {...(found.recommended ? { recommended: found.recommended } : {})} onPick={(v) => answer({ option: v })} />
      )}
      {/* A choice with no options is answered in words, on its Board all the same. */}
      <WordsField
        placeholder={found.options.length ? 'Or say it in your words' : 'Your answer'}
        initial={failure?.draft ?? ''}
        draftKey={wordsKey}
        onSend={(t) => answer({ text: t })}
        autoFocus={!found.options.length && !failure}
      />
      <Failed failure={failure} />
    </>
  );
}

function WordsAnswer({ alert, failure, onSend, sessionId }: FormProps & { sessionId: string | null }) {
  const { send } = useSessionSend(sessionId);
  // A failed session: its probe says so, or the task's status names the failure as its ask.
  const failed = alert.kind === 'error' || alert.source === 'error';
  if (!sessionId) return <div className="org-answer-note">It has no session to answer. Open it to start one.</div>;
  const wordsKey = sessionDraftKey(sessionId);
  const reply = (text: string) => {
    const settle = onSend();
    void send(sessionId, text).catch(() => false).then((ok) => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'words', sessionId, ok });
      if (ok) clearDraft(wordsKey);
      settle(ok ? undefined : { message: 'Not sent. Try again.', draft: text });
    });
  };
  const retry = () => {
    const settle = onSend();
    retrySession(sessionId).then(() => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'retry', sessionId });
      settle();
    }, (err: unknown) => {
      log.warn('org-page', 'org alert retry failed', { taskId: alert.taskId, sessionId, error: String(err) });
      settle({ message: 'Retry failed.' });
    });
  };
  return (
    <>
      {alert.ask && <div className="org-answer-q" title={alert.ask}>{alert.ask}</div>}
      {failed && (
        <Options testId="org-answer-retry" options={[{ value: 'retry', label: 'Retry', title: 'Start the failed session again' }]} onPick={retry} />
      )}
      <WordsField placeholder={failed ? 'Or tell it what to do' : 'Your answer'} initial={failure?.draft ?? ''} draftKey={wordsKey} onSend={reply} autoFocus={!failure} />
      <Failed failure={failure} />
    </>
  );
}

/** The Answer button and its dropdown. `onAnswer` hides the row the moment an answer goes and
 *  returns how to settle it; `failure` (the last try failed) opens the dropdown again with it. */
export function OrgAlertAnswer({ alert, task, onAnswer, failure, onFailureSeen }: {
  alert: OrgAlertView;
  task: Task | undefined;
  onAnswer: (taskId: string) => AnswerSettle;
  failure?: AnswerFailure;
  /** The user closed the dropdown that showed a failure: it is told. */
  onFailureSeen?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(!!failure);
  // A letter or a choice this browser cannot find takes the words form instead.
  const [wordsOnly, setWordsOnly] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 140, onAnchorLost: () => setOpen(false) });
  const close = () => { setOpen(false); if (failure) onFailureSeen?.(alert.taskId); };
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { close(); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  const sessionId = task ? resolveTaskSessionId(task) : null;
  const shape = wordsOnly ? 'words' : answerShape(alert);
  const send = (): AnswerSettle => { setOpen(false); return onAnswer(alert.taskId); };
  // A live prompt answers through its own card, which says when it was taken.
  const promptDone = () => { setOpen(false); onAnswer(alert.taskId)(); };
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
        onClick={() => { setWordsOnly(false); if (open) close(); else setOpen(true); }}
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
              onAnswered={promptDone}
            />
          ) : shape === 'letter' ? (
            <LetterAnswer alert={alert} failure={failure} onSend={send} onWords={toWords} />
          ) : shape === 'choice' ? (
            <ChoiceAnswer alert={alert} failure={failure} onSend={send} onWords={toWords} />
          ) : (
            <WordsAnswer alert={alert} failure={failure} onSend={send} sessionId={sessionId} />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
