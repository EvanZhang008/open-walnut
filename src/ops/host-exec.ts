import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

/** What a run the host stopped at a dialog says (host-exec-watch.ts): which dialog, and what to do. */
function blockedLine(b: Record<string, unknown>): string | null {
  const blocked = b.blocked && typeof b.blocked === 'object' ? b.blocked as { reason?: unknown; service?: unknown } : null
  if (!blocked) return null
  const dialog = blocked.reason === 'password_prompt'
    ? 'a password dialog (SecurityAgent: a keychain or an admin password)'
    : `a macOS permission dialog (${String(blocked.service ?? 'TCC')}: a place macOS guards)`
  return `It sat idle at ${dialog} on ${String(b.host)}'s screen, so Walnut stopped it. Do not run it again as it is: leave that `
    + 'path or step out, or ask the user and, if they agree, pass allow_prompts:true.'
}

/** A strict run's failing step (host-exec-strict.ts), in one sentence. */
function failedLine(b: Record<string, unknown>): string {
  const f = b.failedStep && typeof b.failedStep === 'object' ? b.failedStep as { exitCode?: unknown; line?: unknown; text?: unknown; command?: unknown; pipeStatus?: unknown } : null
  if (!f) return ''
  const where = typeof f.line === 'number' ? ` on line ${f.line}` : ''
  const codes = Array.isArray(f.pipeStatus) ? f.pipeStatus.filter((c): c is number => typeof c === 'number') : []
  const bad = codes.reduce((at, c, i) => (c !== 0 ? i : at), -1)
  if (codes.length > 1 && bad >= 0 && bad < codes.length - 1) {
    // pipefail took a middle member's code; $BASH_COMMAND names the last member, which did not fail.
    const text = typeof f.text === 'string' && f.text ? ` (\`${f.text}\`)` : ''
    return `It stopped${where}${text}: command ${bad + 1} of its pipe of ${codes.length} exited ${codes[bad]} (the pipe's commands exited ${codes.join(', ')} in order).`
  }
  const pipe = Array.isArray(f.pipeStatus) ? ` Its pipe's commands exited ${f.pipeStatus.join(', ')} in order.` : ''
  return `It stopped at \`${String(f.command)}\`${where}, which exited ${String(f.exitCode)}.${pipe}`
}

/** The run in two lines: how it ended, then the output, so an agent reads it like its own Bash tool. */
function runOutcome(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const where = `${String(b.host)}${b.cwd ? ` in ${String(b.cwd)}` : ''}${typeof b.shell === 'string' ? ` (${b.shell})` : ''}`
  const head = b.running
    ? `Running on ${where} as job ${String(b.jobId)}.`
    : b.blocked ? `Stopped on ${where} after ${String(b.ms)} ms: it was waiting on a dialog.`
      : b.timedOut ? `Stopped on ${where} at its deadline after ${String(b.ms)} ms (exit ${String(b.exitCode ?? b.signal)}).`
        : `Exit ${String(b.exitCode ?? b.signal)} on ${where} after ${String(b.ms)} ms.`
  const notes = [
    b.sameJob ? `This is job ${String(b.jobId)}, which this task already started with that job_id; it did not run again.` : '',
    typeof b.note === 'string' ? b.note : '',
    blockedLine(b) ?? '',
    b.truncated ? `Only the last part of the output is here; the whole log is ${String(b.logFile)} on that host (host_exec_read with offset 0).` : '',
    b.more ? `More output follows: host_exec_read with offset ${String(b.nextOffset)}.` : '',
    failedLine(b),
    b.redactedLines ? `${String(b.redactedLines)} line(s) that looked like a credential were hidden.` : '',
  ].filter(Boolean).join(' ')
  return withOutcome(b, notes ? `${head} ${notes}` : head,
    b.running ? 'host_exec_read with this job_id and wait_ms waits for it to end and returns the output.' : 'Read output and exitCode.')
}

