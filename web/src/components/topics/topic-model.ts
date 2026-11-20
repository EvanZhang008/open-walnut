/**
 * The pure rules the topic views draw with (experiment `topics`), kept apart so tests reach them:
 * the Org page's selection key of a topic, "@Name" mentions, the @ autocomplete (and the keys its
 * list takes), the small line under a message (who it woke, who reads it next time, who it was
 * mailed to or will be), the stacked avatars a topic shows for its members, and the words of the
 * yes asked before Walnut emails a person.
 */
import type { MemberRef, Topic, TopicMember, TopicMessage, TopicSummary } from '@/api/topics';
import { isImeKey } from '@/utils/ime-key';

/** The Org page selects a topic through its `node` param, beside 'main' and 'project:<key>'. */
export const TOPIC_KEY_PREFIX = 'topic:';
export const topicKey = (id: string): string => `${TOPIC_KEY_PREFIX}${id}`;
export function topicOfKey(key: string | null | undefined): string | null {
  return key && key.startsWith(TOPIC_KEY_PREFIX) && key.length > TOPIC_KEY_PREFIX.length ? key.slice(TOPIC_KEY_PREFIX.length) : null;
}

/** Member wakes a round allows (src/core/topics/topic-wake.ts). */
export const ROUND_WAKES = 3;

type MemberLike = Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>;

/** One key per member ref: the same task, node or address is one member. */
export function refKey(ref: MemberRef): string {
  if (ref.kind === 'task') return `task:${ref.taskId}`;
  if (ref.kind === 'org') return `org:${ref.node}`;
  return `person:${ref.email.trim().toLowerCase()}`;
}

/** An Org row's key is already its node id ('main' | 'project:<key>'). */
export const orgRef = (node: string): MemberRef => ({ kind: 'org', node });
export const taskRef = (taskId: string): MemberRef => ({ kind: 'task', taskId });

export function isEmail(s: string): boolean {
  return /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(s.trim());
}

// Who "@Name" names: the server's own rule, one module (src/core/topics/topic-mentions.ts).
export { mentionShortForms, parseMentions } from '../../../../src/core/topics/topic-mentions';

/** A row of the @ list: a member first, else a task not in the topic yet (picking it asks first). */
export type MentionCandidate =
  | { kind: 'member'; member: MemberLike }
  | { kind: 'task'; taskId: string; name: string };

/** How well `name` answers `q`: 0 starts with it, 1 a word starts with it, 2 holds it, -1 no. */
function matchRank(name: string, q: string): number {
  const n = name.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s\-_/.]+/).some((w) => w.startsWith(q))) return 1;
  return n.includes(q) ? 2 : -1;
}

/** The rows whose name answers `query`, best first (starts with it, a word does, holds it), then by name. */
export function rankByName<T>(rows: readonly T[], nameOf: (r: T) => string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return rows
    .map((r) => ({ r, k: matchRank(nameOf(r), q) }))
    .filter((x) => x.k >= 0)
    .sort((a, b) => a.k - b.k || nameOf(a.r).localeCompare(nameOf(b.r)))
    .map((x) => x.r);
}

/** The @ autocomplete: members that match first, then open tasks that are not members yet. */
export function mentionCandidates(
  query: string,
  members: readonly MemberLike[],
  tasks: ReadonlyArray<{ id: string; name: string }>,
  limit = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const rank = <T,>(rows: T[], nameOf: (r: T) => string) => rankByName(rows, nameOf, q);
  const live = members.filter((m) => m.status !== 'left');
  const inTopic = new Set(live.flatMap((m) => (m.ref.kind === 'task' ? [m.ref.taskId] : [])));
  const out: MentionCandidate[] = rank([...live], (m) => m.name).map((member) => ({ kind: 'member', member }));
  // Tasks only once something is typed: a bare "@" lists the members.
  if (q) {
    const others = rank(tasks.filter((t) => !inTopic.has(t.id)), (t) => t.name);
    for (const t of others) out.push({ kind: 'task', taskId: t.id, name: t.name });
  }
  return out.slice(0, limit);
}

/** Who wrote a message, for its avatar and name. */
export type MessageAuthor =
  | { kind: 'human' }
  | { kind: 'walnut' }
  | { kind: 'member'; member: MemberLike | undefined; name: string };

export function authorOf(m: Pick<TopicMessage, 'author'>, members: readonly MemberLike[]): MessageAuthor {
  if (m.author === 'human') return { kind: 'human' };
  if (m.author === 'walnut') return { kind: 'walnut' };
  const member = members.find((x) => x.id === m.author);
  return { kind: 'member', member, name: member?.name ?? 'A former member' };
}

