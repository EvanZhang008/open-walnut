/**
 * Answer one ask of the Org rail right in its row (2026-10-31, the user: "make the answer layout if
 * there are space so user can just click ... yes and noe, or single or multiple choice, or text
 * right, ideally prefer non text"). The form is the ask's own, never a guess (org-ask-form.ts): a
 * live prompt shows its own controls (Allow / Deny, a question's options), a decision letter its
 * actions, a Board choice its options, a task's ask form its Yes / No, its choices (multi: check,
 * then Send) or a line; an ask with no shape a line that goes to that task's session. A choice can
 * also be answered in words, in the same box a thread card answers with, shown at once: no click opens
 * it (2026-11-20, the user: "Why the fuck i need to clcik reply ... Can it jsut show inbox and I can
 * tuype?"). It never takes the focus by itself: a page shows many of them. Every kind takes words (2026-11-19, the user: "这个能不能搞得像 thread
 * 一样……我想 reply 之类的"): a letter's reply answers it, a tool prompt's declines the step with
 * them, and an approval's goes to its session while the approval still waits for Approve or Deny.
 *
 * The row answers the click, not the server: the row goes the moment the answer is sent, and a
 * failure brings it back with the reason (a busy server on the Mac held a 24 ms op for 5 s,
 * 2026-09-29). Its words and pictures wait in the box's own draft until the server took them: every
 * send resolves true or false to the composer, which keeps them on false.
 * Each box keeps its own draft (never the session's composer, nor the Board's), so words typed here
 * never show up in another box to be sent twice.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useMinuteValue } from '@/utils/minute-clock';
import type { Task } from '@open-walnut/core';
import { apiGet, apiPut } from '@/api/client';
import { answerLetter, humanReplyToLetter } from '@/api/human-inbox';
import { respondToPermission, retrySession } from '@/api/sessions';
import { Checkbox } from '@/components/controls';
import { KanbanCardPrompt } from '@/components/board/kanban/KanbanCardPrompt';
import { ReplyComposer } from '@/components/chat/ReplyComposer';
import { buildImageRefsPayload } from '@/api/image-upload';
import type { ImageAttachment } from '@/api/chat';
import { getLetterSnapshot, loadLetters, patchLetter, subscribeLetters } from '@/components/inbox/letter-store';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useExperimental } from '@/hooks/useExperimental';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import { openLetterFor } from './org-answer-shape';
import { answerMessage, formOptions, inlineShape, type AskOption } from './org-ask-form';
import type { OrgAlertView } from './org-channels-model';
import '@/styles/inline-answer.css';
import { LoadingState } from '@/components/common/EmptyState';

/** Where an answer failed: the reason (the words and pictures stay in the box's own draft). */
export interface AnswerFailure { message: string; /** What failed: an answer (default), or the row's snooze, which the row says itself. */ of?: 'answer' | 'snooze' }
/** Settles an answer sent from a row: no argument once it was taken, a failure to bring the row back. */
export type AnswerSettle = (failure?: AnswerFailure) => void;

/**
 * A choice's buttons, the one rendering wherever a choice is answered (2026-11-20, the user: "it has
 * to be unified ... it can always give an option"): an ask's options, a letter's actions, a Board
 * choice, a thread's options. The recommended one first, marked "Recommended" (a CSS mark on
 * data-recommended, so the label stays the button's text); its line of detail beside the label in the
 * card (data-detail, ask-card.css) and whole on hover. Its click is
 * the answer. With threads_one_card off (core/org/one-card.ts) the buttons read as before it: in
 * their own order, the recommended one only highlighted.
 */
