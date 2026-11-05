/**
 * Settings > Remote Hosts: the SSH host editor's rows and what it saves (pure, so the
 * save rules are tested without a DOM: tests/web/remote-hosts-model.test.ts).
 *
 * The rows are keyed by `_key`, never by alias: an alias is what the person types, and two
 * rows may hold the same one while they type. 2026-11-04: a new row typed as `devbox` took
 * over the saved devbox's status, and the autosave wrote it OVER that host (its hostname,
 * user and label gone). An alias another host has, or none beside a hostname, is refused
 * next to the field, and nothing saves while a row is refused (`aliasRefusals`); the save
 * itself never lets one row replace another (`entriesToHosts`). Of two rows with one alias,
 * the host saved under it keeps it (`aliasOwners`): the row read from config.yaml under that
 * alias, else a row saved under it since, else the first. The other is the one refused, so
 * renaming a host to another's alias never takes that host's status or its row.
 */
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS, companionAliasRefusal } from '@open-walnut/companion-keep';
import { normalizeKeep, splitKeepEntries, type ReplicaKeep } from './ReplicaKeepRows';

export type FoundAnswer = 'ask' | 'yes' | 'not_now';

export interface HostEntry {
  _key: number; // stable React key
  alias: string;
  hostname: string;
  user: string;
  port: number | undefined;
  label: string;
  shell_setup: string;
  enabled: boolean;
  discovered: boolean;
  /** A found host's answer to "Connect to it?" (src/core/hosts/found-hosts.ts); absent on a host added by hand. */
  connect?: FoundAnswer;
  /** Only `false` is ever written (config-only switch, no control here yet). */
  autofix?: boolean;
  /** What the host keeps a read copy of (core/host-replica.ts); undefined = everything. */
  keep?: ReplicaKeep;
  /** The "Leave out folders or notes" text as typed (a trailing comma survives a save). */
  excludeText?: string;
  /** The alias config.yaml had this row under when it was read; absent on a row added here. */
  savedAlias?: string;
  /** A new row's alias still follows its hostname (aliasFromHostname): nobody typed one. */
  aliasAuto?: boolean;
}

/** A found host Walnut does not connect to until the person says so (asked, or Not now). */
export function waitsForYes(h: Pick<HostEntry, 'discovered' | 'connect'>): boolean {
  return h.discovered && (h.connect === 'ask' || h.connect === 'not_now');
}

/**
 * For each alias two or more rows hold, the index of the row that keeps it: the row read from
 * config.yaml under it (2), else one added here and saved under it since (1, `saved` holds the
 * saved aliases), else the first. `saved` defaults to the aliases the rows were read under.
 */
export function aliasOwners(hosts: HostEntry[], saved?: ReadonlySet<string>): Map<string, number> {
  const known = saved ?? new Set(hosts.map((h) => h.savedAlias).filter((a): a is string => !!a));
  const rank = (h: HostEntry, alias: string) => (h.savedAlias === alias ? 2 : h.savedAlias === undefined && known.has(alias) ? 1 : 0);
  const out = new Map<string, number>();
  hosts.forEach((h, idx) => {
    const alias = h.alias.trim();
    if (!alias) return;
    const cur = out.get(alias);
    if (cur === undefined || rank(h, alias) > rank(hosts[cur], alias)) out.set(alias, idx);
  });
  return out;
}

/**
 * The persisted `hosts` map from the rows, dropping incomplete rows (no alias or hostname).
 * Used by the save and by the autosave fingerprint, so a half-typed host is never written.
 * A row whose alias another row keeps (`aliasOwners`) is left out: it never replaces that host.
 */
export function entriesToHosts(hosts: HostEntry[], saved?: ReadonlySet<string>): NonNullable<Config['hosts']> {
  const hostsConfig: NonNullable<Config['hosts']> = {};
  const owners = aliasOwners(hosts, saved);
  for (const [idx, h] of hosts.entries()) {
    if (!h.alias || !h.hostname || owners.get(h.alias.trim()) !== idx || Object.hasOwn(hostsConfig, h.alias)) continue;
    const keep = normalizeKeep(h.excludeText === undefined ? h.keep : { ...(h.keep ?? {}), notes_exclude: splitKeepEntries(h.excludeText) });
    hostsConfig[h.alias] = {
      hostname: h.hostname,
      user: h.user || undefined,
      port: h.port,
      label: h.label || undefined,
      shell_setup: h.shell_setup || undefined,
      enabled: h.enabled,
      discovered: h.discovered,
      ...(h.discovered && h.connect ? { connect: h.connect } : {}),
      // Kept through a save: the editor has no control for it, and dropping it
      // would silently turn a host's automatic fixes back on.
      ...(h.autofix === false ? { autofix: false } : {}),
      ...(keep ? { keep } : {}),
    };
  }
  return hostsConfig;
}

/**
 * The persisted hosts through the SAME field order entriesToHosts produces, so the baseline
 * can't differ from `current` purely by key order (which would loop: save, refresh, reorder
 * mismatch, save again).
 */
