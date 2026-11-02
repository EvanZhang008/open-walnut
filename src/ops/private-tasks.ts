/**
 * task_make_local / task_sync_to_project: a task kept local in a project that syncs to an outside
 * service (src/core/private-tasks/, routes in src/web/routes/private-tasks-v1.ts).
 */
import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

defineOp({
  name: 'task_make_local',
  title: 'Turn a synced task local',
  description:
    'Stop a task syncing to the outside service its project syncs to, and keep it in the same project as a local task '
    + 'with all of its content (title, description, notes, sessions). Its subtasks synced to the same service go with it. '
    + '`outside` says what happens to its copy there: keep (default: left as it is, no longer updated), archive (closed '
    + 'there), or neutralize (its title, description and notes replaced with nothing of the task, then closed). Use it '
    + 'when a task about a private matter (the user\'s own promotion or performance, feedback on a colleague, pay, '
    + 'health, immigration, money, family, a job search, a personal side project) is synced.',
  input: {
    id: z.string().min(1).describe('The task (id or unique prefix)'),
    outside: z.enum(['keep', 'archive', 'neutralize']).optional().describe('What happens to its copy in the outside service (default keep)'),
  },
  handler: async (args, call) => {
    const body = await call('POST', `/tasks/${encodeURIComponent(String(args.id))}/make-local`, {
      ...(args.outside ? { outside: args.outside } : {}),
    }) as { outcome?: string };
    return withOutcome(body, body.outcome ?? 'The task is local.', 'No further action is required.');
  },
  routes: [{ method: 'POST', path: '/tasks/:id/make-local' }],
  tags: { readonly: false, remote: 'allow' },
});

defineOp({
  name: 'task_sync_to_project',
  title: 'Send a local task to its project\'s service',
  description:
    'Give a local task in a project that syncs to an outside service that source, and send it there now: a task '
    + 'Walnut kept local (judged private, a private word, the check could not answer) or one made local. Sending it out '
    + 'is the user\'s decision: pass user_words quoting what the user said asking for it.',
  input: {
    id: z.string().min(1).describe('The task (id or unique prefix)'),
    user_words: z.string().min(1).describe('What the user said asking to send it (quoted, in their language)'),
  },
  handler: async (args, call) => {
    const body = await call('POST', `/tasks/${encodeURIComponent(String(args.id))}/sync-to-project`, {
      user_words: args.user_words,
    }) as { service?: string; sync_error?: string };
    return withOutcome(
      body,
      body.sync_error ? `The task now syncs to ${body.service}, but the first push failed: ${body.sync_error}` : `The task now syncs to ${body.service}.`,
      'No further action is required.',
    );
  },
  routes: [{ method: 'POST', path: '/tasks/:id/sync-to-project' }],
  tags: { readonly: false, remote: 'allow' },
});

defineOp({
  name: 'project_make_local',
  title: 'Stop a project syncing to its outside service',
  description:
    'Turn a whole project local, one batch per call: each task in it that syncs to the project\'s outside service is made '
    + 'local the way task_make_local does it (all content kept, its remote identity released so no pull imports it again, '
    + 'its copy there archived by default or kept), and once none syncs the project itself becomes a Local project. Call '
    + 'again while `remaining` is above 0; check the result between batches. `failed` lists tasks whose copy there could '
    + 'not be closed (they are local all the same).',
  input: {
    name: z.string().min(1).describe('The project name'),
    outside: z.enum(['archive', 'keep']).optional().describe('What happens to each task\'s copy there (default archive: completed there)'),
    limit: z.number().int().min(1).max(200).optional().describe('Tasks per call (default 25)'),
  },
  handler: async (args, call) => {
    const body = await call('POST', `/projects/${encodeURIComponent(String(args.name))}/make-local`, {
      ...(args.outside ? { outside: args.outside } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    }) as { outcome?: string; done?: boolean };
    return withOutcome(body, body.outcome ?? 'Done.', body.done ? 'No further action is required.' : 'Call project_make_local again to continue.');
  },
  routes: [{ method: 'POST', path: '/projects/:name/make-local' }],
  tags: { readonly: false, remote: 'allow' },
});