defineOp({
  name: 'host_exec',
  title: 'Run a command on another host',
  description:
    'Run one command on ANOTHER host Walnut knows (host_list names them), as the user, and get its exit code and output: '
    + 'like your Bash tool, but on that machine. For a step only that host can do: Xcode and the iOS simulator on the Mac, '
    + 'its signed-in tools, its files. Give `command` (a shell line) or `argv` (a program and its arguments, no shell parsing). '
    + 'The line runs in bash (sh on a host with none) after the user\'s login shell set up PATH and the environment, so zsh rules never '
    + 'apply; `shell` in the answer names it (null: an older Walnut there ran it in the login shell itself, zsh on a Mac). '
    + '$WALNUT_TASK_DIR there is your task\'s directory on that host, where its logs stay too (`taskDir` in the answer). '
    + '`host` is an alias or a capability selector ("@ios"); never your own host (use your Bash tool). A host found in ~/.ssh/config '
    + 'that also joined over the host network is one machine: Walnut uses its joined row and `note` says so. '
    + 'The first call for this task on a host asks the user by letter (403 exec_grant_required): do other work, you get a notice '
    + 'when they allow it; the grant lasts until they revoke it. A Mac runs it in the user\'s session, so a dialog shows on their '
    + 'screen and the run waits there for someone: a keychain read (`security`), `osascript ... with administrator privileges`, and '
    + 'any read of a place macOS guards (Desktop, Documents, Downloads, Pictures, Movies, Music, Mail, Messages, iCloud Drive, app '
    + 'containers, /Volumes, or a walk such as du, find or grep -r over ~, ~/Library or ~/Library/Caches). Walnut refuses those '
    + 'with 409 may_prompt; ask the user first, then pass allow_prompts:true. A run found idle at such a dialog is stopped and '
    + 'comes back with `blocked`. A tool that reads the keychain itself (codesign, git, gh) can hit one too when the keychain is locked. '
    + 'A run ends by its deadline (timeout_ms, default 2 minutes, at most 10; '
    + 'with background:true at most 2 hours), its whole process group stopped. The call waits for the run to end, but from a session on '
    + 'another host at most about 12 seconds: a run still going comes back running:true with its job_id, and host_exec_read with '
    + 'wait_ms waits for it (never run it again: it is still running). The walnut CLI picks the job_id before it calls; when no '
    + 'answer came back it prints that id, and host_exec_list lists this task\'s jobs on the host. With strict:true the line stops at the first command that fails, a pipe included, and failedStep names it. Up to 4 runs at once per task and 8 per host; a call at a cap waits for a slot (up to 20 s, less from another host), then answers 429 busy. '
    + 'Only the last 256 KB of output comes back; the full log stays in your task\'s directory on that host. Lines that look like a credential are hidden.',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the Mac) or a selector like "@ios"'),
    command: z.string().optional().describe('A shell line, run by bash on that host after the user\'s login shell set up the environment'),
    argv: z.array(z.string()).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).max(7_200_000).optional().describe('Deadline in ms (default 120000; at most 600000, or 7200000 with background)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
    allow_prompts: z.boolean().optional().describe('The user agreed this command may show a dialog on that host\'s screen (a 409 may_prompt asked for it)'),
    strict: z.boolean().optional().describe('Stop at the first command that fails (set -e, pipefail) and name it in failedStep: {exitCode, command, line, pipeStatus}'),
    job_id: z.string().regex(/^hx-[A-Za-z0-9_-]{4,64}$/).optional().describe('The id this run gets (hx-...; the walnut CLI picks one). The same id again from this task answers that run, never a second one'),
  },
  bind: { method: 'POST', path: '/hosts/:host/exec' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body }) => runOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_read',
  title: 'Read a command\'s output on another host',
  description:
    'The output of a host_exec job: from `offset` (bytes into its log) or, with no offset, its last 256 KB; `nextOffset` continues. '
    + '`wait_ms` holds the answer until the job ends (up to 60000; about 10000 from a session on another host), so poll rarely. '
    + '`running` false means it ended, with `exitCode`. `truncated` means the start of the output is not here; `more`, that output '
    + 'after nextOffset is. Only the task that started a job reads or stops it.',
  input: {
    host: z.string().min(1).describe('The host the job runs on'),
    job_id: z.string().min(1).describe('The jobId host_exec returned'),
    offset: z.number().int().min(0).optional().describe('Byte offset into the log (default: the tail)'),
    wait_ms: z.number().int().min(0).max(60_000).optional().describe('Wait up to this long for the job to end'),
  },
  bind: { method: 'GET', path: '/hosts/:host/exec/:job_id' },
  timeoutMs: 2 * 60_000,
  mapResult: ({ body }) => runOutcome(body),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_exec_stop',
  title: 'Stop a command on another host',
  description: 'Stop a running host_exec job: its whole process group gets SIGTERM, then SIGKILL after 3 seconds.',
  input: {
    host: z.string().min(1).describe('The host the job runs on'),
    job_id: z.string().min(1).describe('The jobId host_exec returned'),
  },
  bind: { method: 'POST', path: '/hosts/:host/exec/:job_id/stop' },
  // The route dials the host and answers within the relayed caller's hold (about 12 s).
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    return withOutcome(b, typeof b.note === 'string' ? `Stopping. ${b.note}` : 'Stopping.', 'host_exec_read shows when it ended.')
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
    + 'not answer) and exitCode. Use it to find a job whose answer never came back, then host_exec_read it; never run it again.',
  input: {
    host: z.string().min(1).describe('The host the jobs run on'),
  },
  bind: { method: 'GET', path: '/hosts/:host/exec' },
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { host?: unknown; jobs?: Array<{ state?: string }>; hostAway?: unknown }
    const jobs = Array.isArray(b.jobs) ? b.jobs : []
    const running = jobs.filter((j) => j.state === 'running').length
    const head = jobs.length
      ? `${jobs.length} job(s) of this task on ${String(b.host)}, ${running} running.`
      : `No jobs of this task on ${String(b.host)}.`
    return withOutcome(b, typeof b.hostAway === 'string' ? `${head} The host did not answer (${b.hostAway}); these are the runs Walnut started there.` : head,
      jobs.length ? 'host_exec_read a jobId for its output.' : 'Nothing to read.')
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
