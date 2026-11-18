/**
 * Host aliases a daemon confirmed are one daemon, kept in each alias's host profile
 * (`sameDaemon`), so a server that just started still pushes one set for all of them
 * (daemon-connection.ts sameDaemonHosts). The daemon keeps ONE trigger set per Walnut:
 * without this, the first link back after a restart pushed its own alias's set alone, and the
 * other alias's triggers stayed disarmed for as long as its link stayed down.
 *
 * A pair is written only from the daemon's own word (both links' hellos named one process),
 * never from a hostname or an address. Each side is recorded with what a dial of its alias
 * reaches (linkIdentityOf: the network key, or the user, host and port ssh resolves); one that
 * now resolves anywhere else, cannot be resolved, or has no row, voids the pair. A pair whose two
 * aliases are both up on different daemon processes is dropped (forgetSameDaemon).
 */
import { readHostProfile, updateHostProfile } from './host-profile.js';
import type { SshTarget } from '../../providers/session-io.js';
import type { Config } from '../types.js';

type HostRow = { hostname?: unknown; user?: unknown; port?: unknown; transport?: unknown; endpoint?: unknown } | undefined;

type SshResolver = (name: string) => Promise<{ hostname: string; port: number; user: string } | null>;

/** `ssh -G`, as a dial of that name resolves it (~/.ssh/config applied); never the real ~/.ssh under a test runner. */
const realResolver: SshResolver = async (name) => {
  const { realSshReachAllowed } = await import('../../lib/real-ssh-guard.js');
  if (!realSshReachAllowed()) return null;
  return (await import('./ssh-resolve.js')).resolveSshName(name);
};
let resolveSsh: SshResolver = realResolver;

/** Tests: stand in for `ssh -G` (null restores it). */
export function __setSshResolverForTest(fn: SshResolver | null): void {
  resolveSsh = fn ?? realResolver;
}

/**
 * What an alias's row connects to now, or null when that cannot be told (no row, a name ssh does
 * not resolve). A network row is its machine's key; an SSH row is the user, host and port a dial
 * of it uses, with ~/.ssh/config applied, so a HostName changed there voids a pair as a changed
 * row does.
 */
export async function linkIdentityOf(alias: string, row: HostRow): Promise<string | null> {
  if (alias === '__local__') return 'local';
  if (!row) return null;
  try {
    // Loaded when asked: a static import put link.ts into daemon-connection's own import graph, and
    // tests that mock daemon-connection then reached a real dial (list-dirs-incomplete, list-dirs-no-dial).
    const { linkTarget } = await import('./link.js');
    return await targetIdentityOf(alias, linkTarget(alias, { hosts: { [alias]: row } } as never));
  } catch { return null; }
}

/** The connection's actual target, resolved with the same rules as its config row. */
export async function targetIdentityOf(alias: string, target: SshTarget | null): Promise<string | null> {
  if (alias === '__local__') return 'local';
  if (!target) return null;
  if (target.via === 'net') return target.endpoint ? `net:${target.endpoint.toLowerCase()}` : null;
  const resolved = await resolveSsh(target.sshAlias ?? target.hostname).catch(() => null);
  if (!resolved) return null;
  return JSON.stringify(['ssh', target.user || resolved.user, resolved.hostname.toLowerCase(), String(target.port || resolved.port)]);
}

/** The configured rows now; null when config.yaml could not be read (then nothing is joined from a record). */
async function rowsNow(): Promise<Record<string, HostRow> | null> {
  const { getConfig, isFallbackConfig } = await import('../config-manager.js');
  const config = await getConfig();
  if (isFallbackConfig(config)) return null;
  return (config.hosts ?? {}) as Record<string, HostRow>;
}

/** The row's current identity, also used to snapshot an explicitly routed direct connection. */
export async function configuredIdentityOf(host: string): Promise<string | null> {
  const rows = await rowsNow();
  return rows ? linkIdentityOf(host, rows[host]) : null;
}

/**
 * The aliases recorded as reaching `host`'s daemon whose rows, and `host`'s own, still connect where they did.
 * `config`: check against these rows instead of config.yaml's (a caller that already holds the config).
 */
export async function recordedSameDaemon(host: string, config?: Pick<Config, 'hosts'>): Promise<string[]> {
  const rows = config ? ((config.hosts ?? {}) as Record<string, HostRow>) : await rowsNow();
  const mine = rows && await linkIdentityOf(host, rows[host]);
  if (!rows || !mine) return [];
  const pairs = (await readHostProfile(host)).sameDaemon ?? {};
  const out: string[] = [];
  for (const [other, pair] of Object.entries(pairs)) {
    if (other !== host && pair?.self === mine && pair.other === await linkIdentityOf(other, rows[other])) out.push(other);
  }
  return out;
}

/** Pairs this server wrote or read as written, so a push does not rewrite the profile each time. */
const written = new Set<string>();

/** Record that `others` reach the same daemon process as `host` (its hello and theirs said so), in both profiles. */
export async function rememberSameDaemon(host: string, others: readonly string[], dialled: ReadonlyMap<string, string | null>): Promise<void> {
  const rows = await rowsNow();
  const mine = rows && await linkIdentityOf(host, rows[host]);
  if (!rows || !mine || dialled.get(host) !== mine) return;
  for (const other of others) {
    const theirs = await linkIdentityOf(other, rows[other]);
    if (!theirs || other === host || dialled.get(other) !== theirs) continue;
    for (const [a, self, b, peer] of [[host, mine, other, theirs], [other, theirs, host, mine]] as const) {
      const key = JSON.stringify([a, self, b, peer]);
      if (written.has(key)) continue;
      const current = (await readHostProfile(a)).sameDaemon?.[b];
      if (current?.self !== self || current.other !== peer) {
        await updateHostProfile(a, (p) => { p.sameDaemon = { ...(p.sameDaemon ?? {}), [b]: { self, other: peer, at: new Date().toISOString() } }; });
      }
      written.add(key);
    }
  }
}

/** The two are up on different daemon processes: the pair goes from both profiles. */
export async function forgetSameDaemon(host: string, other: string): Promise<void> {
  // Rare (two daemons where one was seen): the next confirmed pair is checked against the file again.
  written.clear();
  for (const [a, b] of [[host, other], [other, host]]) {
    if (!(await readHostProfile(a)).sameDaemon?.[b]) continue;
    await updateHostProfile(a, (p) => {
      const { [b]: _gone, ...rest } = p.sameDaemon ?? {};
      p.sameDaemon = rest;
    });
  }
}

/** Tests: forget what this server wrote. */
export function _resetSameDaemonRecordForTest(): void {
  written.clear();
}
