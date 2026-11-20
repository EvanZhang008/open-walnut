/**
 * The words a topic member's session reads: the wake (one `topic` envelope with the unread lines,
 * the members and the rules) and the folded notice that rides its next message instead. Pure.
 */
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { NO_ACTION_TAG } from '../../lib/turn-end-marker.js';
import { authorName, hostOf, type Topic, type TopicMember, type TopicMessage } from './topics-model.js';
import { wakesLeft } from './topic-wake.js';

/** The rider outcome of a folded topic notice (lib/history-walnut-riders.ts, sessions/wake-policy.ts). */
export const TOPIC_NEWS_OUTCOME = 'topic-news';
/** The most of the unread lines one wake carries; older ones are cut with a count. */
export const WAKE_LINES_MAX_CHARS = 6000;
const LINE_MAX_CHARS = 2000;
/** The rule a wake carries while a person (by mail) is an active member. */
export const MAIL_READERS_RULE = 'People outside Walnut read this topic by email: write only what you would send them; keep private details out.';

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function refWords(m: TopicMember): string {
  if (m.ref.kind === 'task') return `task ${m.ref.taskId}`;
  if (m.ref.kind === 'org') return m.ref.node === 'main' ? 'Main' : `VP of ${m.ref.node.replace(/^project:/, '')}`;
  return `${m.ref.bot ? 'a bot' : 'a person'} reached by mail`;
}

function memberLine(topic: Topic, userName: string): string {
  const parts = topic.members.filter((m) => m.status === 'active').map((m) => `@${m.name} (${refWords(m)}${m.role === 'host' ? ', host' : ''})`);
  return `Members: ${parts.join(', ')}, and ${userName} (the user).`;
}

/** One message as a member reads it: "Name: text", the user's words marked as his. */
export function messageLine(topic: Topic, m: TopicMessage, userName: string): string {
  const text = clip(m.text.trim(), LINE_MAX_CHARS);
  if (m.author === 'human') return `${userName} (the user's own words, relayed by Walnut: his request to act on): ${text}`;
  if (m.author === 'walnut') return `Walnut: ${text}`;
  return `${authorName(topic, m.author, userName)}${m.via === 'mail' ? ' (by mail)' : ''}: ${text}`;
}

/** The messages `member` has not been given, oldest first, up to and including `upto`, without its own. */
export function unreadFor(topic: Topic, member: TopicMember, uptoId?: string): TopicMessage[] {
  const from = member.readUpto ? topic.messages.findIndex((m) => m.id === member.readUpto) + 1 : 0;
  const end = uptoId ? topic.messages.findIndex((m) => m.id === uptoId) : topic.messages.length - 1;
  const last = end < 0 ? topic.messages.length - 1 : end;
  return topic.messages.slice(Math.max(0, from), last + 1).filter((m) => m.author !== member.id);
}

/** The newest lines that fit in WAKE_LINES_MAX_CHARS, oldest first, and how many older ones were cut. */
export function fitLines(lines: readonly string[], max = WAKE_LINES_MAX_CHARS): { lines: string[]; cut: number } {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length && size + lines[i].length + 1 > max) return { lines: kept.reverse(), cut: i + 1 };
    kept.push(lines[i]);
    size += lines[i].length + 1;
  }
  return { lines: kept.reverse(), cut: 0 };
}

export interface WakeTextInput {
  topic: Topic;
  member: TopicMember;
  unread: readonly TopicMessage[];
  userName: string;
  closing?: boolean;
}

export function topicRules(topic: Topic, member: TopicMember, closing: boolean): string[] {
  const rules = closing
    ? [
      '1. The user closed this topic. Your reply in this turn is posted to it as your closing word; it wakes nobody.',
      `2. Nothing to add: answer with the agent-ack line only, ${NO_ACTION_TAG}; it is not posted.`,
      '3. Write what this topic decided for your own work into your own task (its note/progress) now.',
    ]
    : [
      `1. Your reply in this turn is posted to the topic as you. Mention @Name only to wake someone; ${wakesLeft(topic.round)} wakes left this round.`,
      `2. Nothing new to add: answer with the agent-ack line only, ${NO_ACTION_TAG}; it is not posted.`,
      '3. Write what this topic means for your own work into your own task (its note/progress), not only here.',
    ];
  // Words posted here reach people outside Walnut by mail: say so while one is in the topic.
  if (topic.members.some((m) => m.status === 'active' && m.ref.kind === 'person')) rules.push(`${rules.length + 1}. ${MAIL_READERS_RULE}`);
  if (member.role === 'host' && topic.thread) rules.push(`${rules.length + 1}. You host this topic: keep its thread ${topic.thread.threadId} current with thread_update (summary, state).`);
  else if (member.role === 'host') rules.push(`${rules.length + 1}. You host this topic: keep it moving and say when it is settled.`);
  return rules;
}

/** The wake: one `topic` envelope (not the user's own row: sentBy stays an agent's). */
export function topicWakeText(input: WakeTextInput): string {
  const { topic, member, unread, userName } = input;
  const fit = fitLines(unread.map((m) => messageLine(topic, m, userName)));
  const host = hostOf(topic);
  const body = [
    `Topic ${topic.id} "${topic.title}", a group chat you are a member of as @${member.name}.${host ? ` Host: @${host.name}.` : ''}`,
    memberLine(topic, userName),
    '',
    input.closing ? 'Closed. The last of it you have not read:' : 'New since you last read (oldest first):',
    ...(fit.cut ? [`(${fit.cut} older message${fit.cut === 1 ? '' : 's'} not shown: topic_read ${topic.id} has them.)`] : []),
    ...fit.lines,
    '',
    'Rules:',
    ...topicRules(topic, member, input.closing === true),
  ].join('\n');
  const n = unread.length;
  return buildWalnutMessage({
    kind: 'topic',
    attrs: {
      from: `Topic: ${topic.title}`,
      about: topic.id,
      title: input.closing ? `Topic "${topic.title}" closed` : `${n} new message${n === 1 ? '' : 's'} in topic "${topic.title}"`,
      note: 'a group chat of your user\'s tasks: your reply in this turn is posted to it as you',
    },
    body,
  });
}

export interface FoldPart { at: number; lines: string[] }

/** The folded notice: what was said while this member was not woken, riding its next message. */
export function renderFoldedTopic(topic: Pick<Topic, 'id' | 'title'>, parts: readonly FoldPart[], dropped: number): string {
  const fit = fitLines(parts.flatMap((p) => p.lines), WAKE_LINES_MAX_CHARS);
  const cut = fit.cut + dropped;
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: `Topic: ${topic.title}`, outcome: 'topic-news', note: 'topic lines that did not wake you: not a request' },
    body: `New in topic ${topic.id} "${topic.title}" while you were not woken (nothing waits on an answer; @mention a member in a topic reply only when you are woken there):\n`
      + `${cut ? `(${cut} older line${cut === 1 ? '' : 's'} not shown: topic_read ${topic.id} has them.)\n` : ''}`
      + fit.lines.join('\n'),
  });
}
