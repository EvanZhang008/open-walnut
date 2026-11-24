import { z } from 'zod';
import { defineOp } from './registry.js';
import { clipText } from './doc-page.js';
import { withOutcome } from './outcome.js';
import { runOutcome, stoppedEnd } from './host-exec-answers.js';
import { RUN_ANSWER_MAX_CHARS, shownRun } from './host-exec-shown.js';
import { LIST_MAX } from '../lib/zod-rules.js';
import type { OpAnswer } from './answer.js';

/**
 * A run's answer is what it ran (its exit code and output), not an object it changed: content, with
 * the first lines and the tail of the output and the read for the rest (host-exec-shown.ts).
 */
const RUN_ANSWER: OpAnswer = { kind: 'content', max: RUN_ANSWER_MAX_CHARS, shape: shownRun };

const WAIT_FOR = z.object({
  output: z.string().min(1).max(200).optional().describe('A JavaScript regular expression (`/ready/i` is read as ready with the i flag; `/ready/` with no flags keeps its slashes), tested on each whole line of output on its own (a line ends at a newline or \\r; colour codes are removed first; a line is tested on its first 64 K characters)'),
  flags: z.string().max(4).optional().describe('"i" for case-insensitive (a leading (?i) in output does the same), "u" for Unicode mode; m and s are refused, as each line is matched on its own'),
  partial: z.boolean().optional().describe('Also match the line still being written, such as a `Password: ` prompt with no newline yet (once it has not grown for 0.2 s); by default only whole lines count, and the last line once the run ended'),
  port: z.number().int().min(1).max(65535).optional().describe('A TCP port that anything on that host listens on: 127.0.0.1, ::1 or one of its own addresses'),
  file: z.string().min(1).optional().describe('A path that exists on that host (relative to the job\'s cwd; ~, $HOME and $WALNUT_TASK_DIR expand, no other variable); it counts once it exists, empty too, and a symlink once its target does; looked for about every 0.2 s; one path, never a pattern: * and ? are refused, while [, ], { and } are part of the name'),
}).strict()

