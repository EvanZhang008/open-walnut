/**
 * Who a topic message wakes, who reads it next time, and who is mailed. Pure.
 *
 * The user's message starts a new round. With no @mention it wakes every active task and org
 * member; with mentions only the ones named, the rest read it at their next turn. A member's
 * message wakes nobody unless it names someone, and then at most ROUND_WAKES members a round in
 * all, each pair of members at most once each way a round (two agents never ping-pong). What is
 * not woken folds into the member's next message. Persons are mailed by the mail bridge: now when
 * named, else on its schedule. Pending and left members get nothing; the author never wakes itself.
 *
 * Delivery (topic-delivery.ts) may still refuse a planned wake (no session, the task is complete).
 */
import {
  ROUND_WAKES, freshRound, isAgentMember,
  type MemberId, type Topic, type TopicMessage, type TopicRound,
} from './topics-model.js';

export interface DeliveryRefusal { member: MemberId; why: string }

export interface DeliveryPlan {
  /** Members whose session gets a turn now. */
  wake: MemberId[];
  /** Members who get the message with their next turn instead. */
  fold: MemberId[];
  /** Persons the message is (or will be) mailed to. */
  mail: MemberId[];
  /** Of `mail`, those to mail now (named, or the user wrote to everyone); the rest go on the bridge's schedule. */
  mailNow: MemberId[];
  refused: DeliveryRefusal[];
  /** The topic's round after this message. */
  round: TopicRound;
  /** A Walnut line to post: the round's wakes are used up (once a round). */
  budgetLine?: string;
}

export const PAIR_LIMIT_WHY = 'pair limit';
export const BUDGET_WHY = 'round budget used up';

export function budgetLineText(userName: string): string {
  return `This round's ${ROUND_WAKES} member wakes are used up; the rest wait for ${userName}.`;
}

function emptyPlan(round: TopicRound): DeliveryPlan {
  return { wake: [], fold: [], mail: [], mailNow: [], refused: [], round };
}

function copyRound(r: TopicRound): TopicRound {
  return { ...r, pairs: { ...r.pairs } };
}

export function planDelivery(topic: Topic, message: TopicMessage, opts: { userName?: string } = {}): DeliveryPlan {
  if (message.author === 'walnut' || topic.closed) return emptyPlan(copyRound(topic.round));
  const active = topic.members.filter((m) => m.status === 'active');
  const agents = active.filter(isAgentMember).map((m) => m.id);
  const persons = active.filter((m) => !isAgentMember(m)).map((m) => m.id);
  const named = new Set(message.mentions);

  if (message.author === 'human') {
    const round = freshRound(topic.round.n + 1, message.at);
    const plan = emptyPlan(round);
    if (!message.mentions.length) {
      plan.wake = agents;
      plan.mail = persons;
      plan.mailNow = persons;
      return plan;
    }
    plan.wake = agents.filter((id) => named.has(id));
    plan.fold = agents.filter((id) => !named.has(id));
    plan.mail = persons;
    plan.mailNow = persons.filter((id) => named.has(id));
    return plan;
  }

  const author = message.author;
  const round = copyRound(topic.round);
  const plan = emptyPlan(round);
  const others = agents.filter((id) => id !== author);
  plan.mail = persons.filter((id) => id !== author);
  plan.mailNow = plan.mail.filter((id) => named.has(id));
  let overBudget = false;
  for (const id of others) {
    if (!named.has(id)) { plan.fold.push(id); continue; }
    const there = round.pairs[`${author}>${id}`] ?? 0;
    const back = round.pairs[`${id}>${author}`] ?? 0;
    if (there >= 1 || there + back >= 2) {
      plan.fold.push(id);
      plan.refused.push({ member: id, why: PAIR_LIMIT_WHY });
      continue;
    }
    if (round.hops >= ROUND_WAKES) {
      plan.fold.push(id);
      plan.refused.push({ member: id, why: BUDGET_WHY });
      overBudget = true;
      continue;
    }
    plan.wake.push(id);
    round.hops += 1;
    round.pairs[`${author}>${id}`] = there + 1;
  }
  if (overBudget && !round.budgetTold) {
    round.budgetTold = true;
    plan.budgetLine = budgetLineText(opts.userName ?? 'the user');
  }
  return plan;
}

/** Closing a topic wakes every active task and org member once, outside the round's budget. */
export function planClosing(topic: Topic): DeliveryPlan {
  const active = topic.members.filter((m) => m.status === 'active');
  const plan = emptyPlan(copyRound(topic.round));
  plan.wake = active.filter(isAgentMember).map((m) => m.id);
  plan.mail = active.filter((m) => !isAgentMember(m)).map((m) => m.id);
  plan.mailNow = plan.mail;
  return plan;
}

/** Wakes left this round for members (what a woken member is told). */
export function wakesLeft(round: TopicRound): number {
  return Math.max(0, ROUND_WAKES - round.hops);
}
