/**
 * Topics: a group chat of tasks, org nodes and people (experiment `topics`). The shapes mirror
 * src/core/topics/topics-model.ts; the routes are src/web/routes/topics-v1.ts. Every write here is
 * the person in the browser, so its author is 'human' on the server.
 *
 *   GET  /api/topics                          { topics: TopicSummary[] }
 *   POST /api/topics                          { title, members, host?, text?, clientId? } -> { topic }
 *   GET  /api/topics/:id?since=<tpm id>       { topic }
 *   POST /api/topics/:id/messages             { text, mentions?, clientId? } -> { message, delivery }
 *   POST /api/topics/:id/members              { add?, remove? } -> { topic }
 *   POST /api/topics/:id/members/:mid/confirm -> { topic }
 *   POST /api/topics/:id/close                -> { topic }
 *   GET  /api/topics/mail-accounts            { accounts: TopicMailAccount[], available }
 *   POST /api/topics/:id/mail                 { accountId: string | null, everyMinutes? } -> { topic }
 */
import { apiGet, apiPost } from './client';

export type TopicId = `tp-${string}`;
export type MemberId = `mb-${string}`;

export type MemberRef =
  | { kind: 'task'; taskId: string }
  | { kind: 'org'; node: string }
  | { kind: 'person'; name: string; email: string; bot?: boolean };

export type MemberStatus = 'active' | 'pending' | 'left';

export interface TopicMember {
  id: MemberId;
  ref: MemberRef;
  name: string;
  role: 'host' | 'member';
  joinedAt?: string;
  addedBy?: string;
  status: MemberStatus;
  readUpto?: string;
  pendingTurn?: { sessionId: string; since: string; messageId: string };
}

export interface TopicMessage {
  id: string;
  at: string;
  /** 'human', a member id, or 'walnut' (a system line). */
  author: string;
  text: string;
  mentions: string[];
  via: 'ui' | 'agent' | 'mail' | 'system';
  woke?: string[];
  folded?: string[];
  mailed?: string[];
  refused?: Array<{ member: string; why: string }>;
}

export interface TopicThreadLink { node: string; threadId: string }

export interface Topic {
  id: TopicId;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  members: TopicMember[];
  messages: TopicMessage[];
  droppedMessages?: number;
  round: { n: number; startedAt: string; hops: number; pairs: Record<string, number> };
  thread?: TopicThreadLink;
  mail?: { accountId?: string; everyMinutes: number };
  closed?: { at: string; by: string };
}

/** One row of the list: enough for the Org list, the pickers and a thread card. */
export interface TopicSummary {
  id: TopicId;
  title: string;
  members: Array<Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>>;
  /** The host's member id. */
  host?: string;
  /** The newest message: its author's display name, its first 200 characters, when. */
  last?: { author: string; text: string; at: string };
  updatedAt: string;
  closed?: { at: string; by: string };
  thread?: TopicThreadLink;
}

export interface TopicDelivery {
  wake: string[];
  fold: string[];
  mail: string[];
  refused: Array<{ member: string; why: string }>;
}

const base = '/api/topics';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

/** A fresh id for one send, so a retry of the same POST is answered with the first result. */
export function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Every topic, open and closed. A server with the experiment off answers 404 `topics_off`: no topics. */
export async function listTopics(): Promise<TopicSummary[]> {
  try {
    const res = await apiGet<{ topics?: TopicSummary[] }>(base, undefined, { quietStatuses: [404] });
    return res.topics ?? [];
  } catch (err) {
    if ((err as { status?: number }).status === 404) return [];
    throw err;
  }
}

export async function readTopic(id: string, since?: string): Promise<Topic> {
  const res = await apiGet<{ topic: Topic }>(one(id), since ? { since } : undefined, { quietStatuses: [404] });
  return res.topic;
}

export async function createTopic(input: { title: string; members: MemberRef[]; host?: number; text?: string; clientId?: string }): Promise<Topic> {
  const body = {
    title: input.title,
    members: input.members,
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.text?.trim() ? { text: input.text.trim() } : {}),
    clientId: input.clientId ?? newClientId(),
  };
  const res = await apiPost<{ topic: Topic }>(base, body);
  return res.topic;
}

export async function postTopicMessage(id: string, text: string, opts: { mentions?: string[]; clientId?: string } = {}): Promise<{ message: TopicMessage; delivery?: TopicDelivery }> {
  return apiPost(`${one(id)}/messages`, {
    text,
    ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
    clientId: opts.clientId ?? newClientId(),
  });
}

export async function editTopicMembers(id: string, change: { add?: MemberRef[]; remove?: string[] }): Promise<Topic> {
  const res = await apiPost<{ topic: Topic }>(`${one(id)}/members`, change);
  return res.topic;
}

export async function confirmTopicMember(id: string, memberId: string): Promise<Topic> {
  const res = await apiPost<{ topic: Topic }>(`${one(id)}/members/${encodeURIComponent(memberId)}/confirm`, {});
  return res.topic;
}

export async function closeTopic(id: string): Promise<Topic> {
  const res = await apiPost<{ topic: Topic }>(`${one(id)}/close`, {});
  return res.topic;
}

/** A mail account a topic may email from (the mail plugin's, as the topics bridge sees it). */
export interface TopicMailAccount { accountId: string; address: string; canSend: boolean }

/** The mail accounts; `available` false when the mail plugin is off or did not answer in time. */
export async function listTopicMailAccounts(): Promise<{ accounts: TopicMailAccount[]; available: boolean }> {
  const res = await apiGet<{ accounts?: TopicMailAccount[]; available?: boolean }>(`${base}/mail-accounts`, undefined, { quietStatuses: [404] });
  return { accounts: res.accounts ?? [], available: res.available !== false };
}

/** The mailbox the topic's people are emailed from (null: none, nothing is emailed). The user's own choice. */
export async function setTopicMail(id: string, accountId: string | null, everyMinutes?: number): Promise<Topic> {
  const res = await apiPost<{ topic: Topic }>(`${one(id)}/mail`, { accountId, ...(everyMinutes !== undefined ? { everyMinutes } : {}) });
  return res.topic;
}
