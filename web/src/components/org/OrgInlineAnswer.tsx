/**
 * Answer one ask of the Org rail right in its row (2026-10-31, the user: "make the answer layout if
 * there are space so user can just click ... yes and noe, or single or multiple choice, or text
 * right, ideally prefer non text"). The form is the ask's own, never a guess (org-ask-form.ts): a
 * live prompt shows its own controls (Allow / Deny, a question's options), a decision letter its
 * actions, a Board choice its options, a task's ask form its Yes / No, its choices (multi: check,
 * then Send) or a line; an ask with no shape a line that goes to that task's session. A choice can
 * still be answered in words ("Other"), but the words box is never the first thing shown.
 *
 * The row answers the click, not the server: the row goes the moment the answer is sent, and a
 * failure brings it back with the reason and the words the user typed (a busy server on the Mac
 * held a 24 ms op for 5 s, 2026-09-29).
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { apiGet, apiPut } from '@/api/client';
import { answerLetter } from '@/api/human-inbox';
import { retrySession } from '@/api/sessions';
import { KanbanCardPrompt } from '@/components/board/kanban/KanbanCardPrompt';
import { getLetterSnapshot, loadLetters, patchLetter, subscribeLetters } from '@/components/inbox/letter-store';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useDraft } from '@/hooks/useDraft';
import { clearDraft } from '@/utils/drafts';
import { sessionDraftKey } from '@/utils/composer-insert';
import { boardChoiceDraftKey } from '@/components/board/BoardReplyDock';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import { openLetterFor } from './org-answer-shape';
import { answerMessage, formOptions, inlineShape, type AskOption } from './org-ask-form';
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
  return (
    <div className="org-answer-options" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn btn-sm${o.value === recommended ? ' btn-primary' : ''}`}
          data-testid="org-answer-option"
          data-value={o.value}
          title={o.title ?? (o.value === recommended ? 'Recommended' : o.label)}
          onClick={() => onPick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/** A line in the user's own words. Kept under `draftKey` (the ask's own box: the session's composer,
 *  the Board choice's) until the answer is taken; the caller clears it then. */
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
        rows={1}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <button type="button" className="btn btn-sm btn-primary" data-testid="org-answer-send" disabled={!text.trim()} onClick={send}>{sendLabel}</button>
    </div>
  );
}

/** "Other": a choice answered in words, opened on a click so the choices stay the first thing. */
function OtherWords({ open, onOpen, children }: { open: boolean; onOpen: () => void; children: ReactNode }) {
  if (open) return <>{children}</>;
  return <button type="button" className="org-answer-other" data-testid="org-answer-other" onClick={onOpen}>Other…</button>;
}

const Failed = ({ failure }: { failure: AnswerFailure | undefined }) =>
  failure ? <div className="org-answer-error" role="alert" data-testid="org-answer-error">{failure.message}</div> : null;

interface FormProps {
  alert: OrgAlertView;
  /** The last try at this ask failed: its reason and the words to put back. */
  failure: AnswerFailure | undefined;
  /** The answer goes now: the row goes with it (the page answers the click before the server
   *  does); settle it with the server's answer. */
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
  useEffect(() => { if (fresh && !letter) onWords(); }, [fresh, letter, onWords]);
  if (!letter) return <div className="org-answer-note" role="status">{fresh ? '' : 'Loading the letter…'}</div>;
  const pick = (actionId: string) => {
    const settle = onSend();
    answerLetter(letter.id, actionId).then((result) => {
      if (result.letter) patchLetter(letter.id, { answered: result.letter.answered, read: true });
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, actionId, delivery: result.delivery });
      settle();
    }, (err: unknown) => {
      const status = (err as { status?: number }).status;
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'letter', letterId: letter.id, error: String(err) });
      // Answered somewhere else: nothing is left to answer here.
      if (status === 409) settle();
      else settle({ message: 'Not sent. Try again.' });
    });
  };
  return (
    <>
      <Options
        testId="org-answer-letter"
        options={letter.actions!.map((a) => ({ value: a.id, label: a.label, ...(a.description ? { title: a.description } : {}) }))}
        onPick={pick}
      />
      <Failed failure={failure} />
    </>
  );
}

interface ChoiceFound { owner: string; id: string; title: string; options: Array<{ value: string; label: string }>; recommended?: string }

function ChoiceAnswer({ alert, failure, onSend, onWords }: FormProps & { onWords: () => void }) {
  const [found, setFound] = useState<ChoiceFound | null | undefined>(undefined);
  const [other, setOther] = useState(!!failure?.draft);
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
  const words = (
    <WordsField placeholder={found.options.length ? 'Say it in your words' : 'Your answer'} initial={failure?.draft ?? ''} draftKey={wordsKey} onSend={(t) => answer({ text: t })} autoFocus={found.options.length > 0} />
  );
  return (
    <>
      {found.options.length > 0 && (
        <Options testId="org-answer-choice" options={found.options} {...(found.recommended ? { recommended: found.recommended } : {})} onPick={(v) => answer({ option: v })} />
      )}
      {/* A choice with no options is answered in words, on its Board all the same. */}
      {found.options.length ? <OtherWords open={other} onOpen={() => setOther(true)}>{words}</OtherWords> : words}
      <Failed failure={failure} />
    </>
  );
}

