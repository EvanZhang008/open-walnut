import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const ENGINES = ['claude', 'codex', 'gemini', 'opencode', 'goose', 'pi', 'dsh', 'custom'] as const;

defineOp({
  name: 'task_transfer',
  title: 'Move a task\'s work to a NEW task (another host or engine)',
  description:
    'Move a task\'s work into a NEW task beside this one, on another host and/or coding engine, and start it. ' +
    'Only for when the user asks for a new task: to change the engine (or the model) of a task, switch it inside the task with task_switch_engine instead, '
    + 'and to move a task to another host keeping the task (same id, conversation, requests), task_move. ' +
    'the source task completes unless keep_source is true, and it STAYS OPEN, keep_source:false or not, when the task is still in use: ' +
    'the user wrote in it or its session in the last 7 days, its session was open in a terminal (the user working in it) in that time, ' +
    'or it leads work (open subtasks, an org role, an armed trigger); the answer names why in sourceKeptOpen. ' +
    'mode=carry (default) brings the conversation (Claude to Claude on the same host and directory, e.g. a model change: the CLI\'s own transcript, forked; ' +
    'every other pair, Claude to Claude elsewhere included: a transcript file plus a seed); ' +
    'a forked carry is done only once the new session started, and the source completes only then; ' +
    'mode=brief starts the new task from a handoff brief instead. ' +
    'On a host change the workspace (branch, uncommitted changes, untracked files) is packed and copied over, host to host when they can reach each other, ' +
    'and the new session sets it up and installs what is missing. cwd="auto" (the default on a host change) lets Walnut pick the directory. ' +
    'Engines other than Claude run on the primary machine only. Only transfer when the user asked for it.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix of the task to move'),
    engine: z.enum(ENGINES).optional().describe('Target coding engine; omit to keep the current one'),
    host: z.string().min(1).optional().describe('Target host alias ("__local__" = the primary machine); omit to keep the current one'),
    cwd: z.string().min(1).optional().describe('Absolute directory on the target host, or "auto" to let Walnut choose (the default on a host change)'),
    mode: z.enum(['carry', 'brief']).optional().describe('carry (default): bring the conversation; brief: start from a handoff brief'),
    model: z.string().min(1).optional().describe('Model for the new session; omit for the current model (same engine) or the engine default'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort for the new Claude Code session; omit to keep the current one (same engine)'),
    permission_mode: z.enum(['plan', 'default', 'dontAsk', 'accept', 'auto', 'bypass']).optional().describe('Permission mode the new session starts in; omit to keep the current one'),
    message: z.string().min(1).optional().describe('What the new task should do first once it has the work'),
    keep_source: z.boolean().optional().describe('Leave the source task open (a copy); default false: it completes, unless it is still in use (then it stays open)'),
    wait_ms: z.number().int().min(0).max(25_000).optional().describe('How long to wait for it to finish before answering "running" (default 20000)'),
  },
  bind: { method: 'POST', path: '/tasks/:id/transfer' },
  timeoutMs: 60_000,
  mapResult: ({ body }) => transferOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

function transferOutcome(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.state === 'unconfirmed') {
    return withOutcome(
      b,
      `Transfer ${String(b.transferId)} is unconfirmed: this server lost track of it while task ${String(b.taskId)} was still starting. `
        + 'Nothing was completed or removed; the source task is open.',
      `walnut tools call task_history '{"id":"${String(b.taskId)}"}' to see whether the new task's session runs.`,
    );
  }
  if (b.state === 'running') {
    return withOutcome(
      b,
      `Transfer ${String(b.transferId)} is still moving the work (packing and copying can take minutes).`,
      `walnut tools call transfer_get '{"id":"${String(b.transferId)}"}' (it waits up to 25 s per call).`,
    );
  }
  const target = (b.target ?? {}) as { engine?: string; host?: string; cwd?: string };
  return withOutcome(
    { ...b, ref: `<task-ref id="${String(b.taskId ?? '')}" label="${String(b.title ?? '').replace(/"/g, '&quot;')}"/>` },
    `Task ${String(b.taskId)} took over the work (${target.engine} on ${target.host} in ${target.cwd}); `
      + `the conversation came as ${String(b.history)}${b.sourceCompleted ? ', and the source task is complete' : ''}.`
      + (Array.isArray(b.sourceKeptOpen) && b.sourceKeptOpen.length > 0
        ? ` The source task ${String(b.sourceTaskId)} stays open because it is still in use: ${(b.sourceKeptOpen as string[]).join('; ')}. Do not complete it yourself.`
        : ''),
    'Its session is starting; read it with task_history. Talk to it with task_send to the NEW task id.',
  );
}

