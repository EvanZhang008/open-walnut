/**
 * Board ops: the standing surface a leader keeps for the user (skill walnut-board).
 *
 * A board belongs to a task. Its html is written by that task's session or any
 * task in its tree; Walnut keeps the chat threads (a human's questions typed on
 * the Board tab, a session's answers), the user's notes, the board's projects
 * (one area of this board each, NOT a Walnut project) and their status, the
 * user's read ticks and answers to choices, and reminders beside it. The web UI
 * renders the html with live `<walnut-task>` chips. Routes: src/web/routes/board-v1.ts.
 *
 * A team shares ONE board: `task` defaults to the board owner of the calling
 * session's own task (GET /me, then GET /tasks/<it>/board/owner: the task itself
 * when it has a board, else the nearest ancestor with one, else the root of the
 * tree), so a worker updates its leader's board without naming the leader.
 * No op writes read ticks, choices or sections seen: those are the user's word.
 */
import { z } from 'zod';
import type { OpCall } from './core.js';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

interface CallerMe {
  kind?: string
  task?: { id?: string; title?: string }
}

interface BoardOwnerBody {
  task_id?: string
  self?: boolean
}

interface BoardBody {
  board?: { html?: string; version?: number; updated_at?: string; updated_by?: string } | null
  threads?: Record<string, Array<{ author?: string; ts?: string }>>
  marks?: Record<string, { state?: string; note?: string }>
  projects?: Record<string, { title?: string; status?: string; tasks?: string[]; status_by?: string }>
  checks?: Record<string, { hash?: string; read?: boolean; changed?: boolean }>
  choices?: Record<string, { option?: string; label?: string; text?: string }>
  reminders?: Record<string, { at?: string; fired_at?: string }>
  refs?: Array<{ id: string; title?: string; phase?: string }>
  cards?: Record<string, { summary?: string; lane_suggested?: unknown }>
  team?: Array<{ id: string; phase?: string }>
}

/**
 * "cards: 14 open, 6 with no summary from you, 2 suggestions the user has not
 * answered" (G19); '' from a server that sends no kanban fields.
 */
export function cardsLine(b: BoardBody): string {
  if (!Array.isArray(b.team)) return '';
  const cards = b.cards ?? {};
  const open = (b.team ?? []).filter((t) => t.phase !== 'COMPLETE');
  const bare = open.filter((t) => !cards[t.id]?.summary).length;
  const team = new Set((b.team ?? []).map((t) => t.id));
  const suggested = Object.entries(cards).filter(([id, c]) => team.has(id) && c.lane_suggested).length;
  return `cards: ${open.length} open, ${bare} with no summary from you, ${plural(suggested, 'suggestion')} the user has not answered`;
}

export const TASK_ARG = z.string().min(1).optional().describe(
  'Task whose board this is; defaults to your team\'s shared board (yours, else your nearest leader\'s that has one).');

export interface BoardTarget {
  taskId: string
  /** The board belongs to a leader above the caller, not to the caller's own task. */
  shared: boolean
}

export async function resolveBoardTask(args: Record<string, unknown>, call: OpCall): Promise<BoardTarget> {
  const raw = args.task ?? args.task_id;
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (given) return { taskId: given, shared: false };
  const me = await call('GET', '/me').then((b) => b as CallerMe, () => undefined);
  const id = me?.task?.id;
  if (!id) throw new Error('No task of your own to find a board on: pass task (the leader\'s id).');
  const owner = await call('GET', boardPath(id, '/owner')).then((b) => b as BoardOwnerBody, () => undefined);
  const ownerId = typeof owner?.task_id === 'string' && owner.task_id ? owner.task_id : id;
  return { taskId: ownerId, shared: ownerId !== id };
}

export function boardPath(taskId: string, tail = ''): string {
  return `/tasks/${encodeURIComponent(taskId)}/board${tail}`;
}

