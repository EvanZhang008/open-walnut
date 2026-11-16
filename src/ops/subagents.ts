import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const ENGINES = ['codex', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude'] as const;

defineOp({
  name: 'subagent_run',
  title: 'Run a subagent on another host or another engine',
  description: [
    'USE YOUR OWN Agent TOOL FOR MOST SUBAGENTS. Use subagent_run only when the step must run on ANOTHER HOST (UI tests on clouddev, '
      + 'an iOS build on a Mac, the user\'s own browser: `host`, an alias from host_list or a selector like "@ios" or "@browser"; never '
      + 'task_move for one step) or on ANOTHER ENGINE (`engine`: codex for GPT models such as Sol or Astra, opencode, goose, pi, gemini, '
      + 'dsh, custom). Default: Claude Code with its own default model.',
    'It works like your Agent tool: one prompt (it sees nothing else of your conversation, so write everything it needs into it), and '
      + 'its answer comes back to you. Underneath it is a hidden Walnut task session (no task, no board row): started the way a task\'s '
      + 'session starts on that host, with the same tools, skills, MCP servers and permissions (full access when yours has it), and its '
      + '`walnut` calls act as you. It shows in your Background tasks panel, where the user can read its conversation and write to it.',
    'YOU NEVER WAIT ON IT OR POLL IT. By default the call waits for its answer (up to wait_ms, at most 10 minutes, less through a '
      + 'host\'s gateway). background:true returns at once. A run still going when the call returns, or a background one, sends its '
      + 'answer into this session by itself when it ends, which wakes this session if it is idle, the way a background Agent\'s '
      + 'completion does: carry on with other work or end your turn.',
    'It keeps its context after it answers: subagent_send {id, message} tells it more, and its answer comes back the same way. It is '
      + 'closed after an hour with no message, when you stop it (subagent_stop), or when this session ends.',
    'With `host`, Walnut copies your work there (your folder\'s git repository: its commits, uncommitted changes and untracked files; '
      + '`cwd` picks the folder, by default your session\'s working directory; your own folder is left as it is). Every file it puts in '
      + 'its out folder or names by absolute path (videos, screenshots, logs) is copied into your task directory under subagents/<id>/ '
      + '(`files` lists them). The copy is removed when it is closed: ask it to describe or return a change (a patch file). A host other '
      + 'than yours needs this task\'s grant there, the one host_exec uses. Model and effort: omit for the engine\'s own default; a model '
      + 'the engine does not offer is refused with the list it offers. At most 4 answer at once per session; each turn has its time '
      + 'limit (timeout_min, default 30, at most 120).',
  ].join('\n\n'),
  input: {
    engine: z.enum(ENGINES).optional().describe('The engine: claude (default), codex (GPT, e.g. Sol/Astra), opencode, goose, pi, gemini, dsh, or custom'),
    host: z.string().min(1).max(120).optional().describe('Run on this other host, in a copy of your work there: an alias (host_list) or a selector like "@ios"; omit for your own host'),
    cwd: z.string().min(1).max(4096).optional().describe('The folder it runs in, an absolute path on your host (with `host`: the folder whose work is copied there); omit for your session\'s working directory. Name it when your work is in another folder than the one your session started in (a clone in your task directory)'),
    prompt: z.string().min(1).describe('The whole task for the subagent: it sees nothing else of your conversation'),
    model: z.string().min(1).optional().describe('The model id on that engine (e.g. "gpt-6.1-sol" for codex); omit for the engine\'s default'),
    effort: z.string().min(1).optional().describe('Reasoning effort (e.g. low, medium, high, xhigh) where the engine has one; omit for its default'),
    description: z.string().max(120).optional().describe('A few words for the Background tasks panel (default: the prompt\'s first line)'),
    background: z.boolean().optional().describe('Return at once; its answer comes into this session by itself when it ends (do not poll)'),
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
  name: 'subagent_send',
  title: 'Tell a subagent more',
  description: 'Send a subagent of this session (subagent_run) another message, as you would message your own agent: it keeps its '
    + 'context (its conversation, its copy of your work on its host) and answers like the first time. The call waits for that answer '
    + '(wait_ms, as subagent_run); background:true returns at once. Either way an answer the call did not return comes into this session '
    + 'by itself: never poll. A message sent while it is still answering waits for that answer first. A closed subagent (stopped, an hour '
    + 'with no message, its session ended) is refused with code closed: start a new one.',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).describe('The id subagent_run returned (sa-...)'),
    message: z.string().min(1).describe('What to tell it: it sees this and its own conversation so far'),
    background: z.boolean().optional().describe('Return at once; its answer comes into this session by itself'),
    wait_ms: z.number().int().min(0).max(600_000).optional().describe('How long this call waits for the answer (default 600000; background: 0)'),
  },
  bind: { method: 'POST', path: '/subagents/:id/message' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body }) => runOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'subagent_read',
  title: 'Look at a subagent',
  description: 'A subagent of this session (subagent_run): its state (running, completed, failed, stopped), whether it is still open '
    + 'for a message, what it is doing, and its last `answer`. Only to look: its answers come to you by themselves, so never call this to '
    + 'wait for one. With no id: every subagent of this session, open and recent.',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).optional().describe('The id subagent_run returned (sa-...); omit to list them all'),
  },
  handler: async (args, call) => {
    if (!args.id) return call('GET', '/subagents');
    return runOutcome(await call('GET', `/subagents/${encodeURIComponent(String(args.id))}`));
  },
  routes: [{ method: 'GET', path: '/subagents' }, { method: 'GET', path: '/subagents/:id' }],
  timeoutMs: 11 * 60_000,
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'subagent_stop',
  title: 'Stop and close a subagent',
  description: 'Stop a subagent of this session (subagent_run) and close it: a turn it is in is cancelled, and its session and its copy '
    + 'of your work are removed, so it takes no more messages. One already closed answers stopped:false with its state.',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).describe('The id subagent_run returned (sa-...)'),
  },
  bind: { method: 'POST', path: '/subagents/:id/stop' },
  timeoutMs: 30_000,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

/** What a subagent call answers (exported for the no-polling guard test). */
export function runOutcome(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? '');
  if (b.state === 'completed') {
    const files = Array.isArray(b.files) ? b.files.length : 0
    return withOutcome(b, `Subagent ${id} answered${b.from_host ? ` from ${String(b.host)}` : ''}${files ? `, and ${files} file${files === 1 ? '' : 's'} came back (files)` : ''}.`,
      b.open === false ? 'Use its answer.' : `Use its answer. It keeps its context: subagent_send {"id":"${id}","message":"..."} tells it more.`)
  };
  if (b.state === 'running') {
    // Never a read to wait with: the answer comes by itself (registry.ts tellParent), as a background Agent's does.
    return withOutcome(b, `Subagent ${id} is working (${b.tool_uses ?? 0} tool uses so far).`,
      'Its answer comes into this session by itself when it ends. Do nothing to wait for it: carry on with other work, or end your turn.');
  }
  if (b.state === 'stopped') return withOutcome(b, `Subagent ${id} was stopped.`, 'Run it again with subagent_run if you still need it.');
  return withOutcome(b, `Subagent ${id} failed: ${String(b.error ?? 'unknown error')}`, 'Fix what the error names, or try another engine or model.');
}
