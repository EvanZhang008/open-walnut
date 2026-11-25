import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { DOC_PART_INPUT, pagedResult } from './doc-page.js';

/**
 * Locked notes for agents (core/notes/locked-note-ask.ts, docs/reference/locked-notes.md). A note
 * the user locked is private and hand-written: an agent reads only its stub (note_read says
 * `locked: true`). These ops are the one way past it, and each needs the user's own yes, given
 * with their Passwords master password; there is no op that locks, unlocks or reads one unasked.
 * No answer of theirs is kept for a resend: their routes say so (lib/answer-not-kept.ts).
 */

/**
 * A released note's whole answer, at most, on every surface. Claude Code writes a large tool answer
 * to a file on the session's host (tool-results/*.txt), which would leave the user's private text
 * there in the clear; the 23,000-character pages a document gets did (2026-11-25 review). So this op
 * answers in pages no larger than a shell's `walnut tools call` gets, and reads on by `next`.
 */
export const LOCKED_NOTE_ANSWER_MAX = 8_000;

const USE_RULE = 'The text is the user\'s private writing: use it only for the purpose you gave, quote no more than the step needs, '
  + 'and never put it in a file, a commit, a log, a search, a memory or another message.';

function askOutcome(body: unknown) {
  const b = (body ?? {}) as { status?: string; path?: string; readUntil?: string; editUntil?: string; requestId?: string };
  if (b.status === 'released') {
    return withOutcome(b as Record<string, unknown>,
      `The user approved: the text of ${b.path} is in content. The same locked_note_wait reads it again (or its next page) until ${b.readUntil}.`
      + (b.editUntil ? ` Save changes with locked_note_save (the whole text) until ${b.editUntil}.` : ''),
      USE_RULE);
  }
  if (b.status === 'pending') {
    return withOutcome(b as Record<string, unknown>,
      'Waiting for the user to approve on their Mac or the web console (it needs their master password).',
      'Call locked_note_wait with id (requestId) and token (waitToken) until it is released. Do not ask again meanwhile.');
  }
  if (b.status === 'expired' || b.status === 'canceled') {
    return withOutcome(b as Record<string, unknown>, b.status === 'expired' ? 'Nobody answered in time: nothing was given.' : 'The ask was withdrawn: nothing was given.',
      'Go on without the note, or ask the user in words whether it is needed.');
  }
  return withOutcome(b as Record<string, unknown>, 'Still waiting for the user.', 'Call locked_note_wait again.');
}

const waitAgain = (args: Record<string, unknown>) => (more: Record<string, unknown>) =>
  `locked_note_wait ${JSON.stringify({ id: args.id, token: args.token, ...more })}`;

defineOp({
  name: 'locked_note_ask',
  title: 'Ask the user to open a locked note',
  description:
    'Ask the user to let you read (access "read") or change (access "edit") ONE note they locked. Use it only when the task cannot go '
    + 'on without that note, and say why in `purpose`, in words the user reads before deciding. The user approves on a card, typing '
    + 'their Passwords master password; Approvals being off does not answer it. Answers `status: "pending"` with requestId and '
    + 'waitToken: then locked_note_wait. A yes lets this task read the note for 10 minutes; "edit" lets it read and save it '
    + '(locked_note_save) for 30 minutes. Refusals: not_locked (read it with note_read), note_hidden (the user hid it: no tool reads it), '
    + 'denied (do not ask again unless the user says so), '
    + 'agent_paused (three denials: stop asking), too_many_asks. ' + USE_RULE,
  input: {
    path: z.string().min(1).max(1000).describe('Vault-relative path of the locked note (from note_read or note_search)'),
    purpose: z.string().min(4).max(200).describe('Why you need it, in a few words the user reads before deciding'),
    access: z.enum(['read', 'edit']).optional().describe('read (default): read it for 10 minutes; edit: read and save it for 30 minutes'),
  },
  bind: { method: 'POST', path: '/vault/notes/agent/ask' },
  mapResult: ({ body }) => askOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'locked_note_wait',
  title: 'Wait for the user to open a locked note',
  description:
    'Wait for the user\'s answer to a locked_note_ask: holds up to `wait_ms` (at most 12000), then answers `released` with the note\'s '
    + 'text in content, `pending`, or `expired`/`canceled`. A no is 403 denied. After a yes, the same call reads the note again until '
    + 'readUntil; a long note comes in pages (`page` says how to read on; offset or section picks a part). ' + USE_RULE,
  input: {
    id: z.string().min(1).describe('requestId from locked_note_ask'),
    token: z.string().min(1).describe('waitToken from locked_note_ask'),
    wait_ms: z.number().int().min(0).max(12_000).optional().describe('How long to hold for an answer (default 12000)'),
    ...DOC_PART_INPUT,
  },
  bind: { method: 'POST', path: '/vault/notes/agent/ask/:id/wait' },
  timeoutMs: 20_000,
  mapResult: ({ body }) => askOutcome(body),
  // Its answer is the note's text the user released: a document, paged like note_read (doc-page.ts), never cut.
  answer: {
    kind: 'content', max: LOCKED_NOTE_ANSWER_MAX,
    shape: ({ result, args, max, surface }) => pagedResult(result, 'content', args, waitAgain(args), { fit: { max, surface } }),
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'locked_note_save',
  title: 'Save a locked note the user let you change',
  description:
    'Save the WHOLE new text of a locked note under an approved "edit" ask (same task, within its 30 minutes). Pass expectedHash: the '
    + 'contentHash locked_note_wait gave, or the one the last save answered. A page of a long note is not the whole text: read every page '
    + 'first. The note stays locked and encrypted. Refusals: '
    + 'not_approved, edit_ended (ask again), conflict (the user changed it meanwhile: do not overwrite; tell the user).',
  input: {
    id: z.string().min(1).describe('requestId from locked_note_ask'),
    token: z.string().min(1).describe('waitToken from locked_note_ask'),
    content: z.string().describe('The note\'s whole new text'),
    expectedHash: z.string().min(1).describe('contentHash of the text you edited'),
  },
  bind: { method: 'POST', path: '/vault/notes/agent/ask/:id/save' },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, 'Saved; the note stays locked.', 'Keep contentHash for another save in the same window.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'locked_note_cancel',
  title: 'Withdraw a locked-note ask',
  description: 'Withdraw a locked_note_ask still waiting for the user (the step is no longer needed), or end an approved edit early.',
  input: {
    id: z.string().min(1).describe('requestId from locked_note_ask'),
    token: z.string().min(1).describe('waitToken from locked_note_ask'),
  },
  bind: { method: 'POST', path: '/vault/notes/agent/ask/:id/cancel' },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, 'Withdrawn.', 'Nothing more to do.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
