/**
 * What the user and the members do in a topic: make one, post, change who is in it, confirm a
 * person, close it. Each write goes through the store's lock; a post then runs its delivery
 * (topic-delivery.ts) and tells the message listeners (the mail bridge).
 */
import { log } from '../../logging/index.js';
import { CEO_LABEL, ORG_MAIN_NODE, VP_LABEL, orgDisplayTitle } from '../org/org-tree.js';
import { keepsThreads } from '../org/keeps-threads.js';
import {
  MAIL_EVERY_MINUTES_DEFAULT, TOPIC_MEMBERS_MAX, TOPIC_TEXT_MAX, TOPIC_TITLE_MAX, TopicError, USER_FALLBACK_NAME,
  freshRound, isAgentMember, mentionsOf, newMemberId, newMessageId, newTopicId, sameRef, uniqueName,
  type MemberId, type MemberRef, type MessageVia, type Topic, type TopicActor, type TopicMember, type TopicMessage,
} from './topics-model.js';
import { assertTopicsOn, mutateTopic, notifyTopicMessage, readTopic, writeNewTopic } from './topics-store.js';
import { planClosing, planDelivery, type DeliveryPlan } from './topic-wake.js';
import { deliver, memberTask } from './topic-delivery.js';
import { topicMailTransport, type TopicMailAccount } from './topic-mail-port.js';
import { withDeadline } from '../../lib/with-deadline.js';

/** The user's own name (config.user.name), else "The user". */
export async function userName(): Promise<string> {
  try {
    const { getConfig } = await import('../config-manager.js');
    return (await getConfig()).user?.name?.trim() || USER_FALLBACK_NAME;
  } catch {
    return USER_FALLBACK_NAME;
  }
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const ORG_NODE_RE = /^(?:main|project:.+)$/;

/** A member ref from a request body, checked; throws 400 on anything else. */
export function parseMemberRef(raw: unknown): MemberRef {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === 'task' && typeof r.taskId === 'string' && r.taskId.trim()) return { kind: 'task', taskId: r.taskId.trim() };
  if (r.kind === 'org' && typeof r.node === 'string' && ORG_NODE_RE.test(r.node.trim())) {
    const node = r.node.trim();
    return { kind: 'org', node: node === ORG_MAIN_NODE ? node : `project:${node.slice(8).trim().toLowerCase()}` };
  }
  if (r.kind === 'person' && typeof r.email === 'string' && EMAIL_RE.test(r.email.trim())) {
    const email = r.email.trim();
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : email.split('@')[0];
    return { kind: 'person', name, email, ...(r.bot === true ? { bot: true } : {}) };
  }
  throw new TopicError('bad_input', 400, 'A member is {kind:"task",taskId}, {kind:"org",node:"main"|"project:<key>"} or {kind:"person",name,email,bot?}.');
}

/** The member a ref makes: its name, and pending when an agent added a person. */
async function newMember(ref: MemberRef, by: TopicActor, taken: readonly string[], at: string): Promise<TopicMember> {
  let name: string;
  if (ref.kind === 'person') {
    name = ref.name;
  } else {
    const probe = { id: newMemberId(), ref, name: '', role: 'member', joinedAt: at, addedBy: by, status: 'active' } as TopicMember;
    const task = await memberTask(probe);
    if (ref.kind === 'task' && !task) throw new TopicError('bad_input', 400, `No task ${ref.taskId}.`);
    if (ref.kind === 'task') ref = { kind: 'task', taskId: task!.id };
    name = task ? orgDisplayTitle(task) : ref.kind === 'org' && ref.node === ORG_MAIN_NODE ? CEO_LABEL : `${(ref as { node: string }).node.slice(8)} ${VP_LABEL}`;
  }
  return {
    id: newMemberId(), ref, name: uniqueName(name, taken), role: 'member', joinedAt: at, addedBy: by,
    status: ref.kind === 'person' && by !== 'human' ? 'pending' : 'active',
  };
}

export interface CreateTopicInput { title: string; members: MemberRef[]; host?: number; text?: string; by: TopicActor }

