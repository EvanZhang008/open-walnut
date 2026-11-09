/**
 * Whose a failed session is (2026-11-09, the CEO for the user: "retrying what an agent broke was
 * never his decision"; two review sessions on another Mac failed on "API Error: Connection dropped
 * (ECONNRESET)", Walnut's own retries failed the same way, and both read Needs you with "Retry it or
 * open it"). Walnut retries a transient turn error by itself first (session-auto-continue.ts); a
 * failure left after that is the node above the task's to retry: its lead, else its project's VP,
 * else Main. Only a failure the user alone can fix (credentials, a sign-in, a permission, spending)
 * still goes to him, named by its kind.
 *
 * Pure and browser-safe: user-status.ts derives with it. The subtask notice (peers/envelope-kit.ts)
 * carries the retry line itself, since that factory may reference nothing outside it.
 */

/** A failure only the user can fix. */
export type UserErrorKind = 'credentials' | 'sign-in' | 'permissions' | 'spending';

/** Checked in order: a sign-in wins over the 401 its CLI reports with it. */
const USER_ERROR_PATTERNS: ReadonlyArray<readonly [UserErrorKind, RegExp]> = [
  ['sign-in', /\bsign(?:ed)?[- ]?in\b|\blog(?:ged)?[- ]?in\b|\/login\b|not logged|cert(?:ificate)?[- ]expired|session expired|reauthenticate|re-authenticate/i],
  // The session budget's own refusal (providers/delivery-failure.ts budget_paused) is spending too.
  ['spending', /budget(?:_| is )paused|raise or remove the limit|quota exceeded|insufficient (?:quota|funds|credit|balance)|credit balance|bil{2}ing|payment required|\b402\b|spend(?:ing)? limit|usage limit reached/i],
  ['credentials', /\b401\b|unauthori[sz]ed|\bauth\b|authentication|invalid (?:api[_ ]?)?key|api key|expired token|token (?:has )?expired|invalid token|credential|security token/i],
  ['permissions', /\b403\b|forbidden|permission denied|not authori[sz]ed|access denied|\bEACCES\b|\bEPERM\b/i],
];

/** The kind of a failure only the user can fix, or null when it is the team's to retry. */
export function usersErrorKind(text: string | null | undefined): UserErrorKind | null {
  if (!text) return null;
  for (const [kind, re] of USER_ERROR_PATTERNS) if (re.test(text)) return kind;
  return null;
}

/** What each kind asks of the user, in one clause. */
export const USER_ERROR_WORDS: Readonly<Record<UserErrorKind, string>> = {
  'sign-in': 'a sign-in only you can do',
  credentials: 'credentials only you can fix',
  permissions: 'a permission only you can grant',
  spending: 'spending only you can approve',
};

/** The node above a task that takes its failures: its lead, its project's VP, Main. */
export type ErrorOwner = 'lead' | 'vp' | 'main';

export function errorOwnerOf(input: { hasLeader?: boolean; leaderOpen?: boolean; projectLead?: boolean; hasMain?: boolean; isMain?: boolean; isLead?: boolean }): ErrorOwner | null {
  // Main has no one above it but the user.
  if (input.isMain) return null;
  // A completed leader hears nothing more from its subtasks (subtask-notices.ts): the next node takes it.
  if (input.hasLeader && input.leaderOpen !== false) return 'lead';
  // A VP's own failure goes to Main, never to itself.
  if (input.projectLead && !input.isLead) return 'vp';
  if (input.hasMain) return 'main';
  return null;
}

export const ERROR_OWNER_WORDS: Readonly<Record<ErrorOwner, string>> = { lead: 'Its lead', vp: 'Its VP', main: 'Main' };

