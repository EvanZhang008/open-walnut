/**
 * Topics: a group chat of tasks, org nodes and people (experiment `topics`).
 *
 * The user makes a topic and adds members: a task, an org node whose task may change (Main, a VP),
 * or a person outside Walnut reached by mail. A message in it wakes the members it is for
 * (topic-wake.ts decides who, topic-delivery.ts sends), and a member's reply in that turn is posted
 * back as that member (topic-replies.ts). One JSON file per topic (topics-store.ts), leader only.
 *
 * This file is pure: the types, the ids, the @mention parser and the summary the list shows.
 */
import { randomBytes } from 'node:crypto';
import { parseMentions as parseMentionsOf } from './topic-mentions.js';

export type TopicId = `tp-${string}`;
export type MemberId = `mb-${string}`;
export type TopicMessageId = `tpm-${string}`;
/** Who made a change: the user, or a task's session. */
export type TopicActor = 'human' | `task:${string}`;

export type MemberRef =
  | { kind: 'task'; taskId: string }
  | { kind: 'org'; node: string }
  | { kind: 'person'; name: string; email: string; bot?: boolean };

export interface TopicPendingTurn {
  sessionId: string;
  /** When the turn's (first) wake went out: its reply is read from the turn that wake opened. */
  since: string;
  messageId: string;
  /** More was said to the member while this turn ran: one follow-up wake when it ends (topic-delivery.ts). */
  more?: boolean;
}

export interface TopicMember {
  id: MemberId;
  ref: MemberRef;
  /** Display name, also the @handle (matched case-insensitively, longest first). */
  name: string;
  role: 'host' | 'member';
  joinedAt: string;
  addedBy: TopicActor;
  /** A person an agent added is pending until the user confirms: no mail goes to a pending person. */
  status: 'active' | 'pending' | 'left';
  /** The last message this member was given (woken with or folded). */
  readUpto?: string;
  /** A topic-woken turn in flight: its reply is posted as this member. */
  pendingTurn?: TopicPendingTurn;
  /** Person only (the mail bridge keeps it). */
  mail?: { lastSentAt?: string; lastSentMessageId?: string; threadMessageId?: string };
}

export type MessageVia = 'ui' | 'agent' | 'mail' | 'system';

export interface TopicMessage {
  id: TopicMessageId;
  at: string;
  /** The user, a member, or Walnut's own line ("this round's wakes are used up"). */
  author: 'human' | MemberId | 'walnut';
  text: string;
  mentions: MemberId[];
  via: MessageVia;
  woke?: MemberId[];
  folded?: MemberId[];
  /** The persons this message goes to by mail (topic-wake.ts DeliveryPlan.mail): sent by the bridge. */
  toMail?: MemberId[];
  /** Of `toMail`, those the bridge mails at once; the rest wait for its schedule. */
  mailNow?: MemberId[];
  /** The persons a mail carrying this message actually went to (the bridge adds each as it goes out). */
  mailed?: MemberId[];
  refused?: { member: MemberId; why: string }[];
  /** The id the author's POST carried (dedupe and the browser's merge); answered to its author only. */
  clientId?: string;
}

export interface TopicRound {
  n: number;
  startedAt: string;
  /** Member-started wakes this round (the user's own wakes never count). */
  hops: number;
  /** `A>B`: how many times member A woke member B this round. */
  pairs: Record<string, number>;
  /** The "wakes used up" line was already posted this round. */
  budgetTold?: boolean;
}

export interface Topic {
  id: TopicId;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: TopicActor;
  members: TopicMember[];
  /** Capped at TOPIC_MESSAGES_MAX, oldest dropped (counted in droppedMessages). */
  messages: TopicMessage[];
  droppedMessages?: number;
  round: TopicRound;
  /** The host's thread, when the host keeps Threads. */
  thread?: { node: string; threadId: string };
  mail?: { accountId?: string; everyMinutes: number };
  closed?: { at: string; by: TopicActor };
}

/** Member wakes a round allows; the user's next message starts a new round. */
export const ROUND_WAKES = 3;
export const TOPIC_MESSAGES_MAX = 2000;
export const TOPIC_TEXT_MAX = 16_000;
export const TOPIC_TITLE_MAX = 120;
export const TOPIC_MEMBERS_MAX = 24;
export const MAIL_EVERY_MINUTES_DEFAULT = 15;
/** A topic-woken turn older than this is no longer waited on. */
export const PENDING_TURN_MAX_MS = 2 * 3600_000;

export const TOPIC_ID_RE = /^tp-[a-f0-9]{12}$/;
export const MEMBER_ID_RE = /^mb-[a-f0-9]{8}$/;
export const TOPIC_MESSAGE_ID_RE = /^tpm-[a-f0-9]{12}$/;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
export const newTopicId = (): TopicId => `tp-${hex(6)}`;
export const newMemberId = (): MemberId => `mb-${hex(4)}`;
export const newMessageId = (): TopicMessageId => `tpm-${hex(6)}`;

export class TopicError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'TopicError';
  }
}

