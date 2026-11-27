import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { OWN_WAIT_TURN_END } from '../lib/turn-end-marker.js';
import { clipText } from './doc-page.js';
import { ANSWER_CEILING_CHARS } from './answer.js';

/**
 * Approvals (core/approvals/): ask a person to say yes before a step goes on. A script
 * uses `walnut approve "<what>"`, which runs approval_request and then approval_wait until
 * an answer. There is deliberately no op that answers one: only a person answers, on
 * their own device (routes/approvals-v1.ts).
 */

function stateLine(body: unknown): string {
  const b = (body ?? {}) as { approval?: { id?: string; status?: string; what?: string; answer?: { mode?: string; device?: { name?: string } } }; used?: boolean }
  const a = b.approval
  if (!a) return 'No approval.'
  if (a.status === 'pending') return `Approval ${a.id} ("${a.what}") is waiting for a person.`
  if (a.status === 'approved' || a.status === 'denied') {
    return `Approval ${a.id} was ${a.status} by a person (${a.answer?.mode ?? 'tap'}, ${a.answer?.device?.name ?? 'a device'}).`
  }
  return `Approval ${a.id} is ${a.status}.`
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? clipText(v, max) : undefined
/** Rows approval_list answers by default; `limit` or `id` reads others. */
const LIST_DEFAULT_LIMIT = 10
/** The head of an approval's detail an agent reads in a list or a wait. */
const DETAIL_HEAD = 160

/**
 * One approval as an agent reads it: its state and who answered, the asker in a line, and the
 * head of its detail (the asker wrote it; approval_list {"id"} reads it whole). The digest stays
 * for a single_use approval: approval_consume needs it.
 */
function approvalRow(value: unknown, wholeDetail = false): Record<string, unknown> {
  const a = rec(value)
  const answer = rec(a.answer)
  const asker = rec(a.requester)
  const title = clip(asker.taskTitle, 60)
  const why = clip(rec(a.context).why, 120)
  const detail = typeof a.detail === 'string' ? a.detail : ''
  return {
    id: a.id,
    status: a.status,
    what: a.what,
    ...(a.singleUse ? { singleUse: true, digest: a.digest } : {}),
    ...(a.requestOnly ? { requestOnly: true } : {}),
    ...(a.untilBack ? { untilBack: true } : {}),
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    ...(answer.decision ? { answer: `${String(answer.decision)} at ${String(answer.at)} on ${String(rec(answer.device).name ?? 'a device')}` } : {}),
    ...(a.consumedAt ? { consumedAt: a.consumedAt } : {}),
    ...(asker.taskId || asker.host
      ? { asker: { ...(asker.taskId ? { taskId: asker.taskId } : {}), ...(title ? { taskTitle: title } : {}), ...(asker.host ? { host: asker.host } : {}) } }
      : {}),
    ...(why ? { why } : {}),
    ...(detail ? { detail: wholeDetail ? detail : clip(detail, DETAIL_HEAD), detailChars: detail.length } : {}),
    ...(a.canceledReason ? { canceledReason: clip(a.canceledReason, DETAIL_HEAD) } : {}),
    ...(a.unasked ? { unasked: a.unasked } : {}),
  }
}

defineOp({
  name: 'approval_request',
  title: 'Ask a person to approve a step',
  description:
    'Ask the user to approve one step before it goes on: a notification reaches their Mac and their phone with `what` (one line) '
    + 'and `detail`, and they Approve or Deny with one tap on any device they are signed in on (the web console, the Mac app, the iPhone app). '
    + 'Returns the approval and a `waitToken`; then call approval_wait with both until it is decided, or ' + OWN_WAIT_TURN_END + '. Once it is '
    + 'approved, denied or expired, Walnut tells your session (a Walnut note that wakes it), so no trigger is needed to watch it. In a shell script use '
    + '`walnut approve "<what>" [--why <sentence>] [--timeout 10m] [--detail <file>]` instead: it waits and exits 0 only on Approve '
    + '(`--request-only` asks and exits 4, then `walnut approve --approval <id>` runs it once approved). The person sees why, the task, its last steps '
    + 'and whether Walnut saw the asking process inside this session. '
    + 'It always asks the person, whatever their Approvals switch says: that switch covers only Walnut\'s own asks (posts, mail, '
    + 'browser steps), never an approval someone put in a script or asks for on purpose. '
    + 'No op answers one and the answer route refuses every session: a person answers on their device, and an agent never tries. Use it for a step the user must allow '
    + '(the charter\'s own kinds: an outward send, spending, credentials, deleting data), not for questions you can decide.',
  input: {
    what: z.string().min(1).max(300).describe('What is to be approved, one line (shown as the title)'),
    detail: z.string().max(32_000).optional().describe('The detail the person reads before answering (a diff summary, the command, the target)'),
    // Taken from an older caller and ignored: every approval is a tap on any device the person is signed in on.
    mode: z.enum(['tap', 'biometric']).optional().describe('Ignored (an older caller\'s field): every approval is a tap on any device the person is signed in on'),
    single_use: z.boolean().optional().describe('Strict: bound to this detail; wait only reads, approval_consume spends it once before expiry (at most 5 minutes). Requires a task session.'),
    signing_key_id: z.string().min(1).max(80).optional().describe('Ignored (an older caller\'s pinned device)'),
    signing_key_ids: z.array(z.string().min(1).max(80)).min(2).max(8).optional().describe('Ignored (an older caller\'s pinned devices)'),
    timeout_ms: z.number().int().min(10_000).max(86_400_000).optional().describe('Unanswered after this long = expired. Default: open until the person answers, while they are away too (at most 72 hours; Walnut tells this session the answer); 5 minutes for single_use. Give it only for a wait of your own that ends'),
    cwd: z.string().optional().describe('The asking process\'s working directory, shown to the person'),
    command: z.string().optional().describe('A short name for the asking script or command, shown to the person'),
    why: z.string().max(400).optional().describe('Why this step, in a sentence the person reads first (else Walnut uses your last words before asking)'),
    request_only: z.boolean().optional().describe('Ask and end: Walnut tells this session the answer, and the step runs again with `walnut approve --approval <id>`'),
    terminal_session: z.string().max(120).optional().describe('Set by the walnut CLI in a task terminal Walnut opened; checked against the terminal\'s own process'),
  },
  bind: { method: 'POST', path: '/approvals' },
  // A single-use ask is answered whole: its asker checks the envelope Walnut made (session, task,
  // host, nonce, its own context) before anything runs, and a cut one reads as "not single-use"
  // (2026-11-23, apr-kCUkpVWwmbBH). Its size is bounded by the detail's own 32,000.
  answer: { kind: 'receipt', whole_for: (args) => args.single_use === true },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, stateLine(body), 'approval_wait with id and token (waitToken) until status is approved, denied, expired or canceled, or ' + OWN_WAIT_TURN_END + ': Walnut tells this session the answer.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'approval_wait',
  title: 'Wait for an approval\'s answer',
  description:
    'Wait for the answer to an approval you asked (approval_request): holds up to `wait_ms` (at most 12000) and returns its state. '
    + 'Call it again while `status` is pending. The first read of an answer uses it (`used: true`): one approval lets one step '
    + 'through, and a second read is refused (409 approval_used). Only the asker (its `token`) reads it.',
  input: {
    id: z.string().min(1).describe('The approval id'),
    token: z.string().min(1).describe('The waitToken approval_request returned'),
    wait_ms: z.number().int().min(0).max(12_000).optional().describe('How long to hold for an answer (default 12000)'),
  },
  bind: { method: 'POST', path: '/approvals/:id/wait' },
  timeoutMs: 20_000,
  // Content, not a receipt: its answer is the decision it waited for. The asker's own detail and
  // context are cut to a head (it wrote them), except a single_use one's record; the digest stays for approval_consume.
  answer: {
    kind: 'content',
    // Room for a single-use record whole (below); any other answer is a short row.
    max: ANSWER_CEILING_CHARS,
    shape: ({ result }) => {
      const r = rec(result)
      if (!r.approval) return result
      // A single_use approval is checked whole before approval_consume (its mode, asker, answer,
      // digest, times and envelope: cli-core.ts singleUseProblem), so it is answered as it is.
      if (rec(r.approval).singleUse === true) return result
      return { ...r, approval: approvalRow(r.approval) }
    },
  },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, stateLine(body), (body as { approval?: { singleUse?: boolean } }).approval?.singleUse
    ? 'Do not run yet. Check the record, rebuild the current operation context, then approval_consume; run only after used:true.'
    : 'Go on only when status is approved.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'approval_consume',
  title: 'Use one single-use approval',
  description: 'Use a single_use approval exactly once, after checking the record and rebuilding detail from the operation about to run. Requires the same task session and host, an unexpired approval and matching digest and detail. No retry grace: a lost response means ask again, never run.',
  input: {
    id: z.string().min(1).describe('The approval id'),
    token: z.string().min(1).describe('The waitToken returned to the asker'),
    digest: z.string().regex(/^[0-9a-f]{64}$/).describe('The approval digest the asker checked'),
    detail: z.string().min(1).max(32_000).describe('The original operation context rebuilt from its current state, without the server-generated envelope'),
  },
  bind: { method: 'POST', path: '/approvals/:id/consume' },
  // What the asker reads: that it was used, and which approval (its row, the detail whole).
  answer: {
    kind: 'receipt',
    shape: ({ result }) => {
      const r = rec(result)
      return r.approval ? { ...r, approval: approvalRow(r.approval, true) } : result
    },
  },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, 'The approval was used once.', 'Run only this approved operation; a retry needs a new approval.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'approval_cancel',
  title: 'Withdraw an approval you asked',
  description: 'Withdraw a pending approval you asked (approval_request), so it leaves the user\'s devices. Needs its waitToken.',
  input: {
    id: z.string().min(1).describe('The approval id'),
    token: z.string().min(1).describe('The waitToken approval_request returned'),
    reason: z.string().max(200).optional().describe('Why, in a few words'),
  },
  bind: { method: 'POST', path: '/approvals/:id/cancel' },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, stateLine(body), 'Nothing more to do.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'approval_list',
  title: 'List approvals',
  description: 'The approvals waiting for the user (`status: "all"` adds the decided ones of the last 30 days, with who answered, '
    + `when and on which device), newest first, and \`askMe\`: whether the user's Approvals switch is on. An agent reads ${LIST_DEFAULT_LIMIT} `
    + `rows (\`limit\` for more), each with the head of its detail; \`id\` reads one approval whole.`,
  input: {
    status: z.enum(['pending', 'all']).optional().describe('pending (default) or all'),
    limit: z.number().int().min(1).max(200).optional().describe(`At most this many, newest first (an agent reads ${LIST_DEFAULT_LIMIT} by default)`),
    id: z.string().min(1).max(80).optional().describe('One approval id: that approval whole, its detail and context included'),
  },
  bind: { method: 'GET', path: '/approvals', query: ['status'] },
  // A handler for `id` (GET /approvals/:id) and `limit`; without them it answers what the binding did.
  handler: async (args, call) => {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id) return call('GET', `/approvals/${encodeURIComponent(id)}`)
    const body = rec(await call('GET', `/approvals${args.status === 'all' ? '?status=all' : ''}`))
    if (typeof args.limit !== 'number' || !Array.isArray(body.approvals)) return body
    return { ...body, approvals: body.approvals.slice(0, args.limit), count: body.approvals.length }
  },
  answer: {
    kind: 'content',
    shape: ({ result, args }) => {
      const r = rec(result)
      // One approval asked by id is answered whole (the cap still holds a very long detail).
      if (r.approval || !Array.isArray(r.approvals)) return result
      const limit = typeof args.limit === 'number' ? args.limit : LIST_DEFAULT_LIMIT
      const total = typeof r.count === 'number' ? r.count : r.approvals.length
      const rows = r.approvals.slice(0, limit).map((row) => approvalRow(row))
      const more = total - rows.length
      const headOnly = rows.some((row) => typeof row.detailChars === 'number' && row.detailChars > DETAIL_HEAD)
      const status = args.status === 'all' ? { status: 'all' } : {}
      return {
        ...r,
        approvals: rows,
        count: total,
        ...(more > 0 ? { more, next: `${more} older not shown: approval_list ${JSON.stringify({ ...status, limit: Math.min(200, total) })}` } : {}),
        ...(headOnly ? { detail: `A detail shows its first ${DETAIL_HEAD} characters: approval_list {"id":"<id>"} reads one whole.` } : {}),
      }
    },
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
