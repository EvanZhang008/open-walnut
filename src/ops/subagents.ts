import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { OWN_WAIT_TURN_END } from '../lib/turn-end-marker.js';
import { DOC_ANSWER_MAX_CHARS, DOC_PART_INPUT, askedPart, clipText, pageOnce, pagedResult } from './doc-page.js';
import type { OpAnswer } from './answer.js';

/** The read that goes on in a subagent's answer. */
const answerAgain = (id: unknown) => (more: Record<string, unknown>) => `subagent_read ${JSON.stringify({ id, ...more })}`;

/**
 * subagent_run and subagent_send answer what the subagent answered: content, its deliverable, in
 * pages up to the document cap (doc-page.ts); subagent_read {id, offset} reads on.
 */
const ANSWERED: OpAnswer = {
  kind: 'content', max: DOC_ANSWER_MAX_CHARS,
  shape: ({ result, max, surface }) => pageOnce(result, () => pagedResult(result, 'answer', {}, answerAgain((result as { id?: unknown }).id), { fit: { max, surface } })),
};

const ENGINES = ['codex', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude'] as const;

defineOp({
  name: 'subagent_run',
  title: 'Run a subagent on another host or another engine',
  description: [
    'USE YOUR OWN Agent TOOL FOR MOST SUBAGENTS. Use subagent_run only for a step that must run on ANOTHER HOST (`host`: an alias '
      + 'from host_list or a selector like "@ios" or "@browser"; never task_move for one step) or on ANOTHER ENGINE (`engine`: codex '
      + 'for GPT models, opencode, goose, pi, gemini, dsh, custom). Default: Claude Code with its own default model.',
    'Like your Agent tool: one prompt (it sees nothing else of your conversation, so write everything it needs into it), and its '
      + 'answer comes back to you. It is a hidden Walnut session started the way a task\'s session starts on that host, with the '
      + 'same tools, skills and permissions, and its `walnut` calls act as you; the user sees it in your Background tasks panel.',
    'YOU NEVER WAIT ON IT OR POLL IT. The call waits for its answer up to wait_ms (at most 10 minutes, less through a host\'s '
      + 'gateway); background:true returns at once. An answer the call did not return comes into this session by itself, waking it '
      + 'if idle: carry on with other work, or ' + OWN_WAIT_TURN_END + '. subagent_send {id, message} tells it more; it is closed '
      + 'after an hour with no message, by subagent_stop, or when this session ends.',
    'With `host`, Walnut copies your work there (the git repository of `cwd`, default your working directory: commits, uncommitted '
      + 'and untracked files), and every file it puts in its out folder or names by absolute path comes back under '
      + 'subagents/<id>/ in your task directory (`files`); the copy is removed when it closes, so ask it to return a change as a patch. '
      + 'Another host needs this task\'s grant there, as host_exec does. At most 4 answer at once per session; a turn stops at '
      + 'timeout_min (default 30, at most 120).',
  ].join('\n\n'),
  input: {
    engine: z.enum(ENGINES).optional().describe('The engine: claude (default), codex (GPT, e.g. Sol/Astra), opencode, goose, pi, gemini, dsh, or custom'),
    host: z.string().min(1).max(120).optional().describe('Run on this other host, in a copy of your work there: an alias (host_list) or a selector like "@ios"; omit for your own host'),
    cwd: z.string().min(1).max(4096).optional().describe('The folder it runs in, an absolute path on your host (with `host`: the folder whose work is copied there); omit for your session\'s working directory. Name it when your work is in another folder than the one your session started in (a clone in your task directory)'),
    prompt: z.string().min(1).describe('The whole task for the subagent: it sees nothing else of your conversation'),
    model: z.string().min(1).optional().describe('The model id on that engine (e.g. "gpt-6.2-sol" for codex); omit for the engine\'s default'),
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
  answer: ANSWERED,
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
  answer: ANSWERED,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'subagent_read',
  title: 'Look at a subagent',
  description: 'A subagent of this session (subagent_run): its state (running, completed, failed, stopped), whether it is still open '
    + 'for a message, what it is doing, and its last `answer`. Only to look: its answers come to you by themselves, so never call this to '
    + 'wait for one. With no id: every subagent of this session, open and recent, one short row each. A long answer comes in '
    + 'pages (`page` says how to read on).',
  input: {
    id: z.string().regex(/^sa-[a-f0-9]{4,32}$/).optional().describe('The id subagent_run returned (sa-...); omit to list them all'),
    ...DOC_PART_INPUT,
  },
  handler: async (args, call, caller) => {
    if (!args.id) return call('GET', '/subagents');
    const read = runOutcome(await call('GET', `/subagents/${encodeURIComponent(String(args.id))}`));
    // Asked for a part of its answer: every caller gets that part, an agent's built for its cap.
    return askedPart(args) ? pagedResult(read, 'answer', args, answerAgain(args.id), { fit: caller?.answer }) : read;
  },
  routes: [{ method: 'GET', path: '/subagents' }, { method: 'GET', path: '/subagents/:id' }],
  timeoutMs: 11 * 60_000,
  answer: {
    kind: 'content', max: DOC_ANSWER_MAX_CHARS,
    shape: ({ result, args, max, surface }) => args.id ? pageOnce(result, () => pagedResult(result, 'answer', {}, answerAgain(args.id), { fit: { max, surface } })) : subagentRows(result),
  },
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

/** The start of a listed subagent's answer: subagent_read {id} reads it whole. */
const ROW_ANSWER_CHARS = 300;

/** The list for an agent: one short row per subagent, each answer's start only. */
function subagentRows(result: unknown): unknown {
  const b = result as { subagents?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.subagents)) return result;
  const rows = (b.subagents as Array<Record<string, unknown>>).map((r) => {
    const answer = typeof r.answer === 'string' ? r.answer : undefined;
    return {
      id: r.id, state: r.state, open: r.open, engine: r.engine, host: r.host, description: r.description, elapsed_ms: r.elapsed_ms,
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      ...(Array.isArray(r.files) && r.files.length ? { files: r.files.length } : {}),
      ...(answer !== undefined ? { answer: clipText(answer, ROW_ANSWER_CHARS) } : {}),
    };
  });
  return {
    subagents: rows,
    outcome: `${rows.length} subagent${rows.length === 1 ? '' : 's'} of this session, ${rows.filter((r) => r.state === 'running').length} running.`,
    next: rows.length ? 'subagent_read {"id":"<id>"} reads one with its whole answer and files.' : 'Nothing to read.',
  };
}

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
      'Its answer comes into this session by itself when it ends. Do nothing to wait for it: carry on with other work, or ' + OWN_WAIT_TURN_END + '.');
  }
  if (b.state === 'stopped') return withOutcome(b, `Subagent ${id} was stopped.`, 'Run it again with subagent_run if you still need it.');
  return withOutcome(b, `Subagent ${id} failed: ${String(b.error ?? 'unknown error')}`, 'Fix what the error names, or try another engine or model.');
}
