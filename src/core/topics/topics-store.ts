/**
 * Topics on disk: one JSON file per topic, `<WALNUT_HOME>/topics/<id>.json`, every write a locked
 * read-modify-write (file-lock.ts) through the atomic writer, then one `topic:updated` event.
 * Only the leader keeps topics: on a follower reads are empty and writes refuse.
 *
 * The mail bridge (topic-mail*.ts) uses exactly these: listTopics, readTopic, appendMemberMessage
 * (posts as a member and runs its delivery), updateMember, and registerTopicMessageListener (it
 * hears every posted message with its delivery plan).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { withFileLock } from '../../utils/file-lock.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { bus, EventNames } from '../event-bus.js';
import { isFollower } from '../server-role.js';
import { experimentalEnabled } from '../experimental.js';
import {
  TOPIC_ID_RE, TopicError, capMessages, normalizeTopic,
  type MemberId, type MessageVia, type Topic, type TopicMember, type TopicMessage,
} from './topics-model.js';
import type { DeliveryPlan } from './topic-wake.js';
import type { DeliveryAnswer } from './topic-post.js';

export const topicsDir = (): string => path.join(WALNUT_HOME, 'topics');

function topicFile(id: string): string {
  if (!TOPIC_ID_RE.test(id)) throw new TopicError('not_found', 404, `No topic ${id}.`);
  return path.join(topicsDir(), `${id}.json`);
}

/** The experiment, read from the config now. */
export async function topicsEnabled(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    return experimentalEnabled((await getConfig()).experimental, 'topics');
  } catch {
    return false;
  }
}

export const TOPICS_OFF_MESSAGE = 'Topics are an experiment that is off (Settings, Experimental, "Topics"). Ask the user to turn it on.';

/** Refuse unless the experiment is on and this server keeps topics. */
export async function assertTopicsOn(): Promise<void> {
  if (!(await topicsEnabled())) throw new TopicError('topics_off', 404, TOPICS_OFF_MESSAGE);
  if (isFollower()) throw new TopicError('primary_only', 501, 'Topics are kept on the primary; this server holds no copy.');
}

function emitUpdated(topicId: string): void {
  bus.emit(EventNames.TOPIC_UPDATED, { topicId }, ['web-ui'], { source: 'topics' });
}

export async function listTopics(): Promise<Topic[]> {
  if (isFollower()) return [];
  const names = await fs.readdir(topicsDir()).catch(() => [] as string[]);
  const out: Topic[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || !TOPIC_ID_RE.test(name.slice(0, -5))) continue;
    const t = await readTopic(name.slice(0, -5)).catch((err) => {
      log.task.warn('topics: a topic file did not read', { file: name, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readTopic(id: string): Promise<Topic | null> {
  if (isFollower() || !TOPIC_ID_RE.test(id)) return null;
  return normalizeTopic(await readJsonFile<unknown>(topicFile(id), null));
}

/** Write a new topic (its id must be fresh). */
export async function writeNewTopic(topic: Topic): Promise<Topic> {
  if (isFollower()) throw new TopicError('primary_only', 501, 'Topics are kept on the primary.');
  const file = topicFile(topic.id);
  await withFileLock(file, async () => {
    const existing = await readJsonFile<unknown>(file, null);
    if (existing) throw new TopicError('conflict', 409, `Topic ${topic.id} already exists.`);
    await writeJsonFile(file, topic);
  });
  emitUpdated(topic.id);
  return topic;
}

/**
 * Change one topic under its lock: `mutate` edits the fresh copy in place and returns what the
 * caller wants back. `updatedAt` is stamped and the message cap applied before the write.
 */
export async function mutateTopic<R>(id: string, mutate: (topic: Topic) => R | Promise<R>, opts: { touch?: boolean } = {}): Promise<{ topic: Topic; out: R }> {
  if (isFollower()) throw new TopicError('primary_only', 501, 'Topics are kept on the primary.');
  const file = topicFile(id);
  const result = await withFileLock(file, async () => {
    const topic = normalizeTopic(await readJsonFile<unknown>(file, null));
    if (!topic) throw new TopicError('not_found', 404, `No topic ${id}.`);
    const out = await mutate(topic);
    if (opts.touch !== false) topic.updatedAt = new Date().toISOString();
    capMessages(topic);
    await writeJsonFile(file, topic);
    return { topic, out };
  });
  emitUpdated(id);
  return result;
}

export type MemberPatch = Partial<Omit<TopicMember, 'id' | 'ref'>>;

/** Change one member's fields (a key set to undefined is removed). The mail bridge keeps `mail` here. */
export async function updateMember(topicId: string, memberId: string, patch: MemberPatch): Promise<TopicMember> {
  const { out } = await mutateTopic(topicId, (topic) => {
    const m = topic.members.find((x) => x.id === memberId);
    if (!m) throw new TopicError('not_found', 404, `No member ${memberId} in topic ${topicId}.`);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (m as unknown as Record<string, unknown>)[k];
      else (m as unknown as Record<string, unknown>)[k] = v;
    }
    return { ...m };
  }, { touch: false });
  return out;
}

/**
 * Post `text` as member `memberId` (`via` 'mail' for the mail bridge, 'agent' for a captured reply)
 * and run its delivery. Refused when the member is not active or the topic is closed.
 */
export async function appendMemberMessage(topicId: string, memberId: string, text: string, via: MessageVia): Promise<{ message: TopicMessage; delivery: DeliveryAnswer }> {
  const { postMessage } = await import('./topic-post.js');
  return postMessage(topicId, { author: memberId as MemberId, text, via });
}

export type TopicMessageListener = (topic: Topic, message: TopicMessage, plan: DeliveryPlan) => void | Promise<void>;
const listeners = new Set<TopicMessageListener>();

/** Hear every posted message after its delivery ran (the mail bridge). Returns the unregister. */
export function registerTopicMessageListener(fn: TopicMessageListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tell the listeners; one that throws is logged and never stops the others. */
export async function notifyTopicMessage(topic: Topic, message: TopicMessage, plan: DeliveryPlan): Promise<void> {
  for (const fn of [...listeners]) {
    try {
      await fn(topic, message, plan);
    } catch (err) {
      log.task.warn('topics: a message listener failed', { topicId: topic.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
