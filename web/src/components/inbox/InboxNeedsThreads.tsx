/**
 * The inbox's first section: every thread that needs him, across all nodes, the most urgent first
 * (experiment inbox_needs_threads; the order is core/human-inbox/needs-model.ts, read by the server).
 *
 * Each is the same card the node's Threads and the top of its chat draw (OrgThreads ThreadItem),
 * over the node's own list (useOrgThreads: one list per node for the page), so a snooze, a pin or an
 * answer here is that node's at once. An answer goes the way it goes from the node's Threads: his
 * words, typed or a choice clicked, to the node's chat filed under the thread (a send with
 * `threadId`), or a decision letter's own answer route for a thread that holds one. Once the node's
 * list says it no longer needs him (his reply made it working, it was answered elsewhere), the card
 * leaves here too, before the inbox's own list is read again.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { sharedAnswers } from '@open-walnut/thread-view';
import { needsThreadsOf } from '@open-walnut/inbox-needs';
import type { ImageAttachment } from '@/api/chat';
import type { InboxNeedsThread } from '@/api/inbox-needs';
import type { OrgThread } from '@/api/org-threads';
import { useStoreTask } from '@/contexts/TasksContext';
import { useNamedTasks } from '@/components/org/useNamedTasks';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { resolveTaskSessionId } from '@/utils/session-status';
import { ThreadItem } from '@/components/org/OrgThreads';
import { useOrgThreads } from '@/components/org/useOrgThreads';
import { noteLeft, rereadInboxNeeds, type InboxNeedsState } from '@/stores/inbox-needs-store';
import '@/styles/inbox-needs.css';

/** The card's own copy of the thread: the inbox's extra fields off, so it reads as the node's own. */
function asNodeThread(row: InboxNeedsThread): OrgThread {
  const { node: _n, urgency: _u, ...t } = row;
  return t;
}

/** The node's list is at least as new as the inbox's read and no longer lists it as needing him. */
function leftNeeds(fresh: OrgThread | undefined, all: readonly OrgThread[] | null, row: InboxNeedsThread, now: number): boolean {
  if (!fresh || !all || fresh.updatedAt < row.updatedAt) return false;
  return !needsThreadsOf(all, now).some((t) => t.id === fresh.id);
}

const URGENCY_WORDS: Record<InboxNeedsThread['urgency']['why'], string | null> = {
  pinned: 'Pinned', due: 'Due soon', immediate: 'Immediate', waiting: null,
};

function NeedsCard({ row, now }: { row: InboxNeedsThread; now: number }) {
  const nodeId = row.node.task_id;
  const state = useOrgThreads(nodeId, true);
  const owner = useStoreTask(nodeId) ?? undefined;
  const sessionId = owner ? resolveTaskSessionId(owner) : null;
  const { send } = useSessionSend(sessionId);
  const all = state.threads;
  const fresh = all?.find((t) => t.id === row.id);
  const t = fresh ?? asNodeThread(row);
  // Only the rows this card names: the whole list changes on every task write.
  const tasks = useNamedTasks(t.tasks);
  const shared = useMemo(() => sharedAnswers(all ?? [t]), [all, t]);
  const followUp = useLeanCallback(async (threadId: string, text: string, images?: ImageAttachment[]) => {
    if (!sessionId) return false;
    const ok = await send(sessionId, text, images, { threadId });
    if (ok) rereadInboxNeeds();
    return ok;
  }, [sessionId, send]);
  const gone = leftNeeds(fresh, all, row, now);
  // Off the inbox's list, its count and the bell at once, not at the list's next read.
  useEffect(() => { if (gone) noteLeft(row); }, [gone, row]);
  if (gone) return null;
  const why = URGENCY_WORDS[row.urgency.why];
  return (
    <div className="hib-needs-item" data-testid="inbox-needs-item" data-thread-id={row.id} data-node={nodeId} data-urgency={row.urgency.why}>
      <div className="hib-needs-from">
        <span className="hib-needs-node" data-testid="inbox-needs-node">{row.node.title}</span>
        {why && <span className={`hib-needs-urgency is-${row.urgency.why}`} data-testid="inbox-needs-urgency">{why}</span>}
      </div>
      <ul className="org-thread-list">
        <ThreadItem t={t} all={all ?? [t]} shared={shared} tasks={tasks} state={state} onFollowUp={sessionId ? followUp : null}
          name={row.node.title} now={now} snoozed={false} owner={owner} />
      </ul>
    </div>
  );
}

export function InboxNeedsThreads({ needs }: { needs: InboxNeedsState }) {
  const [now, setNow] = useState(() => Date.now());
  // "3 min ago" on the cards stays true while the inbox is open.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  if (!needs.threads.length && !needs.error) return null;
  return (
    <section className="hib-needs" data-testid="inbox-needs" aria-label="Threads that need you">
      <h3 className="hib-needs-head">Threads that need you <span className="hib-needs-count" data-testid="inbox-needs-count">{needs.threads.length}</span></h3>
      {needs.error && <p className="org-thread-error" role="alert">{needs.error}</p>}
      <div className="hib-needs-list" data-testid="inbox-needs-list">
        {needs.threads.map((row) => <NeedsCard key={`${row.node.task_id}:${row.id}`} row={row} now={Math.max(now, Date.now())} />)}
      </div>
    </section>
  );
}
