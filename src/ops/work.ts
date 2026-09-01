import { z } from 'zod';
import { SESSION_ENGINE_IDS, SESSION_MODE_IDS } from '../core/types.js';
import { defineOp } from './registry.js';
import { REPLY_ARRIVES_HINT, TASK_IS_INERT, dispatchHint, withOutcome } from './outcome.js';

const SESSION_MODE = z.enum(SESSION_MODE_IDS);
const SESSION_ENGINE = z.enum(SESSION_ENGINE_IDS);

defineOp({
  name: 'session_start',
  title: 'Start a session for a task',
  description:
    'Start a NEW coding session for one existing task and send it the first message; returns the sessionId. ' +
    'Create the task first with task_create. If the task already has a live session this returns 409 with ' +
    'existing_session_id — talk to it with session_send instead. Pass expect_reply=true to have the new ' +
    'session report back to YOUR session when it finishes (Walnut also notifies you if it ends without replying).',
  input: {
    task: z.string().min(1).describe('Task id or unique prefix'),
    message: z.string().optional().describe('First instruction; defaults to a sentence naming the task'),
    cwd: z.string().optional().describe('Absolute working directory; omit to resolve from the task/project'),
    host: z.string().optional().describe('Execution host alias; omit for the primary box'),
    model: z.string().optional().describe('Session model id or provider model value'),
    mode: SESSION_MODE.optional().describe('Session permission mode'),
    engine: SESSION_ENGINE.optional().describe('Coding agent engine; default claude'),
    expect_reply: z.boolean().optional().describe('Route the session\'s reply back to your session; enables the no-reply fallback notification'),
    reply_timeout: z.number().int().min(60).max(86_400).optional().describe('Seconds before the no-reply notification (default 3600)'),
  },
  handler: async (args, call) => {
    const { task, ...body } = args;
    const started = await call('POST', `/tasks/${encodeURIComponent(String(task))}/start`, body) as
      Record<string, unknown> | undefined;
    const sessionId = typeof started?.sessionId === 'string' ? started.sessionId : '';
    const requestId = typeof started?.requestId === 'string' ? started.requestId : '';
    return withOutcome(
      { ...(started ?? {}) },
      `A session is now running on this task${sessionId ? ` (${sessionId})` : ''} and has your first message. `
      + 'THIS is what does the work; the task row only records it.',
      requestId
        ? `You asked for a reply (${requestId}). ${REPLY_ARRIVES_HINT}`
        : `${REPLY_ARRIVES_HINT} To add context meanwhile: walnut tools call session_send '{"to":"${sessionId || String(task)}","text":"..."}'`,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'session_send',
  title: 'Send a message to a session',
  description:
    'THE way to talk to any session (yours never — no self-send). `to` accepts a session id, a unique id ' +
    'prefix (>=4 chars), a task id (routes to that task\'s session), or a unique title substring. When ' +
    'another session is the caller, the text is delivered as a fenced peer note that carries no user ' +
    'authorization. expect_reply=true asks the receiver to reply and registers a Walnut fallback ' +
    'notification if it finishes without replying. To ANSWER such a request, call this op with ' +
    'in_reply_to=rq-… (omit `to` — the answer routes to the asker automatically). ' +
    'A task with no session yet → 409: start one with session_start.',
  input: {
    to: z.string().min(1).optional().describe('Session id / unique prefix, task id, or unique title substring (omit only with in_reply_to)'),
    text: z.string().min(1).describe('Message text'),
    expect_reply: z.boolean().optional().describe('Ask the receiver to reply; Walnut notifies you if it finishes without replying'),
    reply_timeout: z.number().int().min(60).max(86_400).optional().describe('Seconds before the no-reply notification (default 3600)'),
    in_reply_to: z.string().regex(/^rq-[a-f0-9]{6,}$/).optional().describe('Request id you are answering — routes to the asker'),
    messageId: z.string().regex(/^qm-[A-Za-z0-9-]{1,64}$/).optional().describe('Stable id for retry deduplication'),
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
    return withOutcome(
      { ...b },
      delivery === 'deferred'
        ? `Message queued for ${target}: it is parked on a human permission prompt, so the text lands after the human answers. Do NOT resend.`
        : `Message delivered to ${target}. It is a separate session doing its own work; you did not take over its turn.`,
      typeof b.requestId === 'string' && b.requestId
        ? `You asked for a reply (${b.requestId}). ${REPLY_ARRIVES_HINT}`
        : REPLY_ARRIVES_HINT,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'request_get',
  title: 'Read a reply-request status',
  description:
    'Status of one expect_reply request (rq-…): pending | replied | notified | expired. ' +
    'Prefer NOT polling this — replies and fallback notifications arrive in your session automatically; ' +
    '`walnut wait rq-…` does the waiting for you when you truly cannot continue without the answer.',
  input: {
    id: z.string().regex(/^rq-[a-f0-9]{6,}$/).describe('Request id from session_send/session_start expect_reply'),
  },
  bind: { method: 'GET', path: '/requests/:id' },
  mapResult: ({ body }) => {
    const request = ((body as { request?: unknown } | undefined)?.request ?? body ?? {}) as
      { status?: unknown };
    const status = typeof request.status === 'string' ? request.status : 'unknown';
    const pending = status === 'pending';
    return withOutcome(
      { ...(body as Record<string, unknown> ?? {}) },
      pending
        ? 'Still pending: the other session has not answered yet. Pending means "not settled", never "failed".'
        : `This request is ${status}; nothing is waiting on it any more.`,
      pending
        ? 'Do not poll this. Carry on with your own work: the answer arrives in your session on its own, '
          + 'and `walnut wait <rq-id>` blocks for you if you truly cannot continue.'
        : 'Nothing else is required.',
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
      args.pinned
        ? `Task is on the pinned board, which is human attention only: no session was started. ${TASK_IS_INERT}`
        : 'Task left the pinned board. Nothing about its execution changed.',
      dispatchHint(String(args.id)),
    );
  },
  tags: { readonly: false, remote: 'allow' },
});

defineOp({
  name: 'task_focus_tier_set',
  title: 'Set a pinned task focus tier',
  description:
    'Move a pinned task to Focus, Satellite, Backlog, Wait, or a registered custom tier. A tier is ' +
    'how the board is ORDERED for the human: Focus does not dispatch, schedule, or prioritize any ' +
    'session. Satellite is represented internally by no stored focus_tier. The task must already be pinned.',
  input: {
    id: z.string().min(1).describe('Pinned task id or unique prefix'),
    tier: z.string().min(1).describe('focus, satellite, backlog, wait, or a custom tier id'),
  },
  handler: async (args, call) => {
    const result = await call(
      'PUT',
      `/focus/tasks/${encodeURIComponent(String(args.id))}/tier`,
      { tier: args.tier },
    ) as Record<string, unknown> | undefined;
    return withOutcome(
      { ...(result ?? {}) },
      `Task moved to the ${String(args.tier)} tier of the board. A tier is human attention, not dispatch: `
      + 'no session was started, stopped, or reprioritized.',
      dispatchHint(String(args.id)),
    );
  },
  tags: { readonly: false, remote: 'allow' },
});
