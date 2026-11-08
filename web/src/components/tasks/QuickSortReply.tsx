/**
 * A Sort card's Reply (2026-11-07, the user: "I can type or speak a response right there, and once
 * said it goes away"): his words go to the task's session as his own message, the way the session
 * composer sends them (`session:send`, so they queue, deliver and show in the chat as typed there);
 * a task with no session yet is started with them as his first message. Enter sends, Shift+Enter is
 * a new line, Escape closes; the words are the session's draft, so nothing typed is lost on a close.
 *
 * The card leaves only once the words are known to be with the task (review round 2): a send goes
 * through the v1 send route with one `qm-` id per attempt, so a Retry after a lost answer is the same
 * message, never a second one; a start is followed until its record says started or failed.
 */
import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiPost } from '@/api/client';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { useDraft } from '@/hooks/useDraft';
import { sessionDraftKey } from '@/utils/composer-insert';
import { draftKey } from '@/utils/drafts';
import { resolveTaskSessionId } from '@/utils/session-status';
import { fetchTask, startTaskAsPerson } from '@/api/tasks';
import { log } from '@/utils/log';

const START_FOLLOW_MS = 120_000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Follows a start the server answered before its session came up, until its record settles. */
async function startSettled(taskId: string): Promise<void> {
  const until = Date.now() + START_FOLLOW_MS;
  while (Date.now() < until) {
    await wait(1500);
    const start = (await fetchTask(taskId).catch(() => null))?.last_start;
    if (start?.state === 'started') return;
    if (start?.state === 'failed') throw new Error(start.error || 'the task did not start');
    if (start?.state === 'unconfirmed') throw new Error(`its start could not be confirmed${start.error ? `: ${start.error}` : ''}. Check the task before sending again`);
  }
  throw new Error('it is still starting. Check the task before sending again');
}

/** Sends the words to the task: its session when it has one (`messageId` makes a retry the same
 *  message), else a start with them that is followed until it is up. */
export async function replyToTask(task: Task, message: string, messageId: string): Promise<void> {
  const sessionId = resolveTaskSessionId(task);
  if (sessionId) {
    await apiPost(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, { text: message, messageId }, { timeoutMs: 20_000 });
    return;
  }
  // `continued`: the task had a session after all, and the words went to it.
  const started = await startTaskAsPerson(task.id, message) as { started?: boolean; continued?: boolean };
  if (started.started !== true && !started.continued) await startSettled(task.id);
}

export function QuickSortReply({ task, onSent, onClose }: { task: Task; onSent: () => void; onClose: () => void }) {
  const sessionId = resolveTaskSessionId(task);
  const draft = useDraft(sessionId ? sessionDraftKey(sessionId) : draftKey('quick-sort-reply', task.id));
  const { text, setText } = draft;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  // One id per words sent: a Retry of the same words reuses it, new words get a new one.
  const attempt = useRef<{ text: string; id: string } | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const sendNow = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError('');
    const sentKey = draft.key;
    if (attempt.current?.text !== message) attempt.current = { text: message, id: `qm-${crypto.randomUUID()}` };
    try {
      await replyToTask(task, message, attempt.current.id);
      log.info('board', 'quick sort reply sent', { taskId: task.id, sessionId, started: !sessionId });
      draft.clear(sentKey);
      mic.current?.clear();
      onSent();
    } catch (err) {
      log.warn('board', 'quick sort reply failed', { taskId: task.id, sessionId, error: String(err) });
      setSending(false);
      setError((err instanceof Error ? err.message : String(err ?? '')).trim() || 'the task did not take it');
    }
  };
  const gate = useSendAfterDictation([mic], () => { void sendNow(); });
  const empty = !text.trim() && !gate.micBusy && !gate.waiting;

  return <div className="quick-sort-reply" data-testid="quick-sort-reply" data-sending={sending || undefined}
    onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <div className="quick-sort-reply-row">
      <textarea ref={ref} className="quick-sort-reply-input" rows={2} data-draft-key={draft.key ?? undefined}
        placeholder={sessionId ? 'Type or speak your reply' : 'Type or speak, and the task starts with it'}
        aria-label={`Reply to ${task.title}`} value={text} readOnly={sending}
        onChange={e => { setText(e.target.value); if (error) setError(''); }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); gate.send(); }
        }} />
      <BoxMic boxRef={ref} text={text} setText={v => { setText(v); if (error) setError(''); }} handleRef={mic} disabled={sending} />
    </div>
    {error && <div className="quick-sort-reply-error" role="alert">Couldn't send: {error}</div>}
    <div className="quick-sort-reply-actions">
      <button type="button" className="quick-sort-btn is-skip" onClick={onClose} disabled={sending}>Cancel</button>
      <button type="button" className="quick-sort-btn is-reply" data-sort-reply-send aria-disabled={empty || undefined} disabled={sending}
        onClick={gate.send} {...dictationWaitProps(gate, empty ? 'Type a reply first' : 'Send (Enter)')}>{sending ? 'Sending…' : error ? 'Retry' : 'Send'}</button>
    </div>
  </div>;
}