defineOp({
  name: 'host_exec',
  title: 'Run a command on another host',
  description: [
    'Run one command on ANOTHER host Walnut knows (host_list names them; never your own host), as the user, and get its exit code '
      + 'and output: like your Bash tool, but on that machine (Xcode and the iOS simulator on the Mac, its signed-in tools, its files). '
      + 'A build or a test: {host, command, cwd}. A dev server: {host, command: "npm run dev", cwd, background: true, wait_for: {port: '
      + '5173}} answers once it listens and leaves it running (host_exec_stop ends it). A long job: background:true, then host_exec_read '
      + 'with wait_for (the line it prints when done) and wait_ms.',
    'The command. `command` is a shell line run by bash (sh where there is none) after the user\'s login shell set up PATH, so zsh '
      + 'rules never apply; `argv` is a program and its arguments, no shell parsing. $WALNUT_TASK_DIR there is your task\'s directory '
      + 'on that host. strict:true runs it under set -e and pipefail: failedStep names the step that failed, and the output ends with '
      + 'Walnut\'s line `walnut strict <job_id>: exit N [pipe codes] line L: command`. keep:true starts where this task\'s last keep call '
      + 'on that host ended (its directory, unless cwd is given, and its exported variables) and carries this run\'s end to the next; '
      + 'only keep.saved true says it carried (not with argv or background:true; the answer says why when it did not).',
    'The host. The first call for this task on a host asks the user by letter (403 exec_grant_required): do other work; a notice '
      + 'comes when they allow it. host_exec_pinned runs under one named grant and never asks. Refused before anything runs: 409 '
      + 'may_prompt, a command that would show a dialog on a Mac (a keychain read, administrator privileges, a place macOS guards such '
      + 'as Desktop, Documents or Downloads, or du, find or grep -r over ~): ask the user, then pass allow_prompts:true; 409 makes_sound '
      + '(no override: render audio to a file); 409 foreground_input, real input to the front window (drive a window the test owns, or '
      + 'name why on its own line: WALNUT_INPUT_REASON=\'<why, 10+ characters>\' <command>).',
    'Bounds. timeout_ms is the run\'s deadline: 2 minutes by default and 10 at most (background:true: 2 hours); then its whole process '
      + 'group is stopped. Through a host\'s gateway (a session on another host) the call answers after about 12 s. A run still going '
      + 'comes back running:true with its job_id: host_exec_read waits on it; never run it again (host_exec_list finds a job whose answer '
      + 'was lost). A task runs at most 4 commands at once and a host 8 (429 busy after a 20 s wait for a slot). The answer shows the '
      + 'first lines and the last 6,000 characters of output; `outputShown` names the log file there and the host_exec_read that shows '
      + 'the rest. Lines that look like a credential are hidden.',
    'Background runs and `&`. What a line starts with `&` (`cmd &`, `nohup cmd &` too) stays in its process group: about 2 s after its '
      + 'shell exits it gets SIGTERM, whatever it does with its output. To keep a process running, start it as its own job, '
      + 'background:true and no `&`, and wait on it with wait_for.',
    'wait_for. The call returns as soon as a line of output matches `output` (a JavaScript regular expression tested on each line on '
      + 'its own; flags "i" or "u"; partial:true also tests a line still being written, such as a prompt), `port` listens there, or '
      + '`file` exists there (one path, relative to cwd, never a pattern); else when the run ends or the wait runs out. A wait ends '
      + 'with its job. Programs that hold their output off a terminal: run them unbuffered (python3 -u, stdbuf -oL) or wait for their '
      + 'port. wait_ms is how long the call waits, at most 10 minutes. `waitedFor` says what held, and the answer\'s `next` is the '
      + 'exact read that waits on. Full rules: docs/reference/host-exec.md in the Walnut repository.',
  ].join('\n\n'),
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the machine the Walnut server runs on, usually the Mac) or a selector like "@ios"'),
    command: z.string().optional().describe('A shell line, run by bash on that host after the user\'s login shell set up the environment'),
    argv: z.array(z.string()).max(LIST_MAX).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).optional().describe('The run\'s deadline in ms: default 120000 and at most 600000; with background:true default and at most 7200000 (a larger one runs with the most, and the answer says so)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
    allow_prompts: z.boolean().optional().describe('The user agreed this command may show a dialog on that host\'s screen (a 409 may_prompt asked for it)'),
    strict: z.boolean().optional().describe('Run under set -e and pipefail: stop at the first command that fails outside an if, while, && or || test, and name it in failedStep: {exitCode, command, line, pipeStatus}'),
    resumable: z.boolean().optional().describe('The run only waits or reads (a poll for a result elsewhere), and you run it again if it ends: a daemon update on that host does not wait for it and ends it, saying so in its log; the answer says resumable:true when the host took it'),
    keep: z.boolean().optional().describe('Start where this task\'s last keep call on that host ended (its directory, unless cwd is given, and its exported variables), and carry this run\'s to the next keep call there (not with background:true)'),
    job_id: z.string().regex(/^hx-[A-Za-z0-9_-]{4,64}$/).optional().describe('The id this run gets (hx-...; the walnut CLI picks one). The same id again from this task answers that run, never a second one'),
    wait_for: WAIT_FOR.optional().describe('Return as soon as one holds: {output: a JavaScript regular expression tested on each output line, flags, partial, port: a TCP port listening there, file: a path there}'),
    wait_ms: z.number().int().min(0).optional().describe('With wait_for: how long the call waits for it, at most 600000 (default: a foreground run to its deadline, a background one 120000); timeout_ms stays the run\'s deadline'),
  },
  bind: { method: 'POST', path: '/hosts/:host/exec' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body, args }) => runOutcome(body, args),
  answer: RUN_ANSWER,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_pinned',
  title: 'Run a command on another host under one named grant',
  description:
    'host_exec under ONE grant the user already gave, named by its id: nothing else counts. Walnut makes no grant (not even for a '
    + 'task on the user\'s own host) and sends no letter, so a refusal asks no one. The grant must be this task\'s, for `host`, and '
    + 'live, and the host open (not closed in Settings > Remote Hosts), when the call starts and again right before the run is sent '
    + '(after any wait for a slot or for the host): otherwise it answers 403 with nothing run there: exec_grant_mismatch (not this '
    + 'task\'s grant on that host; it names the one this task holds there, as `current`), exec_grant_revoked, exec_grant_missing (a grant Walnut no longer finds and nobody revoked), exec_host_closed. Everything else is host_exec\'s: the run, wait_for and wait_ms, its deadline, '
    + 'its answer, job_id, and host_exec_read/host_exec_stop for its job. A server that has this op lists host-exec-pinned-v1 in '
    + 'GET /api/v1/status capabilities; an older one answers 404.',
  input: {
    grant_id: z.string().regex(/^xg-[A-Za-z0-9-]{4,64}$/).describe('The grant to run under (xg-...; host_exec_list on the host names this task\'s as grantId): this task\'s, on this host'),
    host: z.string().min(1).describe('The host the grant is for (an alias; "__local__" = the machine the Walnut server runs on, usually the Mac)'),
    command: z.string().optional().describe('A shell line, run by bash on that host after the user\'s login shell set up the environment'),
    argv: z.array(z.string()).max(LIST_MAX).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).optional().describe('The run\'s deadline in ms: default 120000 and at most 600000; with background:true default and at most 7200000 (a larger one runs with the most, and the answer says so)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
    allow_prompts: z.boolean().optional().describe('The user agreed this command may show a dialog on that host\'s screen (a 409 may_prompt asked for it)'),
    strict: z.boolean().optional().describe('Run under set -e and pipefail: stop at the first command that fails outside an if, while, && or || test, and name it in failedStep: {exitCode, command, line, pipeStatus}'),
    resumable: z.boolean().optional().describe('The run only waits or reads (a poll for a result elsewhere), and you run it again if it ends: a daemon update on that host does not wait for it and ends it, saying so in its log; the answer says resumable:true when the host took it'),
    keep: z.boolean().optional().describe('Start where this task\'s last keep call on that host ended (its directory, unless cwd is given, and its exported variables), and carry this run\'s to the next keep call there (not with background:true)'),
    job_id: z.string().regex(/^hx-[A-Za-z0-9_-]{4,64}$/).optional().describe('The id this run gets (hx-...; the walnut CLI picks one). The same id again from this task answers that run, never a second one'),
    wait_for: WAIT_FOR.optional().describe('Return as soon as one holds: {output: a JavaScript regular expression tested on each output line, flags, partial, port: a TCP port listening there, file: a path there}'),
    wait_ms: z.number().int().min(0).optional().describe('With wait_for: how long the call waits for it, at most 600000 (default: a foreground run to its deadline, a background one 120000); timeout_ms stays the run\'s deadline'),
  },
  bind: { method: 'POST', path: '/host-exec/grants/:grant_id/exec' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body, args }) => runOutcome(body, args),
  answer: RUN_ANSWER,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_read',
  title: 'Read a command\'s output on another host',
  description:
    'The output of a host_exec job, from `offset` (bytes into its log; `nextOffset` goes on) or, with no offset, its tail: the answer '
    + 'shows the first lines and the last 6,000 characters, and `outputShown` names the read for the rest. `running` false means it '
    + 'ended, with `exitCode`. Do not poll: `wait_ms` holds the answer until the job ends (60000 at most), and `wait_for` (as '
    + 'host_exec\'s) until a line of the output matches (from offset, else from the start), the port listens, the '
    + 'file exists or the job ends (wait_ms up to 600000); through a host\'s gateway (a session on another host) about 10000, then call '
    + 'again (heldMs says so). A read that finds nothing new says so in a sentence. To go on after a match or a miss, pass the '
    + 'answer\'s waitedFor.scanned as offset; an offset inside a line tests that whole line, and only a match ending past the offset '
    + 'counts. Only the task that started a job reads or stops it. Refused: 403 exec_grant_revoked after a revoke of the task\'s grant '
    + 'there or a closed host, until granted again (host_exec_list and host_exec_stop still work); 403 exec_grant_missing '
    + 'for a grant gone that nobody revoked (call again); 503 exec_grants_unreadable (try again in a minute).',
  input: {
    host: z.string().min(1).describe('The host the job runs on'),
    job_id: z.string().min(1).describe('The jobId host_exec returned'),
    offset: z.number().int().min(0).optional().describe('Byte offset into the log (default: the tail)'),
    wait_ms: z.number().int().min(0).optional().describe('Wait up to this long for the job to end: 60000 at most without wait_for (a longer one waits 60000), 600000 with it'),
    wait_for: WAIT_FOR.optional().describe('Return as soon as one holds: {output: a JavaScript regular expression tested on each output line, flags, partial, port: a TCP port listening there, file: a path there}'),
  },
  bind: { method: 'GET', path: '/hosts/:host/exec/:job_id' },
  // With wait_for a read may wait 10 minutes (wait_ms 600000): the call must outlast it.
  timeoutMs: 11 * 60_000,
  mapResult: ({ body, args }) => runOutcome(body, args),
  answer: RUN_ANSWER,
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_stop',
  title: 'Stop a command on another host',
  description: 'Stop a running host_exec job: its whole process group gets SIGTERM, then SIGKILL after 3 seconds. '
    + 'It works after the user revoked the task\'s grant there too, so a run left going can still be stopped.',
  input: {
    host: z.string().min(1).describe('The host the job runs on'),
    job_id: z.string().min(1).describe('The jobId host_exec returned'),
  },
  bind: { method: 'POST', path: '/hosts/:host/exec/:job_id/stop' },
  // The route dials the host and answers within the relayed caller's hold (about 12 s).
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const note = typeof b.note === 'string' ? ` ${b.note}` : ''
    // Under a revoked grant a read is refused: the list shows how it ends.
    const revoked = b.grantRevoked === true
    if (b.running === true) {
      return withOutcome(b, `Stopping: its process group got SIGTERM, and SIGKILL follows after 3 seconds.${note}`,
        revoked ? 'host_exec_list shows when it ended (its output is not shown: the user revoked this task\'s grant there).' : 'host_exec_read shows when it ended.')
    }
    return withOutcome(b, `Nothing to stop: ${stoppedEnd(b)}.${note}`, revoked ? 'Nothing more to do there: the user revoked this task\'s grant, so its output is not shown.' : 'host_exec_read reads its output.')
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_list',
  title: 'List this task\'s commands on another host',
  description:
    'This task\'s host_exec jobs on one host, newest first: the running ones and the latest that ended (a host keeps a finished '
    + 'job for an hour; its log stays in your task\'s directory there). Each row has its jobId, the start of its command, startedAt, '
    + 'its state (running, exited, timed_out, stopped, blocked at a dialog, gone: the host no longer holds it, unknown: the host did '
    + 'not answer) and exitCode. Use it to find a job whose answer never came back, then host_exec_read it; never run it again. '
    + 'It lists the runs after the user revoked the task\'s grant there too (they go on to their deadline), so host_exec_stop can end them.',
  input: {
    host: z.string().min(1).describe('The host the jobs run on'),
  },
  bind: { method: 'GET', path: '/hosts/:host/exec' },
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { host?: unknown; jobs?: Array<{ state?: string }>; hostAway?: unknown; endedOf?: unknown; grantRevoked?: unknown; grantId?: unknown }
    const jobs = Array.isArray(b.jobs) ? b.jobs : []
    const running = jobs.filter((j) => j.state === 'running').length
    const ended = jobs.length - running
    // Only the newest that ended are listed: say how many there were.
    const cut = typeof b.endedOf === 'number' && b.endedOf > ended
    const of = cut ? `; it lists the newest ${ended} of the ${String(b.endedOf)} that ended` : ''
    // The task's jobs there, not the ones listed (2026-11-05 review claude13: "21 jobs" of 22).
    const all = cut ? running + (b.endedOf as number) : jobs.length
    const head = jobs.length
      ? `${all} job${all === 1 ? '' : 's'} of this task on ${String(b.host)}, ${running} running${of}.`
      : `No jobs of this task on ${String(b.host)}.`
    const grant = typeof b.grantId === 'string' ? ` This task's grant there is ${b.grantId} (host_exec_pinned names it).` : ''
    const next = b.grantRevoked === true
      ? (running ? 'host_exec_stop stops a running job; its output is not shown, as the user revoked this task\'s grant there.' : 'Nothing runs there; the user revoked this task\'s grant, so output is not shown.')
      : jobs.length ? 'host_exec_read a jobId for its output.' : 'Nothing to read.'
    return withOutcome(b, `${typeof b.hostAway === 'string' ? `${head} The host did not answer (${b.hostAway}); these are the runs Walnut started there.` : head}${grant}`, next)
  },
  // One short row per job (2026-11-21: up to 21,000 characters): host_exec_read a jobId for its output and log file.
  answer: { kind: 'content', shape: ({ result }) => jobRows(result) },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

/** The start of a listed job's command an agent reads: enough to tell the jobs apart. */
const ROW_COMMAND_CHARS = 120;

function jobRows(result: unknown): unknown {
  const b = result as { jobs?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.jobs)) return result;
  return {
    ...(b as Record<string, unknown>),
    jobs: (b.jobs as Array<Record<string, unknown>>).map((j) => {
      const command = typeof j.command === 'string' ? clipText(j.command, ROW_COMMAND_CHARS) : j.command;
      const row: Record<string, unknown> = { jobId: j.jobId, command, startedAt: j.startedAt, state: j.state };
      for (const k of ['exitCode', 'signal', 'ms']) if (j[k] !== null && j[k] !== undefined) row[k] = j[k];
      if (j.blocked) row.blocked = true;
      return row;
    }),
  };
}
