import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

/** The run in two lines: how it ended, then the output, so an agent reads it like its own Bash tool. */
function runOutcome(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const where = `${String(b.host)}${b.cwd ? ` in ${String(b.cwd)}` : ''}`
  const head = b.running
    ? `Running on ${where} as job ${String(b.jobId)}.`
    : b.timedOut ? `Stopped on ${where} at its deadline after ${String(b.ms)} ms (exit ${String(b.exitCode ?? b.signal)}).`
      : `Exit ${String(b.exitCode ?? b.signal)} on ${where} after ${String(b.ms)} ms.`
  const notes = [
    b.truncated ? `Only the last part of the output is here; the whole log is ${String(b.logFile)} on that host (host_exec_read with offset 0).` : '',
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
    + 'its signed-in tools, its files. Give `command` (a shell line, run by the user\'s login shell) or `argv` (a program and its '
    + 'arguments, no shell parsing). `host` is an alias or a capability selector ("@ios"); never your own host (use your Bash tool). '
    + 'The first call for this task on a host asks the user by letter (403 exec_grant_required): do other work, you get a notice '
    + 'when they allow it; the grant lasts until they revoke it. A run ends by its deadline (timeout_ms, default 2 minutes, at most 10; '
    + 'with background:true at most 2 hours), its whole process group stopped. The call waits for the run to end, but from a session on '
    + 'another host at most about 15 seconds: a run still going comes back running:true with its job_id, and host_exec_read with '
    + 'wait_ms waits for it (never run it again: it is still running). Up to 2 runs at once per task, 4 per host. Only the last 256 KB of output comes back; the full log stays '
    + 'in your task\'s directory on that host. Lines that look like a credential are hidden.',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the Mac) or a selector like "@ios"'),
    command: z.string().optional().describe('A shell line, run by the user\'s login shell on that host'),
    argv: z.array(z.string()).optional().describe('Instead of command: the program and its arguments, passed with no shell parsing'),
    cwd: z.string().optional().describe('Working directory on that host (absolute or ~/...; default the user\'s home)'),
    timeout_ms: z.number().int().min(1).max(7_200_000).optional().describe('Deadline in ms (default 120000; at most 600000, or 7200000 with background)'),
    background: z.boolean().optional().describe('Start it and return a job_id at once; read it with host_exec_read'),
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
    + '`wait_ms` holds the answer until the job ends (up to 60000; about 15000 from a session on another host), so poll rarely. '
    + '`running` false means it ended, with `exitCode`. Only the task that started a job reads or stops it.',
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
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, 'Stopping.', 'host_exec_read shows when it ended.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
