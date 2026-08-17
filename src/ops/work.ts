import { z } from 'zod';
import { SESSION_MODE_IDS } from '../core/types.js';
import { defineOp } from './registry.js';

const SESSION_MODE = z.enum(SESSION_MODE_IDS);

defineOp({
  name: 'delegate',
  title: 'Delegate tracked work',
  description:
    'Atomically start tracked work. With taskId, reuse that exact task and its live session or start a new session for it. ' +
    'Without taskId, create a new task and session; cwd is then required. This operation never guesses a task from its title. ' +
    'Use task_create instead when the user only wants to record work without starting it.',
  input: {
    taskId: z.string().min(1).optional().describe('Exact task id or unique prefix to reuse; omit to create a new task'),
    message: z.string().min(1).describe('Initial instruction sent to the coding session'),
    cwd: z.string().min(1).optional().describe('Absolute working directory; required only when creating a new task'),
    title: z.string().min(1).max(500).optional().describe('New task title; used only when taskId is omitted'),
    project: z.string().max(256).optional().describe('New task project; omit or use "" for Inbox'),
    host: z.string().optional().describe('Execution host alias; omit for the primary box'),
    model: z.string().optional().describe('Session model id or provider model value'),
    mode: SESSION_MODE.optional().describe('Session permission mode'),
    engine: z.enum(['claude', 'codex']).optional().describe('Coding agent engine; default claude'),
  },
  bind: { method: 'POST', path: '/delegate' },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'task_start',
  title: 'Start or resume a task session',
  description:
    'Start tracked work for one existing task. With resume=true, send the prompt to its running or idle session; ' +
    'if no live session exists, start a new one. Prefer delegate for the normal create-or-reuse workflow.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    resume: z.boolean().optional().describe('Reuse a running or idle session when available; default false'),
    prompt: z.string().optional().describe('Initial or follow-up instruction'),
  },
  handler: async (args, call) => {
    const { id, ...body } = args;
    return call('POST', `/tasks/${encodeURIComponent(String(id))}/start`, body);
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'session_send',
  title: 'Send a session message',
  description:
    'Send a follow-up message to one existing session through Walnut\'s durable queue. ' +
    'Use task_start or delegate when the task has no session yet.',
  input: {
    id: z.string().min(1).describe('Session id'),
    text: z.string().min(1).describe('Message text'),
    messageId: z.string().regex(/^qm-[A-Za-z0-9-]{1,64}$/).optional().describe('Stable id for retry deduplication'),
  },
  handler: async (args, call) => {
    const { id, ...body } = args;
    return call('POST', `/sessions/${encodeURIComponent(String(id))}/messages`, body);
  },
  tags: { readonly: false, remote: 'allow' },
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
    'Set whether a task appears in the pinned working set. Pinning is separate from focus tier; ' +
    'use task_focus_tier_set after pinning when a non-Satellite tier is needed.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    pinned: z.boolean().describe('true to pin; false to unpin'),
  },
  handler: async (args, call) =>
    call(args.pinned ? 'POST' : 'DELETE', `/focus/tasks/${encodeURIComponent(String(args.id))}`),
  tags: { readonly: false, remote: 'allow' },
});

defineOp({
  name: 'task_focus_tier_set',
  title: 'Set a pinned task focus tier',
  description:
    'Move a pinned task to Focus, Satellite, Backlog, Wait, or a registered custom tier. ' +
    'Satellite is represented internally by no stored focus_tier. The task must already be pinned.',
  input: {
    id: z.string().min(1).describe('Pinned task id or unique prefix'),
    tier: z.string().min(1).describe('focus, satellite, backlog, wait, or a custom tier id'),
  },
  handler: async (args, call) =>
    call('PUT', `/focus/tasks/${encodeURIComponent(String(args.id))}/tier`, { tier: args.tier }),
  tags: { readonly: false, remote: 'allow' },
});
