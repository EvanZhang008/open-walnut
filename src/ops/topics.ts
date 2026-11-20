/**
 * Ops for topics (src/core/topics/, routes src/web/routes/topics-v1.ts): group chats of the user's
 * tasks, Main, the VPs and people reached by mail. Experiment `topics`: off, every op is refused.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import { ROUND_WAKES } from '../core/topics/topics-model.js'

const TOPICS_SCOPE = 'A topic is a group chat the user starts with tasks (yours among them), Main, a VP or people outside Walnut reached by mail. '
  + 'When you are woken in a topic, your reply in that turn is posted to it as you by itself: you need no op to answer. '
  + `@Name in a message wakes that member; a message with no @mention wakes nobody, and the others read it with their next turn. Members wake each other at most ${ROUND_WAKES} times between two messages of the user, and each pair once each way, so agents never talk in a loop.`

const TOPIC_ID = z.string().regex(/^tp-[a-f0-9]{12}$/).describe('The topic (tp-...)')
const CLIENT_ID = z.string().max(120).optional().describe('Any id of your own for this write: the same one again within 2 minutes is answered with the first result, never done twice')

const MEMBER_REF = z.union([
  z.object({ kind: z.literal('task'), taskId: z.string().min(1).describe('Task id') }),
  z.object({ kind: z.literal('org'), node: z.string().regex(/^(?:main|project:.+)$/).describe('"main", or "project:<project key>" for that project\'s VP') }),
  z.object({
    kind: z.literal('person'),
    name: z.string().min(1).max(60).describe('Their name, also their @handle'),
    email: z.string().email().describe('Where they are mailed'),
    bot: z.boolean().optional().describe('Someone else\'s bot, not a person'),
  }),
]).describe('A member: a task, an org node (its task may change), or a person by mail. A person you add waits for the user\'s confirmation before anything is mailed')

interface Member { id: string; name: string; role: string; status: string }
interface TopicView { id: string; title: string; members?: Member[]; messages?: unknown[]; closed?: unknown }
interface Delivery { wake: string[]; fold: string[]; mail: string[]; mailNow?: string[]; refused: Array<{ member: string; why: string }> }

function names(topic: TopicView | undefined, ids: readonly string[]): string {
  return ids.map((id) => topic?.members?.find((m) => m.id === id)?.name ?? id).join(', ')
}

function deliveryWords(topic: TopicView | undefined, d: Delivery | undefined): string {
  if (!d) return ''
  const parts = [
    d.wake.length ? `woke ${names(topic, d.wake)}` : 'woke nobody',
    d.fold.length ? `${names(topic, d.fold)} read it next time` : '',
    // Nothing is mailed by the post itself: the mail bridge sends, at once or on its schedule.
    d.mailNow?.length ? `mailing ${names(topic, d.mailNow)} now` : '',
    d.mail.some((id) => !d.mailNow?.includes(id)) ? `${names(topic, d.mail.filter((id) => !d.mailNow?.includes(id)))} will be mailed` : '',
    d.refused.length ? `not woken: ${d.refused.map((r) => `${names(topic, [r.member])} (${r.why})`).join(', ')}` : '',
  ].filter(Boolean)
  return parts.join('; ')
}

defineOp({
  name: 'topic_list',
  title: 'List topics',
  description: `${TOPICS_SCOPE} Lists every topic, newest change first: its id, title, members (id, @name, kind, status), host and last message.`,
  input: {},
  handler: async (_args, call) => {
    const body = await call('GET', '/api/topics') as { topics: Array<TopicView & { closed?: unknown }> }
    const open = body.topics.filter((t) => !t.closed).length
    return withOutcome(body, `${body.topics.length} topic(s), ${open} open.`, 'No further action is required.')
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'topic_read',
  title: 'Read a topic',
  description: `${TOPICS_SCOPE} Reads one topic whole: members, round (wakes used), and its messages (each with who it woke, who reads it next time and who was mailed); since: only the messages after that message id.`,
  input: {
    id: TOPIC_ID,
    since: z.string().regex(/^tpm-[a-f0-9]{12}$/).optional().describe('Only the messages after this one (tpm-...)'),
  },
  handler: async (args, call) => {
    const body = await call('GET', `/api/topics/${encodeURIComponent(String(args.id))}${args.since ? `?since=${encodeURIComponent(String(args.since))}` : ''}`) as { topic: TopicView }
    return withOutcome(body, `Topic ${body.topic.id} "${body.topic.title}": ${body.topic.members?.length ?? 0} members, ${body.topic.messages?.length ?? 0} message(s) shown${body.topic.closed ? ', closed' : ''}.`, 'No further action is required.')
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'topic_create',
  title: 'Start a topic',
  description: `${TOPICS_SCOPE} Starts a topic with these members; your own task is in it too, and text is its first message, posted as you (wakes only whom it @mentions). `
    + 'host: an index into members (default: the first org node, else the first task); a host that keeps Threads gets a thread for the topic. '
    + 'Only when the user asked for a group conversation, or a question needs several tasks to settle it together; for one task, task_send is the way.',
  input: {
    title: z.string().min(1).max(120).describe('A few words, in the language you write to the user'),
    members: z.array(MEMBER_REF).min(1).max(23).describe('Who is in it'),
    host: z.number().int().min(0).optional().describe('Index into members of the host'),
    text: z.string().max(16000).optional().describe('The first message, posted as you'),
    clientId: CLIENT_ID,
  },
  handler: async (args, call) => {
    const body = await call('POST', '/api/topics', args) as { topic: TopicView; delivery?: Delivery }
    return withOutcome(body, `Started topic ${body.topic.id} "${body.topic.title}" with ${names(body.topic, (body.topic.members ?? []).map((m) => m.id))}.${body.delivery ? ` First message: ${deliveryWords(body.topic, body.delivery)}.` : ''}`, 'Replies are posted to the topic; read them with topic_read.')
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'topic_post',
  title: 'Post in a topic',
  description: `${TOPICS_SCOPE} Posts text as you, outside a turn the topic woke you for (inside one, just reply). @Name in it, or mentions (member ids), wakes those members while this round's wakes last; the rest read it next time. Your task must be a member.`,
  input: {
    id: TOPIC_ID,
    text: z.string().min(1).max(16000).describe('What you say, Markdown; @Name wakes that member'),
    mentions: z.array(z.string().regex(/^mb-[a-f0-9]{8}$/)).max(24).optional().describe('Member ids to wake (also read from @Name in text)'),
    clientId: CLIENT_ID,
  },
  handler: async (args, call) => {
    const { id, ...rest } = args as Record<string, unknown>
    const body = await call('POST', `/api/topics/${encodeURIComponent(String(id))}/messages`, rest) as { message: { id: string }; delivery: Delivery }
    return withOutcome(body, `Posted ${body.message.id}: ${deliveryWords(undefined, body.delivery)}.`, 'Replies come back to the topic; read them with topic_read.')
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'topic_members',
  title: 'Change who is in a topic',
  description: `${TOPICS_SCOPE} Adds members (task, org node, or a person by mail) and removes members by id. A person you add is pending until the user confirms them in the topic: nothing is mailed to them before. Removing the host needs host, the member who hosts it next (its thread moves there). Your task must be a member.`,
  input: {
    id: TOPIC_ID,
    add: z.array(MEMBER_REF).max(23).optional().describe('Members to add'),
    remove: z.array(z.string().regex(/^mb-[a-f0-9]{8}$/)).max(24).optional().describe('Member ids to remove'),
    host: z.string().regex(/^mb-[a-f0-9]{8}$/).optional().describe('The member id (a task or org member) who hosts the topic from now; required to remove the host'),
    clientId: CLIENT_ID,
  },
  handler: async (args, call) => {
    const { id, ...rest } = args as Record<string, unknown>
    const body = await call('POST', `/api/topics/${encodeURIComponent(String(id))}/members`, rest) as { topic: TopicView }
    const members = body.topic.members ?? []
    const pending = members.filter((m) => m.status === 'pending')
    return withOutcome(body, `Topic ${body.topic.id} has ${members.filter((m) => m.status === 'active').length} active member(s)${pending.length ? `; waiting for the user's yes: ${pending.map((m) => m.name).join(', ')}` : ''}.`, 'No further action is required.')
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'topic_close',
  title: 'Close a topic',
  description: `${TOPICS_SCOPE} Closes a topic when it is settled: every task and org member is woken once for its closing word (posted, waking nobody), and nothing more can be posted. Your task must be a member.`,
  input: { id: TOPIC_ID, clientId: CLIENT_ID },
  handler: async (args, call) => {
    const body = await call('POST', `/api/topics/${encodeURIComponent(String(args.id))}/close`, { ...(args.clientId ? { clientId: args.clientId } : {}) }) as { topic: TopicView; delivery: Delivery }
    return withOutcome(body, `Closed topic ${body.topic.id} "${body.topic.title}": ${deliveryWords(body.topic, body.delivery)}.`, 'No further action is required.')
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'topic_mail',
  title: 'Choose the mailbox a topic emails from',
  description: `${TOPICS_SCOPE} Sets the mail account the topic's people are emailed from (accountId; null: no mailbox, nothing is emailed) and how often a person gets the lines that did not name them (everyMinutes, default 15). `
    + 'The user\'s own choice, since the mail goes out in his name: a session is refused (human_only); ask the user to pick it in the topic\'s side panel.',
  input: {
    id: TOPIC_ID,
    accountId: z.string().min(1).nullable().describe('The mail account id (the Mail plugin lists them), or null for none'),
    everyMinutes: z.number().int().min(1).max(1440).optional().describe('Minutes between a person\'s mails of the lines that did not name them'),
  },
  handler: async (args, call) => {
    const { id, ...rest } = args as Record<string, unknown>
    const body = await call('POST', `/api/topics/${encodeURIComponent(String(id))}/mail`, rest) as { topic: TopicView & { mail?: { accountId?: string; everyMinutes: number } } }
    const mail = body.topic.mail
    return withOutcome(body, mail?.accountId ? `Topic ${body.topic.id} emails from account ${mail.accountId}, every ${mail.everyMinutes} min at most.` : `Topic ${body.topic.id} has no mailbox: nothing is emailed.`, 'No further action is required.')
  },
  tags: { readonly: false, remote: 'allow' },
})
