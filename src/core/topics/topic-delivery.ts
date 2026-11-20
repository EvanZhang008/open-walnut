/**
 * A topic message reaches its members (topic-wake.ts planned who).
 *
 * A wake is one `topic` envelope (topic-text.ts) sent into the member's session through the
 * session send path, under source TOPIC_SEND_SOURCE (an agent's row, never the user's own, so
 * thread capture never files it in the member's Threads). A member's wake of another goes through
 * the peer throttle like any task-to-task note. The member's `pendingTurn` records the turn, so its
 * reply is posted back (topic-replies.ts). A fold holds the new lines for the member's next message
 * (held-notices.ts, one notice per topic). A task with no session or a complete one is not woken:
 * the message records why (the web shows it under the message); a topic never starts or reopens a task.
 * Persons are only recorded as mailed: the mail bridge sends.
 */
import { log } from '../../logging/index.js';
import { PeerThrottle } from '../peers/peer-throttle.js';
import { holdFoldedNotice } from '../sessions/held-notices.js';
import { ORG_MAIN_NODE, pickLead, pickMain } from '../org/org-tree.js';
import type { Task } from '../types.js';
import {
  type MemberId, type Topic, type TopicMember, type TopicMessage, type TopicPendingTurn,
} from './topics-model.js';
import { messageLine, renderFoldedTopic, topicWakeText, unreadFor, type FoldPart } from './topic-text.js';
import type { DeliveryPlan, DeliveryRefusal } from './topic-wake.js';
import { notePendingTurn } from './topic-replies.js';

/** The send source of a topic wake (task-wait-resume.ts: an interruption; hints/hint-send.ts: hinted). */
export const TOPIC_SEND_SOURCE = 'topic';

export type TopicSend = (sessionId: string, text: string, opts: { taskId: string }) => Promise<void>;

let sendOverride: TopicSend | null = null;
/** Test seam: replace the session send. */
export function _setTopicSendForTesting(fn: TopicSend | null): void { sendOverride = fn; }

async function sendWake(sessionId: string, text: string, opts: { taskId: string }): Promise<void> {
  if (sendOverride) return sendOverride(sessionId, text, opts);
  const { sendMessageToSession } = await import('../session-message-queue.js');
  await sendMessageToSession(sessionId, text, { source: TOPIC_SEND_SOURCE, taskId: opts.taskId });
}

/** A member's wakes of other members, per sender and target, like any task-to-task note. */
const throttle = new PeerThrottle();

export const NO_SESSION_WHY = 'its task has no session';
export const COMPLETE_WHY = 'its task is complete';
export const NO_TASK_WHY = 'its task was not found';

export const ORG_OFF_WHY = 'the org is off';

export type MemberTarget = { taskId: string; sessionId: string; orgNode: boolean } | { why: string; taskId?: string };

/** The task behind a task or org member now (an org node's task may change). */
export async function memberTask(member: TopicMember, all?: readonly Task[]): Promise<Task | undefined> {
  const { listTasks, listTasksByIds } = await import('../task-manager.js');
  if (member.ref.kind === 'task') return (await listTasksByIds([member.ref.taskId]))[0];
  if (member.ref.kind !== 'org') return undefined;
  const tasks = all ?? await listTasks();
  if (member.ref.node === ORG_MAIN_NODE) return pickMain(tasks);
  const key = member.ref.node.replace(/^project:/, '');
  return key ? pickLead(tasks, key) : undefined;
}

/** Where a member's wake goes, or why it cannot. */
export async function memberTarget(member: TopicMember): Promise<MemberTarget> {
  const task = await memberTask(member);
  if (!task) return { why: NO_TASK_WHY };
  if (task.phase === 'COMPLETE') return { why: COMPLETE_WHY, taskId: task.id };
  const { getSessionsForTask } = await import('../session-tracker.js');
  const { pickDeliverySession } = await import('../routines/session-target.js');
  const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
  if (!target) return { why: NO_SESSION_WHY, taskId: task.id };
  const { isOrgNode } = await import('../org/org-enabled.js');
  return { taskId: task.id, sessionId: target.claudeSessionId, orgNode: isOrgNode(task) };
}

export interface DeliveryOutcome {
  woke: MemberId[];
  folded: MemberId[];
  mailed: MemberId[];
  refused: DeliveryRefusal[];
}

interface MemberUpdate { readUpto?: string; pendingTurn?: TopicPendingTurn }

function laterOf(topic: Topic, a: string | undefined, b: string): string {
  if (!a) return b;
  const ia = topic.messages.findIndex((m) => m.id === a);
  const ib = topic.messages.findIndex((m) => m.id === b);
  return ib > ia ? b : a;
}

