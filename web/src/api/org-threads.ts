import { apiGet, apiPatch, apiPost } from './client';
import type { AckPlaced, AckWaits } from '@open-walnut/thread-groups';

/** An Org node's Threads: the user's own requests to it (src/core/org/threads-model.ts, the shape the route returns). */
export type OrgThreadState = 'new' | 'working' | 'needs' | 'answered' | 'pending';

export interface OrgThreadMessage {
  id: string;
  at: string;
  text: string;
  images?: string[];
  via: 'chat' | 'follow-up' | 'letter' | 'import' | 'split';
  about?: string;
  /**
   * The node's answer, read by Walnut from its chat (src/core/org/thread-answers.ts). `sid`/`host`:
   * the session it was read from (absent on an answer kept before they were recorded: unknown).
   */
  answer?: { text: string; at: string; about?: string[]; clipped?: boolean; from?: 'letter'; sid?: string; host?: string };
  readAt?: string;
  /** His reply from a card above the task that owns the thread, on its way there (src/core/org/thread-reply.ts). */
  delivery?: {
    state: 'pending' | 'claimed' | 'delivered' | 'dropped'; at: string; via?: string
    /** An agent wrote it for him (the writer), not his own words. */
    by?: string
    /** Dropped because he took it back before the task read it. */
    withdrawn?: true
  };
  /** The ask it answers; `stale`: the thread asked something else by then. */
  answers?: { ask_id: string; stale?: boolean };
}

export interface OrgThreadMove { task: string; title: string; at: string; by: string; why?: string; kind?: 'work' | 'hand' }

export interface OrgThread {
  id: string;
  title: string;
  titled?: boolean;
  ask?: string;
  state: OrgThreadState;
  reply?: string;
  /** When the node last wrote the summary (an older answer leaves the card: core/org/thread-view.ts supersededBySummary). */
  replyAt?: string;
  /** Who wrote `reply` and from which session; none of them on an older summary (unknown). */
  reply_by?: string;
  reply_sid?: string;
  reply_host?: string;
  tasks?: string[];
  messages: OrgThreadMessage[];
  follows?: string;
  createdAt: string;
  updatedAt: string;
  by?: string;
  closed?: { how: 'acked' | 'dropped'; at: string; by: string };
  /** Closed here because it moved to another node with its work (core/org/thread-follow.ts): the node it lives at now. */
  movedTo?: OrgThreadMove;
  /** It came from this node with its work. */
  movedFrom?: OrgThreadMove;
  /** He reacted to the answers through this message, as the node judged it. */
  known?: { through: string; by: string; at: string };
  reactedAt?: string;
  /** The node opened the thread itself: its first post and where it came from. */
  opener?: { text: string; at: string; from: string; ref?: string; by: string; sid?: string; host?: string };
  /** Put aside until `until` (core/org/thread-view.ts snoozedNow says whether it still is). */
  snoozed?: { until: string; at: string; by: string };
  /** On his Watching list, whatever its state, and in its own group too (core/org/thread-view.ts watchingOf). */
  watched?: { at: string; by: string };
  /** Walnut woke the node about this thread's overdue stretch (core/org/thread-recheck.ts). */
  recheck?: { since: string; at: string; why?: string; pending?: boolean };
  /** The node named the task that already asks him this decision (core/org/threads-model.ts ThreadAskOwner). */
  askOwner?: { task: string; decision?: string; ask?: string; at: string; by: string };
  /** Projected by the server on every read, never stored: a task asks him this decision now, so the
   *  thread points there instead of asking twice (core/org/thread-task-ask.ts). */
  askedIn?: { task: string; title: string; ask: string; via: 'owner' | 'words' | 'thread'; thread?: string; decision?: string; answered?: true };
  /** A thread of a task below this node, listed here while it waits on him (experiment threads_pop_up, src/core/org/thread-popup.ts). */
  owner?: { task_id: string; title: string };
  /** Its owner takes a reply now; false: the reply is kept and goes when the task is back. */
  can_answer_now?: boolean;
  /** The decision it asks: a reply names it. */
  ask_id?: string;
  /** The decision letter it holds (experiment letters_as_threads, core/org/letter-thread-model.ts): its card answers the letter. */
  letter?: { id: string; task: string; options: Array<{ id: string; label: string; description?: string; recommended?: true }>; off?: true; done?: true };
  /** The Board choice it holds (experiment brief_off, core/org/choice-thread-model.ts): its card answers the choice. */
  choice?: { board: string; id: string; task?: string; options: Array<{ value: string; label: string }>; recommended?: string; off?: true; done?: true };
  /** He acknowledged it, so it went to Acknowledged instead of closing (experiment ack_means_known, core/org/thread-known.ts). */
  ackedAt?: string;
  /** When nothing held that thread any more: it settles a few minutes later. */
  ackDone?: string;
  /** Where it went from Acknowledged, who placed it (the node's AI, or Walnut's rule after 10 minutes) and why (core/org/thread-known.ts). */
  ackPlaced?: AckPlaced;
  /** Projected on its read: what holds it; empty lists once nothing does. */
  awaits?: AckWaits;
  /** Walnut put the task's own ask on this thread (core/org/thread-report-ask.ts): stored as the place only. */
  reportAsk?: { id: string; at: string; ask?: string };
  /** Projected on read: it reads needs because it holds the task's own ask now; `id` is that ask's
   *  Action needed item, `reply` the thread's own summary under the question, `was` its stored state. */
  heldAsk?: { id: string; ask: string; reply?: string; was: string };
  /** Projected with heldAsk: the decision id of the task's own ask it holds (the Action needed item's id). */
  askId?: string;
  /** While it waits on him (needs): the choices he clicks, one shape wherever a choice shows
   *  (core/ask-options.ts); a click is his answer in words, the label. */
  options?: Array<{ id: string; label: string; detail?: string; recommended?: boolean }>;
}