defineOp({
  name: 'transfer_get',
  title: 'Read a running task transfer',
  description:
    'Read back a transfer task_transfer started that was still running when it answered: the result once it is done, its error if it failed. '
    + 'Waits up to wait_ms (default 25000) for it to finish.',
  input: {
    id: z.string().min(1).describe('Transfer id (xf-...) from task_transfer'),
    wait_ms: z.number().int().min(0).max(25_000).default(25_000).describe('How long to wait for it to finish (default 25000)'),
  },
  bind: { method: 'GET', path: '/transfers/:id' },
  timeoutMs: 40_000,
  mapResult: ({ body }) => transferOutcome(body),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_profile_get',
  title: 'What Walnut knows about a host',
  description:
    'Read the profile Walnut keeps for an execution host: the kind of machine (laptop, public or private cloud VM, managed dev box), ' +
    'the system and installed tools from its last probe, known repository paths, which hosts it can copy from directly, ' +
    'and what Walnut has learned the host is used for (regenerated in the background from the sessions that ran there). ' +
    '`summary` is the same in a few lines.',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the primary machine)'),
  },
  bind: { method: 'GET', path: '/hosts/:host/profile' },
  tags: { readonly: true, remote: 'allow' },
});

/** One line per host, so an agent reads the fleet without walking the day buckets. */
function fleetOutcome(body: unknown, one: boolean) {
  const b = (body ?? {}) as { hosts?: Array<Record<string, unknown>>; host?: Record<string, unknown> }
  const hosts = one ? (b.host ? [b.host] : []) : (b.hosts ?? [])
  const lines = hosts.map((h) => String((h as { line?: unknown }).line ?? h.host))
  return withOutcome(b as Record<string, unknown>, lines.length ? lines.join('\n') : 'Walnut knows no hosts yet.',
    one ? 'history.buckets are oldest first; history.outages newest first.' : 'Pick a host for long-running work only where placement.longRunning.ok; host_get gives one host\'s history.');
}

defineOp({
  name: 'host_list',
  title: 'Every host Walnut runs work on, and how each is doing',
  description:
    'The fleet view, the same cards Settings › Remote Hosts shows: for each host (this Mac first) what it is (OS, CPUs, memory), '
    + 'how it is doing now (CPU use, load, memory available, uptime; `now.stale` when it stopped answering), how it did lately '
    + '(its own minute ledger: share of minutes up and linked over 1, 7 and 30 days, outages, boots, daemon restarts), running sessions, '
    + 'model spend there over 30 days at public list prices (not a bill), how it connects (local, SSH tunnel, bridge; round trip), '
    + 'the Walnut server it runs for the Mac, its daemon (version, whether it starts by itself after a reboot), '
    + 'and placement: the room score session placement judges it by (busy, which caps, its weight) and whether a job that must keep running fits there, with the reasons. '
    + '`capabilities` says what a task can use it for: `tags` (always-on, cloud or local, macos or linux, ios with its Xcode and simulator runtimes, '
    + 'browser = the user\'s own signed-in browser through the Walnut extension, docker, mcp:<server> for each Claude Code MCP server there, and the user\'s own tags), '
    + 'with `unknown` naming what its daemon has not reported yet. Ask for a host by tag in task_create or task_start: host "@ios", "@browser", "@ios+always-on". '
    + 'Read-only; never dials a host.',
  input: {
    days: z.number().int().min(1).max(31).optional().describe('History window in days (default 30, one bucket a day)'),
  },
  bind: { method: 'GET', path: '/hosts' },
  timeoutMs: 20_000,
  mapResult: ({ body }) => fleetOutcome(body, false),
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'host_get',
  title: 'One host\'s card and history',
  description:
    'One host of the fleet view (see host_list) with its history at the resolution you ask: `days` back (1 to 31) in buckets of '
    + '`bucket` minutes (default one a day; one an hour when days is 1). Each bucket: minutes covered, up, linked, average CPU use and '
    + 'available memory, most sessions running. 404 for a host Walnut does not know.',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the primary machine)'),
    days: z.number().int().min(1).max(31).optional().describe('History window in days (default 30)'),
    bucket: z.number().int().min(5).max(44_640).optional().describe('Bucket size in minutes (default 1440, or 60 for one day)'),
  },
  bind: { method: 'GET', path: '/hosts/:host' },
  timeoutMs: 20_000,
  mapResult: ({ body }) => fleetOutcome(body, true),
  tags: { readonly: true, remote: 'allow' },
});