export function normalizeHosts(h: Config['hosts']): NonNullable<Config['hosts']> {
  const out: NonNullable<Config['hosts']> = {};
  for (const [alias, v] of Object.entries(h ?? {})) {
    if (v.transport === 'net') continue;
    const keep = normalizeKeep(v.keep);
    out[alias] = {
      hostname: v.hostname,
      user: v.user || undefined,
      port: v.port,
      label: v.label || undefined,
      shell_setup: v.shell_setup || undefined,
      enabled: v.enabled ?? true,
      discovered: v.discovered ?? false,
      ...(v.discovered && v.connect ? { connect: v.connect } : {}),
      ...(v.autofix === false ? { autofix: false } : {}),
      ...(keep ? { keep } : {}),
    };
  }
  return out;
}

let nextHostKey = 0;

export function emptyHost(): HostEntry {
  return { _key: nextHostKey++, alias: '', hostname: '', user: '', port: undefined, label: '', shell_setup: '', enabled: true, discovered: false };
}

/** The SSH hosts this editor writes; a machine that joined with a link has its own rows. */
export function hostsFromConfig(config: Config): HostEntry[] {
  return Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport !== 'net').map(([alias, h]) => ({
    _key: nextHostKey++,
    alias,
    savedAlias: alias,
    hostname: h.hostname,
    user: h.user ?? '',
    port: h.port,
    label: h.label ?? '',
    shell_setup: h.shell_setup ?? '',
    enabled: h.enabled ?? true,
    discovered: h.discovered ?? false,
    ...(h.discovered && h.connect ? { connect: h.connect } : {}),
    ...(h.autofix === false ? { autofix: false } : {}),
    ...(h.keep ? { keep: h.keep } : {}),
  }));
}

/** The name a row shows: its label, else its alias, else its hostname. */
export function hostName(host: HostEntry, idx: number): string {
  return host.label || host.alias || host.hostname || `Host ${idx + 1}`;
}

/**
 * Each row's refusal of its alias, by `_key`. Refused: an alias another row keeps
 * (`aliasOwners`), an alias a machine that joined with a link has (`netAliases`), no alias
 * beside a hostname, and the companion's alias for a new host. A host an older build saved
 * under the companion's alias keeps saving, and its row asks for another one.
 */
export function aliasRefusals(hosts: HostEntry[], opts: { savedUnderCompanion: boolean; netAliases?: Record<string, string>; saved?: ReadonlySet<string> }): Map<number, string> {
  const out = new Map<number, string>();
  const owners = aliasOwners(hosts, opts.saved);
  hosts.forEach((h, idx) => {
    const alias = h.alias.trim();
    const companion = companionAliasRefusal(h.alias, { saved: opts.savedUnderCompanion });
    if (companion) { out.set(h._key, companion); return; }
    if (!alias) {
      if (h.hostname.trim()) out.set(h._key, 'Give it an alias, like devbox.');
      return;
    }
    const net = opts.netAliases?.[alias];
    const owner = owners.get(alias);
    if ((owner !== undefined && owner !== idx) || net !== undefined) {
      const other = owner !== undefined && owner !== idx ? hostName(hosts[owner], owner) : net!;
      out.set(h._key, other && other !== alias ? `${alias} is already ${other}. Pick another alias.` : `${alias} is already taken. Pick another alias.`);
    }
  });
  return out;
}

/** Whether this row's refusal holds the save back: not the companion's alias on the host saved under it. */
export function refusalBlocks(h: HostEntry, refusal: string | undefined, savedUnderCompanion: boolean): boolean {
  return !!refusal && !(savedUnderCompanion && h.savedAlias === COMPANION_ALIAS && h.alias.trim() === COMPANION_ALIAS);
}

export function refusalBlocksSave(hosts: HostEntry[], refusals: Map<number, string>, savedUnderCompanion: boolean): boolean {
  return hosts.some((h) => refusalBlocks(h, refusals.get(h._key), savedUnderCompanion));
}

/**
 * A row found in ~/.ssh/config that is a machine which joined with a link shows once, as
 * that machine. Only the row read under that alias: a row typed with it stays, refused.
 */
export function hiddenAsTwin(h: HostEntry, twins: Record<string, unknown>, refusal: string | undefined): boolean {
  return !refusal && !!h.savedAlias && h.alias === h.savedAlias && !!twins[h.savedAlias];
}

/**
 * The per-host limits as numbers. The editor yields strings while a saved config yields
 * numbers; normalizing keeps the autosave fingerprint stable.
 */
export function normalizeLimits(raw: Record<string, string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'number' ? v : parseInt(v, 10) || 0;
  return out;
}

/**
 * Whether a config read puts its session limits in the boxes (useSshHostEditor). Not the echo of
 * a save this page sent, not a read that says what the last one said, and never while a value is
 * typed and not saved yet: that value saves a moment later and wins (2026-11-05: the echo of one
 * save came back after the next value was typed, put the old value back in the box, and the typed
 * one never saved). Each argument is a normalizeLimits fingerprint; `sent` lists the saves not
 * seen back yet, oldest first, and the answer's `sent` drops the echo and every save before it.
 */
export function limitsRead(read: { incoming: string; seen: string | null; shown: string; sent: readonly string[] }): { take: boolean; sent: string[] } {
  const echo = read.sent.indexOf(read.incoming);
  const sent = echo >= 0 ? read.sent.slice(echo + 1) : [...read.sent];
  if (read.seen === null) return { take: true, sent };
  return { take: echo < 0 && read.incoming !== read.seen && read.shown === read.seen, sent };
}