const base = (taskId: string) => `/api/v1/tasks/${encodeURIComponent(taskId)}/threads`;

export async function fetchOrgThreads(taskId: string): Promise<OrgThread[]> {
  const res = await apiGet<{ threads: OrgThread[] }>(base(taskId), undefined, { quietStatuses: [404, 409, 501] });
  return res.threads ?? [];
}

export interface OrgThreadPatch {
  title?: string;
  state?: OrgThreadState;
  close?: 'acked' | 'dropped';
  reopen?: boolean;
  /** An ISO time it comes back at, or '' to take the snooze off. */
  snooze?: string;
  /** Put it on his Watching list, or take it off. */
  watch?: boolean;
  /** Its place on the Watching list (an ISO time; oldest first): a drag. */
  watch_at?: string;
  merge_into?: string;
}

export async function patchOrgThread(taskId: string, threadId: string, patch: OrgThreadPatch): Promise<OrgThread> {
  const res = await apiPatch<{ thread: OrgThread }>(`${base(taskId)}/${encodeURIComponent(threadId)}`, patch);
  return res.thread;
}

/** His reply on a thread of a task below this node: filed on that task's thread and sent to it.
 *  Answers the thread and his message as filed (its id and its delivery so far). */
export async function replyOnOrgThread(taskId: string, threadId: string, text: string, askId?: string, key?: string): Promise<{ thread: OrgThread; message?: OrgThreadMessage }> {
  const res = await apiPost<{ thread: OrgThread; message?: OrgThreadMessage }>(base(taskId), { text, thread: threadId, ...(askId ? { ask_id: askId } : {}), ...(key ? { key } : {}) });
  return { thread: res.thread, ...(res.message ? { message: res.message } : {}) };
}

export async function splitOrgThread(taskId: string, threadId: string, messageId: string): Promise<OrgThread> {
  const res = await apiPost<{ thread: OrgThread }>(`${base(taskId)}/${encodeURIComponent(threadId)}/split`, { message: messageId });
  return res.thread;
}
