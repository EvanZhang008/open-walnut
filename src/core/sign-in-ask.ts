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
 *
 * The checker's file (SignInStateFile) is also how an outside reminder owns telling the user about
 * sign-in: written fresh with `owns: true`, Walnut's warning ahead of a certificate's expiry steps
 * aside (readSignInOwner); once sign-in is broken, Walnut's letter steps aside only for the owner's
 * own open letter (readSignInOwnerLetter); stale or removed, they speak again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';

/** A checker's word counts this long. */
export const SIGN_IN_OK_FRESH_MS = 30 * 60_000;

/** Where an outside checker writes what it found (SignInStateFile), under `local/`. */
export const SIGN_IN_STATE_FILE = 'sign-in-state.json';

/**
 * What an outside checker writes, whole, every few minutes while it runs. A word older than
 * SIGN_IN_OK_FRESH_MS, dated more than a minute ahead, or without `ok` and `checkedAt`, counts for
 * nothing; the checker removes the file when it is turned off.
 */
export interface SignInStateFile {
  /** Sign-in works now (true) or fails now (false). */
  ok: boolean;
  /** When it checked, ISO 8601. */
  checkedAt: string;
  /** Who checked, a few words the user reads ("the sign-in plugin"); at most 80 characters. */
  by?: string;
  /** With ok false: its own letter asking the user to sign in; every sign-in ask waits on it. */
  letterId?: string;
  /** It tells the user about sign-in itself: Walnut's certificate and sign-in failure letters step aside. */
  owns?: boolean;
}

const MEANING: RegExp[] = [
  /\b(?:sign|log)(?:ged)?[\s-]?(?:in|on)\s+(?:again|once more)\b/i,
  /\bre-?(?:login|log[\s-]?in|sign[\s-]?in|authenticate|auth)\b/i,
  /\b(?:renew|refresh|redo)\b[^.\n]{0,40}\b(?:login|log-?in|sign-?in|credentials?|cookie|session|certificate|cert|token)s?\b/i,
  /\b(?:login|log-?in|sign-?in|credentials?|cookie|certificate|cert|token)s?\b[^.\n]{0,30}\b(?:expired|has expired|is invalid|ran out)\b/i,
  // Chinese: "sign in again", "the login expired", "renew the login / credential".
  /\u91cd\u65b0\u767b\u5f55|\u91cd\u65b0\u767b\u5165|\u767b\u5f55(?:\u5df2)?(?:\u8fc7\u671f|\u5931\u6548)|\u7eed\u671f(?:\u767b\u5f55|\u51ed\u636e|\u8bc1\u4e66)/u,
];

/**
 * What makes a sign-in this machine's: a host, a box, SSH, a certificate, a dev or build machine
 * (a sign-in to a bank or a website is the user's own, never folded with it). Chinese: host,
 * machine, server, certificate.
 */
const MACHINE = /\b(?:hosts?|box(?:es)?|machines?|servers?|ssh|certificates?|certs?|mac|laptop|dev|devbox|build|cloud|vm|terminal|daemon)\b|\u4e3b\u673a|\u673a\u5668|\u670d\u52a1\u5668|\u8bc1\u4e66/iu;

/** Words of a login hint that are not the command itself. */
const HINT_FRAME = new Set([
  'run', 'the', 'your', 'my', 'on', 'this', 'that', 'mac', 'machine', 'host', 'box', 'laptop', 'computer', 'in', 'a', 'an',
  'terminal', 'shell', 'then', 'and', 'again', 'to', 'renew', 'refresh', 'login', 'log', 'sign', 'credentials', 'credential',
  'command', 'please', 'with', 'from', 'here', 'there', 'it', 'or', 'type', 'enter', 'open', 'use',
]);

/**
 * The command of the user's login hint: its first word that names one ("run <command> -o on this
 * Mac" gives <command>; an argument after it, "--profile work", is never taken for it).
 */
