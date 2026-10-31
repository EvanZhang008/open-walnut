import { z } from 'zod';
// Type-only: erased at compile time, so work.ts never depends on core.ts at load
// time (the ops modules are imported in a fixed order by ./index.ts).
import type { OpCall } from './core.js';
import { defineOp, getOp } from './registry.js';
import { startTask, TASK_START_INPUT } from './task-execution.js';
import { deliveryWaitLine, NO_REPLY_ASKED, sendBehindSlowHostLine, REPLY_ARRIVES_HINT, withOutcome } from './outcome.js';
import { MESSAGE_TEXT_HINT } from '../core/team-charter.js';
import { WORK_PLACE_RULE } from '../core/work-place.js';

defineOp({
  name: 'task_start',
  title: 'Start an existing task',
  description:
    'Start or resume the SAME deliverable on an existing task by exact id. An independent goal, or an explicit ' +
    'new-task/clean-context request, needs task_create, even in the same project or client. ' +
    'Only start work the user asked for. If already started, use task_send with the same task id ' +
    'to continue it; do not create a duplicate. Replies return to the caller by default. ' +
    'An accepted start is not a completed task: read the execution field.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    ...TASK_START_INPUT,
  },
  handler: async ({ id, ...body }, call) => startTask(String(id), body, call),
  timeoutMs: 40_000,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'task_send',
  title: 'Send a message to a task',
  description:
    'Message another task (never your own): continue its SAME deliverable, ask for evidence, or reply to a request. ' +
    'An independent goal needs task_create and a fresh session, not the old area owner. ' +
    'Before continuation read task_get to confirm scope and the exact id; never pick by title alone. When another task is the caller, the ' +
    'text is delivered as a <walnut-message kind="peer-note"> envelope, and the receiver treats it as the user\'s ' +
    'request: every task works for the same user. ' +
    'Work handed down or across asks the receiver to reply BY DEFAULT, with a Walnut fallback notification if it ' +
    'finishes without replying; pass expect_reply=false when you do not want an answer. A note UP the org (to your own ' +
    'leader, your VP, or Main: a result, a deploy, a status) asks for no reply by default: pass expect_reply=true to ask a ' +
    'question up. To hand a request you owe to this task ' +
    'instead of answering it now, pass hands_on=rq-… (its id): its asker waits for this task\'s answer instead of hearing you ended ' +
    'without a reply, and is told where the work went; that task\'s answer goes straight to the asker as the answer to it, ' +
    'and you read one line (handed to several tasks, the answers come to you: combine them and answer it yourself). ' +
    'To ANSWER such a request, call this op with ' +
    'in_reply_to=rq-… (omit `to` — the answer routes to the asker automatically). ' +
    'An answer may carry `result` (one sentence: what came of it), `evidence` (paths or links) and `not_done` ' +
    '(what is not done or not checked); a non-empty not_done shows the reply as Partial on the Board and in the Brief, ' +
    'so list there anything left over instead of burying it in the text. ' +
    'Give every message a `title`: the one-line TL;DR the reader sees first. ' +
    'Address the task id. A task not started yet returns 409: use task_start. ' +
    'A COMPLETE task returns 409 target_complete: its work is done and a message would reopen it. ' +
    'Send to it only when it must act again, with force=true and a reason saying why; the reason leads the message. ' +
    'A lead whose project the user put under another VP returns 409 lead_handed_over naming the lead that leads it now: send there. ' +
    'Legacy session ids and handles are also accepted.',
  input: {
    to: z.string().min(1).optional().describe(
      'Task id or unique prefix. Omit only with in_reply_to. Legacy conversation ids and printed handles are accepted for compatibility.'),
    title: z.string().min(1).max(200).optional().describe(
      'One-line TL;DR of the message (about 10 words): the reader sees only this line until they open the message. Always give one; put the detail in `text`.'),
    text: z.string().min(1).optional().describe(`Message text: the detail behind the title. Required, except on an answer (in_reply_to) that gives \`result\`. ${MESSAGE_TEXT_HINT}`),
    expect_reply: z.boolean().optional().describe('Ask the receiver to reply; Walnut notifies you if it finishes without replying. DEFAULT true when a session sends down or across; false when it reports up (to its own leader, its VP, or Main). Pass true to ask a question up, false for fire-and-forget'),
    reply_timeout: z.number().int().min(60).max(86_400).optional().describe('Seconds before the no-reply notification (default 3600)'),
    in_reply_to: z.string().regex(/^rq-[a-f0-9]{6,}$/).optional().describe('Request id you are answering — routes to the asker'),
    hands_on: z.string().regex(/^rq-[a-f0-9]{6,}$/).optional().describe('A request you owe (rq-…) that you hand to this task instead of answering it now: its asker waits for this task\'s answer, is told where the work went, and gets that answer straight from it'),
    force: z.boolean().optional().describe('Send to (or answer) a task that is COMPLETE, which reopens it. Needs `reason`'),
    reason: z.string().min(1).max(500).optional().describe('With force: what changed and why the complete task must act again. Shown to that task and the user'),
    messageId: z.string().regex(/^qm-[A-Za-z0-9-]{1,64}$/).optional().describe('Stable id for retry deduplication'),
    result: z.string().min(1).max(2000).optional().describe('With in_reply_to: one sentence saying what came of the work'),
    evidence: z.union([z.string(), z.array(z.string())]).optional().describe('With in_reply_to: paths or links that show the result (a list, or one per line)'),
    not_done: z.union([z.string(), z.array(z.string())]).optional().describe('With in_reply_to: what is NOT done or not verified (a list, or one per line). Non-empty = the reply reads as Partial'),
  },
  bind: { method: 'POST', path: '/messages' },
  mapResult: ({ body, args }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const delivery = typeof b.delivery === 'string' ? b.delivery : '';
    // The send result names its target `targetSessionId` (session-send-core.ts);
    // fall back to whatever handle the caller used.
    const target = typeof b.targetSessionId === 'string' && b.targetSessionId
      ? b.targetSessionId
      : String(args.to ?? args.in_reply_to ?? 'the session');
    // The target's host did not take its last message in time: this one waits behind it.
    const waiting = sendBehindSlowHostLine(b.waiting, b.requestId, b.messageId);
    return withOutcome(
      { ...b },
      delivery === 'deferred'
        ? `Message queued for ${target}: it is parked on a human permission prompt, so the text lands after the human answers. Do NOT resend.`
        : `Message queued for ${b.targetTaskId || b.taskId || target}${args.force === true ? ' (forced: if it was complete, this reopens it)' : ''}. Accepted for delivery, not a completed reply. Do NOT resend.`
          + (waiting ? ` ${waiting}` : ''),
      (args.in_reply_to && (Array.isArray(args.not_done) ? args.not_done.length > 0 : typeof args.not_done === 'string' && args.not_done.trim() !== '')
        ? 'Marked Partial: the Board and the Brief list what is not done. ' : '')
      + (typeof b.requestId === 'string' && b.requestId
        ? `You asked for a reply (${b.requestId}). ${REPLY_ARRIVES_HINT}`
        : args.in_reply_to ? REPLY_ARRIVES_HINT : NO_REPLY_ASKED)
        + (Array.isArray(b.answeredFor) && b.answeredFor.length
          ? ` It answered ${b.answeredFor.join(', ')} too, so it went straight to the original asker (${b.targetTaskId || target}); the task that handed it to you got one line saying so.`
          : '')
        + (Array.isArray(b.handedOn) && b.handedOn.length ? ` Handed on: ${b.handedOn.join(', ')} now wait for this task's answer, which goes straight to their asker; you read one line. Handed to several tasks, each answer comes to you: combine them and answer.` : '')
        + (Array.isArray(b.handOnRefused) && b.handOnRefused.length
          ? ` Not handed on: ${(b.handOnRefused as { id: string; reason: string }[]).map((r) => `${r.id} (${r.reason})`).join(', ')}.`
          : ''),
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  ...getOp('task_start')!,
  name: 'session_start',
  deprecated: 'Use task_start with id instead of task.',
  input: { task: z.string().min(1), ...TASK_START_INPUT },
  handler: async ({ task, ...body }, call) => startTask(String(task), body, call),
});

defineOp({
  ...getOp('task_send')!,
  name: 'session_send',
  deprecated: 'Use task_send with the task id.',
});

defineOp({
  name: 'task_history',
  title: 'Read a task conversation',
  description: 'Read the current conversation for a task, using the same task id as task_get and task_send. '
    + 'A placeholder returns not_started and no messages. No separate session lookup is needed. '
    + 'A task that switched engines holds earlier sessions too (listed in `sessions`); all:true reads every one of them in order.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    fresh: z.boolean().optional().describe('Force a live transcript read on the primary box'),
    all: z.boolean().optional().describe('Every session of the task, oldest first, not only the active one'),
  },
  handler: async ({ id, fresh, all }, call) => {
    const body = await call('GET', `/tasks/${encodeURIComponent(String(id))}`) as { task?: Record<string, unknown> };
    if (!body?.task?.id) throw new Error('Task response has no id; cannot resolve its conversation.');
    const task = body.task;
    const ids = task.session_ids;
    const sid = task.session_id || task.exec_session_id || (Array.isArray(ids) ? ids.at(-1) : undefined);
    if (!sid) {
      if (task.last_start) throw new Error('This task has a launch attempt but no conversation yet. Read task_get for its execution result.');
      if (!Array.isArray(ids) || ids.length) throw new Error('Task conversation state is unavailable; retry task_history.');
      return { taskId: task.id, execution: { state: 'not_started' }, messages: [] };
    }
    const read = async (sessionId: string) => {
      const h = await call('GET', `/sessions/${encodeURIComponent(sessionId)}/transcript${fresh ? '?fresh=1' : ''}`) as Record<string, unknown> | undefined;
      if (!h || !Array.isArray(h.messages)) throw new Error('Transcript response is incomplete; retry task_history.');
      return h;
    };
    // Earlier sessions an engine switch replaced (an older server has no such route: none).
    const list = await call('GET', `/tasks/${encodeURIComponent(String(task.id))}/sessions`).catch(() => null) as
      { sessions?: Array<{ session_id: string; engine: string; model?: string | null; active?: boolean; started_at?: string | null }> } | null;
    const sessions = (list?.sessions ?? []).map((r) => ({ session_id: r.session_id, engine: r.engine, model: r.model ?? null, active: r.active === true, started_at: r.started_at ?? null }));
    if (all && sessions.length > 1) {
      const messages: unknown[] = [];
      for (const r of sessions) {
        const h = await read(r.session_id).catch(() => ({ messages: [] as unknown[] }));
        messages.push({ role: 'system', kind: 'notification', text: `Session on ${r.engine}${r.model ? ` (${r.model})` : ''}${r.active ? ', the active one' : ''}: ${r.session_id}` });
        messages.push(...(h.messages as unknown[]));
      }
      return { taskId: task.id, sessions, messages };
    }
    const history = await read(String(sid));
    return { ...history, taskId: task.id, ...(sessions.length > 1 ? { sessions } : {}) };
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'request_get',
  title: 'Read a reply-request status',
  description:
    'Status of one expect_reply request (rq-…): pending | replied | notified | expired. ' +
    'Prefer NOT polling this — replies and fallback notifications arrive in your session automatically; ' +
    '`walnut wait rq-…` does the waiting for you when you truly cannot continue without the answer.',
  input: {
    id: z.string().regex(/^rq-[a-f0-9]{6,}$/).describe('Request id returned by task_create, task_start, or task_send'),
  },
  bind: { method: 'GET', path: '/requests/:id' },
  mapResult: ({ body }) => {
    const request = ((body as { request?: unknown } | undefined)?.request ?? body ?? {}) as
      { status?: unknown; id?: unknown };
    const delivery = (body as { delivery?: { state?: unknown } } | undefined)?.delivery;
    const status = typeof request.status === 'string' ? request.status : 'unknown';
    const pending = status === 'pending';
    // The asked message has not gone in yet (a host that did not take it in time).
    const waiting = delivery?.state === 'waiting' ? deliveryWaitLine(delivery, request.id) : '';
    const parked = delivery?.state === 'parked'
      ? `Your message was set aside before it reached that session (${String((delivery as { reason?: unknown }).reason ?? 'parked')}); it goes only if the user retries it there.` : '';
    // An overdue request is still open until a reply settles it.
    const open = pending || status === 'expired';
    return withOutcome(
      { ...(body as Record<string, unknown> ?? {}) },
      waiting
        ? `${pending ? 'Still pending' : 'Overdue, still open'}, and your message has not reached that session yet. ${waiting}`
        : parked ? `${pending ? 'Still pending' : 'Overdue, still open'}. ${parked}`
        : pending
        ? `Still pending: the other session has not answered yet${delivery?.state === 'queued' ? ' (your message is queued for it)' : ''}. Pending means "not settled", never "failed".`
        : `This request is ${status}; nothing is waiting on it any more.`,
      open
        ? 'Do not poll this. Carry on with your own work: the answer arrives in your session on its own, '
          + 'and `walnut wait <rq-id>` blocks for you if you truly cannot continue.'
        : 'Nothing else is required.',
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'message_send_now',
  title: 'Send a queued message now',
  description:
    'A message you sent whose target\'s host did not take it in time (task_send says so; request_get says it has '
    + 'not reached that session yet, with the next try) waits in that queue, and Walnut sends it again by itself. '
    + 'This sends it now, the way the Send now button on the user\'s bubble does: the same queued message, never a '
    + 'second copy. Pass the request id (rq-…) or the message id (qm-…). A message that already went in is not sent '
    + 'again, and one set aside (the user stopped that session) stays for the user\'s Retry.',
  input: {
    id: z.string().regex(/^(rq-[a-f0-9]{6,}|qm-[A-Za-z0-9-]{1,64})$/).describe('The request id (rq-…) or the queued message id (qm-…)'),
  },
  bind: { method: 'POST', path: '/messages/:id/send-now' },
  mapResult: ({ body }) => {
    return withOutcome(
      { ...(body as Record<string, unknown> ?? {}) },
      'Sent again now: the queued message goes to its session. If its host is still slow, request_get shows the next try.',
      'Do not send the text again. The reply, if you asked for one, arrives in your session.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'app_state',
  title: 'What the App beside you shows',
  description:
    'The live state a plugin App shares about your task, whole: for example the code typed in its editor (saved or not), ' +
    'the last test run, a timer. Messages into your session already carry what changed since you last read it ' +
    '(a <walnut-message kind="app-state"> note); call this when you need all of it. Read-only; it never changes the App.',
  input: {},
  bind: { method: 'GET', path: '/me/app-state' },
  mapResult: ({ body }) => {
    const read = (body ?? {}) as { states?: unknown[] };
    const count = Array.isArray(read.states) ? read.states.length : 0;
    return withOutcome(
      { ...read },
      count === 1 ? 'One App shares state about your task.' : count ? `${count} Apps share state about your task.` : 'No App shares state about your task.',
      count ? 'Later messages carry only what changes after this read.' : 'Nothing else is required.',
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'open_items',
  title: 'What is still open for your task',
  description:
    'Unfinished subtasks of your task, replies you are still waiting for, requests to you that you have not answered, ' +
    'and where your task stands now (project, folder, leader). Walnut also puts this into your context after every compaction.',
  input: {
    hook: z.enum(['compact', 'stop']).optional().describe(
      'Set by Walnut\'s own hooks: compact = after a compaction, in the JSON shape a Claude Code SessionStart hook prints; '
      + 'stop = at a turn end, only whether a request to you is still unanswered, as a Stop hook\'s block answer'),
  },
  bind: { method: 'GET', path: '/me/open' },
  mapResult: ({ body, args }) => {
    const open = (body ?? {}) as Record<string, unknown>;
    const text = typeof open.text === 'string' ? open.text : '';
    // The hook's stdout becomes context: `additionalContext` when something is
    // open, and `{}` (nothing injected, no error row) when nothing is.
    if (args.hook === 'stop') {
      const stop = open.stop as { reason?: unknown } | null | undefined;
      return stop && typeof stop.reason === 'string' ? { decision: 'block', reason: stop.reason } : {};
    }
    if (args.hook === 'compact') {
      return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {};
    }
    return withOutcome(
      { ...open },
      ['subtasks', 'waitingOn', 'askedOfYou'].some((k) => Array.isArray(open[k]) && (open[k] as unknown[]).length > 0) || open.board
        ? 'These are still open for your task.' : 'Nothing is open for your task.',
      'Read one with task_get; answer a request with task_send in_reply_to.',
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'task_dir',
  title: 'Your task directory',
  // The whole rule rides this help, so a session spawned before it can still read it.
  description:
    'Make (when missing) and name your task\'s durable working directory on the host your session runs on, ' +
    'the same directory as `$WALNUT_TASK_DIR`. ' + WORK_PLACE_RULE.replace(/^## Where work lives\n\n/, ''),
  input: {},
  bind: { method: 'GET', path: '/me/task-dir' },
  mapResult: ({ body }) => {
    const dir = (body ?? {}) as { path?: string; host?: string; error?: string };
    if (!dir.path) return withOutcome({ ...dir }, `No task directory: ${dir.error ?? 'unknown reason'}.`, 'Put work you must keep in a durable directory, not /tmp.');
    return withOutcome(
      { ...dir },
      `Your task directory is ${dir.path}.`,
      'Keep clones, worktrees, unmerged commits, candidate builds and evidence there; only disposable files go in /tmp.',
    );
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'skill_read',
  title: 'Read a Walnut skill',
  description:
    'Read one skill body on demand by its directory name. Use this when the operating contract names a skill, such as ' +
    '`walnut-self-knowledge`; do not load every skill into the prompt.',
  input: {
    dirName: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).describe('Skill directory name'),
  },
  handler: async (args, call) => call('GET', `/skills/${encodeURIComponent(String(args.dirName))}`),
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'project_metadata_get',
  title: 'Get project settings',
  description:
    'Read one project\'s registry metadata, including default_cwd and default_host. ' +
    'This is not the project rename or merge operation.',
  input: {
    name: z.string().min(1).describe('Project name; Inbox has no metadata row'),
  },
  bind: { method: 'GET', path: '/projects/:name/metadata' },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'project_metadata_update',
  title: 'Update project settings',
  description:
    'Merge execution defaults into one project registry row. Use this for default_cwd or default_host; ' +
    'do not use project rename or merge for settings.',
  input: {
    name: z.string().min(1).describe('Project name; Inbox has no metadata row'),
    default_cwd: z.string().nullable().optional().describe('Absolute default working directory; null clears it'),
    default_host: z.string().nullable().optional().describe('Default execution host alias; null clears it'),
  },
  handler: async (args, call) => {
    const { name, ...body } = args;
    if (body.default_cwd === undefined && body.default_host === undefined) {
      throw new Error('project_metadata_update needs default_cwd or default_host');
    }
    return call('PUT', `/projects/${encodeURIComponent(String(name))}/metadata`, body);
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

// ── Project tracking note ────────────────────────────────────────────────────
//
// The tracking note is ONE note per project (`Projects/<folded name>/Tracking.md`)
// whose location is recorded in `task_projects.metadata.tracking_note`. Two ops
// rather than plain note_read/note_write, because BOTH halves of that sentence are
// server rules: the name folding (src/core/tracking-note.ts, shared with
// ask-agent's projectSafeName) and "the metadata key is the authority". A model
// guessing the path would quietly create a second note beside the real one.

/** Did a note read fail because the note isn't there (vs. a real failure)? */
function isNoteMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not_found|404|Note not found|cannot resolve note reference/i.test(message);
}

/** The project's canonical spelling + its current metadata blob. */
async function projectRow(project: string, call: OpCall): Promise<{ name: string; metadata: Record<string, unknown> }> {
  const body = await call('GET', `/projects/${encodeURIComponent(project)}/metadata`) as
    { name?: unknown; metadata?: unknown } | undefined;
  const name = typeof body?.name === 'string' && body.name ? body.name : project;
  const metadata = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  return { name, metadata };
}

/** The recorded tracking-note path for a project, or '' when it has none. */
function recordedTrackingPath(metadata: Record<string, unknown>): string {
  const value = metadata.tracking_note;
  return typeof value === 'string' ? value.trim() : '';
}

defineOp({
  name: 'project_tracking_get',
  title: 'Read a project\'s tracking note',
  description:
    'Read the tracking note of ONE project — the living note that carries its status, workstreams, '
    + 'open questions and log. Answers { path, content, contentHash, updatedAt }, or { path: null } '
    + 'when the project has no tracking note yet (call project_tracking_ensure to create it). '
    + 'Use this instead of guessing a note path: the path is derived from the project name by a '
    + 'server rule, and a guess creates a SECOND note beside the real one. Keep the contentHash — '
    + 'any edit to the Workstreams table must pass it to note_edit so a human editing the note at '
    + 'the same moment wins with a conflict instead of being overwritten.',
  input: {
    project: z.string().min(1).describe('Project name (exact, case-insensitive); Inbox has no tracking note'),
  },
  handler: async (args, call) => {
    const project = String(args.project ?? '').trim();
    if (!project) return { path: null, reason: 'Inbox has no registry row, so it has no tracking note.' };
    const { readNote } = await import('./core.js');
    const row = await projectRow(project, call);
    const recorded = recordedTrackingPath(row.metadata);
    if (!recorded) {
      return {
        project: row.name,
        path: null,
        reason: `Project "${row.name}" has no tracking note yet (no metadata.tracking_note). `
          + 'project_tracking_ensure creates it, with the skeleton, in one call.',
      };
    }
    try {
      // readNote is note_read's own helper, so a tracking note is read exactly the
      // way every other note is. Its title fallback is path-scoped (it matches
      // `%/<the full path>.md`), so it can never hand back another project's note.
      const note = await readNote({ path: recorded }, call);
      return {
        project: row.name,
        path: note.path,
        content: note.content,
        contentHash: note.contentHash,
        updatedAt: note.updatedAt,
      };
    } catch (err) {
      if (!isNoteMissing(err)) throw err;
      return {
        project: row.name,
        path: null,
        reason: `metadata.tracking_note points at "${recorded}", which is no longer in the vault `
          + '(the human deleted or moved it). project_tracking_ensure writes a fresh skeleton there.',
      };
    }
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'project_tracking_ensure',
  title: 'Create a project\'s tracking note if it has none',
  description:
    'Make sure ONE project has ONE tracking note, and that the registry points at it. Writes the '
    + 'skeleton (status / workstreams / open questions / log) when the project has no note, ADOPTS an '
    + 'existing note at that path instead of overwriting it, and records the path in '
    + 'task_projects.metadata.tracking_note. Idempotent: call it before the first edit of a run and it '
    + 'does nothing when the note is already there. Inbox is refused (it has no registry row). '
    + 'Answers { path, created, adopted } — then edit the note with note_edit, never note_write.',
  input: {
    project: z.string().min(1).describe('Project name (exact, case-insensitive); Inbox is refused'),
  },
  handler: async (args, call) => {
    const project = String(args.project ?? '').trim();
    // Refused HERE, before anything is written: setProjectMetadata refuses Inbox
    // too, but by then the note would already exist as an orphan in the vault.
    if (!project) throw new Error('Inbox has no registry row, so it can hold no tracking note — pass a project name.');

    const { readNote } = await import('./core.js');
    const { TRACKING_SKELETON, trackingNotePathFor } = await import('../core/tracking-note.js');
    const row = await projectRow(project, call);
    const recorded = recordedTrackingPath(row.metadata);
    // The recorded key wins: ensure never MOVES a note that is already claimed,
    // even when the derived path has since changed (a rename leaves the note put).
    const notePath = recorded || trackingNotePathFor(row.name);
    if (!notePath) {
      throw new Error(
        `Project "${row.name}" cannot have a tracking note: its name folds to nothing usable as a `
        + 'folder. Skip it — do not invent a path.',
      );
    }

    let existing: { path: string; contentHash: string; updatedAt?: string } | null = null;
    try {
      existing = await readNote({ path: notePath }, call);
    } catch (err) {
      if (!isNoteMissing(err)) throw err;
    }

    // Metadata BEFORE the note: a refused write (Inbox, a deleted/tombstoned
    // project) must leave nothing behind, and a stray note in the user's vault is
    // theirs to clean up by hand. The opposite order's failure mode — a key
    // pointing at a note that isn't there yet — is a state the pane already
    // renders honestly and a second ensure repairs.
    if (recorded !== notePath) {
      await call('PUT', `/projects/${encodeURIComponent(row.name)}/metadata`, { tracking_note: notePath });
    }

    if (existing) {
      return {
        project: row.name,
        path: existing.path,
        created: false,
        // Adopted = a note was already sitting at that path and the registry did
        // not know about it. Its content is left exactly as the human wrote it.
        adopted: !recorded,
        contentHash: existing.contentHash,
        updatedAt: existing.updatedAt,
      };
    }

    const content = TRACKING_SKELETON(row.name, new Date().toISOString());
    try {
      const created = await call('POST', '/notes', { path: notePath, content }) as
        { path?: unknown; contentHash?: unknown; updatedAt?: unknown } | undefined;
      return {
        project: row.name,
        path: typeof created?.path === 'string' ? created.path : notePath,
        created: true,
        adopted: false,
        contentHash: typeof created?.contentHash === 'string' ? created.contentHash : undefined,
        updatedAt: typeof created?.updatedAt === 'string' ? created.updatedAt : undefined,
      };
    } catch (err) {
      // Create-only 409: another writer won the race between the probe and here.
      // That is an adoption, not a failure — never overwrite what landed.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
      const note = await readNote({ path: notePath }, call);
      return { project: row.name, path: note.path, created: false, adopted: true, contentHash: note.contentHash, updatedAt: note.updatedAt };
    }
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'project_delete',
  title: 'Delete a project',
  description:
    'Delete a project. Its tasks fall back to the Inbox and the NAME IS TOMBSTONED: no background ' +
    'writer (a provider pull, a session launch, task_create with the old name) can re-create it — only an ' +
    'explicit project create re-opens it. A project claimed by a sync provider (ms-todo, jira) ' +
    'refuses a plain delete with 409, because its remote container would otherwise keep pulling the ' +
    'tasks back; pass remote=true to also delete the container on the provider side (irreversible). ' +
    'Only call this when the user explicitly asked to delete the project.',
  input: {
    name: z.string().min(1).describe('Project name (exact, case-insensitive); Inbox cannot be deleted'),
    remote: z.boolean().optional().describe(
      'Also delete the remote container (ms-todo list, …) for a provider-claimed project. Irreversible. ' +
      'Default false: a provider-claimed project then answers 409 and nothing changes'),
  },
  handler: async (args, call) => {
    const query = args.remote === true ? '?remote=1' : '';
    const result = await call('DELETE', `/projects/${encodeURIComponent(String(args.name))}${query}`) as
      Record<string, unknown> | undefined;
    const movedToInbox = typeof result?.movedToInbox === 'number' ? result.movedToInbox : 0;
    const remoteDeleted = result?.remoteDeleted === true;
    return withOutcome(
      { ...(result ?? {}) },
      `Project "${String(args.name)}" deleted${remoteDeleted ? ' here AND on the provider side' : ' (local registry)'}; `
      + `${movedToInbox} task(s) moved to the Inbox. The name is tombstoned, so a sync pull or a stale `
      + 'launcher cannot bring it back.',
      'Nothing else is required. To re-open the name later, create the project explicitly (that is the only door back).',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'task_pin_set',
  title: 'Pin or unpin a task',
  description:
    'Set whether a task appears on the user\'s pinned board. This is where the HUMAN looks, not a ' +
    'dispatch: pinning starts no session and changes no execution. Pinning is separate from focus ' +
    'tier; use task_focus_tier_set after pinning when a non-Satellite tier is needed.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    pinned: z.boolean().describe('true to pin; false to unpin'),
  },
  handler: async (args, call) => {
    const result = await call(
      args.pinned ? 'POST' : 'DELETE',
      `/focus/tasks/${encodeURIComponent(String(args.id))}`,
    ) as Record<string, unknown> | undefined;
    return withOutcome(
      { ...(result ?? {}) },
      args.pinned ? 'Task pinned. Execution is unchanged.' : 'Task unpinned. Execution is unchanged.',
      'No further action is required.',
    );
  },
  tags: { readonly: false, remote: 'allow' },
});

defineOp({
  name: 'task_focus_tier_set',
  title: 'Set a pinned task focus tier',
  description:
    'Move a pinned task to Focus, Satellite, Parked (wait), or a registered custom tier. A tier is ' +
    'how the board is ORDERED for the human: Focus does not dispatch, schedule, or prioritize any ' +
    'session. Satellite is represented internally by no stored focus_tier. The task must already be pinned.',
  input: {
    id: z.string().min(1).describe('Pinned task id or unique prefix'),
    tier: z.string().min(1).describe('focus, satellite, wait (Parked), or a custom tier id'),
  },
  handler: async (args, call) => {
    const result = await call(
      'PUT',
      `/focus/tasks/${encodeURIComponent(String(args.id))}/tier`,
      { tier: args.tier },
    ) as Record<string, unknown> | undefined;
    return withOutcome(
      { ...(result ?? {}) },
      `Task moved to the ${String(args.tier)} tier. Execution is unchanged.`,
      'No further action is required.',
    );
  },
  tags: { readonly: false, remote: 'allow' },
});