const list = (ids: readonly string[] | undefined, nameOf: (id: string) => string) =>
  (ids ?? []).map(nameOf).filter(Boolean).join(', ');

/**
 * The small line under a message: "woke A, B · C, D read it next time · mailed E · G will be
 * mailed", then each wake that was not done and why ("F not woken: round budget used up"). Empty
 * when it reached no one. `mailed` is mail that really went out; `toMail` is who it is to go to,
 * so one there and not yet in `mailed` will be mailed.
 */
export function reachLine(m: Pick<TopicMessage, 'woke' | 'folded' | 'toMail' | 'mailed' | 'refused'>, members: readonly MemberLike[]): string {
  const nameOf = (id: string) => members.find((x) => x.id === id)?.name ?? '';
  const refusedIds = new Set((m.refused ?? []).map((r) => r.member));
  const parts: string[] = [];
  const woke = list(m.woke, nameOf);
  if (woke) parts.push(`woke ${woke}`);
  // A refused wake folds too; it is said once, with its reason.
  const folded = list((m.folded ?? []).filter((id) => !refusedIds.has(id)), nameOf);
  if (folded) parts.push(`${folded} read it next time`);
  const mailed = list(m.mailed, nameOf);
  if (mailed) parts.push(`mailed ${mailed}`);
  const toMail = list((m.toMail ?? []).filter((id) => !(m.mailed ?? []).includes(id)), nameOf);
  if (toMail) parts.push(`${toMail} will be mailed`);
  for (const r of m.refused ?? []) {
    const name = nameOf(r.member);
    if (name) parts.push(`${name} not woken: ${r.why}`);
  }
  return parts.join(' · ');
}

/**
 * The same reach in a few words, for the line under a message: one name when it is one member,
 * else how many ("Woke Walnut VP · 2 read later · Robin by email"); `full` is reachLine, the names
 * and reasons, for its tooltip.
 */
export function reachSummary(m: Pick<TopicMessage, 'woke' | 'folded' | 'toMail' | 'mailed' | 'refused'>, members: readonly MemberLike[]): { line: string; full: string } {
  const full = reachLine(m, members);
  if (!full) return { line: '', full };
  const nameOf = (id: string) => shortName(members.find((x) => x.id === id)?.name ?? '');
  const names = (ids: readonly string[]) => ids.map(nameOf).filter(Boolean);
  const say = (ids: readonly string[], one: (n: string) => string, many: (k: number) => string) => {
    const n = names(ids);
    return n.length === 0 ? '' : n.length === 1 ? one(n[0]!) : many(n.length);
  };
  const refusedIds = (m.refused ?? []).map((r) => r.member);
  const parts = [
    say(m.woke ?? [], (n) => `Woke ${n}`, (k) => `Woke ${k}`),
    say((m.folded ?? []).filter((id) => !refusedIds.includes(id)), (n) => `${n} reads later`, (k) => `${k} read later`),
    say(m.mailed ?? [], (n) => `Mailed ${n}`, (k) => `Mailed ${k}`),
    say((m.toMail ?? []).filter((id) => !(m.mailed ?? []).includes(id)), (n) => `${n} by email`, (k) => `${k} by email`),
    say(refusedIds, (n) => `${n} not woken`, (k) => `${k} not woken`),
  ].filter(Boolean);
  return { line: parts.join(' · '), full };
}

/** A member's name before its " · <project or folder>" part: "Walnut VP", "Release notes". */
export function shortName(name: string): string {
  const i = name.indexOf(' · ');
  return i > 0 ? name.slice(0, i) : name;
}

/** The part after the first " · ", shown muted beside the name; empty when there is none. */
export function nameContext(name: string): string {
  const i = name.indexOf(' · ');
  return i > 0 ? name.slice(i + 3) : '';
}

/** Lines by one writer this close together read as one block: the name and avatar once. */
export const GROUP_MS = 5 * 60_000;

/** Pure: whether message `m` continues the block of `prev` (same writer, close in time, not Walnut's). */
export function continuesBlock(prev: Pick<TopicMessage, 'author' | 'at'> | undefined, m: Pick<TopicMessage, 'author' | 'at'>): boolean {
  if (!prev || prev.author !== m.author || m.author === 'walnut') return false;
  const gap = (Date.parse(m.at) || 0) - (Date.parse(prev.at) || 0);
  return gap >= 0 && gap <= GROUP_MS;
}