/**
 * Run `plan` for `message` of `topic`, then record what happened on the message and the members
 * (one locked write). Never throws for one member's failure: it is a refusal on the message.
 */
export async function deliver(topic: Topic, message: TopicMessage, plan: DeliveryPlan, opts: { userName: string; closing?: boolean; byMember?: boolean }): Promise<{ topic: Topic; outcome: DeliveryOutcome }> {
  // With the org off (Settings, Org), a member's message never wakes Main or a VP: they read it with
  // their next turn instead. The user's own messages still wake them (org-enabled.ts: a person's words go in).
  const byMember = opts.byMember ?? (message.author !== 'human' && message.author !== 'walnut');
  const orgOff = byMember ? !(await import('../org/org-enabled.js').then((m) => m.isOrgEnabled()).catch(() => true)) : false;
  const fold = [...plan.fold];
  const outcome: DeliveryOutcome = { woke: [], folded: [], mailed: [...plan.mail], refused: [...plan.refused] };
  const updates = new Map<MemberId, MemberUpdate>();
  const nowIso = new Date().toISOString();

  for (const id of plan.wake) {
    const member = topic.members.find((m) => m.id === id);
    if (!member) continue;
    const target = await memberTarget(member).catch((err): MemberTarget => ({ why: `not reached: ${err instanceof Error ? err.message : String(err)}` }));
    if ('why' in target) {
      outcome.refused.push({ member: id, why: target.why });
      continue;
    }
    if (orgOff && target.orgNode) {
      outcome.refused.push({ member: id, why: ORG_OFF_WHY });
      fold.push(id);
      continue;
    }
    const text = topicWakeText({ topic, member, unread: unreadFor(topic, member, message.id), userName: opts.userName, closing: opts.closing });
    if (message.author !== 'human' && message.author !== 'walnut' && !opts.closing) {
      const decision = throttle.admit(`topic:${topic.id}:${message.author}`, target.sessionId, text);
      if (!decision.allowed) {
        outcome.refused.push({ member: id, why: 'throttled' });
        continue;
      }
    }
    try {
      await sendWake(target.sessionId, text, { taskId: target.taskId });
      outcome.woke.push(id);
      // A turn already waited on in the same session keeps its start: the reply read covers both.
      const prev = member.pendingTurn?.sessionId === target.sessionId ? member.pendingTurn : undefined;
      updates.set(id, { readUpto: message.id, pendingTurn: { sessionId: target.sessionId, since: prev?.since ?? nowIso, messageId: message.id } });
      notePendingTurn(target.sessionId, topic.id);
    } catch (err) {
      const why = `not delivered: ${err instanceof Error ? err.message : String(err)}`;
      outcome.refused.push({ member: id, why });
      log.task.warn('topics: a wake was not delivered', { topicId: topic.id, memberId: id, sessionId: target.sessionId, error: why });
    }
  }

  for (const id of fold) {
    const member = topic.members.find((m) => m.id === id);
    if (!member) continue;
    outcome.folded.push(id);
    const target = await memberTarget(member).catch((): MemberTarget => ({ why: 'not reached' }));
    // No session: nothing to hold it for; the member reads it with its next wake (readUpto stays).
    if ('why' in target) continue;
    const lines = unreadFor(topic, member, message.id).map((m) => messageLine(topic, m, opts.userName));
    if (!lines.length) continue;
    const head = { id: topic.id, title: topic.title };
    holdFoldedNotice<FoldPart>(target.sessionId, `topic:${topic.id}`, { at: Date.now(), lines }, (parts, dropped) => renderFoldedTopic(head, parts, dropped));
    updates.set(id, { readUpto: message.id });
  }

  const { mutateTopic } = await import('./topics-store.js');
  const { topic: saved } = await mutateTopic(topic.id, (t) => {
    const m = t.messages.find((x) => x.id === message.id);
    if (m) {
      if (outcome.woke.length) m.woke = [...new Set([...(m.woke ?? []), ...outcome.woke])];
      if (outcome.folded.length) m.folded = [...new Set([...(m.folded ?? []), ...outcome.folded])];
      if (outcome.mailed.length) m.mailed = [...new Set([...(m.mailed ?? []), ...outcome.mailed])];
      if (outcome.refused.length) m.refused = [...(m.refused ?? []), ...outcome.refused];
    }
    for (const [id, u] of updates) {
      const member = t.members.find((x) => x.id === id);
      if (!member) continue;
      if (u.readUpto) member.readUpto = laterOf(t, member.readUpto, u.readUpto);
      if (u.pendingTurn) member.pendingTurn = u.pendingTurn;
    }
  });
  return { topic: saved, outcome };
}
