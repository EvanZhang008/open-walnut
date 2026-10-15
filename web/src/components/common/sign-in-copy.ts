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

export type SignInState = 'unpaired' | 'revoked' | 'signed-out' | 'probe-failed';

export interface SignInCopyInput {
  state: SignInState;
  touch: boolean;
  standalone: boolean;
}

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
  footer: string;
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
export const SIGN_IN_PENDING_LINE = 'Checking the code from your QR scan.';
export const SIGN_IN_PENDING_SLOW = 'Still waiting for Walnut. The connection may be slow.';
export const SIGN_IN_BAD_CHARS = 'Codes never use 0, 1, I, L or O.';
export const SIGN_IN_SIGNED_OUT_FLAG = 'walnut.signedOut';

const NETWORK = 'Walnut did not answer. Check the connection, then try again.';

export function signInCopy({ state, touch, standalone }: SignInCopyInput): SignInCopy {
  const homeScreen = standalone && touch;
  const device = touch ? 'phone' : 'browser';
  const title = state === 'revoked' ? `This ${device} was signed out`
    : state === 'signed-out' ? 'Signed out'
    : 'Sign in to Walnut';
  const tagline = state === 'revoked'
    ? 'Walnut no longer accepts this sign-in. It may have been removed on your computer. Sign in again below.'
    : state === 'signed-out'
      ? `This ${device} no longer has access to Walnut. Sign in again below.`
      : 'Your tasks, AI sessions and notes, from the computer Walnut runs on.';
  const step2 = homeScreen
    ? 'Type the code shown with the QR code in the field above. Scanning the QR code opens Safari, not this app.'
    : touch
      ? "Click Show QR code, then scan it with this phone's camera."
      : 'Click Show QR code, then type the code shown with it below.';
  const scanning = touch && !homeScreen;
  return {
    title,
    tagline,
    steps: ['On your computer, open Walnut and go to Settings > Phones & Cloud.', step2],
    codeHeading: scanning ? "Can't scan it?" : 'Sign-in code',
    codeHint: scanning ? 'Type the 8-character code shown with the QR code.' : null,
    inputLabel: 'Sign-in code',
    placeholder: 'XXXX-XXXX',
    submit: 'Sign in',
    submitBusy: 'Signing in...',
    footer: 'On the computer Walnut runs on? Open Walnut there; it needs no code.',
    retry: state === 'revoked' ? 'Try again' : null,
    probeError: state === 'probe-failed' ? NETWORK : null,
    probeRetry: state === 'probe-failed' ? 'Try again' : null,
    codeFirst: homeScreen,
  };
}

export type SignInErrorKind = 'invalid_code' | 'rate_limited' | 'network' | 'other';

/** The error line under the code field (spec 3.4). */
export function errorMessage(kind: SignInErrorKind, status?: number, serverMessage?: string | null): string {
  if (kind === 'invalid_code') return 'That code is wrong or has expired. Make a new one in Walnut on your computer.';
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
