/**
 * Ops for an Org node's Threads (src/core/org/threads-model.ts, routes src/web/routes/org-threads-v1.ts):
 * the user's own requests to Main, a VP or a lead, one thread per subject.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import type { OpCall } from './core.js'
import { PROOF_IN_PLACE_RULE, THREAD_ONE_PLACE_RULE, THREADS_KNOWN_RULE, THREADS_OPEN_RULE, THREADS_PENDING_RULE, THREADS_SUMMARY_RULE } from '../core/org/thread-rules.js'
import { THREAD_STATES } from '../core/org/threads-model.js'
import { USER_KINDS, USER_KIND_PARAM, USER_KIND_WHY_PARAM } from '../core/org/user-kind.js'

const THREADS_SCOPE = 'Your Threads are the user\'s own requests to you, one thread per subject, on the Org page beside your Brief '
  + '(Main and every lead keep them; a VP is a lead). Walnut files every message he sends you, and tells you in that message which '
  + 'thread it went to. You keep each thread current: a short title in the language you write to him, one line of what he wants (ask), '
  + 'its state (working: you are on it; needs: waiting on him; answered: you answered and he may close it; pending: nothing new for him), the summary (reply) and '
  + 'the tasks you handed it to. Several asks about one subject are ONE thread: put a new one under the open thread it belongs to '
  + '(merge_into). Walnut puts your chat reply under each of his messages by itself (answer). He closes a thread with Acknowledge; a '
  + 'closed one is kept a week, then deleted; a new ask about a closed subject is a new thread. ' + THREADS_SUMMARY_RULE + ' ' + PROOF_IN_PLACE_RULE + ' ' + THREADS_PENDING_RULE + ' ' + THREADS_KNOWN_RULE + ' ' + THREADS_OPEN_RULE + ' ' + THREAD_ONE_PLACE_RULE

async function ownTask(args: { task?: unknown }, call: OpCall): Promise<string> {
  const id = typeof args.task === 'string' && args.task.trim()
    ? args.task.trim()
    : ((await call('GET', '/me')) as { task?: { id?: string } } | undefined)?.task?.id
  if (!id) throw new Error('No task of your own: pass task.')
  return id
}

const TASK_ARG = z.string().min(1).optional().describe('Task id or unique prefix of Main or a lead; default: your own task')

interface ThreadView { id: string; title: string; state: string; closed?: { how: string } | null; messages?: unknown[]; snoozed?: { until: string }; pinned?: { by: string } }

defineOp({
  name: 'thread_list',
  title: 'List Threads',
  description: `${THREADS_SCOPE} Lists the open ones (newest change first), each with its messages (the user's words, each with your answer and whether he knows it), state, reply and tasks; closed: true lists the closed ones of the past week too (to reopen one). task defaults to your own task.`,
  input: {
    task: TASK_ARG,
    closed: z.boolean().optional().describe('Also the closed ones of the past week'),
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('GET', `/tasks/${encodeURIComponent(id)}/threads${args.closed ? '' : '?open=1'}`) as { title?: string; threads: ThreadView[]; closed_count?: number }
    const open = body.threads.filter((t) => !t.closed).length
    return withOutcome(body, `"${body.title}" has ${open} open thread(s)${body.closed_count ? ` (${body.closed_count} closed this week)` : ''}.`, 'No further action is required.')
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'thread_update',
  title: 'Update a Thread',
  description: `${THREADS_SCOPE} Change one thread: title, ask, state, reply, tasks (replace the list) or add_tasks, known (he reacted to your answers through `
    + 'this message: they fold to context), close ("acked" when he reacted to it as finished, "dropped" when he said it is no longer wanted), reopen, '
    + 'snooze (put it aside until a time when he asked to come back to it later: it leaves his view for its Snoozed section and comes back on its date, or earlier when he writes in it, you answer it, or it moves to needs or answered; "" takes it off), '
    + 'pin (true keeps it at the top of his view whatever its state, until he unpins or acknowledges it; false unpins it; one HE pinned '
    + 'you cannot unpin, snooze or close: 409 pinned_by_user), '
    + 'or merge_into another open thread (alone in its call: its messages move there and it is gone). '
    + 'A wrong merge is undone with thread_split. task defaults to your own task.',
  input: {
    id: z.string().regex(/^th-[a-f0-9]{6,32}$/).describe('The thread (th-...)'),
    title: z.string().min(1).max(120).optional().describe('A few words, in the language you write to the user'),
    ask: z.string().max(400).optional().describe('One line: what he wants ("" clears it)'),
    state: z.enum(THREAD_STATES).optional().describe('working (you are on it; out of his sight until your answer), needs (waiting on him), answered (you answered; he may close it), pending (only handed off: hidden even with your answer on it). A new reply without a state sets answered'),
    user_kind: z.enum(USER_KINDS).optional().describe(USER_KIND_PARAM),
    user_kind_why: z.string().max(300).optional().describe(USER_KIND_WHY_PARAM),
    reply: z.string().max(2000).optional().describe('The summary the card shows: the latest first (the open question or what he must decide), then one or two sentences of background; Markdown ("" clears it)'),
    tasks: z.array(z.string().min(1)).max(12).optional().describe('Every task it went to (replaces the list)'),
    add_tasks: z.array(z.string().min(1)).max(12).optional().describe('Tasks to add to it'),
    known: z.string().regex(/^(tm-[a-f0-9]{6,32}|all)$/).optional().describe('He reacted to your answers through this message (tm-...), or "all": they leave the card. Refused before he reacted'),
    close: z.enum(['acked', 'dropped']).optional().describe('Close it: acked (he reacted to it as finished), dropped (he said it is no longer wanted). Refused before he reacted'),
    reopen: z.boolean().optional().describe('Open a closed thread again'),
    snooze: z.string().max(40).optional().describe('Put it aside until this time: an ISO datetime, a date (that day\'s local midnight) or a duration from now ("4h", "3d"); at most a year; "" takes the snooze off'),
    pin: z.boolean().optional().describe('true pins it to the top of his view whatever its state (until he unpins or acknowledges it); false unpins it. You cannot unpin one he pinned'),
    merge_into: z.string().regex(/^th-[a-f0-9]{6,32}$/).optional().describe('Put this thread under that open thread (same subject)'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const { task: _t, id: threadId, ...patch } = args as Record<string, unknown>
    const body = await call('PATCH', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(threadId))}`, patch) as { thread: ThreadView; merged?: string }
    return withOutcome(
      body,
      body.merged ? `Thread ${body.merged} is now under ${body.thread.id} "${body.thread.title}" (${body.thread.messages?.length ?? 0} messages).`
        : `Thread ${body.thread.id} "${body.thread.title}": ${body.thread.closed ? `closed (${body.thread.closed.how})` : body.thread.state}${body.thread.snoozed && !body.thread.closed && Date.parse(body.thread.snoozed.until) > Date.now() ? `, snoozed until ${body.thread.snoozed.until}` : ''}${body.thread.pinned && !body.thread.closed ? `, pinned${body.thread.pinned.by === 'human' ? ' by the user' : ''}` : ''}.`,
      'No further action is required.',
    )
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'thread_create',
  title: 'Open a Thread yourself',
  description: `${THREADS_SCOPE} Opens a thread of your own for something that reached you the user must act on or asked to follow `
    + '(a mail he must answer, a team\'s question only he can settle, news he asked to hear about): its first post is yours, shown as '
    + 'opened by you and where from, and his reply is filed under it. Never a progress feed, and never beside a letter about the same '
    + 'thing: what is on a thread stays there, a decision as its needs state. task defaults to your own task.',
  input: {
    title: z.string().min(1).max(120).describe('A few words, in the language you write to the user'),
    text: z.string().min(1).max(16000).describe('The first post: what reached you and what he needs to know or decide, Markdown'),
    from: z.enum(['mail', 'task', 'letter', 'trigger', 'node']).describe('Where it came from: mail, task (a team\'s work), letter (your letter to him), trigger, node (your own finding)'),
    ref: z.string().max(120).optional().describe('What it points at: a task id, a letter id (lt-...), a mail subject'),
    state: z.enum(['needs', 'answered']).optional().describe('Default needs (it waits on him)'),
    user_kind: z.enum(USER_KINDS).optional().describe(USER_KIND_PARAM),
    user_kind_why: z.string().max(300).optional().describe(USER_KIND_WHY_PARAM),
    tasks: z.array(z.string().min(1)).max(12).optional().describe('Tasks it is about'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const { task: _t, ...open } = args as Record<string, unknown>
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads/open`, open) as { thread: ThreadView }
    return withOutcome(body, `Opened thread ${body.thread.id} "${body.thread.title}".`, 'His reply to it is filed under it; keep it current with thread_update.')
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'thread_split',
  title: 'Split a Thread message out',
  description: `${THREADS_SCOPE} Takes one message (tm-...) out of a thread into a new thread of its own: a merge that was wrong. task defaults to your own task.`,
  input: {
    id: z.string().regex(/^th-[a-f0-9]{6,32}$/).describe('The thread holding the message'),
    message: z.string().regex(/^tm-[a-f0-9]{6,32}$/).describe('The message to take out (thread_list shows the ids)'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads/${encodeURIComponent(String(args.id))}/split`, { message: args.message }) as { thread: ThreadView }
    return withOutcome(body, `The message is its own thread now: ${body.thread.id}.`, `Give it a title with thread_update {"id":"${body.thread.id}","title":"..."}.`)
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'thread_file',
  title: 'File a request as a Thread',
  description: `${THREADS_SCOPE} Files words of the user's that Walnut did not (a request he made elsewhere, or before Threads existed) on a node's Threads, `
    + 'as a new thread or under thread. Quote his words; never your own. task defaults to your own task.',
  input: {
    text: z.string().min(1).max(8000).describe('The user\'s words, quoted'),
    thread: z.string().regex(/^th-[a-f0-9]{6,32}$/).optional().describe('Put it under this thread'),
    at: z.string().optional().describe('When he said it (ISO); default now'),
    task: TASK_ARG,
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/threads`, {
      text: args.text, ...(args.thread ? { thread: args.thread } : {}), ...(args.at ? { at: args.at } : {}),
    }) as { thread: ThreadView; created: boolean }
    return withOutcome(body, body.created ? `Filed as a new thread ${body.thread.id}.` : `Filed under ${body.thread.id} "${body.thread.title}".`,
      body.created ? `Give it a short title with thread_update {"id":"${body.thread.id}","title":"..."}.` : 'No further action is required.')
  },
  tags: { readonly: false, remote: 'allow' },
})
