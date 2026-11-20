/**
 * Topics: group chats of tasks, org nodes and people (core/topics/, experiment `topics`). The web
 * calls these; the topic_* ops call the same routes for a session (agent parity: every human
 * action is an agent action too).
 *
 *   GET  /api/topics                              { topics: TopicSummary[] }
 *   POST /api/topics                              { title, members: MemberRef[], host?, text?, clientId? } -> { topic, message?, delivery? }
 *   GET  /api/topics/:id[?since=<tpm id>]         { topic }  (only the messages after `since` when given)
 *   POST /api/topics/:id/messages                 { text, mentions?, clientId? } -> { message, delivery: { wake, fold, mail, mailNow, refused } }
 *   POST /api/topics/:id/members                  { add?: MemberRef[], remove?: MemberId[], clientId? } -> { topic }
 *   POST /api/topics/:id/members/:mid/confirm     -> { topic }  (the user's own yes for a person an agent added)
 *   POST /api/topics/:id/close                    { clientId? } -> { topic, message, delivery }
 *   GET  /api/topics/mail-accounts                { accounts: [{ accountId, address, canSend }], available }
 *   POST /api/topics/:id/mail                     { accountId: string | null, everyMinutes? } -> { topic }  (the user's own choice)
 *
 * The author is the caller, from `x-walnut-caller-sid` alone: none is the user; a session is its
 * task, which must be a member (409 not_member). The experiment off: 404 topics_off for every
 * route. A POST with the same `clientId` from the same caller within 2 minutes answers the first
 * result again.
 */
import { Router, type Request, type Response } from 'express';
import { resolveThreadCaller } from '../../core/org/thread-caller.js';
import { TopicError, TOPIC_MESSAGE_ID_RE, summarize, type MemberRef, type Topic, type TopicActor } from '../../core/topics/topics-model.js';
import { assertTopicsOn, listTopics, readTopic } from '../../core/topics/topics-store.js';
import { callerMemberAsync, changeMembers, chooseTopicMail, closeTopic, confirmMember, createTopic, parseMemberRef, postMessage, topicMailAccounts, userName } from '../../core/topics/topic-post.js';
import { body, header, param } from './board-v1.js';
import { sendV1Error as sendError } from './v1-control-relay.js';

export const topicsV1Router = Router();

type Answer = { status: number; json: unknown };

function route(fn: (req: Request, res: Response) => Promise<Answer>) {
  return (req: Request, res: Response) => {
    fn(req, res).then(
      (a) => { res.status(a.status).json(a.json); },
      (err: unknown) => {
        if (err instanceof TopicError) return sendError(res, err.status, err.code, err.message);
        sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err));
      },
    );
  };
}

/** Who is calling: the user, a session's task, or a session Walnut cannot place (never a member). */
async function callerOf(req: Request): Promise<TopicActor | 'agent'> {
  return (await resolveThreadCaller(header(req, 'x-walnut-caller-sid'))).by;
}

function writer(by: TopicActor | 'agent'): TopicActor {
  if (by === 'agent') throw new TopicError('not_member', 409, 'Walnut cannot place your session on a task, so it is no member of a topic.');
  return by;
}

const DEDUPE_MS = 2 * 60_000;
const answered = new Map<string, { at: number; answer: Promise<Answer> }>();

/** The first answer to the same caller's same POST with this clientId, within DEDUPE_MS. */
function once(req: Request, by: string, run: () => Promise<Answer>): Promise<Answer> {
  const clientId = body(req).clientId;
  if (typeof clientId !== 'string' || !clientId.trim()) return run();
  const now = Date.now();
  for (const [k, v] of answered) if (now - v.at > DEDUPE_MS) answered.delete(k);
  const key = `${by}|${req.baseUrl}${req.path}|${clientId.trim().slice(0, 120)}`;
  const seen = answered.get(key);
  if (seen) return seen.answer;
  const answer = run();
  answered.set(key, { at: now, answer });
  // A refusal is not kept: the same clientId may try again once the cause is fixed.
  answer.catch(() => answered.delete(key));
  return answer;
}

function refs(raw: unknown, field: string): MemberRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TopicError('bad_input', 400, `${field} must be a list of members.`);
  return raw.map(parseMemberRef);
}

async function topicOr404(id: string): Promise<Topic> {
  const t = await readTopic(id);
  if (!t) throw new TopicError('not_found', 404, `No topic ${id}.`);
  return t;
}

