import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const ENGINES = ['claude', 'codex', 'gemini', 'opencode', 'goose', 'pi', 'dsh', 'custom'] as const;

defineOp({
  name: 'task_switch_engine',
  title: 'Switch a task to another coding engine',
  description:
    'Change the coding engine a task runs on (e.g. Claude Code to Codex, and back) INSIDE the same task: '
    + 'its current session ends and a new session on the other engine starts in the same task, directory and task directory, '
    + 'carrying everything the old session had in its context (its last compaction summary and every turn after it, in full; '
    + 'the oldest turns only when it would not fit the new engine\'s window) plus a transcript file of the whole task. '
    + 'Switching back to an engine the task used before resumes its earlier session there, given only the turns it missed, while that session\'s history is still a prefix of the task\'s conversation '
    + '(same host and directory, same model, nothing compacted or changed since, keeping its prompt cache); otherwise it starts a new session too. A task has one active session at a time; '
    + 'its earlier sessions stay its history. text is the message the new session starts with. '
    + 'While the task\'s session is in a turn the switch waits for that turn to end (state pending). '
    + 'The new session runs on the same host as the old one: a switch never moves the work. An engine that host cannot run (its CLI is not installed there; the custom engine runs on the primary machine only) is refused with 409 engine_not_on_host; '
    + 'moving the work to another host is task_transfer. '
    + 'To change only the model, use the session\'s model switch instead. Only switch when the user asked for another engine; '
    + 'task_transfer (a NEW task) is only for when the user asks for a new task.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    engine: z.enum(ENGINES).describe('The engine to switch to'),
    text: z.string().min(1).describe('The message the new session starts with (what to do next)'),
    model: z.string().min(1).optional().describe('Model for the new session; omit for the engine default'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort for a new Claude Code session'),
    permission_mode: z.enum(['plan', 'default', 'dontAsk', 'accept', 'auto', 'bypass']).optional().describe('Permission mode the new session starts in; omit to keep the current one'),
    confirm_move: z.boolean().optional().describe('Ignored: a switch never moves the work (kept so older callers still switch)'),
    wait_ms: z.number().int().min(0).max(25_000).optional().describe('How long to wait for the new session before answering "switching" (default 25000)'),
  },
  bind: { method: 'POST', path: '/tasks/:id/switch-engine' },
  timeoutMs: 60_000,
  mapResult: ({ body }) => switchOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

function switchOutcome(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = String(b.taskId ?? '');
  if (b.state === 'pending') {
    return withOutcome(b, `The switch of task ${id} to ${String(b.engine)} waits for its running turn to end; then it runs by itself.`,
      `walnut tools call task_sessions '{"id":"${id}"}' to see it land.`);
  }
  if (b.state === 'switching') {
    return withOutcome(b, `Task ${id} is switching to ${String(b.engine ?? 'the new engine')}; the new session is still starting.`,
      `walnut tools call task_sessions '{"id":"${id}"}' in a moment.`);
  }
  if (b.resumed === true) {
    return withOutcome(b,
      `Task ${id} is back on ${String(b.engine)}: its earlier session ${String(b.sessionId ?? '')} resumed with the ${String(b.carriedTurns ?? 0)} turn(s) it missed.`,
      `Talk to it with task_send to task ${id}, as before.`);
  }
  return withOutcome(b,
    `Task ${id} now runs on ${String(b.engine)} in its new session ${String(b.sessionId ?? '')}`
      + (typeof b.carriedTurns === 'number' ? `, carrying ${b.carriedTurns} turn${b.carriedTurns === 1 ? '' : 's'}` : '')
      + (typeof b.trimmedTurns === 'number' && b.trimmedTurns > 0 ? ` (${b.trimmedTurns} older left out to fit)` : '') + '.',
    `Talk to it with task_send to task ${id}, as before.`);
}

defineOp({
  name: 'task_sessions',
  title: 'List the sessions a task held',
  description:
    'Every session a task held over its life, oldest first: engine, model, host, when it started, and which one is active now '
    + '(the others are earlier sessions an engine switch replaced). Read one with session_history.',
  input: { id: z.string().min(1).describe('Task id or unique prefix') },
  bind: { method: 'GET', path: '/tasks/:id/sessions' },
  tags: { readonly: true, remote: 'allow' },
});
