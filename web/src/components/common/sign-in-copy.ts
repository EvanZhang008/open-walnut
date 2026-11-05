/**
 * Every string of the sign-in page (spec 3.2, 3.4), as one pure table so a
 * vitest can pin it word for word (tests/web/sign-in-copy.test.ts).
 *
 *   unpaired      no token, the server said not_paired
 *   revoked       a token the server refuses (token_refused)
 *   signed-out    this browser signed itself out (sessionStorage flag)
 *   probe-failed  no token and GET /api/v1/me did not answer
 *
 * `touch` is a phone or tablet (pointer: coarse); `standalone` is a Home Screen
 * app, whose camera scan opens Safari instead, so the code field comes first.
 */

import type { SignedOutReason } from '@/api/unpaired';

export type SignInState = 'unpaired' | 'revoked' | 'signed-out' | 'probe-failed';

export interface SignInCopyInput {
  state: SignInState;
  touch: boolean;
  standalone: boolean;
  /** Revoked only: why, when the renewal said (api/unpaired.ts). */
  reason?: SignedOutReason | null;
}

/** The revoked page's line under its title, by why the sign-in ended. */
const REVOKED_LINE: Record<SignedOutReason | 'other', string> = {
  cookie_gone: 'Its sign-in was cleared from this browser. Sign in again with a new link.',
  used_elsewhere: 'Its sign-in was used from another device, so Walnut ended it to keep it safe. Sign in again with a new link.',
  year_unused: 'It was not used for a year. Sign in again with a new link.',
  removed: 'It was signed out from your computer. Sign in again with a new link.',
  other: 'Removed on your computer, or its sign-in ended. Sign in again with a new link.',
};

export interface SignInCopy {
  title: string;
  tagline: string;
  steps: [string, string];
  codeHeading: string;
  /** Under the code heading; null when the heading says it all. */
  codeHint: string | null;
  inputLabel: string;
  placeholder: string;
  submit: string;
  submitBusy: string;
  /** The small line at the bottom; null when the page above already says it all. */
  footer: string | null;
  /** Revoked only: a text button that reloads. */
  retry: string | null;
  /** Probe failed only: the error line and the button that asks again. */
  probeError: string | null;
  probeRetry: string | null;
  /** Home Screen app on a phone: the code field sits before the steps. */
  codeFirst: boolean;
}

export const SIGN_IN_PENDING_TITLE = 'Signing in...';
/**
 * The code section's heading after a scanned sign-in link failed (N23, N2-25):
 * one of the two section 3.2 headings; the error line under the field says
 * what to do next (make a new code).
 */
export const SIGN_IN_FAILED_SCAN_HEADING = 'Sign-in code';
export const SIGN_IN_PENDING_LINE = 'Checking the code from your link.';
export const SIGN_IN_PENDING_SLOW = 'Still waiting for Walnut. The connection may be slow.';
export const SIGN_IN_BAD_CHARS = 'Codes never use 0, 1, I, L or O.';
export const SIGN_IN_SIGNED_OUT_FLAG = 'walnut.signedOut';

const NETWORK = 'Walnut did not answer. Check the connection, then try again.';
/** A code that is wrong, was used already, or ran out (the server does not say which). */
export const INVALID_CODE = 'That code is wrong, already used or expired. Make a new one in Walnut on your computer.';

export function signInCopy({ state, touch, standalone, reason = null }: SignInCopyInput): SignInCopy {
  const homeScreen = standalone && touch;
  const device = touch ? 'phone' : 'browser';
  const title = state === 'revoked' ? `This ${device} was signed out`
    : state === 'signed-out' ? 'Signed out'
    : 'Sign in to Walnut';
  const tagline = state === 'revoked'
    ? REVOKED_LINE[reason ?? 'other']
    : state === 'signed-out'
      ? `This ${device} no longer has access to Walnut. Sign in again below.`
      : 'Your tasks, AI sessions and notes, from the computer Walnut runs on.';
  const step2 = homeScreen
    ? 'Paste the link shown under Open on your phone into the field above. Opening the link opens Safari, not this app.'
    : touch
      ? 'On this phone, open the link shown under Open on your phone.'
      : 'Open the link shown under Open on your phone in this browser, or paste it below.';
  const scanning = touch && !homeScreen;
  return {
    title,
    tagline,
    steps: ['On your computer, open Walnut and go to Settings > Phones & Cloud > Browser link.', step2],
    codeHeading: 'Sign-in code',
    // The computer shows the link with its code hidden: pasting it is the way, never typing.
    codeHint: scanning ? "Can't open the link? Paste it here." : null,
    inputLabel: 'Sign-in code',
    placeholder: 'XXXX-XXXX',
    submit: 'Sign in',
    submitBusy: 'Signing in...',
    // A phone is never the computer Walnut runs on, and a note about cookies was noise on a
    // first visit (two reviewers): it has none. A signed-out page says why in its own line.
    footer: touch ? null : 'On the computer Walnut runs on? Open Walnut there; it needs no code.',
    // A refused sign-in stays refused: a reload would show the same page.
    retry: null,
    probeError: state === 'probe-failed' ? NETWORK : null,
    probeRetry: state === 'probe-failed' ? 'Try again' : null,
    codeFirst: homeScreen,
  };
}

export type SignInErrorKind = 'invalid_code' | 'rate_limited' | 'network' | 'other';

/** The error line under the code field (spec 3.4). */
export function errorMessage(kind: SignInErrorKind, status?: number, serverMessage?: string | null): string {
  if (kind === 'invalid_code') return INVALID_CODE;
  if (kind === 'rate_limited') return 'Too many wrong codes. Wait a minute, then try again.';
  if (kind === 'network') return NETWORK;
  const server = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  if (server) return server;
  return `Walnut refused the code (${status ?? 'no status'}).`;
}

/** The kind of a refused exchange, from its status and the server's error code. */
export function errorKindFor(status: number | null, code?: string | null): SignInErrorKind {
  if (status === null) return 'network';
  if (code === 'invalid_code' || (status === 400 && !code)) return 'invalid_code';
  if (code === 'rate_limited' || status === 429) return 'rate_limited';
  return 'other';
}

/**
 * Which page to show, from unpaired.ts's state, the gate's probe result and
 * the self sign-out flag. A self sign-out wins over revoked: until sign-out
 * clears the token (spec D7), the reload after it meets token_refused.
 */
export function pickSignInState(
  unpaired: 'ok' | 'unpaired' | 'revoked', probeFailed: boolean, signedOut: boolean,
): SignInState {
  if (signedOut && unpaired !== 'ok') return 'signed-out';
  if (unpaired === 'revoked') return 'revoked';
  if (probeFailed) return 'probe-failed';
  return 'unpaired';
}
