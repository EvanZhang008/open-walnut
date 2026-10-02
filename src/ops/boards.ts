/**
 * Board ops: the standing surface a leader keeps for the user (skill walnut-board).
 *
 * A board belongs to a task. Its html is written by that task's session or any
 * task in its tree; Walnut keeps the chat threads (a human's questions typed on
 * the Board tab, a session's answers) and the user's marks beside it, and the web
 * UI renders the html with live `<walnut-task>` chips. Routes: src/web/routes/board-v1.ts.
 *
 * `task` defaults to the calling session's own task (GET /me): a leader never
 * has to know its own id; a worker names its leader's.
 */
import { z } from 'zod';
import type { OpCall } from './core.js';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

interface CallerMe {
  kind?: string
  task?: { id?: string; title?: string }
}

interface BoardBody {
  board?: { html?: string; version?: number; updated_at?: string; updated_by?: string } | null
  threads?: Record<string, Array<{ author?: string; ts?: string }>>
  marks?: Record<string, { state?: string; note?: string }>
  refs?: Array<{ id: string; title?: string; phase?: string }>
}

const TASK_ARG = z.string().min(1).optional().describe(
  'Task whose board this is; defaults to your own task. A worker passes its leader\'s id.');

async function resolveBoardTask(args: Record<string, unknown>, call: OpCall): Promise<string> {
  const given = typeof args.task === 'string' ? args.task.trim() : '';
  if (given) return given;
  const me = await call('GET', '/me').then((b) => b as CallerMe, () => undefined);
  const id = me?.task?.id;
  if (!id) throw new Error('No task of your own to find a board on: pass task (the leader\'s id).');
  return id;
}

function boardPath(taskId: string, tail = ''): string {
  return `/tasks/${encodeURIComponent(taskId)}/board${tail}`;
}

/** "version 3, 2 threads (4 messages from the user), 1 mark" */
function boardSummary(b: BoardBody): string {
  const threads = Object.entries(b.threads ?? {});
  const fromUser = threads.reduce((n, [, msgs]) => n + msgs.filter((m) => m.author === 'user').length, 0);
  const marks = Object.keys(b.marks ?? {}).length;
  const parts = [
    `version ${b.board?.version ?? 0}`,
    `${threads.length} thread${threads.length === 1 ? '' : 's'}${fromUser ? ` (${fromUser} message${fromUser === 1 ? '' : 's'} from the user)` : ''}`,
    `${marks} mark${marks === 1 ? '' : 's'}`,
  ];
  return parts.join(', ');
}

const NO_BOARD_NEXT = 'Make one: read the skill (walnut tools call skill_read \'{"dirName":"walnut-board"}\'), then board_set.';
const EDIT_NEXT = 'Keep it current with board_edit; answer the user\'s thread messages with board_post.';

defineOp({
  name: 'board_get',
  title: 'Read a task\'s board',
  description:
    'Read the Board of your task (or of the task you name): its html, every chat thread with the user\'s ' +
    'messages and yours, the user\'s marks and notes, and the live state of each task the board names. ' +
    'Read it before every edit. No board yet means a leader has not made one: the walnut-board skill says how.',
  input: { task: TASK_ARG },
  handler: async (args, call) => {
    const taskId = await resolveBoardTask(args, call);
    const body = await call('GET', boardPath(taskId)) as BoardBody;
    const has = !!body.board && typeof body.board.html === 'string';
    return withOutcome(
      { task_id: taskId, ...body },
      has
        ? `Board of ${taskId}: ${boardSummary(body)}, ${body.board!.html!.length} chars of html, last written ${body.board!.updated_at ?? 'unknown'} by ${body.board!.updated_by ?? 'unknown'}.`
        : `Task ${taskId} has no board yet.`,
      has ? EDIT_NEXT : NO_BOARD_NEXT,
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'board_set',
  title: 'Write a task\'s whole board',
  description:
    'Write the whole Board html of your task (or of the task you name): the first version, or a rebuild ' +
    'when the structure changes. For everything else use board_edit. The html may use <walnut-task id>, ' +
    '<walnut-thread id title>, <walnut-mark id>, <walnut-strip> and <walnut-unread>; the walnut-board skill ' +
    'has the template. Only the board\'s task and the tasks it leads may write.',
  input: {
    task: TASK_ARG,
    html: z.string().min(1).describe('The complete html document'),
    version: z.number().int().optional().describe('The version you read; the write is refused if the board moved on'),
  },
  handler: async (args, call) => {
    const taskId = await resolveBoardTask(args, call);
    const body = await call('PUT', boardPath(taskId), {
      html: args.html,
      ...(args.version !== undefined ? { version: args.version } : {}),
    }) as BoardBody;
    return withOutcome(
      { task_id: taskId, ...body },
      `Board of ${taskId} written: version ${body.board?.version ?? '?'}, ${String(args.html).length} chars. The user sees it on the Board tab.`,
      EDIT_NEXT,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_edit',
  title: 'Edit a task\'s board in place',
  description:
    'Replace exact strings in the Board html of your task (or of the task you name). Each `old` must occur ' +
    'exactly once in the current html, or nothing is written and the error names the edit that failed; ' +
    'several edits apply in order, all or none. This is the normal way to update a board.',
  input: {
    task: TASK_ARG,
    edits: z.array(z.object({
      old: z.string().min(1).describe('Exact text to replace; must occur once'),
      new: z.string().describe('Replacement text'),
    })).min(1).max(50).describe('Replacements, applied in order'),
    version: z.number().int().optional().describe('The version you read; the write is refused if the board moved on'),
  },
  handler: async (args, call) => {
    const taskId = await resolveBoardTask(args, call);
    const edits = args.edits as Array<{ old: string; new: string }>;
    const body = await call('POST', boardPath(taskId, '/edits'), {
      edits,
      ...(args.version !== undefined ? { version: args.version } : {}),
    }) as BoardBody;
    return withOutcome(
      { task_id: taskId, ...body },
      `Board of ${taskId} updated: ${edits.length} edit${edits.length === 1 ? '' : 's'}, now version ${body.board?.version ?? '?'}.`,
      EDIT_NEXT,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_post',
  title: 'Post in a board thread',
  description:
    'Post your answer or note in one thread of the Board (a <walnut-thread id> on the page). Use it to answer ' +
    'a question the user typed under a section; Walnut delivered that question to you naming the thread. ' +
    'The user reads the thread, not your chat. Update the section itself with board_edit when the answer ' +
    'changes a status or a decision.',
  input: {
    task: TASK_ARG,
    thread: z.string().min(1).max(128).describe('The thread id (the <walnut-thread id> attribute)'),
    text: z.string().min(1).max(8192).describe('Your message; plain text or light markdown'),
  },
  handler: async (args, call) => {
    const taskId = await resolveBoardTask(args, call);
    const body = await call('POST', boardPath(taskId, `/threads/${encodeURIComponent(String(args.thread))}`), {
      text: args.text,
    }) as Record<string, unknown>;
    return withOutcome(
      { task_id: taskId, ...body },
      `Posted in thread "${String(args.thread)}" of ${taskId}'s board.`,
      'If the answer changed a status or a decision, update that section with board_edit too.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
