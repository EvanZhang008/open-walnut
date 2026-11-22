/**
 * One sign-in per mail account, from "Sign in with Google / Microsoft" to its calendar being read.
 *
 * The sign-in itself is the shared desktop flow (core/oauth/desktop-oauth.ts), one flow per
 * account (`calendar:<account id>`), with the account's address as the provider's login hint.
 * When it comes back: its tokens are saved (store.ts), then the account's calendar is added the
 * way "Add its calendar" adds one (or, already read, read again), and the outcome is kept for
 * the row to show. The provider's own consent page is the person's yes for the sign-in, so
 * starting one asks nothing more of the caller.
 *
 * The login hint is only a hint: the person can sign in as another account than the row's. The
 * same account by its provider's rules (sign-in-provider.ts `sameAccount`) is kept at once; any
 * other is held on the row, kept nowhere, until the person chooses to use that account's
 * calendar or to discard the sign-in (`decideCalendarSignIn`). Never saved or dropped silently.
 */
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import {
  SIGN_IN_CANCELLED, cancelSignIn, completeSignInFromUrl, signInPending, startSignIn, type SignInResult,
} from '../../../core/oauth/desktop-oauth.js';
import { sameAccount, type SignInProvider } from '../sign-in-provider.js';
import { CALENDAR_SIGN_INS, type ResolvedClient } from './providers.js';
import type { CalendarSignInStore } from './store.js';

export interface SignInDeps {
  store: CalendarSignInStore;
  client: (provider: SignInProvider) => Promise<ResolvedClient | null>;
  /** After a sign-in was saved: read the account's calendar from now on. */
  afterSignIn: (accountId: string, address: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** How long a sign-in waits for the browser (tests shorten it). */
  timeoutMs?: number;
}

export type SignInOutcome =
  | { ok: true; email?: string }
  /** `signedIn`: the sign-in worked and was kept, only reading the calendar failed. */
  | { ok: false; message: string; signedIn: boolean; cancelled?: boolean; held?: { email: string } };

interface Attempt {
  done: Promise<SignInOutcome>;
  authUrl: string;
  address: string;
  provider: SignInProvider;
  outcome?: SignInOutcome;
  /** A sign-in as another account, waiting for the person's choice (in memory only). */
  held?: SignInResult & { ok: true };
}

const attempts = new Map<string, Attempt>();

const flowOf = (accountId: string) => `calendar:${accountId}`;

/** Keep a sign-in and read its calendar. */
async function keep(deps: SignInDeps, accountId: string, attempt: Pick<Attempt, 'address' | 'provider'>, r: SignInResult & { ok: true }): Promise<SignInOutcome> {
  const { address, provider } = attempt;
  try {
    await deps.store.save({ ...r.tokens, provider, account_id: accountId, address });
  } catch (err) {
    return { ok: false, message: `The sign-in worked, but Walnut could not keep it: ${err instanceof Error ? err.message : String(err)}`, signedIn: false };
  }
  const added = await deps.afterSignIn(accountId, address).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }));
  return added.ok ? { ok: true, ...(r.tokens.email ? { email: r.tokens.email } : {}) } : { ok: false, message: added.message, signedIn: true };
}

async function settle(deps: SignInDeps, accountId: string, attempt: Attempt, r: SignInResult): Promise<SignInOutcome> {
  if (!r.ok) return { ok: false, message: r.error, signedIn: false, ...(r.error === SIGN_IN_CANCELLED ? { cancelled: true } : {}) };
  const who = r.tokens.email?.trim();
  if (!who || sameAccount(who, attempt.address)) return keep(deps, accountId, attempt, r);
  // Another account: its calendar would show under this row. The person chooses.
  attempt.held = r;
  return { ok: false, signedIn: false, held: { email: who }, message: `Signed in as ${who}. Use ${who}'s calendar for this account?` };
}

/** The person's choice for a sign-in held as another account: use its calendar for this row, or discard it. */
export async function decideCalendarSignIn(deps: SignInDeps, accountId: string, use: boolean): Promise<SignInOutcome> {
  const attempt = attempts.get(accountId);
  const held = attempt?.held;
  if (!attempt || !held) throw new CalendarHelperError('No sign-in waits for a choice on this account. Sign in again.', 'usage');
  attempt.held = undefined;
  // Nothing was kept, so nothing is revoked either: the grant may be one Drive backups or another row holds.
  attempt.outcome = use
    ? await keep(deps, accountId, attempt, held)
    : { ok: false, signedIn: false, cancelled: true, message: `Walnut kept nothing of the sign-in as ${held.tokens.email}.` };
  return attempt.outcome;
}

/** Open a sign-in for the account; the browser goes to `authUrl`. Throws `not-configured` when the provider has no client yet. */
export async function startCalendarSignIn(deps: SignInDeps, accountId: string, address: string, provider: SignInProvider): Promise<{ authUrl: string }> {
  const resolved = await deps.client(provider);
  if (!resolved) throw new CalendarHelperError(`Add a ${provider} client first (the steps are on this row).`, 'not-configured');
  let finish!: (o: SignInOutcome) => void;
  const done = new Promise<SignInOutcome>((r) => { finish = r; });
  // A newer sign-in ends the older one (desktop-oauth.ts), and so does its row.
  attempts.delete(accountId);
  const attempt: Attempt = { done, authUrl: '', address, provider };
  const started = await startSignIn(CALENDAR_SIGN_INS[provider], resolved.client, {
    flow: flowOf(accountId),
    authParams: { login_hint: address },
    timeoutMs: deps.timeoutMs,
    onDone: (r) => { void settle(deps, accountId, attempt, r).then(finish); },
  });
  attempt.authUrl = started.authUrl;
  attempts.set(accountId, attempt);
  void done.then((outcome) => { attempt.outcome ??= outcome; });
  return { authUrl: started.authUrl };
}

/** The browser was on another device: the address it landed on finishes the sign-in. Answers once the calendar was tried. */
export async function completeCalendarSignIn(accountId: string, pasted: string, provider: SignInProvider): Promise<SignInOutcome> {
  const attempt = attempts.get(accountId);
  await completeSignInFromUrl(flowOf(accountId), pasted, CALENDAR_SIGN_INS[provider].again);
  return attempt ? attempt.done : { ok: true };
}

export function cancelCalendarSignIn(accountId: string): boolean {
  return cancelSignIn(flowOf(accountId));
}

/** Where the account's last sign-in stands: waiting (with its page), or how it ended. */
export function calendarSignInState(accountId: string): { pending: boolean; authUrl?: string; outcome?: SignInOutcome } {
  const attempt = attempts.get(accountId);
  const pending = signInPending(flowOf(accountId));
  if (pending) return { pending, ...(attempt ? { authUrl: attempt.authUrl } : {}) };
  // Still settling (saving, reading the calendar) after the browser came back.
  if (attempt && !attempt.outcome) return { pending: true };
  return { pending: false, ...(attempt?.outcome ? { outcome: attempt.outcome } : {}) };
}

/** Forget what the row would show about the account's last sign-in (its calendar was removed). */
export function clearCalendarSignInState(accountId: string): void {
  cancelSignIn(flowOf(accountId));
  attempts.delete(accountId);
}
