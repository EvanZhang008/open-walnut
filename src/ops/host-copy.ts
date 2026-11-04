import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

function sizeText(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  if (v < 1024) return `${v} bytes`
  const units = ['KB', 'MB', 'GB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x.toFixed(1)} ${units[i]}`
}

function msText(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`
}

/** The copy in a line: copied (with its checksum), or still copying with its copy_id. */
function copyOutcome(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const from = `${String(b.from_host)}:${String(b.from)}`
  const to = `${String(b.to_host)}:${String(b.to)}`
  if (b.running) {
    const sofar = typeof b.bytes === 'number' ? `: ${sizeText(b.sent)} of ${sizeText(b.bytes)} so far` : ''
    return withOutcome(b, `Copying ${from} to ${to} as copy ${String(b.copyId)}${sofar}.`,
      'host_copy_result with this copy_id waits for it; never start it again (it is still copying).')
  }
  return withOutcome(b, `Copied ${sizeText(b.bytes)} from ${from} to ${to} in ${msText(b.ms)} (sha256 ${String(b.sha256)})${b.replaced ? ', replacing the file that was there' : ''}.`,
    'Nothing needed: the file is there, checked.')
}

defineOp({
  name: 'host_copy',
  title: 'Copy a file between hosts',
  description:
    'Copy ONE file from one host Walnut knows to another (host_list names them), through Walnut: send a source tarball to the Mac '
    + 'that builds and tests the iOS app, bring test results, screenshots and videos back. `from_host` and `to_host` are host aliases or '
    + 'selectors ("@ios"); each defaults to your own host, and at least one must be another host. A selector can pick a different host '
    + 'on each call, so after the first call name the host the answer gave (`to_host`, `from_host`). `from` and `to` are paths on those '
    + 'hosts, absolute or ~/... (write them out: no $VARIABLES); a `to` ending in "/", or naming a folder, gets the file\'s own name. '
    + 'The file lands whole or not at all: its size and sha256 are checked before it replaces anything there (`replaced` says it did). '
    + 'It lands as a plain file (mode 0644 by the umask there, the executable bit is not kept): chmod it there with host_exec if it must run. '
    + 'One regular file of at most 2 GB: a folder is refused, so tar it first (host_exec on that host, or your own Bash on yours), and '
    + 'unpack it there with host_exec. Never credentials (~/.ssh, ~/.aws, secrets...) or Walnut\'s own data. On a Mac, a place macOS '
    + 'guards (Desktop, Documents, Downloads, Pictures, Movies, Music, Mail, Messages, other apps\' data, /Volumes) is refused with 409 '
    + 'may_prompt: reading or writing there shows a permission dialog on that Mac\'s screen and the copy waits in it. Use another '
    + 'folder there, or ask the user first, then pass allow_prompts:true. A host that is not yours '
    + 'needs this task\'s grant there, the same one host_exec uses: the first call asks the user by letter (403 exec_grant_required); do '
    + 'other work, you get a notice when they allow it. Big files take time: the call waits up to a minute (about 10 seconds from a '
    + 'session on another host), then answers running:true with a copyId, and host_copy_result waits for it. The same call again while '
    + 'it runs, or the same copy_id (the walnut CLI picks one), answers that copy and never starts a second. Up to 2 copies at once per '
    + 'task and 4 on Walnut; one at a time onto one file (409 target_busy); a copy stops at 1 hour. On another host, $WALNUT_TASK_DIR is '
    + 'the `taskDir` a host_exec answer names. Example: {"from": "<your $WALNUT_TASK_DIR>/src.tgz", "to_host": "@ios", "to": "~/build/"}, '
    + 'build there with host_exec, then {"from_host": "<that host>", "from": "~/build/results.tgz", "to": "<your $WALNUT_TASK_DIR>/"}.',
  input: {
    from: z.string().min(1).describe('The file on the sending host: an absolute path or ~/...'),
    to: z.string().min(1).describe('Where it goes on the receiving host: an absolute path or ~/...; ending in "/" (or a folder) keeps the file\'s name'),
    from_host: z.string().optional().describe('The sending host: an alias ("__local__" = the machine the Walnut server runs on, usually the Mac) or a selector like "@ios" (default: your own host)'),
    to_host: z.string().optional().describe('The receiving host: an alias ("__local__" = the machine the Walnut server runs on, usually the Mac) or a selector like "@ios" (default: your own host)'),
    copy_id: z.string().optional().describe('The id this copy gets (hc-...; the walnut CLI picks one). The same id again from this task answers that copy, never a second one'),
    allow_prompts: z.boolean().optional().describe('The user agreed this copy may show a permission dialog on a Mac\'s screen (a 409 may_prompt asked for it)'),
  },
  bind: { method: 'POST', path: '/host-copy' },
  // The route waits up to a minute for the copy, after its grant check and two reads.
  timeoutMs: 3 * 60_000,
  mapResult: ({ body }) => copyOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_copy_result',
  title: 'Wait for a file copy between hosts',
  description:
    'The answer of a host_copy that came back running: waits up to `wait_ms` (default and at most 60000; about 10000 from a session on '
    + 'another host) for it to end, then gives the result (bytes, sha256, the final `to`) or why it failed, or running:true again with '
    + '`sent` of `bytes` so far. Only the task that started a copy reads it; its answer is kept 30 minutes after it ends.',
  input: {
    copy_id: z.string().min(1).describe('The copyId host_copy returned'),
    wait_ms: z.number().int().min(0).max(60_000).optional().describe('Wait up to this long for the copy to end'),
  },
  bind: { method: 'GET', path: '/host-copy/:copy_id' },
  timeoutMs: 2 * 60_000,
  mapResult: ({ body }) => copyOutcome(body),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
