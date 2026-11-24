/**
 * A thread card's answer parts (OrgThreads.tsx ThreadCard): the box to follow it up in, the line
 * naming the task that already asks its decision, Snooze and the Watch eye, and the answer row of a card
 * that waits on him. Moved out of OrgThreads.tsx whole.
 */
import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { ICON_EYE, ICON_EYE_FILLED } from '@/components/common/Icons';
import { ReplyComposer } from '@/components/chat/ReplyComposer';
import type { ImageAttachment } from '@/api/chat';
import { draftKey } from '@/utils/drafts';
import { resolveTaskSessionId } from '@/utils/session-status';
import { useOpenTask } from '@/hooks/useOpenTask';
import { AskCardFrame } from '@/components/actions/AskCard';
import type { OrgThread } from '@/api/org-threads';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgThreadSnooze } from './OrgThreadSnooze';
import { ThreadOptions } from './OrgInlineAnswer';

/** Send a message filed under a thread; null when the node has no chat yet. */
export type OnFollowUp = ((threadId: string, text: string, images?: ImageAttachment[]) => Promise<boolean>) | null;

/** The box to follow a thread up in, always on its card: no click opens it (2026-11-20, the user:
 *  "why thead nede to click follow up, just have. ainbox bar there ok"). The chat's own composer
 *  (chat/ReplyComposer.tsx): @, /, pictures and the mic as in the chat, its words kept per thread
 *  until sent, and kept in the box when a send fails. It never takes the focus by itself: a page
 *  shows many of them. */
export function FollowUp({ threadId, title, owner, onSend }: {
  threadId: string; title: string;
  /** The node's own task: its session's commands on /, where a file goes, and left out of @. */
  owner: Task | undefined;
  onSend: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const sessionId = owner ? resolveTaskSessionId(owner) : null;
  return (
    <div className="org-thread-follow" data-testid="org-thread-follow" aria-label={`Follow up on \u201c${title}\u201d`} role="group">
      <ReplyComposer
        placeholder="Follow up on this request"
        draftKey={draftKey('thread-follow', threadId)}
        sessionId={sessionId}
        {...(owner ? { taskId: owner.id } : {})}
        testId="org-thread-follow-input"
        sendTestId="org-thread-follow-send"
        onSend={async (text, images) => {
          setFailed(false);
          const ok = await onSend(text, images).catch(() => false);
          if (!ok) setFailed(true);
          return ok;
        }}
      />
      {failed && <span className="org-thread-error" data-testid="org-thread-follow-failed">Not sent. Your words and pictures are still here.</span>}
    </div>
  );
}

/**
 * The task that already asks him this thread's decision: he answers it there (one click opens it).
 * `via: 'thread'`: this thread is a result, held by that task's own card on its subject while it
 * asks him and after he answered it there, or (`result`) while that card holds the task's newer
 * result and after he read it (core/org/thread-subject-pairs.ts).
 */
export function AskedIn({ a }: { a: NonNullable<OrgThread['askedIn']> }) {
  const openTask = useOpenTask();
  const held = a.via === 'thread';
  const [lead, rest] = held && a.result
    ? a.answered ? ['You read the result of', ' on this: it comes back here when there is news.'] : ['', ' has the result on this: read it on its card above. This one comes back when there is news here.']
    : held
    ? a.answered ? ['You answered', ' on this: it comes back here when there is news.'] : ['', ' asks you about this now: answer on its card. This one comes back when it stops asking.']
    : a.answered ? ['Decided in', ': nothing more to decide here.'] : ['Asked in', ': answer it there. This thread comes back if that task stops asking it.'];
  return (
    <p className="org-thread-follows org-thread-asked-in" data-testid="org-thread-asked-in" data-task-id={a.task} data-answered={a.answered ? 'true' : undefined} data-via={a.via} title={a.ask}>
      {lead}{lead ? ' ' : ''}
      <button type="button" className="btn btn-link" data-testid="org-thread-asked-in-task" onClick={() => openTask(a.task)}>{a.title}</button>
      {rest}
    </p>
  );
}

/** A card's Snooze (with Unsnooze while put aside) and its Watch eye (the task header's WatchButton look). */
export function ThreadTools({ t, snoozed, state, watched }: { t: OrgThread; snoozed: boolean; state: OrgThreadsState; watched: boolean }) {
  return (<>
    <OrgThreadSnooze
      title={t.title}
      current={snoozed ? t.snoozed?.until : undefined}
      onSnooze={(until) => void state.update(t.id, { snooze: until })}
    />
    {/* An icon: the row keeps one line in the side bar (the label is its name and tooltip). */}
    <button
      type="button" className={`btn btn-sm btn-ghost org-thread-watch-btn${watched ? ' is-watched' : ''}`} data-testid="org-thread-watch" aria-pressed={watched}
      aria-label={watched ? `Stop watching "${t.title}"` : `Watch "${t.title}"`}
      title={watched ? 'Watching \u00b7 click to take it off your Watching list' : 'Watch: keep it on your Watching list at the top, whatever its state; it stays in its own group too'}
      onClick={() => void state.update(t.id, { watch: !watched })}
    >{watched ? ICON_EYE_FILLED : ICON_EYE}</button>
  </>);
}

/**
 * A thread waiting on him, answered in the one ask card's row (actions/AskCard.tsx): its choices
 * as buttons (OrgInlineAnswer AskOptions, the recommended one first), the box, always shown, then
 * Snooze. A click is his answer in words (the label), filed under the thread like a typed reply.
 */
export function NeedsAnswer({ t, owner, onFollowUp, snoozed, state, watched }: {
  t: OrgThread; owner: Task | undefined; onFollowUp: OnFollowUp; snoozed: boolean; state: OrgThreadsState; watched: boolean;
}) {
  /** A click that did not go (a typed reply's failure is the box's own). */
  const [failed, setFailed] = useState(false);
  /** His reply went (typed or clicked): the card says so at once, until the thread moves on. */
  const [sentFor, setSentFor] = useState<string | null>(null);
  const answer = async (label: string): Promise<boolean> => {
    if (!onFollowUp) return false;
    setFailed(false);
    const ok = await onFollowUp(t.id, label).catch(() => false);
    if (!ok) setFailed(true); else { setSentFor(t.updatedAt); state.heard(t.id, undefined, label); }
    return ok;
  };
  const sent = sentFor === t.updatedAt;
  return (
    <AskCardFrame
      testId="org-thread-ask"
      className="org-thread-ask"
      status={failed
        ? <p className="org-thread-error" role="alert" data-testid="org-thread-ask-failed">Not sent. Try again.</p>
        : sent ? <p className="org-thread-stand-in-note" role="status" data-testid="org-thread-ask-sent">Your reply is sent.</p> : undefined}
      answer={onFollowUp ? (<>
        <ThreadOptions thread={t} onAnswer={answer} />
        {/* The thread's one box, the same on every open card. */}
        <FollowUp threadId={t.id} title={t.title} owner={owner} onSend={async (text, images) => {
          const ok = await onFollowUp(t.id, text, images);
          if (ok) { setSentFor(t.updatedAt); state.heard(t.id, undefined, text); }
          return ok;
        }} />
      </>) : undefined}
      tools={<ThreadTools t={t} snoozed={snoozed} state={state} watched={watched} />}
    />
  );
}