/** The ask's own form (user_status.askForm), or its words: one message into the task's session. */
function SessionAnswer({ alert, failure, onSend, sessionId, summary, shape }: FormProps & {
  sessionId: string | null; summary: string; shape: 'yes_no' | 'single' | 'multi' | 'text';
}) {
  const { send } = useSessionSend(sessionId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [other, setOther] = useState(!!failure?.draft);
  // A failed session: its probe says so, or the task's status names the failure as its ask.
  const failed = alert.kind === 'error' || alert.source === 'error';
  if (!sessionId) return <div className="org-answer-note">It has no session to answer. Open it to start one.</div>;
  const wordsKey = sessionDraftKey(sessionId);
  const reply = (text: string, words?: string) => {
    const settle = onSend();
    void send(sessionId, text).catch(() => false).then((ok) => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape, sessionId, ok });
      if (ok && words !== undefined) clearDraft(wordsKey);
      settle(ok ? undefined : { message: 'Not sent. Try again.', ...(words !== undefined ? { draft: words } : {}) });
    });
  };
  const retry = () => {
    const settle = onSend();
    retrySession(sessionId).then((result) => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'retry', sessionId, status: result.status });
      // Its folder is gone: a retry sent nothing. The session's own panel has the way on.
      if (result.status === 'folder_gone') settle({ message: `Its folder ${result.cwdGone.cwd} is gone. Open the session to continue it in a new folder.` });
      else settle();
    }, (err: unknown) => {
      log.warn('org-page', 'org alert retry failed', { taskId: alert.taskId, sessionId, error: String(err) });
      settle({ message: 'Retry failed.' });
    });
  };
  const options: AskOption[] = formOptions(alert.form);
  const recommended = options.find((o) => o.recommended)?.id;
  const words = (
    <WordsField
      placeholder={failed ? 'Or tell it what to do' : shape === 'text' ? 'Your answer' : 'Say it in your words'}
      initial={failure?.draft ?? ''}
      draftKey={wordsKey}
      onSend={(t) => reply(answerMessage(alert.form, summary, { words: t }), t)}
      autoFocus={shape !== 'text'}
    />
  );
  return (
    <>
      {failed && <Options testId="org-answer-retry" options={[{ value: 'retry', label: 'Retry', title: 'Start the failed session again' }]} onPick={retry} />}
      {(shape === 'yes_no' || shape === 'single') && options.length > 0 && (
        <Options testId="org-answer-form" options={options.map((o) => ({ value: o.id, label: o.label }))} {...(recommended ? { recommended } : {})} onPick={(id) => reply(answerMessage(alert.form, summary, { picked: [id] }))} />
      )}
      {shape === 'multi' && options.length > 0 && (
        <div className="org-answer-multi" data-testid="org-answer-multi">
          {options.map((o) => (
            <label key={o.id} className={`org-answer-check${picked.has(o.id) ? ' is-on' : ''}`} data-testid="org-answer-check" data-value={o.id}>
              <input
                type="checkbox"
                checked={picked.has(o.id)}
                onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}
              />{o.label}
            </label>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="org-answer-send-picked"
            disabled={!picked.size}
            onClick={() => reply(answerMessage(alert.form, summary, { picked: options.filter((o) => picked.has(o.id)).map((o) => o.id) }))}
          >Send{picked.size ? ` ${picked.size}` : ''}</button>
        </div>
      )}
      {shape === 'text' || failed ? words : <OtherWords open={other} onOpen={() => setOther(true)}>{words}</OtherWords>}
      <Failed failure={failure} />
    </>
  );
}

/** The ask's answer, in its row. `onAnswer` hides the row the moment an answer goes and returns how
 *  to settle it; `failure` (the last try failed) shows the reason with the form. */
export function OrgInlineAnswer({ alert, task, summary, onAnswer, failure }: {
  alert: OrgAlertView;
  task: Task | undefined;
  summary: string;
  onAnswer: (taskId: string) => AnswerSettle;
  failure?: AnswerFailure;
}) {
  // A letter or a choice this browser cannot find takes the words form instead.
  const [wordsOnly, setWordsOnly] = useState(false);
  const toWords = useMemo(() => () => setWordsOnly(true), []);
  const sessionId = task ? resolveTaskSessionId(task) : null;
  const shape = wordsOnly ? 'text' : inlineShape(alert);
  const send = (): AnswerSettle => onAnswer(alert.taskId);
  // A live prompt answers through its own card, which says when it was taken.
  const promptDone = () => { onAnswer(alert.taskId)(); };
  return (
    <div className="org-answer-inline" data-testid="org-answer-inline" data-shape={shape} data-task-id={alert.taskId}>
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
        <SessionAnswer alert={alert} failure={failure} onSend={send} sessionId={sessionId} summary={summary} shape={shape === 'prompt' ? 'text' : shape} />
      )}
    </div>
  );
}
