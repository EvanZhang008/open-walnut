/**
 * First-run setup's "Add your other machines" step (FirstRunDialog.tsx), pure so its
 * rules are tested without a DOM (tests/web/first-run-model.test.ts).
 *
 * The rows are the SSH hosts in config.hosts: the ones Walnut found in ~/.ssh/config
 * (core/hosts/found-hosts.ts) and any added before. A found host still waiting for
 * the person's yes gets Add; the rest show their live state.
 *
 * A failure the person must fix outside Walnut (a host that asks for a password, a
 * key not loaded) is walked through in place with the exact commands, never as a raw
 * error (`walkthroughOf`); any other failure reads as the host status words every
 * other surface uses (hostProblemOf, the server's hint).
 */
import type { Config } from '@open-walnut/core';
import type { HostStatus } from '@/api/hosts';
import { hostConnectedWords, hostProblemOf, isConnectingPhaseWire } from '@open-walnut/host-problem';

type HostDefs = NonNullable<Config['hosts']>;

export interface FirstRunHostRow {
  alias: string;
  /** What the person calls it: its label, else the alias. */
  name: string;
  /** "sam@10.0.0.9:2222": user, hostname and port as ssh would dial them. */
  address: string;
  /** Still waiting for the person's yes (asked, or Not now on Settings). */
  waits: boolean;
  port?: number;
}

/** A row of config.hosts reached over SSH (a host network machine or the cloud box is not one). */
function isSshHost(def: HostDefs[string]): boolean {
  const transport = (def as { transport?: unknown }).transport;
  return (transport === undefined || transport === 'ssh') && typeof def.hostname === 'string' && def.hostname.trim() !== '';
}

export function addressOf(def: Pick<HostDefs[string], 'hostname' | 'user' | 'port'>): string {
  const user = typeof def.user === 'string' && def.user.trim() ? `${def.user.trim()}@` : '';
  const port = typeof def.port === 'number' && def.port !== 22 ? `:${def.port}` : '';
  return `${user}${def.hostname}${port}`;
}

/**
 * The hosts the step lists, in the config's order (the order of ~/.ssh/config), waiting and
 * added alike, so a reload shows each host where it was (2026-11-11 review: added hosts moved
 * to the bottom, out of sight). A host the person turned off by hand is left out: it was added
 * and turned off on purpose.
 */
export function firstRunHostRows(hosts: Config['hosts'] | undefined): FirstRunHostRow[] {
  const rows: FirstRunHostRow[] = [];
  for (const [alias, def] of Object.entries(hosts ?? {})) {
    if (!def || !isSshHost(def)) continue;
    const waits = def.discovered === true && (def.connect === 'ask' || def.connect === 'not_now');
    if (!waits && def.enabled === false) continue;
    const label = typeof def.label === 'string' && def.label.trim() ? def.label.trim() : alias;
    rows.push({ alias, name: label, address: addressOf(def), waits, ...(typeof def.port === 'number' ? { port: def.port } : {}) });
  }
  return rows;
}

/** One step of a walkthrough: a sentence, and the command it asks for (with Copy). */
export interface WalkStep { text: string; command?: string }
/** `headline` replaces the failure's: these are a one-time setup, not an error. */
export interface Walkthrough { headline: string; lead: string; steps: WalkStep[] }

/** The words a walkthrough points at: the button that tries again, and where a join link is made. */
export interface WalkWords { retry: string; join: string }
export const FIRST_RUN_WORDS: WalkWords = { retry: 'Try again', join: 'use Settings › Remote Hosts › Add host › Join a machine with a link' };
export const REMOTE_HOSTS_WORDS: WalkWords = { retry: 'Retry SSH', join: 'press Join with a link' };

