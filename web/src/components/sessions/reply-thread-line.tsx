/**
 * The thread line under a chat message (experiment reply_thread_line; 2026-11-20, the user,
 * translated: "every time I reply I can't tell which one I replied to ... click it and jump to that
 * thread"): one line of the bubble's own small gray type, a curved arrow and the thread title under his message,
 * right-aligned, and the same with " · <task>" under the answer, left-aligned, in place of the
 * About pills. One click opens that thread on the Threads of the node that holds it, scrolled to
 * it. The thread is the one the row carries (src/core/org/reply-thread.ts): the one Walnut filed
 * his message under, never a guess here.
 *
 * The chat's host (the Org page's node, a task's session panel) says whose chat it is and how its
 * own Threads come into view; a thread held elsewhere (moved on, a task's below) opens there.
 */
import { createContext, useContext } from 'react';
import type { ReplyThread } from '@open-walnut/reply-thread';
import { useExperimental } from '@/hooks/useExperimental';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useOpenTask } from '@/hooks/useOpenTask';
import { useTaskTitle } from '@/components/transfer/TransferLinks';
import { askThreadFocus, topShows } from '@/components/org/thread-focus';
import { useOpenThread } from '@/components/org/open-thread';
import { log } from '@/utils/log';
import '@/styles/reply-thread-line.css';

export interface ReplyThreadHost {
  /** The task whose chat this is. */
  chat: string;
  /** Its threads as last read (useOrgThreads), so a title renamed since the rows came reads new. */
  threads: ReadonlyArray<{ id: string; title: string; movedTo?: unknown }> | null;
  /** Bring this chat's own Threads into view. */
  showOwn: () => void;
}

export const ReplyThreadContext = createContext<ReplyThreadHost | null>(null);

/** Is the line drawn at all (the experiment)? Off: the chat looks as it always did. */
export function useReplyThreadLineOn(): boolean {
  return useExperimental('reply_thread_line');
}

/** Open a thread where it is kept: this chat's own Threads, or the node or task that holds it now. */
function useOpenReplyThread(): (t: ReplyThread) => void {
  const host = useContext(ReplyThreadContext);
  const openThread = useOpenThread();
  return useLeanCallback((t: ReplyThread) => {
    if (!host || t.gone) return;
    const node = t.node ?? host.chat;
    log.info('reply-thread', 'thread line opened', { taskId: host.chat, node, threadId: t.id });
    // The thread on show above this chat (TopThread) steps to it there; any other opens its Threads.
    if (node === host.chat) { askThreadFocus(node, t.id); if (!topShows(node, t.id)) host.showOwn(); return; }
    openThread(node, t.id);
  }, [host, openThread]);
}

/**
 * The mark in front of the title: one round stroke from the message straight down, round at the
 * bottom, then right to the thread, ending in an arrowhead pointing right; no corner anywhere (2026-11-20, the user:
 * "not this stiff 90 degrees: a perfect curve with an arrow", then "not this kind of like bit curved
 * from 90", drawing a round U that ends in an arrow; 2026-11-21 its variant B, drawn inside the 12x12 box so
 * neither client clips it). Drawn in the text's own color and weight, so
 * both themes read it. The phone draws the same path (TimelineRowBuilder.replyArc).
 */
function ReplyArc() {
  return (
    <svg className="msg-reply-thread-arrow" data-testid="msg-reply-thread-arc" viewBox="0 0 12 12" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d="M2.4 1.2 C2 6.2 2.9 9.7 6 9.8 C7.3 9.9 8.5 9.8 10 9.7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8.4 8.1 L10.1 9.7 L8.4 11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A reply that names its tasks and no thread: the thread line's own arrow, then the tasks, shown
 * as they are with nothing to open first (2026-11-23, the user: "use the same small arrow" the
 * threads use, then "why collapse it again? ... just show the little arrow and then show it").
 */
export function AboutLine({ ids }: { ids: readonly string[] }) {
  if (!ids.length) return null;
  return (
    <div className="msg-reply-thread is-answer" data-testid="msg-about" data-ids={ids.join(',')}>
      <ReplyArc />
      {ids.map((id, i) => <TaskPart key={id} id={id} first={i === 0} />)}
    </div>
  );
}

function TaskPart({ id, first = false }: { id: string; first?: boolean }) {
  const title = useTaskTitle(id);
  const openTask = useOpenTask();
  return (
    <>
      {!first && <span className="msg-reply-thread-sep" aria-hidden="true">{'·'}</span>}
      <button type="button" className="msg-reply-thread-task" data-testid="msg-reply-thread-task" data-task-id={id}
        onClick={(e) => { e.stopPropagation(); openTask(id); }}>{title ?? id}</button>
    </>
  );
}

export function ReplyThreadLine({ thread, side, tasks }: {
  thread: ReplyThread;
  /** Under his message (right) or under the answer (left). */
  side: 'user' | 'answer';
  /** The answer's tasks (its About), the chat's own left out. */
  tasks?: readonly string[];
}) {
  const host = useContext(ReplyThreadContext);
  const open = useOpenReplyThread();
  const live = !thread.node ? host?.threads?.find((x) => x.id === thread.id) : undefined;
  const title = (live && !live.movedTo ? live.title : undefined) ?? thread.title ?? 'A thread';
  const opens = !!host && !thread.gone;
  return (
    <div className={`msg-reply-thread is-${side}`} data-testid="msg-reply-thread" data-thread-id={thread.id} data-side={side}>
      <button
        type="button"
        className="msg-reply-thread-link"
        data-testid="msg-reply-thread-open"
        disabled={!opens}
        title={opens ? `Open the thread “${title}”` : 'This thread is no longer kept'}
        onClick={(e) => { e.stopPropagation(); open(thread); }}
      >
        <ReplyArc />
        <span className="msg-reply-thread-title">{title}</span>
      </button>
      {tasks?.map((id) => <TaskPart key={id} id={id} />)}
    </div>
  );
}
