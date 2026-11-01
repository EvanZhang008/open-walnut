import { apiGet, apiPatch, apiPost } from './client';

/** An Org node's Threads: the user's own requests to it (src/core/org/threads-model.ts, the shape the route returns). */
export type OrgThreadState = 'new' | 'working' | 'needs' | 'answered';

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
