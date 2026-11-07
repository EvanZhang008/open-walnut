import { apiGet, apiPatch, apiPost } from './client';

/** An Org node's Threads: the user's own requests to it (src/core/org/threads-model.ts, the shape the route returns). */
export type OrgThreadState = 'new' | 'working' | 'needs' | 'answered' | 'pending';

export interface OrgThreadMessage {
  id: string;
  at: string;
  text: string;
  images?: string[];
  via: 'chat' | 'follow-up' | 'letter' | 'import' | 'split';
  about?: string;
  /** The node's answer, read by Walnut from its chat (src/core/org/thread-answers.ts). */
  answer?: { text: string; at: string; about?: string[]; clipped?: boolean };
}

export interface OrgThread {
  id: string;
  title: string;
  titled?: boolean;
  ask?: string;
  state: OrgThreadState;
  reply?: string;
  /** When the node last wrote the summary (an older answer leaves the card: core/org/thread-view.ts supersededBySummary). */
  replyAt?: string;
  tasks?: string[];
  messages: OrgThreadMessage[];
  follows?: string;
  createdAt: string;
  updatedAt: string;
  by?: string;
  closed?: { how: 'acked' | 'dropped'; at: string; by: string };
  /** He reacted to the answers through this message, as the node judged it. */
  known?: { through: string; by: string; at: string };
  /** The node opened the thread itself: its first post and where it came from. */
  opener?: { text: string; at: string; from: string; ref?: string; by: string };
  /** Put aside until `until` (core/org/thread-view.ts snoozedNow says whether it still is). */
  snoozed?: { until: string; at: string; by: string };
  /** Pinned to the top of his view, whatever its state (core/org/thread-view.ts pinnedNow). */
  pinned?: { at: string; by: string };
  /** Walnut woke the node about this thread's overdue stretch (core/org/thread-recheck.ts). */
  recheck?: { since: string; at: string; why?: string; pending?: boolean };
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
  /** Pin it to the top of his view, or unpin it. */
  pin?: boolean;
  merge_into?: string;
}

export async function patchOrgThread(taskId: string, threadId: string, patch: OrgThreadPatch): Promise<OrgThread> {
  const res = await apiPatch<{ thread: OrgThread }>(`${base(taskId)}/${encodeURIComponent(threadId)}`, patch);
  return res.thread;
}

export async function splitOrgThread(taskId: string, threadId: string, messageId: string): Promise<OrgThread> {
  const res = await apiPost<{ thread: OrgThread }>(`${base(taskId)}/${encodeURIComponent(threadId)}/split`, { message: messageId });
  return res.thread;
}
