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
 *
 * A member never loses a post (2026-11-23, the user: no message is ever lost). A fold moves the
 * member's readUpto only once the fold is on disk, so its held part is `whole` (no age limit or fold
 * cap drops it) and it follows the member's task to its next session. Only a session gone with none
 * going on drops it, and then its posts go back to the topic as unread first (returnFoldsUnread):
 * the member's next wake or fold carries them again, and each message says why it was not read yet.
 * A readUpto moved back meanwhile is never moved forward again by a delivery that read the topic
 * before (advanceRead). What a wake or fold shows is still cut at WAKE_LINES_MAX_CHARS, newest kept,
 * with a pointer to topic_read for the older lines: those are in the topic, not lost.
 */
import { log } from '../../logging/index.js';
import { PeerThrottle } from '../peers/peer-throttle.js';
import { holdFoldedNotice } from '../sessions/held-notices.js';
import { ORG_MAIN_NODE, pickLead, pickMain } from '../org/org-tree.js';
import type { Task } from '../types.js';
import {
  TopicError, type MemberId, type Topic, type TopicMember, type TopicMessage, type TopicPendingTurn,
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
export { QUEUED_WHY } from './topic-reasons.js';
import { FOLD_GONE_WHY, QUEUED_WHY } from './topic-reasons.js';

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
 * Move `member`'s readUpto (in the fresh `t`) up to `upto`, for a delivery that read the member
 * unread from `from`. A readUpto that went back meanwhile (returnFoldsUnread: its folds' session is
 * gone) stays where it is, so the next wake carries everything again. Once it passes a message the
 * member's FOLD_GONE_WHY mark is on, that mark goes: the member has read it.
 */
export function advanceRead(t: Topic, member: TopicMember, from: string | undefined, upto: string): void {
  const at = (id: string | undefined) => (id ? t.messages.findIndex((m) => m.id === id) : -1);
  if (at(member.readUpto) < at(from)) return;
  member.readUpto = laterOf(t, member.readUpto, upto);
  const end = at(member.readUpto);
  for (const m of t.messages.slice(0, end + 1)) {
    if (!m.refused?.some((r) => r.member === member.id && r.why === FOLD_GONE_WHY)) continue;
    m.refused = m.refused.filter((r) => !(r.member === member.id && r.why === FOLD_GONE_WHY));
    if (!m.refused.length) delete m.refused;
  }
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
    const unread = unreadFor(topic, member, message.id);
    if (!unread.length) continue;
    const lines = unread.map((m) => messageLine(topic, m, opts.userName));
    const head = { id: topic.id, title: topic.title };
    // Whole: no age limit or fold cap drops it, since its readUpto moves (returnFoldsUnread).
    const part: FoldPart = {
      at: Date.now(), lines, whole: true, topic: topic.id, member: id, task: target.taskId, first: unread[0].id, upto: message.id,
    };
    // readUpto moves only once the fold is on disk: a fold that was not saved is read again with the next wake.
    const saved = await holdFoldedNotice<FoldPart>(target.sessionId, `topic:${topic.id}`, part, (parts, dropped) => renderFoldedTopic(head, parts, dropped));
    if (saved) readUpto.set(id, message.id);
    else log.task.warn('topics: a fold was not saved; its member reads these lines with its next wake', { topicId: topic.id, memberId: id, sessionId: target.sessionId });
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
      if (member) advanceRead(t, member, topic.members.find((x) => x.id === id)?.readUpto, upto);
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
    if (m) advanceRead(t, m, member.readUpto, last.id);
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

/**
 * Folds held for a session that is gone with none going on (held-notices-sweep.ts, before it drops
 * them): each member's readUpto goes back to just before the first post its folds carried, so its
 * next wake or fold carries them again, and each of those messages says why (FOLD_GONE_WHY). Only
 * ever moves a readUpto back, so running it twice is the same as once. Posts the member was given
 * after the fold (a wake meanwhile) are given again too: delivered twice, never lost. A topic or a
 * member that is no more has nothing left to read. Returns the topics that could not be written:
 * the sweep keeps their folds and tries them again next lap.
 */
export async function returnFoldsUnread(parts: readonly unknown[]): Promise<Set<string>> {
  const failed = new Set<string>();
  const byTopic = new Map<string, Map<string, { first?: string; upto?: string }>>();
  for (const p of parts) {
    const f = (p && typeof p === 'object' ? p : {}) as FoldPart;
    if (typeof f.topic !== 'string' || typeof f.member !== 'string') continue;
    const members = byTopic.get(f.topic) ?? new Map<string, { first?: string; upto?: string }>();
    byTopic.set(f.topic, members);
    const cur = members.get(f.member);
    // The parts are oldest first: the first part's first post and the last part's last.
    members.set(f.member, { first: cur?.first ?? f.first, upto: f.upto ?? cur?.upto });
  }
  const { mutateTopic } = await import('./topics-store.js');
  for (const [topicId, members] of byTopic) {
    try {
      await mutateTopic(topicId, (t) => {
        for (const [memberId, span] of members) {
          const member = t.members.find((x) => x.id === memberId);
          if (!member) continue;
          const from = span.first ? t.messages.findIndex((m) => m.id === span.first) : -1;
          const to = span.upto ? t.messages.findIndex((m) => m.id === span.upto) : -1;
          if (from < 0 && to < 0) continue;
          // The first post was capped out of the file: every message kept is after it.
          const start = from < 0 ? 0 : from;
          const read = member.readUpto ? t.messages.findIndex((m) => m.id === member.readUpto) : -1;
          if (read >= start) {
            if (start > 0) member.readUpto = t.messages[start - 1].id;
            else delete member.readUpto;
          }
          for (const m of t.messages.slice(start, (to < 0 ? t.messages.length - 1 : to) + 1)) {
            if (!m.folded?.includes(member.id) || m.refused?.some((r) => r.member === member.id && r.why === FOLD_GONE_WHY)) continue;
            m.refused = [...(m.refused ?? []), { member: member.id, why: FOLD_GONE_WHY }];
          }
          log.task.warn('topics: folded posts went back unread, their session is gone', { topicId, memberId, first: span.first, upto: span.upto });
        }
      }, { touch: false });
    } catch (err) {
      if (err instanceof TopicError && err.code === 'not_found') continue;
      failed.add(topicId);
      log.task.warn('topics: folded posts could not go back unread; kept, tried again next lap', {
        topicId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}
