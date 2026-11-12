import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const ENGINES = ['codex', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude'] as const;

defineOp({
  name: 'subagent_run',
  title: 'Run a subagent on another engine',
  description: [
    'Run one prompt as a SUBAGENT on a coding engine you name (codex: GPT models such as Sol or Astra; opencode, goose, pi, gemini, '
      + 'dsh, custom; or claude), inside your own turn, the way your Agent tool runs a subagent, but on that engine: a second opinion, '
      + 'a review, or a piece of work in another model. It is not a Walnut task: no task, no board row, no session of its own. It runs '
      + 'in your working directory on your host, sees only the prompt you give it (write everything it needs into it: no part of your '
      + 'conversation goes with it), and can act with your permissions: full access when your session runs with full access, else '
      + 'read only. Its `walnut` calls act as you. It shows in your Background tasks panel, where the user can watch it and stop it.',
    'By default the call waits for its answer (up to wait_ms, at most 10 minutes, less through a host\'s gateway) and returns it as '
      + '`answer` with state completed. A run still going returns state running with what it is doing: read it again with subagent_read '
      + '(wait_ms waits), stop it with subagent_stop. background:true returns at once. A run whose end no call returned is told to you '
      + 'as a notification when it ends, as a Claude Code background agent is. Model and effort: omit for the engine\'s own default; a '
      + 'model the engine does not offer is refused with the list it offers. An engine your host cannot run is refused with the engines '
      + 'it can. At most 4 run at once per session; each has its time limit (timeout_min, default 30, at most 120).',
  ].join('\n\n'),
  input: {
    engine: z.enum(ENGINES).describe('The engine: codex (GPT, e.g. Sol/Astra), opencode, goose, pi, gemini, dsh, custom, or claude'),
    prompt: z.string().min(1).describe('The whole task for the subagent: it sees nothing else of your conversation'),
    model: z.string().min(1).optional().describe('The model id on that engine (e.g. "gpt-6.1-sol" for codex); omit for the engine\'s default'),
    effort: z.string().min(1).optional().describe('Reasoning effort (e.g. low, medium, high, xhigh) where the engine has one; omit for its default'),
    description: z.string().max(120).optional().describe('A few words for the Background tasks panel (default: the prompt\'s first line)'),
    background: z.boolean().optional().describe('Return at once; the answer comes as a notification when it ends (or read it with subagent_read)'),
    wait_ms: z.number().int().min(0).max(600_000).optional().describe('How long this call waits for the answer (default 600000; background: 0)'),
    timeout_min: z.number().int().min(1).max(120).optional().describe('The run\'s own limit in minutes (default 30): past it the run is stopped'),
    tool_use_id: z.string().max(200).optional().describe('Filled in by Walnut\'s MCP server: leave it out'),
  },
  bind: { method: 'POST', path: '/subagents' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body }) => runOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'subagent_read',
  title: 'Read a subagent\'s state or answer',
  description: 'A subagent of this session (subagent_run): its state (running, completed, failed, stopped), what it is doing, and its '
    + '`answer` once completed. wait_ms waits for it to end (at most 600000; less through a host\'s gateway, then call again). With no id: '
    + 'every subagent of this session, running and recent.',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).optional().describe('The id subagent_run returned (sa-...); omit to list them all'),
    wait_ms: z.number().int().min(0).max(600_000).optional().describe('Wait up to this long for it to end (default 0)'),
  },
  handler: async (args, call) => {
    if (!args.id) return call('GET', '/subagents');
    const q = typeof args.wait_ms === 'number' ? `?wait_ms=${args.wait_ms}` : '';
    return runOutcome(await call('GET', `/subagents/${encodeURIComponent(String(args.id))}${q}`));
  },
  routes: [{ method: 'GET', path: '/subagents' }, { method: 'GET', path: '/subagents/:id' }],
  timeoutMs: 11 * 60_000,
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'subagent_stop',
  title: 'Stop a subagent',
  description: 'Stop a running subagent of this session (subagent_run): its engine\'s turn is cancelled and its worker ends. '
    + 'One that already ended answers stopped:false with its state.',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).describe('The id subagent_run returned (sa-...)'),
  },
  bind: { method: 'POST', path: '/subagents/:id/stop' },
  timeoutMs: 30_000,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

function runOutcome(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? '');
  if (b.state === 'completed') return withOutcome(b, `Subagent ${id} answered.`, 'Use its answer.');
  if (b.state === 'running') {
    return withOutcome(b, `Subagent ${id} is still running (${b.tool_uses ?? 0} tool uses so far).`,
      `walnut tools call subagent_read '{"id":"${id}","wait_ms":600000}' waits for it; you are also told when it ends.`);
  }
  if (b.state === 'stopped') return withOutcome(b, `Subagent ${id} was stopped.`, 'Run it again with subagent_run if you still need it.');
  return withOutcome(b, `Subagent ${id} failed: ${String(b.error ?? 'unknown error')}`, 'Fix what the error names, or try another engine or model.');
}
