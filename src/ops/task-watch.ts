/**
 * task_watch: a watch on a task, so its follower hears where it stands at least every N
 * (src/core/sessions/task-watch.ts). Usually a VP or Main on a task it follows.
 */
import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

defineOp({
  name: 'task_watch',
  title: 'Watch a task',
  description:
    'Hear where a task stands at least every `every` ("30m", "3h", "1d"; 10 minutes to 7 days). Every status the task '
    + 'gives on its own (its turn ends) restarts the clock. When it runs out, Walnut looks: a task with no live session, '
    + 'or idle with nothing new since its last status, is left alone; otherwise Walnut asks it its status (also in the '
    + 'middle of a long turn) and the answer rides your next message, never waking you. A completion ends the watch. '
    + '`for` is the task that hears it (default: your own task; for a person, the VP or Main that follows the task). '
    + '`off: true` ends it. A VP or Main hears each of its tasks\' turn ends and completion without a watch: use one '
    + 'when you need word by a time.',
  input: {
    id: z.string().min(1).describe('The task to watch (id or unique prefix)'),
    every: z.string().min(1).optional().describe('How often at least: "30m", "3h", "1d"'),
    for: z.string().min(1).optional().describe('The task that hears it; default: your own task'),
    off: z.boolean().optional().describe('true ends the watch'),
  },
  handler: async (args, call) => {
    if (!args.off && !args.every) throw new Error('Pass every ("30m", "3h", "1d"), or off: true to end the watch.');
    const body = await call('PUT', `/tasks/${encodeURIComponent(String(args.id))}/watch`, args.off
      ? { off: true }
      : { every: args.every, ...(args.for ? { for: args.for } : {}) }) as
      { title?: string; watch?: { by_name?: string; every_ms?: number } | null; due_at?: string | null };
    const mins = body.watch?.every_ms ? Math.round(body.watch.every_ms / 60_000) : 0;
    return withOutcome(
      body,
      body.watch
        ? `Watching "${body.title}" every ${mins >= 60 ? `${+(mins / 60).toFixed(1)} h` : `${mins} min`} for "${body.watch.by_name ?? 'its follower'}"; next due ${body.due_at}.`
        : `No watch on "${body.title}" now.`,
      'No further action is required: the answer rides your next message.',
    );
  },
  routes: [{ method: 'PUT', path: '/tasks/:id/watch' }],
  tags: { readonly: false, remote: 'allow' },
});