/** The avatars a topic shows stacked: its live members, the host first, at most `max`, and how many more. */
export function stackedAvatars<M extends MemberLike>(members: readonly M[], max = 4): { shown: M[]; more: number } {
  const live = members.filter((m) => m.status !== 'left');
  const ordered = [...live.filter((m) => m.role === 'host'), ...live.filter((m) => m.role !== 'host')];
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}

export function hostOf<M extends MemberLike>(t: { members: readonly M[]; host?: string }): M | undefined {
  return (t.host ? t.members.find((m) => m.id === t.host) : undefined) ?? t.members.find((m) => m.role === 'host');
}

/** "topic · 4 members · host Walnut VP" */
export function topicSubtitle(t: Pick<Topic, 'members'> & { host?: string }): string {
  const live = t.members.filter((m) => m.status !== 'left').length;
  const host = hostOf(t);
  return `${host ? `Hosted by ${shortName(host.name)} · ` : ''}${live} ${live === 1 ? 'member' : 'members'}`;
}

/** The server's default host: the first org member, else the first task member (a person never hosts). */
export function defaultHost(picked: ReadonlyArray<{ ref: MemberRef }>): number | undefined {
  const org = picked.findIndex((p) => p.ref.kind === 'org');
  if (org >= 0) return org;
  const task = picked.findIndex((p) => p.ref.kind === 'task');
  return task >= 0 ? task : undefined;
}

/** The newest topic first; closed ones out of the open list. */
export function openTopics(list: readonly TopicSummary[]): TopicSummary[] {
  return list.filter((t) => !t.closed).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The topic whose host thread this is, if any (a thread card wears its members). */
export function topicOfThread(list: readonly TopicSummary[], threadId: string): TopicSummary | undefined {
  return list.find((t) => t.thread?.threadId === threadId);
}

/** What a member's status reads as in the side panel. */
export function memberStatusLabel(m: Pick<TopicMember, 'status' | 'role' | 'pendingTurn'>): string {
  if (m.status === 'pending') return 'Waiting for your yes';
  if (m.status === 'left') return 'Left';
  if (m.pendingTurn) return 'Replying';
  return m.role === 'host' ? 'Host' : 'Member';
}

/** What the confirm says in place of "from <mailbox>" while the topic has none chosen. */
export const NO_MAILBOX_WORDS = 'once you choose a mailbox for this topic (nothing is sent until then)';

/** "a@x", "a@x and b@y", "a@x, b@y and c@z". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The yes asked before a person joins a topic (added, or an agent's add confirmed): Walnut emails
 * them in the user's name, from the topic's mailbox. `from`: that mailbox's address, or null.
 */
export function personMailConfirm(emails: readonly string[], from: string | null, ask: 'Add?' | 'Confirm?' | 'Use it?' = 'Add?'): string {
  const where = from ? `from ${from} with this topic's new messages` : NO_MAILBOX_WORDS;
  return `Walnut will email ${listWords(emails)} ${where}. ${ask}`;
}

/** The yes asked before a mailbox is chosen while people are in the topic: mail starts going to them from it. */
export function mailboxConfirm(emails: readonly string[], from: string): string {
  return personMailConfirm(emails, from, 'Use it?');
}

/** The addresses of the topic's active people: who a chosen mailbox starts mailing. */
export function activePersonEmails(members: readonly Pick<TopicMember, 'ref' | 'status'>[]): string[] {
  return members.flatMap((m) => (m.status === 'active' && m.ref.kind === 'person' ? [m.ref.email.trim()] : []));
}

/** The emails of the people among `refs`. */
export function personEmails(refs: readonly MemberRef[]): string[] {
  return refs.flatMap((r) => (r.kind === 'person' ? [r.email.trim()] : []));
}

/**
 * What a key does while the @ list is open: move the highlight, pick the highlighted row, close the
 * list, or nothing (the box takes it). A key of an input method's composition is the IME's: the
 * Enter that commits a Chinese or Japanese word never picks a row (isImeKey: isComposing, or
 * WebKit's keyCode 229 on the key that ends one).
 */
export type MentionKey = 'next' | 'prev' | 'pick' | 'close' | null;
export function mentionKeyAction(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): MentionKey {
  if (isImeKey({ isComposing: !!e.isComposing, keyCode: e.keyCode })) return null;
  if (e.key === 'ArrowDown') return 'next';
  if (e.key === 'ArrowUp') return 'prev';
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') return 'pick';
  if (e.key === 'Escape') return 'close';
  return null;
}