export async function createTopic(input: CreateTopicInput): Promise<{ topic: Topic; message?: TopicMessage; delivery?: DeliveryAnswer }> {
  await assertTopicsOn();
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > TOPIC_TITLE_MAX) throw new TopicError('bad_input', 400, `title must be 1 to ${TOPIC_TITLE_MAX} characters.`);
  const refs: MemberRef[] = [];
  // A session that makes a topic is in it: its first message is its own.
  if (input.by !== 'human') refs.push({ kind: 'task', taskId: input.by.slice(5) });
  for (const r of input.members) if (!refs.some((x) => sameRef(x, r))) refs.push(r);
  if (!refs.length) throw new TopicError('bad_input', 400, 'A topic needs at least one member.');
  if (refs.length > TOPIC_MEMBERS_MAX) throw new TopicError('bad_input', 400, `A topic holds at most ${TOPIC_MEMBERS_MAX} members.`);
  const at = new Date().toISOString();
  const members: TopicMember[] = [];
  for (const ref of refs) members.push(await newMember(ref, input.by, members.map((m) => m.name), at));
  // The host: the one asked for (an index into `members` as given), else the first org member, else the first task.
  const asked = typeof input.host === 'number' ? input.members[input.host] : undefined;
  const host = asked ? members.find((m) => sameRef(m.ref, asked)) : members.find((m) => m.ref.kind === 'org') ?? members.find((m) => m.ref.kind === 'task');
  if (asked && (!host || !isAgentMember(host))) throw new TopicError('bad_input', 400, 'The host must be a task or an org node of the topic.');
  if (host) host.role = 'host';
  const topic: Topic = {
    id: newTopicId(), title, createdAt: at, updatedAt: at, createdBy: input.by, members, messages: [],
    round: freshRound(0, at), mail: { everyMinutes: MAIL_EVERY_MINUTES_DEFAULT },
  };
  const hostTask = host ? await memberTask(host).catch(() => undefined) : undefined;
  if (hostTask && keepsThreads(hostTask)) {
    try {
      const { openNodeThread } = await import('../org/threads-store.js');
      // Out of his sight (pending) until the host has something for him: the topic is the conversation.
      const thread = await openNodeThread(hostTask.id, {
        title, from: 'node', ref: topic.id,
        text: `Topic ${topic.id} "${title}" with ${members.map((m) => m.name).join(', ')}. This thread keeps where it stands.`,
        quiet_summary: `Topic "${title}" with ${members.map((m) => m.name).join(', ')}: nothing settled yet.`,
      }, input.by);
      topic.thread = { node: hostTask.id, threadId: thread.id };
    } catch (err) {
      log.task.warn('topics: the host thread was not opened', { topicId: topic.id, hostTask: hostTask.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await writeNewTopic(topic);
  if (!input.text?.trim()) return { topic };
  const author = input.by === 'human' ? 'human' : members[0].id;
  const posted = await postMessage(topic.id, { author, text: input.text, via: input.by === 'human' ? 'ui' : 'agent' });
  return { topic: (await readTopic(topic.id)) ?? topic, ...posted };
}

/** What a post answers: who was woken, who reads it next time, who is mailed, and who was not woken and why. */
export interface DeliveryAnswer { wake: MemberId[]; fold: MemberId[]; mail: MemberId[]; mailNow: MemberId[]; refused: DeliveryPlan['refused'] }

export interface PostInput {
  author: 'human' | MemberId;
  text: string;
  via: MessageVia;
  mentions?: string[];
  /** A captured closing reply goes into a closed topic (it wakes nobody there). */
  allowClosed?: boolean;
}

export async function postMessage(topicId: string, input: PostInput): Promise<{ message: TopicMessage; delivery: DeliveryAnswer }> {
  await assertTopicsOn();
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new TopicError('bad_input', 400, 'text is required.');
  if (text.length > TOPIC_TEXT_MAX) throw new TopicError('bad_input', 400, `text holds at most ${TOPIC_TEXT_MAX} characters.`);
  const name = await userName();
  const { topic, out } = await mutateTopic(topicId, (t) => {
    if (t.closed && !input.allowClosed) throw new TopicError('closed', 409, `Topic ${t.id} is closed.`);
    if (input.author !== 'human') {
      const m = t.members.find((x) => x.id === input.author);
      if (!m || m.status !== 'active') throw new TopicError('not_member', 409, `Not an active member of topic ${t.id}.`);
    }
    const message: TopicMessage = { id: newMessageId(), at: new Date().toISOString(), author: input.author, text, via: input.via, mentions: mentionsOf(text, input.mentions, t.members) };
    const plan = planDelivery(t, message, { userName: name });
    t.round = plan.round;
    t.messages.push(message);
    if (plan.budgetLine) t.messages.push({ id: newMessageId(), at: message.at, author: 'walnut', text: plan.budgetLine, mentions: [], via: 'system' });
    return { message, plan };
  });
  return runDelivery(topic, out.message, out.plan, { userName: name });
}

async function runDelivery(topic: Topic, message: TopicMessage, plan: DeliveryPlan, opts: { userName: string; closing?: boolean; byMember?: boolean }): Promise<{ message: TopicMessage; delivery: DeliveryAnswer }> {
  const { topic: after, outcome } = await deliver(topic, message, plan, opts);
  const saved = after.messages.find((m) => m.id === message.id) ?? message;
  const delivery: DeliveryAnswer = { wake: outcome.woke, fold: outcome.folded, mail: outcome.mailed, mailNow: plan.mailNow, refused: outcome.refused };
  await notifyTopicMessage(after, saved, { ...plan, wake: outcome.woke, fold: outcome.folded, refused: outcome.refused });
  return { message: saved, delivery };
}

/** The caller's active member in a topic, or 409 not_member. */
export function callerMember(topic: Topic, by: TopicActor): TopicMember {
  const taskId = by === 'human' ? '' : by.slice(5);
  const m = topic.members.find((x) => x.status === 'active' && x.ref.kind === 'task' && x.ref.taskId === taskId);
  if (m) return m;
  throw new TopicError('not_member', 409, `Your task is not a member of topic ${topic.id}: a member adds it with topic_members.`);
}

/** The caller's member id when it is an org node's current task (Main, a VP). */
export async function callerMemberAsync(topic: Topic, by: TopicActor): Promise<TopicMember> {
  try {
    return callerMember(topic, by);
  } catch (err) {
    const taskId = by === 'human' ? '' : by.slice(5);
    for (const m of topic.members) {
      if (m.status !== 'active' || m.ref.kind !== 'org') continue;
      if ((await memberTask(m).catch(() => undefined))?.id === taskId) return m;
    }
    throw err;
  }
}

export async function changeMembers(topicId: string, change: { add?: MemberRef[]; remove?: string[] }, by: TopicActor): Promise<Topic> {
  await assertTopicsOn();
  const current = await readTopic(topicId);
  if (!current) throw new TopicError('not_found', 404, `No topic ${topicId}.`);
  if (by !== 'human') await callerMemberAsync(current, by);
  const at = new Date().toISOString();
  // Names and tasks are read outside the lock; a member added twice at once is kept once below.
  const made: TopicMember[] = [];
  for (const ref of change.add ?? []) {
    if (made.some((m) => sameRef(m.ref, ref))) continue;
    made.push(await newMember(ref, by, [...current.members.map((m) => m.name), ...made.map((m) => m.name)], at));
  }
  const { topic } = await mutateTopic(topicId, (t) => {
    if (t.closed) throw new TopicError('closed', 409, `Topic ${t.id} is closed.`);
    const added: string[] = [];
    const removed: string[] = [];
    for (const m of made) {
      const old = t.members.find((x) => sameRef(x.ref, m.ref));
      if (old && old.status !== 'left') continue;
      if (old) { old.status = m.status; old.joinedAt = at; old.addedBy = by; added.push(old.name); continue; }
      if (t.members.filter((x) => x.status !== 'left').length >= TOPIC_MEMBERS_MAX) throw new TopicError('bad_input', 400, `A topic holds at most ${TOPIC_MEMBERS_MAX} members.`);
      t.members.push({ ...m, name: uniqueName(m.name, t.members.map((x) => x.name)) });
      added.push(m.name);
    }
    for (const id of change.remove ?? []) {
      const m = t.members.find((x) => x.id === id);
      if (!m || m.status === 'left') continue;
      m.status = 'left';
      delete m.pendingTurn;
      removed.push(m.name);
      if (m.role === 'host') {
        m.role = 'member';
        const next = t.members.find((x) => x.status === 'active' && isAgentMember(x));
        if (next) next.role = 'host';
      }
    }
    const words = [added.length ? `Added ${added.map((n) => `@${n}`).join(', ')}` : '', removed.length ? `Removed ${removed.map((n) => `@${n}`).join(', ')}` : ''].filter(Boolean);
    if (words.length) t.messages.push({ id: newMessageId(), at, author: 'walnut', text: `${words.join('. ')}.`, mentions: [], via: 'system' });
  });
  return topic;
}

/** The user's yes for a person an agent added: only then is the person mailed. */
export async function confirmMember(topicId: string, memberId: string): Promise<Topic> {
  await assertTopicsOn();
  const { topic } = await mutateTopic(topicId, (t) => {
    const m = t.members.find((x) => x.id === memberId);
    if (!m) throw new TopicError('not_found', 404, `No member ${memberId} in topic ${t.id}.`);
    if (m.status !== 'pending') throw new TopicError('conflict', 409, `@${m.name} is ${m.status}, not waiting for a yes.`);
    m.status = 'active';
    t.messages.push({ id: newMessageId(), at: new Date().toISOString(), author: 'walnut', text: `@${m.name} confirmed by the user.`, mentions: [], via: 'system' });
  });
  return topic;
}

/** Close a topic: every active task and org member is woken once for its closing word. */
export async function closeTopic(topicId: string, by: TopicActor): Promise<{ topic: Topic; message: TopicMessage; delivery: DeliveryAnswer }> {
  await assertTopicsOn();
  const current = await readTopic(topicId);
  if (!current) throw new TopicError('not_found', 404, `No topic ${topicId}.`);
  if (by !== 'human') await callerMemberAsync(current, by);
  const name = await userName();
  const { topic, out } = await mutateTopic(topicId, (t) => {
    if (t.closed) throw new TopicError('closed', 409, `Topic ${t.id} is already closed.`);
    const at = new Date().toISOString();
    const closer = by === 'human' ? name : t.members.find((m) => m.ref.kind === 'task' && m.ref.taskId === by.slice(5))?.name ?? 'a member';
    const message: TopicMessage = { id: newMessageId(), at, author: 'walnut', text: `Closed by ${closer}.`, mentions: [], via: 'system' };
    t.messages.push(message);
    const plan = planClosing(t);
    t.closed = { at, by };
    return { message, plan };
  });
  const posted = await runDelivery(topic, out.message, out.plan, { userName: name, closing: true, byMember: by !== 'human' });
  return { topic: (await readTopic(topicId)) ?? topic, ...posted };
}

/** How long a read of the mail accounts may take before it answers without them. */
const ACCOUNTS_DEADLINE_MS = 8000;
export const MAIL_EVERY_MINUTES_MAX = 24 * 60;

/** The mail plugin's accounts as the topics bridge sees them; `available` false: the plugin is off or did not answer in time. */
export async function topicMailAccounts(): Promise<{ accounts: TopicMailAccount[]; available: boolean }> {
  const transport = topicMailTransport();
  if (!transport) return { accounts: [], available: false };
  return withDeadline(
    transport.accounts().then((accounts) => ({ accounts, available: true })),
    ACCOUNTS_DEADLINE_MS,
    () => ({ accounts: [], available: false }),
  ).catch(() => ({ accounts: [], available: false }));
}

/**
 * The mailbox a topic's mail goes out from, the user's own choice (mail goes out in his name; the
 * route refuses a session). `accountId` null: no mailbox, nothing is mailed. The account must
 * exist and be able to send. `everyMinutes`: how often a person gets the lines that did not name them.
 */
export async function chooseTopicMail(topicId: string, input: { accountId: string | null; everyMinutes?: number }): Promise<Topic> {
  await assertTopicsOn();
  const every = input.everyMinutes;
  if (every !== undefined && (!Number.isInteger(every) || every < 1 || every > MAIL_EVERY_MINUTES_MAX)) {
    throw new TopicError('bad_input', 400, `everyMinutes must be a whole number from 1 to ${MAIL_EVERY_MINUTES_MAX}.`);
  }
  let account: TopicMailAccount | undefined;
  if (input.accountId !== null) {
    const id = typeof input.accountId === 'string' ? input.accountId.trim() : '';
    if (!id) throw new TopicError('bad_input', 400, 'accountId must be a mail account id, or null for no mailbox.');
    const { accounts, available } = await topicMailAccounts();
    if (!available) throw new TopicError('mail_unavailable', 503, 'The mail plugin is off or did not answer: choose the mailbox again once Mail runs.');
    account = accounts.find((a) => a.accountId === id);
    if (!account) throw new TopicError('bad_input', 400, `No mail account ${id}.`);
    if (!account.canSend) throw new TopicError('cannot_send', 409, `The mail account ${account.address} cannot send.`);
  }
  const { topic } = await mutateTopic(topicId, (t) => {
    if (t.closed) throw new TopicError('closed', 409, `Topic ${t.id} is closed.`);
    const before = t.mail?.accountId;
    t.mail = { ...(account ? { accountId: account.accountId } : {}), everyMinutes: every ?? t.mail?.everyMinutes ?? MAIL_EVERY_MINUTES_DEFAULT };
    if (before === t.mail.accountId) return;
    const text = account ? `Email to this topic's people now goes out from ${account.address}.` : 'No mailbox is chosen: nothing is emailed.';
    t.messages.push({ id: newMessageId(), at: new Date().toISOString(), author: 'walnut', text, mentions: [], via: 'system' });
  });
  log.task.info('topics: mailbox chosen', { topicId, accountId: account?.accountId ?? null, everyMinutes: topic.mail?.everyMinutes });
  return topic;
}