/** The sign-in methods ssh said the host offers ("Permission denied (publickey,password)"). */
export function offeredMethods(error: string | undefined): string[] {
  const m = /permission denied \(([a-z0-9@.,-]+)\)/i.exec(error ?? '');
  return m ? m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

/** The key ssh signs in to a host with (GET /api/hosts/:host/ssh-key), when Walnut could read it. */
export interface SshKey { path: string; exists: boolean }

/** A path as a shell word (a space or quote in it is quoted). */
export function shellWord(p: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(p)) return p;
  const home = p.startsWith('~/') ? '~/' : '';
  return `${home}'${p.slice(home.length).replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_KEY = '~/.ssh/id_ed25519';

/**
 * The in-place walkthrough for a failure, or null when the server's own words cover it. The
 * person must fix a sign-in outside Walnut (a host that asks for a password, a key not loaded),
 * so those name the exact commands, with the key ssh really offers that host (`key`: its
 * IdentityFile, else the default); a host that does not answer gets plain words and Try again.
 * `alias` is what they type: ssh reads it from ~/.ssh/config, where Walnut found it.
 */
export function walkthroughOf(
  kind: string | undefined, alias: string, name: string, error?: string, key?: SshKey | null, port?: number,
  words: WalkWords = FIRST_RUN_WORDS,
): Walkthrough | null {
  const retry = words.retry;
  const keyPath = key?.path ?? DEFAULT_KEY;
  const keyWord = shellWord(keyPath);
  const isDefault = keyPath === DEFAULT_KEY;
  const makeKey: WalkStep | null = key?.exists
    ? null
    : { text: isDefault ? 'If you have no SSH key yet, make one (press Enter at each question):' : `Make the key ${name} uses (press Enter at each question):`, command: isDefault ? 'ssh-keygen -t ed25519' : `ssh-keygen -t ed25519 -f ${keyWord}` };
  if (kind === 'agent_missing') {
    return {
      headline: `Load your SSH key to add ${name}`,
      lead: `Your SSH key for ${name} is not loaded, so Walnut cannot sign in.`,
      steps: [
        { text: 'Load it in Terminal (it asks for the key\'s passphrase if it has one):', command: key ? `ssh-add ${keyWord}` : 'ssh-add' },
        { text: `Then press ${retry}.` },
      ],
    };
  }
  if (kind === 'auth') {
    const methods = offeredMethods(error);
    const asksPassword = methods.length === 0 || methods.includes('password') || methods.includes('keyboard-interactive');
    if (asksPassword) {
      return {
        headline: `${name} needs a one-time setup`,
        lead: `${name} asks for a password. Walnut signs in with an SSH key instead; set one up once in Terminal:`,
        steps: [
          ...(makeKey ? [makeKey] : []),
          { text: `Copy your key to ${name} (it asks for the password this one last time):`, command: isDefault && !key ? `ssh-copy-id ${alias}` : `ssh-copy-id -i ${keyWord} ${alias}` },
          { text: `Then press ${retry}.` },
        ],
      };
    }
    return {
      headline: `${name} needs your SSH key`,
      lead: `${name} did not accept your SSH key, and it takes no password.`,
      steps: [
        ...(makeKey ? [makeKey] : []),
        { text: 'Show your public key:', command: `cat ${shellWord(`${keyPath}.pub`)}` },
        { text: `Add that line to ~/.ssh/authorized_keys on ${name}, or ask whoever runs it to.` },
        { text: `Check that this logs in with no password, then press ${retry}:`, command: `ssh ${alias}` },
      ],
    };
  }
  // A host that does not answer: what to check, in plain words (the ssh output stays behind its toggle).
  if (kind === 'timeout' || kind === 'unreachable') {
    return { headline: `${name} did not answer`, lead: `Check that ${name} is on and that this computer can reach it (Wi-Fi, VPN), then press ${retry}.`, steps: [] };
  }
  if (kind === 'refused') {
    return { headline: `Nothing answers SSH on ${name}`, lead: `${name} is reachable, but no SSH server listens on port ${port ?? 22}. Turn on its SSH server (on a Mac: System Settings › General › Sharing › Remote Login), then press ${retry}.`, steps: [] };
  }
  if (kind === 'not_linux') {
    return { headline: `${name} is not a Linux machine`, lead: `Walnut adds machines from your SSH config when they run Linux. To add it, ${words.join}, and run its one command on ${name}.`, steps: [] };
  }
  if (kind === 'dns') {
    return { headline: `This computer cannot find ${name}`, lead: `Its name does not resolve here. Check the HostName in ~/.ssh/config, or connect to the network it lives on (VPN), then press ${retry}.`, steps: [] };
  }
  return null;
}

/** What an added host's row shows now. */
export type AddedRowState =
  | { type: 'connecting'; words: string }
  | { type: 'connected'; words: string }
  | { type: 'off'; words: string }
  | { type: 'failed'; headline: string; hint: string; summary: string; kind: string; walkthrough: Walkthrough | null; retryAt?: number };

export function addedRowState(row: FirstRunHostRow, status: HostStatus | undefined, serverNow: number, key?: SshKey | null): AddedRowState {
  if (!status) return { type: 'connecting', words: 'Connecting…' };
  if (status.connected) return { type: 'connected', words: hostConnectedWords(status, serverNow) };
  const problem = hostProblemOf(status);
  if (problem?.type === 'off') return { type: 'off', words: 'Added. This test server does not connect to remote hosts.' };
  if (problem?.type === 'connect') {
    return {
      type: 'failed', headline: problem.headline, hint: problem.hint, summary: problem.summary, kind: problem.kind,
      walkthrough: walkthroughOf(problem.kind, row.alias, row.name, problem.summary, key, row.port),
      ...(problem.retryAt !== undefined ? { retryAt: problem.retryAt } : {}),
    };
  }
  // Coming back after a failure it already said: the same words as a failure, so the fix stays on screen.
  if (problem?.type === 'reconnecting' && problem.kind && problem.headline) {
    return {
      type: 'failed', headline: problem.headline, hint: problem.hint ?? '', summary: status.lastError ?? '', kind: problem.kind,
      walkthrough: walkthroughOf(problem.kind, row.alias, row.name, status.lastError, key, row.port),
    };
  }
  if (isConnectingPhaseWire(status.phase) || status.phase === 'queued' || status.phase === 'reconnecting') {
    return { type: 'connecting', words: status.phaseLabel?.trim() || 'Connecting…' };
  }
  return { type: 'connecting', words: 'Connecting…' };
}
