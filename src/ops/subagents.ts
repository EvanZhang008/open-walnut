import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const ENGINES = ['codex', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude'] as const;

defineOp({
  name: 'subagent_run',
  title: 'Run a subagent, on another engine or another host',
  description: [
    'Run one prompt as a SUBAGENT inside your own turn, the way your Agent tool runs a subagent, but on a coding engine you name '
      + '(claude, the default; codex: GPT models such as Sol or Astra; opencode, goose, pi, gemini, dsh, custom) and, with `host`, on '
      + 'ANOTHER HOST. It is not a Walnut task: no task, no board row, no conversation of its own. It sees only the prompt you give it '
      + '(write everything it needs into it: no part of your conversation goes with it), acts with your permissions (full access when '
      + 'your session runs with full access), and its `walnut` calls act as you. It shows in your Background tasks panel, where the '
      + 'user can watch it and stop it.',
    'NEED ANOTHER HOST FOR ONE STEP (UI tests on clouddev, an iOS build on a Mac, a browser on the user\'s machine): call subagent_run '
      + 'with `host` (an alias from host_list, or a selector like "@ios" or "@browser"), never task_move. Walnut copies your work there '
      + '(your folder\'s git repository: its commits, uncommitted changes and untracked files; your folder itself is left as it is), '
      + 'runs the subagent in that copy as a session started the way a task\'s session starts there (Claude Code with its own default '
      + 'model, the same tools, skills, MCP servers and permissions a task session has on that host), and returns its answer plus every '
      + 'file it put in its out folder or named by absolute path (videos, screenshots, logs), copied into your task directory under '
      + 'subagents/<id>/ (`files` lists them). The copy on that host is removed when it ends. Its changes stay there: ask it to describe '
      + 'or return them (a patch file) when you want them. A host other than yours needs this task\'s grant there, the one host_exec uses.',
    'Without `host` it runs in your working directory on your host. By default the call waits for its answer (up to wait_ms, at most '
      + '10 minutes, less through a host\'s gateway) and returns it as `answer` with state completed. A run still going returns state '
      + 'running with what it is doing: read it again with subagent_read (wait_ms waits), stop it with subagent_stop. background:true '
      + 'returns at once. A run whose end no call returned is told to you as a notification when it ends, as a Claude Code background '
      + 'agent is. Model and effort: omit for the engine\'s own default; a model the engine does not offer is refused with the list it '
      + 'offers. An engine the host cannot run is refused with the engines it can. At most 4 run at once per session; each has its time '
      + 'limit (timeout_min, default 30, at most 120).',
  ].join('\n\n'),
  input: {
    engine: z.enum(ENGINES).optional().describe('The engine: claude (default), codex (GPT, e.g. Sol/Astra), opencode, goose, pi, gemini, dsh, or custom'),
    host: z.string().min(1).max(120).optional().describe('Run on this other host, in a copy of your work there: an alias (host_list) or a selector like "@ios"; omit for your own host'),
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
  if (b.state === 'completed') {
    const files = Array.isArray(b.files) ? b.files.length : 0
    return withOutcome(b, `Subagent ${id} answered${b.from_host ? ` from ${String(b.host)}` : ''}${files ? `, and ${files} file${files === 1 ? '' : 's'} came back (files)` : ''}.`, 'Use its answer.')
  };
  if (b.state === 'running') {
    return withOutcome(b, `Subagent ${id} is still running (${b.tool_uses ?? 0} tool uses so far).`,
      `walnut tools call subagent_read '{"id":"${id}","wait_ms":600000}' waits for it; you are also told when it ends.`);
  }
  if (b.state === 'stopped') return withOutcome(b, `Subagent ${id} was stopped.`, 'Run it again with subagent_run if you still need it.');
  return withOutcome(b, `Subagent ${id} failed: ${String(b.error ?? 'unknown error')}`, 'Fix what the error names, or try another engine or model.');
}