export function AskOptions({ options, recommended, onPick, testId, disabled }: {
  options: ReadonlyArray<{ value: string; label: string; title?: string }>;
  recommended?: string;
  onPick: (value: string) => void;
  testId: string;
  /** Its answer is on its way, or went: no second one. */
  disabled?: boolean;
}) {
  const oneCard = useExperimental('threads_one_card');
  const ordered = oneCard && recommended ? [...options.filter((o) => o.value === recommended), ...options.filter((o) => o.value !== recommended)] : options;
  return (
    <div className="org-answer-options" data-testid={testId}>
      {ordered.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn btn-sm${o.value === recommended ? ' btn-primary' : ''}`}
          data-testid="org-answer-option"
          data-value={o.value}
          {...(oneCard && o.value === recommended ? { 'data-recommended': 'true' } : {})}
          {...(o.title || o.value === recommended ? { 'aria-description': o.title ?? 'Recommended' } : {})}
          {...(oneCard && o.title ? { title: o.title, 'data-detail': o.title } : {})}
          {...(disabled ? { disabled: true } : {})}
          onClick={() => onPick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/** Sends words from a box: true once taken, false keeps them (and their pictures) in it. */
type WordsSend = (text: string, images?: ImageAttachment[]) => Promise<boolean>;
const kept = Promise.resolve(false);

/**
 * A thread's own choices (OrgThread.options, core/org/thread-options.ts), on its card and on the card
 * of a thread below: AskOptions, and a click is his answer in words, the label. Once one went the
 * buttons stay off until the thread's choices change (its answer is in, its card is about to read
 * working), so a second click never answers twice; a failed send turns them on again.
 */
export function ThreadOptions({ thread, onAnswer }: {
  thread: { id: string; state: string; options?: ReadonlyArray<AskOption> };
  onAnswer: (label: string) => Promise<boolean>;
}) {
  // Buttons only with threads_one_card on (core/org/one-card.ts): off, a card as before it.
  const oneCard = useExperimental('threads_one_card');
  const options = oneCard && thread.state === 'needs' ? thread.options ?? [] : [];
  const sig = `${thread.id}:${options.map((o) => `${o.id}=${o.label}`).join('|')}`;
  const [busy, setBusy] = useState<string | null>(null);
  if (!options.length) return null;
  const recommended = options.find((o) => o.recommended)?.id;
  return (
    <AskOptions
      testId="org-thread-options"
      options={options.map((o) => ({ value: o.id, label: o.label, ...(o.detail ? { title: o.detail } : {}) }))}
      {...(recommended ? { recommended } : {})}
      disabled={busy === sig}
      onPick={(id) => {
        const o = options.find((x) => x.id === id);
        if (!o || busy === sig) return;
        setBusy(sig);
        void onAnswer(o.label).catch(() => false).then((ok) => { if (!ok) setBusy(null); });
      }}
    />
  );
}

/** A line in the user's own words: the chat's own composer (ReplyComposer), so @, / and pictures
 *  work as in the chat. Kept under `draftKey`, this box's own, until the answer is taken. */
function WordsField({ placeholder, draftKey, onSend, sessionId, taskId }: {
  placeholder: string;
  draftKey: string;
  onSend: WordsSend;
  sessionId?: string | null;
  taskId?: string;
}) {
  return <ReplyComposer placeholder={placeholder} draftKey={draftKey} onSend={onSend} sessionId={sessionId ?? null} {...(taskId ? { taskId } : {})} />;
}

/** Runs an answer that settles its row, and tells the box whether it was taken. */
function settled(run: (settle: AnswerSettle) => void, settle: AnswerSettle): Promise<boolean> {
  return new Promise((resolve) => run((failure) => { settle(failure); resolve(!failure); }));
}

const Failed = ({ failure }: { failure: AnswerFailure | undefined }) =>
  failure ? <div className="org-answer-error" role="alert" data-testid="org-answer-error">{failure.message}</div> : null;

interface FormProps {
  alert: OrgAlertView;
  /** The last try at this ask failed: its reason and the words to put back. */
  failure: AnswerFailure | undefined;
  /** The answer goes now: the row goes with it (the page answers the click before the server
   *  does); settle it with the server's answer. `said` is what the answer says (a pick's label, the
   *  words), for a card that keeps it in sight once answered (actions/ask-pages.ts). */
  onSend: (said?: string) => AnswerSettle;
}

function LetterAnswer({ alert, failure, onSend, onWords }: FormProps & { onWords: () => void }) {
  const snap = useSyncExternalStore(subscribeLetters, getLetterSnapshot, getLetterSnapshot);
  // The letter's recommended option is marked only with threads_one_card on (core/org/one-card.ts).
  const oneCard = useExperimental('threads_one_card');
  // The store follows new letters only while an inbox is on screen: read it now, and take the
  // line instead only when this read has no letter either (a held copy shows at once).
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadLetters().finally(() => { if (alive) setFresh(true); });
    return () => { alive = false; };
  }, []);
  // On the minute clock: the letter's grace window ends without a new read of the list.
  const letter = useMinuteValue((now) => openLetterFor(snap.letters, alert.taskId, now, alert.itemId));
  useEffect(() => { if (fresh && !letter) onWords(); }, [fresh, letter, onWords]);
  // Fresh with no letter: the words box takes over (onWords), so nothing shows meanwhile.
  if (!letter) return fresh ? <div className="org-answer-note" role="status" /> : <LoadingState size="row" title="Loading the letter…" />;
  // Words written back answer the letter as a pick does (the server's one rule, awaitsUserDecision).
  const replyWords: WordsSend = (text, images) => {
    if (!text.trim()) return kept;
    return settled((settle) => humanReplyToLetter(letter.id, text, images).then((result) => {
      if (result.letter) patchLetter(letter.id, { answered: result.letter.answered, read: true });
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'letter-reply', letterId: letter.id, images: images?.length ?? 0 });
      settle();
    }, (err: unknown) => {
      log.warn('org-page', 'org alert reply failed', { taskId: alert.taskId, letterId: letter.id, error: String(err) });
      settle({ message: 'Not sent. Try again.' });
    }), onSend(text));
  };
  const pick = (actionId: string) => {
    const settle = onSend(letter.actions?.find((a) => a.id === actionId)?.label);
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
      <AskOptions
        testId="org-answer-letter"
        options={letter.actions!.map((a) => ({ value: a.id, label: a.label, ...(a.description ? { title: a.description } : {}) }))}
        {...(oneCard && letter.actions!.find((a) => a.recommended) ? { recommended: letter.actions!.find((a) => a.recommended)!.id } : {})}
        onPick={pick}
      />
      <ReplyField placeholder="Reply…" onSend={replyWords} taskId={alert.taskId} draftKey={`draft:letter-reply:${letter.id}`} />
      <Failed failure={failure} />
    </>
  );
}

/** The words box beside an ask's own buttons, always shown. One component wherever an ask is answered. */
export function ReplyField({ placeholder, onSend, draftKey, sessionId = null, taskId }: {
  placeholder: string;
  onSend: WordsSend;
  /** The card's own box: its words wait here until sent. */
  draftKey: string;
  sessionId?: string | null;
  taskId?: string;
}) {
  return <WordsField placeholder={placeholder} draftKey={draftKey} onSend={onSend} sessionId={sessionId} {...(taskId ? { taskId } : {})} />;
}

/** An approval answered in words: they go to its session as the user's message; only Approve or
 *  Deny answers the approval itself (a tap or a signature, never words). */
export function ApprovalReply({ sessionId, summary, onSent }: { sessionId: string | null; summary: string; onSent?: () => void }) {
  const { send } = useSessionSend(sessionId);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [failure, setFailure] = useState<AnswerFailure | undefined>(undefined);
  if (!sessionId) return null;
  const reply: WordsSend = (text, images) => {
    if (!text.trim()) return kept;
    setNote(null);
    setFailure(undefined);
    return send(sessionId, `About the approval "${summary}": ${text}`, images).catch(() => false).then((ok) => {
      log.info('action-needed', 'approval reply sent', { sessionId, ok, images: images?.length ?? 0 });
      if (ok) { setNote({ ok: true, text: 'Sent to its session. The approval still waits for Approve or Deny.' }); onSent?.(); }
      else setFailure({ message: 'Not sent. Try again.' });
      return ok;
    });
  };
  return (
    <>
      <ReplyField placeholder="Tell it something (Approve still needed)" onSend={reply} sessionId={sessionId} draftKey={`draft:approval-reply:${sessionId}:${summary}`} />
      {note && <div className="org-answer-note" role="status" data-testid="approval-reply-sent">{note.text}</div>}
      <Failed failure={failure} />
    </>
  );
}

export interface ChoiceFound { owner: string; id: string; title: string; options: Array<{ value: string; label: string }>; recommended?: string }

function ChoiceAnswer({ alert, failure, onSend, onWords, known }: FormProps & { onWords: () => void; known?: ChoiceFound }) {
  const [found, setFound] = useState<ChoiceFound | null | undefined>(known);
  useEffect(() => {
    // A thread that holds the choice (core/org/choice-thread-model.ts) names it: nothing to look up.
    if (known) return;
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
  }, [alert.taskId, known]);
  useEffect(() => { if (found === null) onWords(); }, [found, onWords]);
  if (!found) return found === undefined ? <LoadingState size="row" title="Loading the choice…" /> : <div className="org-answer-note" role="status" />;
  const answer = (body: { option?: string; text?: string }, images?: ImageAttachment[]): Promise<boolean> => {
    // A choice's words are its answer: a picture goes with words, never alone ('' clears the words).
    if (images?.length && !body.option && !body.text) { onSend()({ message: 'Add a few words to go with the picture.' }); return kept; }
    // Pictures go up over HTTP first; the answer carries their names (api/image-upload.ts).
    return settled((settle) => buildImageRefsPayload(images).then((pictures) => apiPut(`/api/v1/tasks/${encodeURIComponent(found.owner)}/board/choices/${encodeURIComponent(found.id)}`, { ...body, ...pictures })).then(() => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape: 'choice', owner: found.owner, choiceId: found.id, option: body.option ?? '' });
      settle();
    }, (err: unknown) => {
      log.warn('org-page', 'org alert answer failed', { taskId: alert.taskId, shape: 'choice', error: String(err) });
      // A replica answers 501 to every Board write.
      const message = (err as { status?: number }).status === 501 ? 'Boards are read only here. Answer it from the main Walnut.' : 'Not saved. Try again.';
      settle({ message });
    }), onSend(body.text ?? found.options.find((o) => o.value === body.option)?.label));
  };
  const words = (
    <WordsField placeholder="Reply…" draftKey={`draft:choice-reply:${found.owner}:${found.id}`} onSend={(t, images) => answer({ text: t }, images)} taskId={alert.taskId} />
  );
  return (
    <>
      {found.options.length > 0 && (
        <AskOptions testId="org-answer-choice" options={found.options} {...(found.recommended ? { recommended: found.recommended } : {})} onPick={(v) => answer({ option: v })} />
      )}
      {/* A choice with no options is answered in words, on its Board all the same. */}
      {words}
      <Failed failure={failure} />
    </>
  );
}

/** The ask's own form (user_status.askForm), or its words: one message into the task's session. */
function SessionAnswer({ alert, failure, onSend, sessionId, summary, shape, threadId }: FormProps & {
  sessionId: string | null; summary: string; shape: 'yes_no' | 'single' | 'multi' | 'text';
  /** Answered on the thread that holds the ask: the answer is filed under it. */
  threadId?: string;
}) {
  const { send } = useSessionSend(sessionId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // A failed session: its probe says so, or the task's status names the failure as its ask.
  const failed = alert.kind === 'error' || alert.source === 'error';
  if (!sessionId) return <div className="org-answer-note">It has no session to answer. Open it to start one.</div>;
  const reply = (text: string, images?: ImageAttachment[], said?: string): Promise<boolean> => settled((settle) => {
    void send(sessionId, text, images, threadId ? { threadId } : undefined).catch(() => false).then((ok) => {
      log.info('org-page', 'org alert answered', { taskId: alert.taskId, shape, sessionId, ok, images: images?.length ?? 0 });
      settle(ok ? undefined : { message: 'Not sent. Try again.' });
    });
  }, onSend(said));
  const retry = () => {
    const settle = onSend('Retry');
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
      placeholder={failed ? 'Or tell it what to do' : 'Reply…'}
      draftKey={`draft:ask-reply:${sessionId}:${alert.itemId ?? alert.taskId}`}
      sessionId={sessionId}
      taskId={alert.taskId}
      onSend={(t, images) => {
        // The words are the answer: a picture goes with them, never as "(no answer)".
        if (!t.trim() && images?.length) { onSend()({ message: 'Add a few words to go with the picture.' }); return kept; }
        return reply(answerMessage(alert.form, summary, { words: t }), images, t);
      }}
    />
  );
  return (
    <>
      {failed && <AskOptions testId="org-answer-retry" options={[{ value: 'retry', label: 'Retry', title: 'Start the failed session again' }]} onPick={retry} />}
      {(shape === 'yes_no' || shape === 'single') && options.length > 0 && (
        <AskOptions testId="org-answer-form" options={options.map((o) => ({ value: o.id, label: o.label, ...(o.detail ? { title: o.detail } : {}) }))} {...(recommended ? { recommended } : {})} onPick={(id) => reply(answerMessage(alert.form, summary, { picked: [id] }), undefined, options.find((o) => o.id === id)?.label)} />
      )}
      {shape === 'multi' && options.length > 0 && (
        <div className="org-answer-multi" data-testid="org-answer-multi">
          {options.map((o) => (
            <label key={o.id} className={`org-answer-check${picked.has(o.id) ? ' is-on' : ''}`} data-testid="org-answer-check" data-value={o.id}>
              <Checkbox
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
            onClick={() => reply(answerMessage(alert.form, summary, { picked: options.filter((o) => picked.has(o.id)).map((o) => o.id) }), undefined, options.filter((o) => picked.has(o.id)).map((o) => o.label).join(', '))}
          >Send{picked.size ? ` ${picked.size}` : ''}</button>
        </div>
      )}
      {words}
      <Failed failure={failure} />
    </>
  );
}

/** The ask's answer, in its row. `onAnswer` hides the row the moment an answer goes and returns how
 *  to settle it; `failure` (the last try failed) shows the reason with the form. */
export function OrgInlineAnswer({ alert, task, summary, onAnswer, failure, sessionId: askingSession, threadId, choice }: {
  alert: OrgAlertView;
  task: Task | undefined;
  summary: string;
  onAnswer: (taskId: string, said?: string) => AnswerSettle;
  failure?: AnswerFailure;
  /** The session that asks (an Action needed item's own), else the task's. */
  sessionId?: string;
  /** The thread that holds this ask (core/org/thread-report-ask.ts): a words answer is filed under it. */
  threadId?: string;
  /** The Board choice a thread holds (core/org/choice-thread-model.ts): answered by its own ids. */
  choice?: ChoiceFound;
}) {
  // A letter or a choice this browser cannot find takes the words form instead.
  const [wordsOnly, setWordsOnly] = useState(false);
  const toWords = useMemo(() => () => setWordsOnly(true), []);
  const sessionId = askingSession ?? (task ? resolveTaskSessionId(task) : null);
  const shape = wordsOnly ? 'text' : inlineShape(alert);
  const send = (said?: string): AnswerSettle => onAnswer(alert.taskId, said);
  // A live prompt answers through its own card, which says when it was taken.
  const promptDone = () => { onAnswer(alert.taskId)(); };
  return (
    <div className="org-answer-inline" data-testid="org-answer-inline" data-shape={shape} data-answer-task={alert.taskId}>
      {shape === 'prompt' && sessionId ? (<>
        <KanbanCardPrompt
          request={{ sessionId, toolName: alert.kind === 'question' ? 'AskUserQuestion' : alert.tool ?? '', ...(alert.itemId ? { requestId: alert.itemId } : {}) }}
          onAnswered={promptDone}
        />
        {/* A tool step answered in words declines it with them (a question's card has its own Other). */}
        {alert.kind !== 'question' && alert.itemId && (
          <ReplyField placeholder="Tell it what to do instead (declines this step)" sessionId={sessionId} taskId={alert.taskId} draftKey={`draft:prompt-reply:${alert.itemId}`} onSend={(text) => {
            if (!text.trim()) return kept;
            return settled((settle) => respondToPermission(sessionId, alert.itemId!, false, text).then(() => settle(), (err: unknown) => {
              log.warn('org-page', 'prompt reply failed', { taskId: alert.taskId, sessionId, error: String(err) });
              settle({ message: 'Not sent. Try again.' });
            }), onAnswer(alert.taskId, text));
          }} />
        )}
      </>) : shape === 'letter' ? (
        <LetterAnswer alert={alert} failure={failure} onSend={send} onWords={toWords} />
      ) : shape === 'choice' ? (
        <ChoiceAnswer alert={alert} failure={failure} onSend={send} onWords={toWords} {...(choice ? { known: choice } : {})} />
      ) : (
        <SessionAnswer alert={alert} failure={failure} onSend={send} sessionId={sessionId} summary={summary} shape={shape === 'prompt' ? 'text' : shape} {...(threadId ? { threadId } : {})} />
      )}
    </div>
  );
}