const SHARED = ' (your leader\'s, shared with your team)';
/** "lead01" or "lead01 (your leader's, shared with your team)" */
const boardOf = (t: BoardTarget) => `${t.taskId}${t.shared ? SHARED : ''}`;
/** "lead01's board" or "lead01's board (your leader's, shared with your team)" */
export const boardOfPossessive = (t: BoardTarget) => `${t.taskId}'s board${t.shared ? SHARED : ''}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

const STATUS_ORDER = ['decide', 'wip', 'wait', 'done'];
const LIST_CAP = 8;

function capped(items: string[]): string {
  return items.length > LIST_CAP ? `${items.slice(0, LIST_CAP).join('; ')}; and ${items.length - LIST_CAP} more` : items.join('; ');
}

function dueReminders(b: BoardBody, nowMs: number): string[] {
  return Object.entries(b.reminders ?? {})
    .filter(([, r]) => !!r.fired_at || (Date.parse(r.at ?? '') <= nowMs))
    .map(([id]) => id);
}

/** Enough of the user's own words on a choice to know it has them; the whole text is under `choices`. */
const CHOICE_WORDS_SHOWN = 120;

/** `deploy-when "Run it now", in their words: "only after the backup…"`, or the words alone. */
function choiceLine(id: string, c: { option?: string; label?: string; text?: string }): string {
  const text = c.text?.replace(/\s+/g, ' ').trim() ?? '';
  const words = text ? `"${text.length > CHOICE_WORDS_SHOWN ? `${text.slice(0, CHOICE_WORDS_SHOWN)}…` : text}"` : '';
  if (!c.option) return `${id} in their own words: ${words}`;
  return `${id} "${c.label ?? c.option}"${words ? `, in their words: ${words}` : ''}`;
}

/**
 * The user's side of the board in a few sentences: projects by status, read
 * ticks, answered choices with their labels, reminders. Empty parts are left out.
 */
function itemsSummary(b: BoardBody, nowMs: number): string {
  const out: string[] = [];
  const projects = Object.values(b.projects ?? {});
  if (projects.length) {
    const counts = STATUS_ORDER.map((s) => [s, projects.filter((p) => p.status === s).length] as const).filter(([, n]) => n);
    const none = projects.filter((p) => !p.status || !STATUS_ORDER.includes(p.status)).length;
    const parts = [...counts.map(([s, n]) => `${n} ${s}`), ...(none ? [`${none} without a status`] : [])];
    const byUser = Object.entries(b.projects ?? {}).filter(([, p]) => p.status && p.status_by === 'human');
    const picked = byUser.length ? ` The user set ${capped(byUser.map(([id, p]) => `${id} to ${p.status}`))}.` : '';
    out.push(`${plural(projects.length, 'project')}: ${parts.join(', ')}.${picked}`);
  }
  const checks = Object.values(b.checks ?? {});
  if (checks.length) {
    const read = checks.filter((c) => c.read).length;
    const changed = checks.filter((c) => c.changed).length;
    out.push(`${read} of ${plural(checks.length, 'point')} read${changed ? `, ${changed} changed since read` : ''}.`);
  }
  const answered = Object.entries(b.choices ?? {});
  if (answered.length) {
    out.push(`${plural(answered.length, 'choice')} answered: ${capped(answered.map(([id, c]) => choiceLine(id, c)))}.`);
  }
  const reminders = Object.entries(b.reminders ?? {});
  if (reminders.length) {
    const due = dueReminders(b, nowMs);
    const pending = reminders.filter(([id]) => !due.includes(id))
      .map(([id, r]) => `${id} at ${r.at ?? '?'}`);
    const parts = [
      ...(due.length ? [`${due.length} due (${capped(due)})`] : []),
      ...(pending.length ? [`${pending.length} pending (${capped(pending)})`] : []),
    ];
    out.push(`Reminders: ${parts.join(', ')}.`);
  }
  return out.join(' ');
}

const NO_BOARD_NEXT = 'Make one: read the skill (walnut tools call skill_read \'{"dirName":"walnut-board"}\'), then board_set.';
const EDIT_NEXT = 'Keep it current with board_edit; answer the user\'s thread messages with board_post.';

defineOp({
  name: 'board_get',
  title: 'Read a task\'s board',
  description:
    'Read your team\'s Board (or the one of the task you name): its html, every chat thread with the user\'s ' +
    'messages and yours, the user\'s notes (under `marks`), the board\'s projects and their status (with who ' +
    'set it: status_by "human" is the user\'s pick), which points ' +
    'the user ticked read (and which changed since), the user\'s answers to choices (an option, their own words ' +
    'under `text`, or both), reminders, and the live ' +
    'state of each task the board names. Read it before every edit. No board yet means a leader has not made ' +
    'one: the walnut-board skill says how.',
  input: { task: TASK_ARG },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const body = await call('GET', boardPath(target.taskId)) as BoardBody;
    // A kanban write makes a board file with no page (html ''): its cards are kept, but there is nothing to edit yet.
    const hasFile = !!body.board && typeof body.board.html === 'string';
    const has = hasFile && body.board!.html!.trim() !== '';
    const nowMs = Date.now();
    const items = has ? itemsSummary(body, nowMs) : '';
    const due = has ? dueReminders(body, nowMs) : [];
    const cards = cardsLine(body);
    return withOutcome(
      { task_id: target.taskId, ...body },
      has
        ? `Board of ${boardOf(target)}: ${boardSummary(body)}, ${body.board!.html!.length} chars of html, last written ${body.board!.updated_at ?? 'unknown'} by ${body.board!.updated_by ?? 'unknown'}.${items ? ` ${items}` : ''}${cards ? ` ${cards}.` : ''}`
        : hasFile
          ? `The board of ${boardOf(target)} has no page yet, only its kanban cards.${cards ? ` ${cards}.` : ''}`
          : `Task ${boardOf(target)} has no board yet.`,
      has
        ? `${due.length ? `A reminder the user set is due on ${due.join(', ')}: raise it with the user now. ` : ''}${EDIT_NEXT}`
        : NO_BOARD_NEXT,
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'board_set',
  title: 'Write a task\'s whole board',
  description:
    'Write the whole Board html of your team (or of the task you name): the first version, or a rebuild ' +
    'when the structure changes. For everything else use board_edit. The html may use <walnut-task id>, ' +
    '<walnut-thread id title>, <walnut-mark id>, <walnut-project id>, <walnut-check id>, ' +
    '<walnut-choice id options recommended title>, <walnut-strip>, <walnut-unread> and data-project="id" on a ' +
    'section; the walnut-board skill has the template. Only the board\'s task and the tasks it leads may write.',
  input: {
    task: TASK_ARG,
    html: z.string().min(1).describe('The complete html document'),
    version: z.number().int().optional().describe('The version you read; the write is refused if the board moved on'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const body = await call('PUT', boardPath(target.taskId), {
      html: args.html,
      ...(args.version !== undefined ? { version: args.version } : {}),
    }) as BoardBody;
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Board of ${boardOf(target)} written: version ${body.board?.version ?? '?'}, ${String(args.html).length} chars. The user sees it on the Board tab.`,
      EDIT_NEXT,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_edit',
  title: 'Edit a task\'s board in place',
  description:
    'Replace exact strings in the Board html of your team (or of the task you name). Each `old` must occur ' +
    'exactly once in the current html, or nothing is written and the error names the edit that failed; ' +
    'several edits apply in order, all or none. This is the normal way to update a board. Editing the text ' +
    'inside a <walnut-check> brings that point back unread for the user.',
  input: {
    task: TASK_ARG,
    edits: z.array(z.object({
      old: z.string().min(1).describe('Exact text to replace; must occur once'),
      new: z.string().describe('Replacement text'),
    })).min(1).max(50).describe('Replacements, applied in order'),
    version: z.number().int().optional().describe('The version you read; the write is refused if the board moved on'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const edits = args.edits as Array<{ old: string; new: string }>;
    const body = await call('POST', boardPath(target.taskId, '/edits'), {
      edits,
      ...(args.version !== undefined ? { version: args.version } : {}),
    }) as BoardBody;
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Board of ${boardOf(target)} updated: ${edits.length} edit${edits.length === 1 ? '' : 's'}, now version ${body.board?.version ?? '?'}.`,
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
    'The user reads the thread, not your chat. One message per post: never paste a history as one blob. ' +
    'Update the section itself with board_edit when the answer changes a status or a decision.',
  input: {
    task: TASK_ARG,
    thread: z.string().min(1).max(128).describe('The thread id (the <walnut-thread id> attribute)'),
    text: z.string().min(1).max(8192).describe(
      'Your message, in light markdown (bold, italic, `code`, lists, code blocks, quotes, links); line breaks are kept'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const body = await call('POST', boardPath(target.taskId, `/threads/${encodeURIComponent(String(args.thread))}`), {
      text: args.text,
    }) as Record<string, unknown> & { message?: { id?: string } };
    const id = typeof body.message?.id === 'string' ? body.message.id : '';
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Posted ${id ? `${id} ` : ''}in thread "${String(args.thread)}" of ${boardOfPossessive(target)}.`,
      'If the answer changed a status or a decision, update that section with board_edit too.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_post_delete',
  title: 'Delete a post from a board thread',
  description:
    'Delete one of your own posts from a thread of your team\'s Board (or of the task you name): a ' +
    'wrong or outdated answer. board_post names the id it made; board_get lists every message id under ' +
    '`threads`. A session may delete only its own posts; the user deletes any from the Board tab.',
  input: {
    task: TASK_ARG,
    thread: z.string().min(1).max(128).describe('The thread id (the <walnut-thread id> attribute)'),
    id: z.string().min(1).max(64).describe('The message id (bm-…)'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const thread = String(args.thread);
    const id = String(args.id);
    const body = await call(
      'DELETE',
      boardPath(target.taskId, `/threads/${encodeURIComponent(thread)}/messages/${encodeURIComponent(id)}`),
    ) as Record<string, unknown>;
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Deleted ${id} from thread "${thread}" of ${boardOfPossessive(target)}.`,
      'Nothing else is needed; post a corrected answer with board_post if one is due.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

const PROJECT_TEXT_ARGS = ['summary', 'latest', 'next', 'waiting', 'meta'] as const;

defineOp({
  name: 'board_project_set',
  title: 'Set a board project\'s status, tasks and card text',
  description:
    'Create or update one project of your team\'s Board (or of the task you name). A board project is one ' +
    'area of this board, one cause or one ticket; it is NOT a Walnut project (a task\'s project field). Its ' +
    'status (decide = needs the user, wip, wait, done) lives in Walnut: every element with ' +
    'data-project="<id>" and every <walnut-project id> on the page recolors on its own, and the strip ' +
    'recounts. The user can pick a status on the page too (you are told when they do); a status the user ' +
    'picked stays theirs: changing or removing it is refused unless you pass override_user: true. ' +
    'The Board tab\'s Overview shows each project as a card: its title, status, tasks, and the card ' +
    'text you set here (summary, latest, next, waiting, meta); set them on every update so the card ' +
    'reads current. Absent fields keep their value; "" clears one; tasks is a full replacement; a ' +
    'project left with no title, status, tasks and text, or delete: true, is removed.',
  input: {
    task: TASK_ARG,
    id: z.string().min(1).max(128).describe('The project id (the data-project / <walnut-project id> value)'),
    title: z.string().max(200).optional().describe('A short name for the area; "" clears it'),
    status: z.enum(['decide', 'wip', 'wait', 'done', '']).optional().describe(
      'decide (needs the user), wip (a task is on it), wait (waiting on someone else), done; "" clears'),
    tasks: z.array(z.string().min(1)).max(200).optional().describe(
      'The task ids working on this area (full ids or unique prefixes); replaces the whole list. The Board ' +
      'tab\'s Overview groups the team by these (a named task\'s own subtasks follow it): a team member no ' +
      'project names falls to "Other tasks" at the end'),
    summary: z.string().max(2000).optional().describe('What this area is, in one to three sentences (the card\'s overview); "" clears'),
    latest: z.string().max(2000).optional().describe('The latest update, newest facts first; Walnut stamps when it changed; "" clears'),
    next: z.string().max(1000).optional().describe('The next step, and who takes it; "" clears'),
    waiting: z.string().max(120).optional().describe('What it waits on, a few words ("3 CRs to deploy"); "" clears'),
    meta: z.string().max(80).optional().describe('A short note for the end of the title row ("6 tickets"); "" clears'),
    delete: z.boolean().optional().describe('Remove the project'),
    override_user: z.boolean().optional().describe(
      'true: replace (or remove) a status the user picked on the page; without it that status stays'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const id = String(args.id);
    const body = await call('PUT', boardPath(target.taskId, `/projects/${encodeURIComponent(id)}`), {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.tasks !== undefined ? { tasks: args.tasks } : {}),
      ...Object.fromEntries(PROJECT_TEXT_ARGS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])),
      ...(args.delete === true ? { delete: true } : {}),
      ...(args.override_user === true ? { override_user: true } : {}),
    }) as { project?: { status?: string; tasks?: string[] } | null };
    const project = body.project;
    return withOutcome(
      { task_id: target.taskId, ...body },
      project
        ? `Project "${id}" of ${boardOfPossessive(target)}: ${project.status || 'no status'}, ${plural(project.tasks?.length ?? 0, 'task')}.`
        : `Project "${id}" removed from ${boardOfPossessive(target)}.`,
      project
        ? 'The page and the Overview card recolor on their own; keep summary, latest and next current here, and the page\'s section with board_edit.'
        : 'Remove its section from the html with board_edit if it is still there.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_remind',
  title: 'Set or clear a reminder on a board item',
  description:
    'Set (or clear) a reminder on one <walnut-choice> or <walnut-thread> of your team\'s Board (or of the task ' +
    'you name), for when the user says "later". When it comes due Walnut tells you in this session and the ' +
    'Board shows it due to the user; raise that item with the user then. One reminder per item; a new one ' +
    'replaces it. The user sets them too, with the Remind me control.',
  input: {
    task: TASK_ARG,
    target: z.string().min(1).max(128).describe('The choice or thread id'),
    at: z.string().describe('When, as an ISO-8601 time in the future (at most 90 days out); "" clears the reminder'),
    note: z.string().max(4096).optional().describe('What to raise, in a few words'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const item = String(args.target);
    const at = typeof args.at === 'string' ? args.at.trim() : '';
    const body = await call('PUT', boardPath(target.taskId, `/reminders/${encodeURIComponent(item)}`), {
      at: at || null,
      ...(typeof args.note === 'string' && args.note.trim() ? { note: args.note } : {}),
    }) as { reminder?: { at?: string } | null };
    return withOutcome(
      { task_id: target.taskId, ...body },
      body.reminder
        ? `Reminder on "${item}" of ${boardOfPossessive(target)} set for ${body.reminder.at ?? at}.`
        : `Reminder on "${item}" of ${boardOfPossessive(target)} cleared.`,
      body.reminder
        ? 'Nothing to poll: when it comes due Walnut tells you in this session; raise that item with the user then.'
        : 'Nothing else is needed.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
