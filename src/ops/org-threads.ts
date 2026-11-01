/**
 * Ops for an Org node's Threads (src/core/org/threads-model.ts, routes src/web/routes/org-threads-v1.ts):
 * the user's own requests to Main, a VP or a lead, one thread per subject.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import type { OpCall } from './core.js'

const THREADS_SCOPE = 'Your Threads are the user\'s own requests to you, one thread per subject, on the Org page beside your Brief '
  + '(Main and every lead keep them; a VP is a lead). Walnut files every message he sends you, and tells you in that message which '
  + 'thread it went to. You keep each thread current: a short title in the language you write to him, one line of what he wants (ask), '
  + 'its state (working; needs: waiting on him; answered: you answered and he may close it), one line of where it stands (reply) and '
  + 'the tasks you handed it to. Several asks about one subject are ONE thread: put a new one under the open thread it belongs to '
  + '(merge_into). He closes a thread with Acknowledge; a new ask about a closed subject is a new thread.'

async function ownTask(args: { task?: unknown }, call: OpCall): Promise<string> {
  const id = typeof args.task === 'string' && args.task.trim()
    ? args.task.trim()
    : ((await call('GET', '/me')) as { task?: { id?: string } } | undefined)?.task?.id
  if (!id) throw new Error('No task of your own: pass task.')
  return id
}

const TASK_ARG = z.string().min(1).optional().describe('Task id or unique prefix of Main or a lead; default: your own task')

interface ThreadView { id: string; title: string; state: string; closed?: { how: string } | null; messages?: unknown[] }

defineOp({
  name: 'thread_list',
  title: 'List Threads',
  description: `${THREADS_SCOPE} Lists them, open first (newest change first), each with its messages (the user's words), state, reply and tasks. task defaults to your own task.`,
  input: {
    task: TASK_ARG,
    open: z.boolean().optional().describe('Only the open threads'),
  },
  handler: async (args, call) => {
    const id = await ownTask(args, call)
    const body = await call('GET', `/tasks/${encodeURIComponent(id)}/threads${args.open ? '?open=1' : ''}`) as { title?: string; threads: ThreadView[] }
    const open = body.threads.filter((t) => !t.closed).length
    return withOutcome(body, `"${body.title}" has ${open} open thread(s) and ${body.threads.length - open} closed.`, 'No further action is required.')
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'thread_update',
  title: 'Update a Thread',
  description: `${THREADS_SCOPE} Change one thread: title, ask, state, reply, tasks (replace the list) or add_tasks, close ("acked" when he is done with it, `
    + '"dropped" when it is no longer wanted), reopen, or merge_into another open thread (alone in its call: its messages move there and it is gone). '
    + 'A wrong merge is undone with thread_split. task defaults to your own task.',
  input: {
    id: z.string().regex(/^th-[a-f0-9]{6,32}$/).describe('The thread (th-...)'),
    title: z.string().min(1).max(120).optional().describe('A few words, in the language you write to the user'),
    ask: z.string().max(400).optional().describe('One line: what he wants ("" clears it)'),
    state: z.enum(['new', 'working', 'needs', 'answered']).optional().describe('working, needs (waiting on him), answered (you answered; he may close it)'),
    reply: z.string().max(2000).optional().describe('One or two lines of where it stands, Markdown ("" clears it)'),
    tasks: z.array(z.string().min(1)).max(12).optional().describe('Every task it went to (replaces the list)'),
    add_tasks: z.array(z.string().min(1)).max(12).optional().describe('Tasks to add to it'),
    close: z.enum(['acked', 'dropped']).optional().describe('Close it: acked (he is done with it), dropped (no longer wanted)'),
    reopen: z.boolean().optional().describe('Open a closed thread again'),
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
        : `Thread ${body.thread.id} "${body.thread.title}": ${body.thread.closed ? `closed (${body.thread.closed.how})` : body.thread.state}.`,
      'No further action is required.',
    )
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
