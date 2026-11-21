/**
 * A thread of a task below this node, listed here while it waits on him (experiment
 * threads_pop_up, src/core/org/thread-popup.ts): the one ask card (actions/AskCard.tsx) with the
 * chat's own reply box. His words go to the task that owns it (POST .../threads with `thread`,
 * src/core/org/thread-reply.ts), never to this node's chat; the card says when the task cannot
 * take them now, and that a reply sent is not read yet.
 *
 * His reply reads as received the moment the server took it (2026-11-20, the user: once his words
 * are sent the card must never look unsent): his words under "Sent", then whether the task has read
 * them, from the message's own delivery. They are read from the thread's record (ThreadSentWords),
 * so a reload or a redraw keeps them. A failed send keeps his words in the box, with the reason.
 *
 * It reads as the group it is drawn in (thread-badge.ts): its title line starts with the group's dot
 * and word (ThreadState, as the node's own cards), and only in Needs you is its box an "Answer" box;
 * anywhere else the box follows the task up. Snoozed, it says until when
 * and offers Unsnooze (OrgThreadSnooze), as the node's own cards do.
 */
import { useEffect, useRef, useState } from 'react';
import { AskCardFrame } from '@/components/actions/AskCard';
import { ReplyComposer } from '@/components/chat/ReplyComposer';
import { draftKey } from '@/utils/drafts';
import { useOpenTask } from '@/hooks/useOpenTask';
import { replyOnOrgThread, type OrgThread, type OrgThreadMessage } from '@/api/org-threads';
import { log } from '@/utils/log';
import { randomId } from '@/utils/random-id';
import { AgentText } from '@/components/common/AgentText';
import { threadSummarySource } from './thread-text-source';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgThreadSnooze, SnoozedUntil } from './OrgThreadSnooze';
import { threadBadge } from './thread-badge';
import { ThreadState } from './ThreadState';
import { ThreadLetterAnswer, answersLetter } from './ThreadLetterAnswer';
import { ThreadOptions } from './OrgInlineAnswer';
import { ThreadSentWords } from './ThreadSentWords';

export function PoppedThreadCard({ node, t, state, now, snoozed, listed }: {
  node: string; t: OrgThread; state: OrgThreadsState; now: number;
  /** It is put aside now: it says until when, with Unsnooze. */
  snoozed: boolean;
  /** His view lists it now (listedForHim): its group. */
  listed: boolean;
}) {
  const openTask = useOpenTask();
  const [failed, setFailed] = useState<string | null>(null);
  // One key per reply: a retry of the same send is filed once (threads-model.ts fileMessage).
  const key = useRef<{ text: string; key: string } | null>(null);
  const owner = t.owner!;
  const badge = threadBadge(t, listed, now);
  const { group } = badge;
  const until = snoozed ? t.snoozed?.until : undefined;
  // A thread holding its task's own ask (core/org/thread-report-ask.ts): its question, then its own summary under it.
  const detail = t.heldAsk ? t.heldAsk.reply : t.reply;
  // His reply this card sent, from the server's answer: shown at once, until the thread's record
  // holds it; then forgotten, so a message split or moved away later never comes back from here.
  const [sent, setSent] = useState<OrgThreadMessage | null>(null);
  const recorded = !!sent && t.messages.some((m) => m.id === sent.id);
  useEffect(() => { if (recorded) setSent(null); }, [recorded]);
  // His words (typed, or a choice's label clicked) go to the task that owns the thread. A retry of
  // the same words keeps its key; other words (a click after a failed typed send) take a new one.
  const reply = async (text: string): Promise<boolean> => {
    setFailed(null);
    try {
      if (key.current?.text !== text) key.current = { text, key: `pr-${randomId().replace(/-/g, '').slice(0, 24)}` };
      const back = await replyOnOrgThread(node, t.id, text, t.ask_id, key.current.key);
      key.current = null;
      if (back.message) setSent(back.message);
      state.heard(t.id, back.thread);
      return true;
    } catch (err) {
      log.warn('org-threads', 'reply below not sent', { taskId: node, threadId: t.id, owner: owner.task_id, error: err instanceof Error ? err.message : String(err) });
      setFailed('Not sent. Your words are still here.');
      return false;
    }
  };
  return (
    <li className="org-thread is-popped" data-testid="org-thread" data-thread-id={t.id} data-state={t.state} data-group={group} data-owner={owner.task_id} data-snoozed={until ? 'true' : undefined}>
      <AskCardFrame
        testId="org-thread-popped"
        data={{ 'data-can-answer': t.can_answer_now === false ? 'false' : 'true' }}
        title={(<>
          <ThreadState badge={badge} />{' \u00b7 '}
          <button type="button" className="org-thread-link" data-testid="org-thread-owner" onClick={() => openTask(owner.task_id)}>{owner.title}</button>
        </>)}
        question={<AgentText compact inline {...threadSummarySource(t)} text={t.heldAsk?.ask || t.ask?.trim() || t.title} testId="org-thread-popped-ask" />}
        detail={detail?.trim() ? <AgentText compact {...threadSummarySource(t)} text={detail} testId="org-thread-popped-summary" /> : undefined}
        status={(<>
          {until && <SnoozedUntil until={until} now={now} />}
          {t.can_answer_now === false && <p className="org-thread-stand-in-note" data-testid="org-thread-not-now">{owner.title} is not running now: your reply is kept and goes to it when it is back.</p>}
          <ThreadSentWords t={t} owner={owner.title} justSent={sent} />
          {failed && <p className="org-thread-error" role="alert" data-testid="org-thread-popped-failed">{failed}</p>}
        </>)}
        // A thread holding a decision letter is answered by the letter (its buttons, its box).
        answer={answersLetter(t) ? <ThreadLetterAnswer t={t} /> : (<>
          <ThreadOptions thread={t} onAnswer={reply} />
          <ReplyComposer
            placeholder={group === 'needs' ? `Answer ${owner.title}` : `Follow up with ${owner.title}`}
            draftKey={draftKey('thread-follow', t.id)}
            sessionId={null}
            taskId={owner.task_id}
            testId="org-thread-popped-input"
            sendTestId="org-thread-popped-send"
            onSend={async (text, images) => {
              setFailed(null);
              // The reply goes as words: pictures belong in the task's own chat for now.
              if (images?.length) { setFailed(`Pictures go in ${owner.title}'s own chat: open it to send them.`); return false; }
              return reply(text);
            }}
          />
        </>)}
        tools={<OrgThreadSnooze title={t.title} current={until} onSnooze={(until) => void state.update(t.id, { snooze: until })} />}
      />
    </li>
  );
}
