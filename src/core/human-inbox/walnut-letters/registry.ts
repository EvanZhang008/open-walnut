/**
 * Every letter Walnut writes itself, declared once (kind.ts). A caller builds its letter through its
 * kind's `render`, in the user's letter language (languages.ts); the sweep (sweep.ts) settles an
 * open one its kind's `stillNeeded` rule says nobody needs any more.
 *
 * The ratchet (tests/core/walnut-letters-ratchet.test.ts) reads every send site in src/ and fails
 * on one that is neither a kind's caller nor listed in EXEMPT_LETTER_SENDS with a reason.
 */
import type { LetterRecord } from '../types.js';
import type { WalnutLetterKind } from './kind.js';
import { HOST_SIGN_IN } from './host-sign-in.js';
import { HOST_EXEC_ASK } from './host-exec-ask.js';
import { BUDGET_PAUSED } from './budget-paused.js';
import { ORG_REPORT } from './org-report.js';
import { MAIL_APPROVAL } from './mail-approval.js';
import { MAIL_UNSUBSCRIBE } from './mail-unsubscribe.js';
import { MAIL_DIGEST } from './mail-digest.js';
import { OFFLINE_CONFLICT } from './offline-conflict.js';
import { LOCAL_NETWORK_BLOCKED } from './local-network-blocked.js';
import { SSH_CERT_EXPIRY } from './ssh-cert-expiry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WALNUT_LETTER_KINDS: readonly WalnutLetterKind<any>[] = [
  HOST_SIGN_IN,
  HOST_EXEC_ASK,
  BUDGET_PAUSED,
  ORG_REPORT,
  MAIL_APPROVAL,
  MAIL_UNSUBSCRIBE,
  MAIL_DIGEST,
  OFFLINE_CONFLICT,
  LOCAL_NETWORK_BLOCKED,
  SSH_CERT_EXPIRY,
];

/** Send sites whose words are not Walnut's own, each with why (repo-relative path -> reason). */
export const EXEMPT_LETTER_SENDS: Readonly<Record<string, string>> = {
  'src/core/human-inbox/store.ts': 'the store itself: sendLetter is sendLetterOnce',
  'src/core/router/service.ts': 'a mail router\'s for_user letter: the router session wrote the brief; Walnut adds only the email\'s sender and subject as labels',
  'src/core/human-inbox/letter-ops.ts': 'a session\'s own letter (human_inbox_send): the session wrote every word',
  'src/core/human-inbox/relay.ts': 'a session\'s letter relayed from a replica: the session wrote every word',
  'src/web/routes/human-inbox-v1.ts': 'POST /api/v1/human-inbox: a session\'s own letter',
  'src/core/offline-merge/apply-letter.ts': 'journal replay of a session\'s letter written while the server was away',
  'src/core/plugins/server-api.ts': 'walnut.letters.send: a plugin supplies the text (the built-in mail plugin\'s are kinds here)',
};

/** The kind of a letter Walnut wrote itself, or undefined. */
export function kindOfLetter(letter: LetterRecord): WalnutLetterKind<unknown> | undefined {
  const op = letter.createdByOp ?? '';
  return WALNUT_LETTER_KINDS.find((k) => (k.marked && op.startsWith(`${k.id}:`)) || k.matchesUnmarked?.(letter));
}
