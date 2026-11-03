import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

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

defineOp({
  name: 'approval_request',
  title: 'Ask a person to approve a step',
  description:
    'Ask the user to approve one step before it goes on: a notification reaches their Mac and their phone with `what` (one line) '
    + 'and `detail`, and they Approve or Deny. `mode: "biometric"` needs Face ID or Touch ID on a device that signs approvals, '
    + 'so no agent and no click-through can say yes (with no such device yet it asks for a tap and says why in `downgraded`). '
    + 'Returns the approval and a `waitToken`; then call approval_wait with both until it is decided. In a shell script use '
    + '`walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>]` instead: it waits and exits 0 only on Approve. '
    + 'No op answers one and the answer route refuses every session: a person answers on their device, and an agent never tries. Use it for a step the user must allow '
    + '(the charter\'s own kinds: an outward send, spending, credentials, deleting data), not for questions you can decide.',
  input: {
    what: z.string().min(1).max(300).describe('What is to be approved, one line (shown as the title)'),
    detail: z.string().max(32_000).optional().describe('The detail the person reads before answering (a diff summary, the command, the target)'),
    mode: z.enum(['tap', 'biometric']).optional().describe('tap (default): a plain Approve; biometric: Face ID / Touch ID on a device that signs'),
    timeout_ms: z.number().int().min(10_000).max(86_400_000).optional().describe('Unanswered after this long = expired (default 10 minutes)'),
    cwd: z.string().optional().describe('The asking process\'s working directory, shown to the person'),
    command: z.string().optional().describe('A short name for the asking script or command, shown to the person'),
  },
  bind: { method: 'POST', path: '/approvals' },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, stateLine(body), 'approval_wait with id and token (waitToken) until status is approved, denied, expired or canceled.'),
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
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, stateLine(body), 'Go on only when status is approved.'),
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
    + 'when, on which device and how), and the devices that sign approvals.',
  input: {
    status: z.enum(['pending', 'all']).optional().describe('pending (default) or all'),
  },
  bind: { method: 'GET', path: '/approvals', query: ['status'] },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
