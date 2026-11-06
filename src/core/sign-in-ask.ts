/**
 * An ask that the user sign in again, as one thing however it is worded. 2026-11-05: five tasks in
 * three teams each asked the user to run his login command, each in its own words and flags, while
 * he had signed in long before ("I set it up long ago, why do you keep asking me?"). The same-ask
 * fold compares words within one team, so none of them folded.
 *
 * A sign-in ask is recognised by its meaning (sign in / log in again, renew a login, an expired
 * login or credential) or by the user's own login command, read from config `ssh_login_hint`; it
 * never names a tool in code. Before it reaches the user it is checked against the live sign-in
 * state (readSignInState):
 *   - a Walnut sign-in letter is open (the sign-in alert, the certificate letter): the ask waits on
 *     that letter, the one place the user is asked;
 *   - a checker said sign-in works within SIGN_IN_OK_FRESH_MS (`local/sign-in-state.json`, written
 *     by whatever checks it, a plugin): the ask is not shown, and a write is refused saying so;
 *   - otherwise every task's sign-in ask folds into the first one asked, whatever team it is in.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';

/** A checker's "sign-in works" counts this long. */
export const SIGN_IN_OK_FRESH_MS = 30 * 60_000;

/** Where an outside checker writes what it found: `{ ok, checkedAt, by?, letterId? }`. */
export const SIGN_IN_STATE_FILE = 'sign-in-state.json';

const MEANING: RegExp[] = [
  /\b(?:sign|log)(?:ged)?[\s-]?(?:in|on)\s+(?:again|once more)\b/i,
  /\bre-?(?:login|log[\s-]?in|sign[\s-]?in|authenticate|auth)\b/i,
  /\b(?:renew|refresh|redo)\b[^.\n]{0,40}\b(?:login|log-?in|sign-?in|credentials?|cookie|session|certificate|cert|token)s?\b/i,
  /\b(?:login|log-?in|sign-?in|credentials?|cookie|certificate|cert|token)s?\b[^.\n]{0,30}\b(?:expired|has expired|is invalid|ran out)\b/i,
  // Chinese: "sign in again", "the login expired", "renew the login / credential".
  /\u91cd\u65b0\u767b\u5f55|\u91cd\u65b0\u767b\u5165|\u767b\u5f55(?:\u5df2)?(?:\u8fc7\u671f|\u5931\u6548)|\u7eed\u671f(?:\u767b\u5f55|\u51ed\u636e|\u8bc1\u4e66)/u,
];

/** Words of a login hint that are not the command itself. */
const HINT_FRAME = new Set([
  'run', 'the', 'your', 'my', 'on', 'this', 'that', 'mac', 'machine', 'host', 'box', 'laptop', 'computer', 'in', 'a', 'an',
  'terminal', 'shell', 'then', 'and', 'again', 'to', 'renew', 'refresh', 'login', 'log', 'sign', 'credentials', 'credential',
  'command', 'please', 'with', 'from', 'here', 'there', 'it', 'or',
]);

/** The command words of the user's login hint ("run <command> -o on this Mac" gives its command). */
export function loginCommandWords(hint: string | undefined | null): string[] {
  const words = (hint ?? '').toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => /^[a-z][a-z0-9_.-]{2,}$/.test(w) && !HINT_FRAME.has(w));
  return [...new Set(words)].slice(0, 4);
}

/** Whether `text` asks the user to sign in again. `loginWords`: loginCommandWords of the user's hint. */
export function isSignInAsk(text: string | undefined | null, loginWords: readonly string[] = []): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (MEANING.some((re) => re.test(t))) return true;
  const lower = t.toLowerCase();
  return loginWords.some((w) => new RegExp(`(^|[^a-z0-9_.-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`).test(lower));
}

/** What Walnut knows of the user's sign-in now. */
export interface SignInState {
  /** A Walnut letter asks the user to sign in now (its id), or a checker found it broken. */
  broken?: { letterId?: string; by: string };
  /** A checker found it working at `at` (ISO), within SIGN_IN_OK_FRESH_MS. */
  ok?: { at: string; by?: string };
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); } catch { return null; }
}

/** The live sign-in state: Walnut's own open sign-in letters first, then an outside checker's word. */
export async function readSignInState(nowMs = Date.now(), dir = path.join(WALNUT_HOME, 'local')): Promise<SignInState> {
  const auth = await readJson(path.join(dir, 'host-auth-alert.json')) as { episodes?: Array<{ key?: string; letterId?: string; joined?: boolean }> } | null;
  const login = auth?.episodes?.find((e) => e.key === 'login' && e.letterId);
  if (login?.letterId) return { broken: { letterId: login.letterId, by: 'the sign-in letter' } };
  const cert = await readJson(path.join(dir, 'ssh-cert-expiry-alert.json')) as { episode?: { letterId?: string; expiredTold?: boolean } | null } | null;
  if (cert?.episode?.letterId && cert.episode.expiredTold) return { broken: { letterId: cert.episode.letterId, by: 'the certificate letter' } };
  const said = await readJson(path.join(dir, SIGN_IN_STATE_FILE)) as { ok?: unknown; checkedAt?: unknown; by?: unknown; letterId?: unknown } | null;
  const at = typeof said?.checkedAt === 'string' ? Date.parse(said.checkedAt) : NaN;
  if (!said || !Number.isFinite(at)) return {};
  const by = typeof said.by === 'string' ? said.by.slice(0, 80) : undefined;
  if (said.ok === false) return { broken: { ...(typeof said.letterId === 'string' ? { letterId: said.letterId } : {}), by: by ?? 'the sign-in check' } };
  if (said.ok === true && nowMs - at <= SIGN_IN_OK_FRESH_MS && at <= nowMs + 60_000) return { ok: { at: new Date(at).toISOString(), ...(by ? { by } : {}) } };
  return {};
}

/** The time a check ran, as a status line prints it (UTC, to the minute). */
export function checkedWords(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

/** Its wait in words while sign-in is known: the open letter, or that it works. */
export function signInWaitWords(state: SignInState): string | null {
  if (state.broken?.letterId) return `the user's sign-in, asked once in ${state.broken.by} (${state.broken.letterId}) in their inbox`;
  if (state.ok) return `its next step: sign-in works (checked ${checkedWords(state.ok.at)}${state.ok.by ? ` by ${state.ok.by}` : ''}), so the user is not asked`;
  return null;
}

/** Why a sign-in ask is not put on the user now, for a refused write, or null to let it through. */
export function signInRefusal(state: SignInState): string | null {
  if (state.broken?.letterId) {
    return `Not put on the user: ${state.broken.by} (${state.broken.letterId}) already asks them to sign in, the one place they are asked. `
      + 'Do not ask again in your own words: wait for it (the hosts come back by themselves once they sign in), or name that letter.';
  }
  if (state.ok) {
    return `Not put on the user: sign-in works (checked ${checkedWords(state.ok.at)}${state.ok.by ? ` by ${state.ok.by}` : ''}). `
      + 'Retry your step; if it still fails, the cause is something else: report what failed, not a sign-in ask.';
  }
  return null;
}
