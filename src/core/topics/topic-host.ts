/**
 * A topic's host and its thread: the host keeps the topic's thread (when it keeps Threads), so it
 * shows in Threads like any other only once it needs the user or has a result.
 *
 * Opened when the topic is made (topic-post.ts createTopic). When the host changes (the host is
 * removed and another member named, changeMembers), the thread goes with it: moved to the new host's
 * Threads (threads-store.ts moveThread, a hand move), or opened there when there was none; a new
 * host that keeps no Threads leaves the topic without a thread link.
 */
import { log } from '../../logging/index.js';
import { orgDisplayTitle } from '../org/org-tree.js';
import { keepsThreads } from '../org/keeps-threads.js';
import type { Task } from '../types.js';
import { memberTask } from './topic-delivery.js';
import { mutateTopic } from './topics-store.js';
import type { Topic, TopicActor, TopicMember } from './topics-model.js';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Open the topic's quiet thread on `hostTask`'s Threads; undefined when it keeps none or the open failed. */
export async function openHostThread(topic: Pick<Topic, 'id' | 'title' | 'members'>, hostTask: Task, by: TopicActor): Promise<Topic['thread']> {
  if (!keepsThreads(hostTask)) return undefined;
  const names = topic.members.filter((m) => m.status !== 'left').map((m) => m.name).join(', ');
  try {
    const { openNodeThread } = await import('../org/threads-store.js');
    // Out of his sight (pending) until the host has something for him: the topic is the conversation.
    const thread = await openNodeThread(hostTask.id, {
      title: topic.title, from: 'node', ref: topic.id,
      text: `Topic ${topic.id} "${topic.title}" with ${names}. This thread keeps where it stands.`,
      quiet_summary: `Topic "${topic.title}" with ${names}: nothing settled yet.`,
    }, by);
    return { node: hostTask.id, threadId: thread.id };
  } catch (err) {
    log.task.warn('topics: the host thread was not opened', { topicId: topic.id, hostTask: hostTask.id, error: errText(err) });
    return undefined;
  }
}

/**
 * The topic's new host `host` takes its thread: moved from the old host's Threads, or opened on its
 * own when the topic had none (or the move failed); dropped when the new host keeps no Threads.
 * Writes `topic.thread` and returns the topic as saved.
 */
export async function rehostThread(topic: Topic, host: TopicMember, by: TopicActor): Promise<Topic> {
  const task = await memberTask(host).catch(() => undefined);
  if (!task) return topic;
  let next: Topic['thread'];
  if (!keepsThreads(task)) {
    next = undefined;
  } else if (topic.thread && topic.thread.node === task.id) {
    return topic;
  } else if (topic.thread) {
    try {
      const { listTasksByIds } = await import('../task-manager.js');
      const { moveThread } = await import('../org/threads-store.js');
      const from = (await listTasksByIds([topic.thread.node]))[0];
      const moved = await moveThread({
        from: { task: topic.thread.node, title: from ? orgDisplayTitle(from) : topic.thread.node },
        to: { task: task.id, title: orgDisplayTitle(task) },
        threadId: topic.thread.threadId, by, why: `the new host of topic "${topic.title}"`, kind: 'hand',
      });
      next = { node: task.id, threadId: moved.id };
    } catch (err) {
      log.task.warn('topics: the thread did not move to the new host; a new one is opened there', { topicId: topic.id, hostTask: task.id, error: errText(err) });
      next = await openHostThread(topic, task, by);
    }
  } else {
    next = await openHostThread(topic, task, by);
  }
  const { topic: saved } = await mutateTopic(topic.id, (t) => {
    if (next) t.thread = next;
    else delete t.thread;
  });
  return saved;
}
