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

/**
 * The copy in a line: done (with its checksum), or still copying with its copy_id.
 * 2026-11-21: 134 of 1,543 host_copy calls in a week repeated a copy that had already
 * answered, so a finished copy says it is finished and that nothing more is needed.
 */
function copyOutcome(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const from = `${String(b.from_host)}:${String(b.from)}`
  const to = `${String(b.to_host)}:${String(b.to)}`
  if (b.running) {
    const sofar = typeof b.bytes === 'number' ? `: ${sizeText(b.sent)} of ${sizeText(b.bytes)} so far` : ''
    return withOutcome(b, `Still copying ${from} to ${to} as copy ${String(b.copyId)}${sofar}. Not done yet.`,
      `host_copy_result ${JSON.stringify({ copy_id: b.copyId })} waits for it (up to a minute a call); never start it again: it is still copying.`)
  }
  return withOutcome(b, `Done: copied ${sizeText(b.bytes)} from ${from} to ${to} in ${msText(b.ms)} (sha256 ${String(b.sha256)})${b.replaced ? ', replacing the file that was there' : ''}. The file is there, its size and checksum checked.`,
    'Nothing more to do: do not copy it again (only a file that changed since needs a new copy).')
}

/** A copy's answer is a few hundred characters; this leaves room for a long path on each side. */
const COPY_ANSWER = { kind: 'content', max: 3_000 } as const

defineOp({
  name: 'host_copy',
  title: 'Copy a file between hosts',
  description:
    'Copy ONE regular file (at most 2 GB) from one host Walnut knows to another (host_list names them), through Walnut: '
    + 'sources to the Mac that builds the iOS app, results back. `from_host` and `to_host` are aliases or selectors ("@ios"); each '
    + 'defaults to your own host, and one must be another host. A selector may pick another host each call: after the first, name '
    + 'the host the answer gave. `from` and `to` are absolute or ~/ paths there, written out (no $VARIABLES; on another host '
    + '$WALNUT_TASK_DIR is the `taskDir` a host_exec answer names); a `to` ending in "/", or naming a folder, keeps the file\'s name. '
    + 'It lands whole or not at all, size and sha256 checked (`replaced` says it replaced one), as a plain file: chmod it there with '
    + 'host_exec if it must run. A folder is refused: tar it first, unpack it there with host_exec. Never credentials or Walnut\'s '
    + 'own data. On a Mac, a place macOS guards (Desktop, Documents, Downloads...) is refused with 409 may_prompt: use another folder, '
    + 'or ask the user, then pass allow_prompts:true. A host that is not yours needs this task\'s host_exec grant there: the first '
    + 'call asks the user by letter (403 exec_grant_required); do other work, a notice comes when they allow it. The call waits up '
    + 'to a minute (about 10 s from a session on another host) for the copy to end. An outcome starting "Done" means the file is '
    + 'there, checked: do not copy it again. running:true means still copying: host_copy_result with its copyId waits for it, '
    + 'and the same call again joins that copy, never a second one.',
  // 2026-11-23: names agents sent for these in real use (72 hours of sessions): read as the declared ones.
  renamedInput: [{ from: 'from_path', to: 'from' }, { from: 'to_path', to: 'to' }],
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
  // Content, not a receipt: the answer is the copy it ran (done, or the copyId still copying).
  answer: COPY_ANSWER,
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
  answer: COPY_ANSWER,
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
