/**
 * A thread of a task below this node, listed here while it waits on him (experiment
 * threads_pop_up, src/core/org/thread-popup.ts): the one ask card (actions/AskCard.tsx) with the
 * chat's own reply box. His words go to the task that owns it (POST .../threads with `thread`,
 * src/core/org/thread-reply.ts), never to this node's chat; the card says when the task cannot
 * take them now, and that a reply sent is not read yet.
 */
import { useRef, useState } from 'react';
import { AskCardFrame } from '@/components/actions/AskCard';
import { ReplyComposer } from '@/components/chat/ReplyComposer';
import { draftKey } from '@/utils/drafts';
import { useOpenTask } from '@/hooks/useOpenTask';
import { replyOnOrgThread, type OrgThread } from '@/api/org-threads';
import { log } from '@/utils/log';
import { randomId } from '@/utils/random-id';
import { AgentText } from '@/components/common/AgentText';
import { threadSummarySource } from './thread-text-source';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgThreadSnooze } from './OrgThreadSnooze';

export function PoppedThreadCard({ node, t, state }: { node: string; t: OrgThread; state: OrgThreadsState }) {
  const openTask = useOpenTask();
  const [failed, setFailed] = useState<string | null>(null);
  // One key per reply: a retry of the same send is filed once (threads-model.ts fileMessage).
  const key = useRef<string | null>(null);
  const owner = t.owner!;
  const unread = t.messages.some((m) => m.delivery?.state === 'pending' || m.delivery?.state === 'claimed');
  return (
    <li className="org-thread is-popped" data-testid="org-thread" data-thread-id={t.id} data-state={t.state} data-owner={owner.task_id}>
      <AskCardFrame
        testId="org-thread-popped"
        data={{ 'data-can-answer': t.can_answer_now === false ? 'false' : 'true' }}
        title={<button type="button" className="org-thread-link" data-testid="org-thread-owner" onClick={() => openTask(owner.task_id)}>{owner.title}</button>}
        question={<AgentText compact inline {...threadSummarySource(t)} text={t.ask?.trim() || t.title} testId="org-thread-popped-ask" />}
        detail={t.reply?.trim() ? <AgentText compact {...threadSummarySource(t)} text={t.reply} testId="org-thread-popped-summary" /> : undefined}
        status={(<>
          {t.can_answer_now === false && <p className="org-thread-stand-in-note" data-testid="org-thread-not-now">{owner.title} is not running now: your reply is kept and goes to it when it is back.</p>}
          {unread && <p className="org-thread-stand-in-note" data-testid="org-thread-unread-by-task">Sent, {owner.title} has not read it yet.</p>}
          {failed && <p className="org-thread-error" role="alert" data-testid="org-thread-popped-failed">{failed}</p>}
        </>)}
        answer={(
          <ReplyComposer
            placeholder={`Answer ${owner.title}`}
            draftKey={draftKey('thread-follow', t.id)}
            sessionId={null}
            taskId={owner.task_id}
            testId="org-thread-popped-input"
            sendTestId="org-thread-popped-send"
            onSend={async (text, images) => {
              setFailed(null);
              // The reply goes as words: pictures belong in the task's own chat for now.
              if (images?.length) { setFailed(`Pictures go in ${owner.title}'s own chat: open it to send them.`); return false; }
              try {
                key.current ??= `pr-${randomId().replace(/-/g, '').slice(0, 24)}`;
                await replyOnOrgThread(node, t.id, text, t.ask_id, key.current);
                key.current = null;
                return true;
              } catch (err) {
                log.warn('org-threads', 'reply below not sent', { taskId: node, threadId: t.id, owner: owner.task_id, error: err instanceof Error ? err.message : String(err) });
                setFailed('Not sent. Your words are still here.');
                return false;
              }
            }}
          />
        )}
        tools={<OrgThreadSnooze title={t.title} current={undefined} onSnooze={(until) => void state.update(t.id, { snooze: until })} />}
      />
    </li>
  );
}