topicsV1Router.get('/topics', route(async () => {
  await assertTopicsOn();
  const name = await userName();
  return { status: 200, json: { topics: (await listTopics()).map((t) => summarize(t, name)) } };
}));

topicsV1Router.post('/topics', route(async (req) => {
  await assertTopicsOn();
  const by = writer(await callerOf(req));
  return once(req, by, async () => {
    const b = body(req);
    const out = await createTopic({
      title: typeof b.title === 'string' ? b.title : '',
      members: refs(b.members, 'members'),
      ...(typeof b.host === 'number' ? { host: b.host } : {}),
      ...(typeof b.text === 'string' ? { text: b.text } : {}),
      by,
    });
    return { status: 201, json: out };
  });
}));

// Before /topics/:id, which would take its name for a topic id.
topicsV1Router.get('/topics/mail-accounts', route(async () => {
  await assertTopicsOn();
  return { status: 200, json: await topicMailAccounts() };
}));

topicsV1Router.get('/topics/:id', route(async (req) => {
  await assertTopicsOn();
  const topic = await topicOr404(param(req.params.id));
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  if (since && !TOPIC_MESSAGE_ID_RE.test(since)) throw new TopicError('bad_input', 400, 'since must be a message id (tpm-...).');
  if (!since) return { status: 200, json: { topic } };
  const at = topic.messages.findIndex((m) => m.id === since);
  return { status: 200, json: { topic: { ...topic, messages: at < 0 ? topic.messages : topic.messages.slice(at + 1) } } };
}));

topicsV1Router.post('/topics/:id/messages', route(async (req) => {
  await assertTopicsOn();
  const by = writer(await callerOf(req));
  const id = param(req.params.id);
  return once(req, by, async () => {
    const b = body(req);
    const author = by === 'human' ? 'human' as const : (await callerMemberAsync(await topicOr404(id), by)).id;
    const mentions = Array.isArray(b.mentions) ? b.mentions.filter((m): m is string => typeof m === 'string') : undefined;
    const out = await postMessage(id, { author, text: typeof b.text === 'string' ? b.text : '', via: by === 'human' ? 'ui' : 'agent', ...(mentions ? { mentions } : {}) });
    return { status: 201, json: out };
  });
}));

topicsV1Router.post('/topics/:id/members', route(async (req) => {
  await assertTopicsOn();
  const by = writer(await callerOf(req));
  return once(req, by, async () => {
    const b = body(req);
    const remove = b.remove === undefined ? [] : Array.isArray(b.remove) ? b.remove.filter((m): m is string => typeof m === 'string') : null;
    if (!remove) throw new TopicError('bad_input', 400, 'remove must be a list of member ids.');
    const topic = await changeMembers(param(req.params.id), { add: refs(b.add, 'add'), remove }, by);
    return { status: 200, json: { topic } };
  });
}));

topicsV1Router.post('/topics/:id/members/:mid/confirm', route(async (req) => {
  await assertTopicsOn();
  const by = await callerOf(req);
  // An outward send needs the user's own yes: a session may add a person, never confirm one.
  if (by !== 'human') throw new TopicError('human_only', 403, 'Only the user confirms a person: mail goes to them only after his own yes.');
  return { status: 200, json: { topic: await confirmMember(param(req.params.id), param(req.params.mid)) } };
}));

topicsV1Router.post('/topics/:id/close', route(async (req) => {
  await assertTopicsOn();
  const by = writer(await callerOf(req));
  return once(req, by, async () => ({ status: 200, json: await closeTopic(param(req.params.id), by) }));
}));

topicsV1Router.post('/topics/:id/mail', route(async (req) => {
  await assertTopicsOn();
  // Mail goes out in the user's name: a session may read the choice, only he makes it.
  if ((await callerOf(req)) !== 'human') throw new TopicError('human_only', 403, 'Only the user chooses the mailbox a topic emails from: mail goes out in his name.');
  const b = body(req);
  if (b.accountId !== null && typeof b.accountId !== 'string') throw new TopicError('bad_input', 400, 'accountId must be a mail account id, or null for no mailbox.');
  if (b.everyMinutes !== undefined && typeof b.everyMinutes !== 'number') throw new TopicError('bad_input', 400, 'everyMinutes must be a number of minutes.');
  const topic = await chooseTopicMail(param(req.params.id), {
    accountId: b.accountId as string | null,
    ...(typeof b.everyMinutes === 'number' ? { everyMinutes: b.everyMinutes } : {}),
  });
  return { status: 200, json: { topic } };
}));