export function loginCommandWords(hint: string | undefined | null): string[] {
  const words = (hint ?? '').toLowerCase().replace(/`/g, ' ').split(/\s+/).filter(Boolean);
  const first = words.find((w) => /^[a-z][a-z0-9_.-]{2,}$/.test(w) && !HINT_FRAME.has(w));
  return first ? [first] : [];
}

/**
 * Whether `text` asks the user to sign this machine in again: it names the user's login command
 * (`loginWords`, loginCommandWords of the hint), or it means a sign-in and names a machine.
 */
export function isSignInAsk(text: string | undefined | null, loginWords: readonly string[] = []): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (loginWords.some((w) => new RegExp(`(^|[^a-z0-9_.-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`).test(lower))) return true;
  return MEANING.some((re) => re.test(t)) && MACHINE.test(t);
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

/** The checker's file while its word still counts, with the time it checked, or null. */
async function freshStateFile(nowMs: number, dir: string): Promise<{ said: SignInStateFile; at: number; by?: string } | null> {
  const said = await readJson(path.join(dir, SIGN_IN_STATE_FILE)) as Partial<SignInStateFile> | null;
  const at = typeof said?.checkedAt === 'string' ? Date.parse(said.checkedAt) : NaN;
  if (!said || typeof said.ok !== 'boolean' || !Number.isFinite(at) || nowMs - at > SIGN_IN_OK_FRESH_MS || at > nowMs + 60_000) return null;
  const by = typeof said.by === 'string' && said.by.trim() ? said.by.trim().slice(0, 80) : undefined;
  return { said: said as SignInStateFile, at, ...(by ? { by } : {}) };
}

/**
 * The outside reminder that owns telling the user about sign-in now (its file fresh, `owns: true`),
 * or null: then Walnut's own certificate and sign-in failure letters speak.
 */
export async function readSignInOwner(nowMs = Date.now(), dir = path.join(WALNUT_HOME, 'local')): Promise<{ by: string } | null> {
  const fresh = await freshStateFile(nowMs, dir);
  return fresh?.said.owns === true ? { by: fresh.by ?? 'the sign-in check' } : null;
}

/**
 * The outside reminder that has its OWN open letter asking the user to sign in now (its file fresh,
 * `owns: true`, `ok: false`, a `letterId` still before the user), or null. Once sign-in is broken
 * (a login failure, a certificate past its expiry) only that holds Walnut's sign-in letter back:
 * owning the reminder is not telling the user. 2026-11-10: the sign-in plugin kept `owns: true`
 * fresh, pushed a heads-up two hours before the certificate expired, and wrote `ok: false` with no
 * letter after it; Walnut stepped aside, and the inbox said nothing while every host refused the
 * sign-in for half an hour.
 */
export async function readSignInOwnerLetter(
  nowMs = Date.now(), dir = path.join(WALNUT_HOME, 'local'), isOpen: (letterId: string) => Promise<boolean> = letterOpen,
): Promise<{ by: string; letterId: string } | null> {
  const fresh = await freshStateFile(nowMs, dir);
  if (fresh?.said.owns !== true || fresh.said.ok !== false) return null;
  const letterId = typeof fresh.said.letterId === 'string' ? fresh.said.letterId.trim() : '';
  if (!letterId || !(await isOpen(letterId))) return null;
  return { by: fresh.by ?? 'the sign-in check', letterId };
}

/** Whether a letter is still before the user (not archived); a letter that cannot be read counts as open. */
async function letterOpen(id: string): Promise<boolean> {
  try {
    const { getLetter } = await import('./human-inbox/store.js');
    const letter = await getLetter(id, { deferBodies: true });
    return !!letter && !letter.archived;
  } catch { return true; }
}

/**
 * The live sign-in state: Walnut's own sign-in letters still before the user, and an outside
 * checker's word; when both speak, the newer one does (a check that works after the letter went out
 * says the user signed in).
 */
export async function readSignInState(
  nowMs = Date.now(), dir = path.join(WALNUT_HOME, 'local'), isOpen: (letterId: string) => Promise<boolean> = letterOpen,
): Promise<SignInState> {
  let broken: { letterId?: string; by: string; since: number } | null = null;
  const auth = await readJson(path.join(dir, 'host-auth-alert.json')) as { episodes?: Array<{ key?: string; letterId?: string; openedAt?: number }> } | null;
  const login = auth?.episodes?.find((e) => e.key === 'login' && e.letterId);
  if (login?.letterId && await isOpen(login.letterId)) broken = { letterId: login.letterId, by: 'the sign-in letter', since: Number(login.openedAt) || 0 };
  if (!broken) {
    const cert = await readJson(path.join(dir, 'ssh-cert-expiry-alert.json')) as { episode?: { letterId?: string; expiredTold?: boolean; expiresAt?: number } | null } | null;
    if (cert?.episode?.letterId && cert.episode.expiredTold && await isOpen(cert.episode.letterId)) {
      broken = { letterId: cert.episode.letterId, by: 'the certificate letter', since: Number(cert.episode.expiresAt) || 0 };
    }
  }
  // A stale word counts for nothing either way: a checker that stopped says nothing of now.
  const fresh = await freshStateFile(nowMs, dir);
  if (fresh?.said.ok === true && (!broken || fresh.at > broken.since)) return { ok: { at: new Date(fresh.at).toISOString(), ...(fresh.by ? { by: fresh.by } : {}) } };
  if (broken) return { broken: { ...(broken.letterId ? { letterId: broken.letterId } : {}), by: broken.by } };
  if (fresh?.said.ok === false) {
    const letterId = typeof fresh.said.letterId === 'string' && fresh.said.letterId ? fresh.said.letterId : undefined;
    return { broken: { ...(letterId ? { letterId } : {}), by: fresh.by ?? 'the sign-in check' } };
  }
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
