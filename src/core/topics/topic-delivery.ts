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
 * Persons are not mailed here: the message lists them (`toMail`) and the mail bridge sends.
 *
 * A woken member's `pendingTurn` is on disk BEFORE its wake is sent: a turn that ends at once (its
 * result can come before this delivery's last write) still finds the turn its reply belongs to
 * (review 2026-11-20, a reply lost by that race). A wake that was not delivered takes it back.
 *
 * One topic turn at a time per member: a member whose topic turn is still in flight is never sent
 * another wake into it (its answer to the first would be lost in the second's turn: 2026-11-20
 * acceptance, a member's real answer never posted). The turn is marked `more` instead (the wake
 * still counted against the round); when it ends, its reply is posted and ONE follow-up wake
 * carries what it has not read (wakeAgain, from topic-replies.ts). In flight means live
 * (topic-turn-live.ts): the member's delivery session still runs that turn or holds its wake. A
 * turn that no longer runs, or one in another session, is stale: the new wake replaces it.
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
import { sessionTurnLive, turnHoldsWake } from './topic-turn-live.js';

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
/** A wake held back because the member's topic turn still runs: it reads the line when that turn ends. */
export const QUEUED_WHY = 'its turn is still running: it reads this when that turn ends';

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
  refused: DeliveryRefusal[];
}

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
  const outcome: DeliveryOutcome = { woke: [], folded: [], refused: [...plan.refused] };
  const readUpto = new Map<MemberId, string>();
  const nowIso = new Date().toISOString();
  const { mutateTopic } = await import('./topics-store.js');

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
    // The turn goes down first (see the file comment); the one it replaced comes back if the send fails.
    const claim = await claimTurn(topic.id, id, target.sessionId, message.id, nowIso);
    if (claim.queued) {
      outcome.refused.push({ member: id, why: QUEUED_WHY });
      continue;
    }
    notePendingTurn(target.sessionId, topic.id);
    try {
      await sendWake(target.sessionId, text, { taskId: target.taskId });
      outcome.woke.push(id);
      readUpto.set(id, message.id);
    } catch (err) {
      const why = `not delivered: ${err instanceof Error ? err.message : String(err)}`;
      outcome.refused.push({ member: id, why });
      log.task.warn('topics: a wake was not delivered', { topicId: topic.id, memberId: id, sessionId: target.sessionId, error: why });
      await restorePendingTurn(topic.id, id, message.id, claim.before).catch(() => {});
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
    readUpto.set(id, message.id);
  }

  // The turns are already on disk; never written again here (a reply captured meanwhile cleared one).
  const { topic: saved } = await mutateTopic(topic.id, (t) => {
    const m = t.messages.find((x) => x.id === message.id);
    if (m) {
      if (outcome.woke.length) m.woke = [...new Set([...(m.woke ?? []), ...outcome.woke])];
      if (outcome.folded.length) m.folded = [...new Set([...(m.folded ?? []), ...outcome.folded])];
      if (outcome.refused.length) m.refused = [...(m.refused ?? []), ...outcome.refused];
    }
    for (const [id, upto] of readUpto) {
      const member = t.members.find((x) => x.id === id);
      if (member) member.readUpto = laterOf(t, member.readUpto, upto);
    }
  });
  return { topic: saved, outcome };
}

/**
 * Claim member `id`'s topic turn in `sessionId` (one locked write), before its wake is sent. A turn
 * still live (turnHoldsWake: this session, running it or holding its wake, under
 * PENDING_TURN_MAX_MS) is not replaced: it is marked `more` and the wake is not sent (`queued`).
 * Else the new turn is written; `before` is the stale one it replaced.
 */
async function claimTurn(topicId: string, id: MemberId, sessionId: string, messageId: string, nowIso: string): Promise<{ queued: true } | { queued: false; before?: TopicPendingTurn }> {
  const { mutateTopic, readTopic } = await import('./topics-store.js');
  // The session is read outside the topic's lock (the session store and the queue). A turn written
  // between this read and the lock is under TOPIC_TURN_SETTLE_MS old, so it holds the wake anyway.
  const seen = (await readTopic(topicId).catch(() => null))?.members.find((x) => x.id === id)?.pendingTurn;
  const live = seen?.sessionId === sessionId ? await sessionTurnLive(sessionId) : false;
  const { out } = await mutateTopic(topicId, (t): { queued: true } | { queued: false; before?: TopicPendingTurn } => {
    const member = t.members.find((x) => x.id === id);
    if (!member) return { queued: false };
    const cur = member.pendingTurn;
    if (cur && turnHoldsWake(cur, sessionId, live, Date.parse(nowIso))) {
      cur.more = true;
      return { queued: true };
    }
    member.pendingTurn = { sessionId, since: nowIso, messageId };
    return { queued: false, ...(cur ? { before: cur } : {}) };
  }, { touch: false });
  return out;
}

/**
 * The one follow-up wake of a member whose turn ended while more was said to it (`more`): every
 * line it has not read, in one wake (a closing wake when the topic closed meanwhile). False when
 * there is nothing unread, no session to wake, or another turn is already in flight.
 */
export async function wakeAgain(topicId: string, memberId: string, userName: string): Promise<boolean> {
  const { mutateTopic, readTopic } = await import('./topics-store.js');
  const topic = await readTopic(topicId);
  const member = topic?.members.find((m) => m.id === memberId);
  if (!topic || !member || member.status !== 'active') return false;
  const unread = unreadFor(topic, member);
  const last = topic.messages[topic.messages.length - 1];
  if (!unread.length || !last) return false;
  const target = await memberTarget(member).catch((): MemberTarget => ({ why: 'not reached' }));
  if ('why' in target) return false;
  const text = topicWakeText({ topic, member, unread, userName, closing: !!topic.closed });
  const claim = await claimTurn(topic.id, member.id, target.sessionId, last.id, new Date().toISOString());
  if (claim.queued) return false;
  notePendingTurn(target.sessionId, topic.id);
  try {
    await sendWake(target.sessionId, text, { taskId: target.taskId });
  } catch (err) {
    log.task.warn('topics: a follow-up wake was not delivered', { topicId, memberId, sessionId: target.sessionId, error: err instanceof Error ? err.message : String(err) });
    await restorePendingTurn(topic.id, member.id, last.id, claim.before).catch(() => {});
    return false;
  }
  await mutateTopic(topic.id, (t) => {
    const m = t.members.find((x) => x.id === member.id);
    if (m) m.readUpto = laterOf(t, m.readUpto, last.id);
  }, { touch: false });
  return true;
}

/** A wake that was not delivered: its turn goes back to what it was (only while it is still this one). */
async function restorePendingTurn(topicId: string, id: MemberId, messageId: string, before: TopicPendingTurn | undefined): Promise<void> {
  const { mutateTopic } = await import('./topics-store.js');
  await mutateTopic(topicId, (t) => {
    const member = t.members.find((x) => x.id === id);
    if (!member || member.pendingTurn?.messageId !== messageId) return;
    if (before) member.pendingTurn = before;
    else delete member.pendingTurn;
  }, { touch: false });
}
