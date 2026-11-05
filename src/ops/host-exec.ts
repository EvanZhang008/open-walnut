import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { runOutcome, stoppedEnd } from './host-exec-answers.js';

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
    'Run one command on ANOTHER host Walnut knows (host_list names them), as the user, and get its exit code and output: '
      + 'like your Bash tool, but on that machine (Xcode and the iOS simulator on the Mac, its signed-in tools, its files).',
    'Common uses. A build or a test: {host, command, cwd}, then read exitCode and output. A dev server: {host, command: "npm run '
      + 'dev", cwd, background: true, wait_for: {port: 5173}} answers once it listens and leaves it running (host_exec_stop ends '
      + 'it). A long job: background:true, then host_exec_read with wait_for (the line it prints when done) and wait_ms.',
    'The command. Give `command` (a shell line) or `argv` (a program and its arguments, no shell parsing). It runs in bash '
      + '(sh where there is none) after the user\'s login shell set up PATH, so zsh rules never apply. $WALNUT_TASK_DIR there is '
      + 'your task\'s directory on that host. strict:true runs the line under bash\'s set -e and pipefail: it stops at the first '
      + 'command that fails, a pipe included, except where bash tests the result (after if, while, && or ||, and anything a '
      + 'function runs when it is called that way, so `f || echo x` runs all of f). failedStep names the step, and the output '
      + 'ends with Walnut\'s line `walnut strict <job_id>: exit N [pipe codes] line L: command`, which a wait never matches. '
      + 'A `trap … ERR` of your own replaces the one strict names the step with.',
    'Shell state across calls. keep:true starts the run where this task\'s last keep call on that host ended: its working '
      + 'directory (unless you give cwd, which wins) and its exported variables, new, changed and unset ones (a venv\'s PATH '
      + 'and VIRTUAL_ENV too); at its end its own directory and exported variables carry to the next keep call there. Calls '
      + 'without keep never see or change that state. Not carried: shell functions (a venv\'s `deactivate`), aliases, '
      + 'unexported variables, shell options, traps, POSIXLY_CORRECT. It is saved when the line ends, `exit N` and a stop '
      + '(SIGTERM) included, but not when the line sets its own EXIT trap, runs `exec`, is killed hard (SIGKILL), or runs '
      + 'with background:true (that run starts from the kept state and saves nothing). keep never adds output, changes the '
      + 'exit code or signal, or shows a value, whatever the line turned on (tracing, aliases, functions over builtins). A '
      + 'save that cannot complete (a walnut_ variable or a function over a builtin it needs that the line made readonly, a '
      + 'task directory it cannot write) ends the output with one `walnut: keep could not save ...` line, and the answer has '
      + 'keep.saved false. The kept directory is the run\'s cwd, so the host\'s macOS permission check and a relative '
      + 'wait_for.file use it: a call that starts in or reads a place macOS guards needs allow_prompts on that call too. One '
      + 'that is gone: the run starts in the home directory and keep.gone names it. A daemon that cannot hand Walnut the '
      + 'state (keep.shellCd) has the shell enter the directory, after those checks. Limits: a trace sent to a descriptor '
      + 'of 10 or more (BASH_XTRACEFD) is not silenced in the save; a readonly POSIXLY_CORRECT can stop the save with no '
      + 'line; under set -v the output ends with the save\'s first line (no value in it); on macOS\'s bash 3.2 an exported '
      + 'value of a few hundred KB makes each keep call seconds slower; on Linux one exported value over 128 KiB makes '
      + 'every program a later keep call starts fail with "Argument list too long" until it is unset, as in a shell; the '
      + 'Command Line Tools check reads the login PATH, '
      + 'not one keep restored. It needs bash (under sh it does nothing) and a task directory there (else 409 '
      + 'task_dir_unset): each save is one 0600 snapshot in it and a pointer to it, and values never come back in the '
      + 'answer. With argv it is refused.',
    'The host. `host` is an alias or a selector ("@ios"), never your own host. The first call for this task on a host asks the '
      + 'user by letter (403 exec_grant_required): do other work; a notice comes when they allow it. A revoke, or the host '
      + 'closed in Settings, ends a waiting call at once with a 403; runs already going keep going to their deadline, and '
      + 'host_exec_list and host_exec_stop still reach them. host_exec_pinned runs under one named grant and never asks.',
    'Dialogs on a Mac. The command runs in the user\'s session, so a dialog shows on their screen and the run waits for '
      + 'someone: a keychain read (`security`), `osascript ... with administrator privileges`, or a read of a place macOS guards '
      + '(Desktop, Documents, Downloads, iCloud Drive, Mail, Messages, app containers, /Volumes, or du, find or grep -r over ~ or '
      + '~/Library). Walnut refuses those with 409 may_prompt: ask the user, then pass allow_prompts:true. A run found waiting at '
      + 'a dialog is stopped and comes back `blocked`.',
    'Sound. A command that makes sound there (say without -o, afplay or another player, a volume change or an unmute) is '
      + 'refused with 409 makes_sound, no override: render audio to a file or a virtual device instead.',
    'Input. A command that sends real input to the front window there (cliclick, xdotool, Peekaboo click or type, System Events '
      + 'keystrokes or clicks, an input event API in inline code) is refused with 409 foreground_input: drive a window the test '
      + 'owns from inside it (Playwright, XCUITest, xcrun simctl io); a command that truly must, names why on its own line: '
      + 'WALNUT_INPUT_REASON=\'<why, 10+ characters>\' <command>.',
    'Bounds. A run ends at its deadline, timeout_ms: 2 minutes by default and 10 at most (background:true: 2 hours), and its '
      + 'whole process group is stopped. The call waits for the run to end; through a host\'s gateway (a session on another '
      + 'host) it answers after about 12 s (heldMs). A run still going comes back running:true with its job_id: host_exec_read '
      + 'waits on it; never run it again. The walnut CLI prints the job_id when no answer came back, and host_exec_list lists '
      + 'this task\'s jobs. A task runs at most 4 commands at once and a host 8; over a cap a call waits up to 20 s for a slot, '
      + 'then answers 429 busy. The last 256 KB of output comes back (the full log stays there); lines that look like a '
      + 'credential are hidden.',
    'Background runs and `&`. background:true returns at once with the job_id (with wait_for, once it holds). What a run starts '
      + 'in the background (`cmd &`, `nohup cmd &` too) stays in its process group: about 2 s after its shell exits it gets '
      + 'SIGTERM (SIGKILL 3 s later), whatever it does with its output (a `> file` too). To keep a process running, start it '
      + 'as its own job, background:true and no `&`, and wait on it with wait_for (its port, or the line it prints when ready).',
    'What wait_for waits for. The call returns as soon as a line of the output matches `output`, `port` listens there (127.0.0.1, '
      + '::1 or one of the host\'s addresses), or `file` exists there; else when the run ends or the wait runs out. `file` is '
      + 'one path, relative to cwd, with ~, $HOME and $WALNUT_TASK_DIR expanded and no other variable, never a pattern: one with '
      + 'another $VAR, ~name, * or ? is refused before anything runs; [, ], { and } are part of the name. It counts once it '
      + 'exists, empty too, and a symlink once its target does; it is looked for about every 0.2 s, so a file there for less may '
      + 'be missed. A wait ends with its job, so a port or file made outside the job is waited for in a job that stays alive '
      + '(`sleep 600`, background:true). On a Mac a port look connects, so a one-client server (`nc -l` without -k) takes it as '
      + 'its client: wait for the line it prints instead.',
    'Lines and patterns. `output` is a JavaScript regular expression tested on each line on its own: a line ends at a newline '
      + 'or \\r, colour codes are removed first, and only a line\'s first 64 K characters are tested. The line still being '
      + 'written counts only with `partial: true` (a prompt) or once the run ended. `flags`: "i" ignores case (so does a leading '
      + '`(?i)`), "u" is Unicode mode (\\p{...} needs it). `/ready/i` is read as ready with the i flag, while `/ready/` with no '
      + 'flags is matched with its slashes. Textbook slow shapes (a repeat in a repeat, such as `(a+)+`) are refused before the '
      + 'command runs; a pattern that takes about 200 ms of CPU on its lines is stopped (`tooSlow`), and one the regex engine '
      + 'itself gives up on (too much backtracking, under bun) may read as no match. Many programs (python, build tools) hold '
      + 'their output when it is not a terminal: run them unbuffered (python3 -u, stdbuf -oL) or wait for their port.',
    'How long it waits. wait_ms, at most 10 minutes; by default a foreground run to its deadline, a background one 2 minutes '
      + '(timeout_ms stays the run\'s deadline). Through a host\'s gateway about 12 s. The answer\'s `next` is the host_exec_read '
      + 'that waits on.',
    'Reading on. `waitedFor` says what held: matched (output, port, file, or null), match (the line, the address, the path), '
      + 'matchAt (the log offset of that line), size and dir (a file\'s), ms, scanned (the log offset tested up to: the offset '
      + 'to wait on from), untested, long (lines over 64 K), tooSlow, unfinished (the matched line had no line end yet), '
      + 'wouldMatch (a line still being written that would match), unchecked (what it could not look at), unreachable (the '
      + 'file\'s path is closed to the user, so the wait ended). `already`: the port or file was there when the wait began '
      + '(`beforeRun`: before the job started, so another process may have it).',
  ].join('\n\n'),
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the machine the Walnut server runs on, usually the Mac) or a selector like "@ios"'),
    command: z.string().optional().describe('A shell line, run by bash on that host after the user\'s login shell set up the environment'),
    argv: z.array(z.string()).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).optional().describe('The run\'s deadline in ms: default 120000 and at most 600000; with background:true default and at most 7200000 (a larger one runs with the most, and the answer says so)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
    allow_prompts: z.boolean().optional().describe('The user agreed this command may show a dialog on that host\'s screen (a 409 may_prompt asked for it)'),
    strict: z.boolean().optional().describe('Run under set -e and pipefail: stop at the first command that fails outside an if, while, && or || test, and name it in failedStep: {exitCode, command, line, pipeStatus}'),
    keep: z.boolean().optional().describe('Start where this task\'s last keep call on that host ended (its directory, unless cwd is given, and its exported variables), and carry this run\'s to the next keep call there (not with background:true)'),
    job_id: z.string().regex(/^hx-[A-Za-z0-9_-]{4,64}$/).optional().describe('The id this run gets (hx-...; the walnut CLI picks one). The same id again from this task answers that run, never a second one'),
    wait_for: WAIT_FOR.optional().describe('Return as soon as one holds: {output: a JavaScript regular expression tested on each output line, flags, partial, port: a TCP port listening there, file: a path there}'),
    wait_ms: z.number().int().min(0).optional().describe('With wait_for: how long the call waits for it, at most 600000 (default: a foreground run to its deadline, a background one 120000); timeout_ms stays the run\'s deadline'),
  },
  bind: { method: 'POST', path: '/hosts/:host/exec' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body, args }) => runOutcome(body, args),
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
    + 'task\'s grant on that host; it names the one this task holds there, as `current`), exec_grant_revoked, exec_host_closed. Everything else is host_exec\'s: the run, wait_for and wait_ms, its deadline, '
    + 'its answer, job_id, and host_exec_read/host_exec_stop for its job. A server that has this op lists host-exec-pinned-v1 in '
    + 'GET /api/v1/status capabilities; an older one answers 404.',
  input: {
    grant_id: z.string().regex(/^xg-[A-Za-z0-9-]{4,64}$/).describe('The grant to run under (xg-...; host_exec_list on the host names this task\'s as grantId): this task\'s, on this host'),
    host: z.string().min(1).describe('The host the grant is for (an alias; "__local__" = the machine the Walnut server runs on, usually the Mac)'),
    command: z.string().optional().describe('A shell line, run by bash on that host after the user\'s login shell set up the environment'),
    argv: z.array(z.string()).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).optional().describe('The run\'s deadline in ms: default 120000 and at most 600000; with background:true default and at most 7200000 (a larger one runs with the most, and the answer says so)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
    allow_prompts: z.boolean().optional().describe('The user agreed this command may show a dialog on that host\'s screen (a 409 may_prompt asked for it)'),
    strict: z.boolean().optional().describe('Run under set -e and pipefail: stop at the first command that fails outside an if, while, && or || test, and name it in failedStep: {exitCode, command, line, pipeStatus}'),
    keep: z.boolean().optional().describe('Start where this task\'s last keep call on that host ended (its directory, unless cwd is given, and its exported variables), and carry this run\'s to the next keep call there (not with background:true)'),
    job_id: z.string().regex(/^hx-[A-Za-z0-9_-]{4,64}$/).optional().describe('The id this run gets (hx-...; the walnut CLI picks one). The same id again from this task answers that run, never a second one'),
    wait_for: WAIT_FOR.optional().describe('Return as soon as one holds: {output: a JavaScript regular expression tested on each output line, flags, partial, port: a TCP port listening there, file: a path there}'),
    wait_ms: z.number().int().min(0).optional().describe('With wait_for: how long the call waits for it, at most 600000 (default: a foreground run to its deadline, a background one 120000); timeout_ms stays the run\'s deadline'),
  },
  bind: { method: 'POST', path: '/host-exec/grants/:grant_id/exec' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body, args }) => runOutcome(body, args),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_read',
  title: 'Read a command\'s output on another host',
  description:
    'The output of a host_exec job: from `offset` (bytes into its log) or, with no offset, its last 256 KB; `nextOffset` continues. '
    + '`wait_ms` holds the answer until the job ends (up to 60000: a longer one waits 60000 and says so; with wait_for up to 600000; about 10000 through a host\'s gateway, as a session on another host calls, then call again: heldMs says so). '
    + '`running` false means it ended, with `exitCode`. `truncated` means the start of the output is not here; `more`, that output '
    + 'after nextOffset is. Only the task that started a job reads or stops it. `wait_for` (as host_exec\'s) waits up to wait_ms '
    + '(default 60000, at most 600000; about 10000 through a host\'s gateway) until a line of the output matches (tested from offset, else '
    + 'from the start of the log), the port listens, the file exists, or the job ends. To go on after a match or a miss, pass the '
    + 'answer\'s waitedFor.scanned as offset: from the same offset, the same line matches again. An offset inside a line reads and '
    + 'tests that whole line, and a match there counts only when it ends past the offset, so a prompt already seen is not seen '
    + 'again. A revoke of the task\'s grant there, or the host closed, ends a waiting read at once with a 403, and '
    + 'later reads of its jobs there are refused the same way (403 exec_grant_revoked) until the user grants it again; host_exec_list and host_exec_stop still work.',
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
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