/** One of Walnut's own lines in a topic ("Added @Ada."): it wakes and mails nobody. */
export function walnutLine(text: string, at = new Date().toISOString()): TopicMessage {
  return { id: newMessageId(), at, author: 'walnut', text, mentions: [], via: 'system' };
}

export function freshRound(n: number, at: string): TopicRound {
  return { n, startedAt: at, hops: 0, pairs: {} };
}

/** Task and org members are woken in their session; persons are mailed. */
export function isAgentMember(m: TopicMember): boolean {
  return m.ref.kind === 'task' || m.ref.kind === 'org';
}

export function sameRef(a: MemberRef, b: MemberRef): boolean {
  if (a.kind === 'task' && b.kind === 'task') return a.taskId === b.taskId;
  if (a.kind === 'org' && b.kind === 'org') return a.node === b.node;
  if (a.kind === 'person' && b.kind === 'person') return a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
  return false;
}

export function memberById(topic: Pick<Topic, 'members'>, id: string): TopicMember | undefined {
  return topic.members.find((m) => m.id === id);
}

export function hostOf(topic: Pick<Topic, 'members'>): TopicMember | undefined {
  return topic.members.find((m) => m.role === 'host' && m.status !== 'left');
}

/** The name people and agents write after "@": one word run, no "@" or line break. */
export function cleanName(name: string): string {
  return name.replace(/[@\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'member';
}

/** A name no other member holds (case-insensitive): "Acme VP", then "Acme VP 2". */
export function uniqueName(want: string, taken: readonly string[]): string {
  const base = cleanName(want);
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Who "@Name" names: one rule shared with the web composer (topic-mentions.ts). */
export function parseMentions(text: string, members: readonly TopicMember[]): MemberId[] {
  return parseMentionsOf<MemberId>(text, members);
}

/** Mentions given by id and parsed from the text, once each, only of this topic's members. */
export function mentionsOf(text: string, given: readonly string[] | undefined, members: readonly TopicMember[]): MemberId[] {
  const ids = new Set(members.filter((m) => m.status !== 'left').map((m) => m.id));
  const out: MemberId[] = [];
  for (const id of [...(given ?? []), ...parseMentions(text, members)]) {
    if (ids.has(id as MemberId) && !out.includes(id as MemberId)) out.push(id as MemberId);
  }
  return out;
}

/** Keep the newest TOPIC_MESSAGES_MAX messages, counting the dropped ones. Mutates. */
export function capMessages(topic: Topic): void {
  const over = topic.messages.length - TOPIC_MESSAGES_MAX;
  if (over <= 0) return;
  topic.messages = topic.messages.slice(over);
  topic.droppedMessages = (topic.droppedMessages ?? 0) + over;
}

/** What the user is called when his own name is not set (config.user.name). */
export const USER_FALLBACK_NAME = 'The user';

/** The user's name inside a sentence: the fallback reads "the user", a set name stays as it is. */
export function midSentenceName(name: string): string {
  return name === USER_FALLBACK_NAME ? 'the user' : name;
}

/** The name a message's author reads as. */
export function authorName(topic: Pick<Topic, 'members'>, author: TopicMessage['author'], userName = USER_FALLBACK_NAME): string {
  if (author === 'human') return userName;
  if (author === 'walnut') return 'Walnut';
  return memberById(topic, author)?.name ?? 'A former member';
}

export interface TopicSummary {
  id: TopicId;
  title: string;
  members: Array<Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>>;
  host?: MemberId;
  last?: { author: string; text: string; at: string };
  updatedAt: string;
  closed?: Topic['closed'];
  thread?: Topic['thread'];
}

export function summarize(topic: Topic, userName?: string): TopicSummary {
  const last = topic.messages[topic.messages.length - 1];
  const host = hostOf(topic);
  return {
    id: topic.id,
    title: topic.title,
    members: topic.members.map(({ id, name, ref, role, status }) => ({ id, name, ref, role, status })),
    ...(host ? { host: host.id } : {}),
    ...(last ? { last: { author: authorName(topic, last.author, userName), text: last.text.slice(0, 200), at: last.at } } : {}),
    updatedAt: topic.updatedAt,
    ...(topic.closed ? { closed: topic.closed } : {}),
    ...(topic.thread ? { thread: topic.thread } : {}),
  };
}

/** A topic read from disk, made whole: fields an older or hand-edited file lacks get their defaults. */
export function normalizeTopic(raw: unknown): Topic | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<Topic>;
  if (typeof t.id !== 'string' || !TOPIC_ID_RE.test(t.id) || typeof t.title !== 'string') return null;
  const at = typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString();
  return {
    ...(t as Topic),
    createdAt: at,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : at,
    createdBy: t.createdBy ?? 'human',
    members: Array.isArray(t.members) ? t.members : [],
    messages: Array.isArray(t.messages) ? t.messages : [],
    round: t.round && typeof t.round === 'object' ? { ...freshRound(0, at), ...t.round, pairs: { ...(t.round.pairs ?? {}) } } : freshRound(0, at),
  };
}
