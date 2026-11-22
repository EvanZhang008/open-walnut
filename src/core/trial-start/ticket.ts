/**
 * How a server is started as a trial for the restore drill (docs/reference/backups.md,
 * "Restore drill"; the leader switch's trial is entered through its write permission instead,
 * src/core/leader/switch/boot.ts). A trial runs only the boot policy's trial column
 * (src/core/boot-policy.ts): HTTP, the databases and their migrations, nothing that acts.
 *
 * No environment variable alone puts a server into it, and no environment variable alone keeps a
 * drill's server out of it. Entry takes all of:
 *   - the argv flag TRIAL_START_FLAG: how THIS process was invoked, never inherited by the
 *     processes it starts (the reason IS_EPHEMERAL is argv-based, src/constants.ts);
 *   - a ticket in the home it boots on (TRIAL_TICKET_FILE), written by the drill a moment before,
 *     naming the drill's pid (this process's parent), and a nonce that the env carries
 *     (TRIAL_NONCE_ENV); the ticket is removed as it is read, so it starts one server;
 *   - a home that is a drill's restored copy (`<tmp>/walnut-restore-drill-XXXXXX/home`) and is not
 *     the user's data home (~/.open-walnut, or the one the drill names in the ticket);
 *   - the ephemeral argv flag beside it (IS_EPHEMERAL: no permit, standby or backup of its own).
 * Without the flag nothing here is read: a production server with a stray nonce in its env, or a
 * ticket in its home, boots as it always did. With the flag, any part missing or wrong refuses the
 * start (TrialStartRefused): a drill's server never boots as a normal one on a restored copy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountInfo } from '../../lib/account.js';
import { DRILL_DIR_RE, DRILL_HOME_NAME } from '../backup/restore-drill-dir.js';

export const TRIAL_START_FLAG = '--_trial-start';
/** The ephemeral identity (src/constants.ts IS_EPHEMERAL) a trial start always carries. */
const EPHEMERAL_FLAG = '--_ephemeral-child';
export const TRIAL_TICKET_FILE = path.join('local', 'trial-start.json');
export const TRIAL_NONCE_ENV = 'WALNUT_TRIAL_NONCE';
/** A ticket older than this is from a drill that is gone. */
export const TRIAL_TICKET_MAX_AGE_MS = 10 * 60_000;

/** What a trial start is for. The leader switch's trial is the other purpose of the trial column. */
export type TrialStartPurpose = 'restore-drill';

interface Ticket {
  version: 1; purpose: TrialStartPurpose; parentPid: number; nonce: string; at: string;
  /** The user's data home as the drill knows it (it may live outside ~/.open-walnut): the trial never boots on it. */
  liveHomes?: string[];
}

export interface TicketOptions { parentPid?: number; liveHomes?: readonly string[] }

export class TrialStartRefused extends Error {
  constructor(why: string) {
    super(`Walnut does not start this trial server: ${why}`);
    this.name = 'TrialStartRefused';
  }
}

/** Write the ticket for one trial server on `home`; returns the nonce its env must carry. */
export function writeTrialTicket(home: string, purpose: TrialStartPurpose, opts: TicketOptions = {}): string {
  const nonce = crypto.randomBytes(24).toString('hex');
  const file = path.join(home, TRIAL_TICKET_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const ticket: Ticket = {
    version: 1, purpose, parentPid: opts.parentPid ?? process.pid, nonce, at: new Date().toISOString(),
    ...(opts.liveHomes?.length ? { liveHomes: [...opts.liveHomes] } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(ticket), { mode: 0o600 });
  return nonce;
}

/** The user's data homes this process can name ($HOME's and the account's own). */
function productionHomes(): string[] {
  const homes = new Set([os.homedir()]);
  try { homes.add(accountInfo().homedir); } catch { /* no passwd entry: $HOME is all there is */ }
  return [...homes].map((h) => path.join(h, '.open-walnut'));
}

const insideOrAt = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

function realOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export interface TakeTicketInput {
  home: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  now?: number;
}

/**
 * The purpose of this process's trial start, or null when it was not invoked as one (no flag:
 * nothing else is looked at). Throws TrialStartRefused when invoked as one and anything does not
 * hold. Removes the ticket (and the nonce from `env`) once read, valid or not.
 */
export function takeTrialTicket(input: TakeTicketInput): TrialStartPurpose | null {
  const argv = input.argv ?? process.argv;
  if (!argv.includes(TRIAL_START_FLAG)) return null;
  // What keeps an ephemeral server off the user's witnesses, standby and backups (IS_EPHEMERAL,
  // src/constants.ts) must hold for the trial too: a trial start without it is refused.
  if (!argv.includes(EPHEMERAL_FLAG)) {
    throw new TrialStartRefused(`${TRIAL_START_FLAG} runs only with ${EPHEMERAL_FLAG}`);
  }
  const env = input.env ?? process.env;
  const nonce = env[TRIAL_NONCE_ENV];
  delete env[TRIAL_NONCE_ENV];
  const file = path.join(input.home, TRIAL_TICKET_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new TrialStartRefused(`no ticket at ${file} (only the restore drill starts a trial server)`);
  }
  try { fs.rmSync(file, { force: true }); } catch { /* the checks below still hold */ }
  let ticket: Partial<Ticket>;
  try { ticket = JSON.parse(raw) as Partial<Ticket>; } catch { throw new TrialStartRefused('its ticket is not readable'); }
  if (ticket.version !== 1 || ticket.purpose !== 'restore-drill') throw new TrialStartRefused(`its ticket names no known purpose (${String(ticket.purpose)})`);
  if (!nonce || typeof ticket.nonce !== 'string' || nonce.length !== ticket.nonce.length
    || !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(ticket.nonce))) {
    throw new TrialStartRefused(`its ticket and its ${TRIAL_NONCE_ENV} do not match`);
  }
  const ppid = input.ppid ?? process.ppid;
  if (ticket.parentPid !== ppid) throw new TrialStartRefused(`its ticket names parent ${String(ticket.parentPid)}, its parent is ${ppid}`);
  const age = (input.now ?? Date.now()) - Date.parse(String(ticket.at));
  if (!(age >= 0 && age <= TRIAL_TICKET_MAX_AGE_MS)) throw new TrialStartRefused('its ticket is stale');
  const home = realOr(input.home);
  if (path.basename(home) !== DRILL_HOME_NAME || !DRILL_DIR_RE.test(path.basename(path.dirname(home)))) {
    throw new TrialStartRefused(`${home} is not a restore drill's copy`);
  }
  const live = [...productionHomes(), ...(Array.isArray(ticket.liveHomes) ? ticket.liveHomes.filter((h): h is string => typeof h === 'string') : [])];
  if (live.some((h) => insideOrAt(home, realOr(h)) || insideOrAt(realOr(h), home))) {
    throw new TrialStartRefused(`${home} is the user's data home`);
  }
  return 'restore-drill';
}
