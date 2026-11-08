/**
 * Settings > Remote Hosts: the words and rules of the one list of machines (RemoteHostsSection.tsx
 * and HostRow.tsx), pure so each rule has a unit test (tests/web/host-row-model.test.ts): the
 * summary line and the network map, both read from what each row says (host-list-store.ts), the
 * "need a look" stepper, a live host's state line, the one action a row offers, and a new SSH
 * host's alias.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { isLive, problemsOf } from './host-fleet-dashboard-model';
import { pct, usd } from './host-fleet-model';
import type { HostEntry } from './remote-hosts-model';

/**
 * What one row of the list says about its machine, for the summary line, the "need a look"
 * count and the network map: every surface reads the same rows, so none disagrees with the list
 * (2026-11-04 review: the map drew a host green that its row said was Off, and the summary did
 * not move when a host was turned on, added or removed).
 */
export interface RowReport {
  key: string;
  host: string;
  name: string;
  /** A machine of the fleet (not a draft, not a found host still waiting for a yes). */
  counted: boolean;
  /** Found in ~/.ssh/config and waiting for a yes: a row of the list, not a machine of the fleet yet. */
  found?: boolean;
  online: boolean;
  /** Switched off here: Walnut does not connect to it. */
  off: boolean;
  needsLook: boolean;
  /** Up, but its link keeps dropping (FleetHost connection.unstable). */
  unstable?: boolean;
  local: boolean;
  /** How this Mac reaches it. */
  via: 'local' | 'ssh' | 'net' | 'bridge';
  rttMs: number | null;
  sessions: number | null;
  spendUsd: number | null;
  /** A few words under its name on the map (its system). */
  sub: string;
  /** Its Walnut holds the phone tunnel. */
  phone?: boolean;
}

export interface ListSummary {
  /** Every row the list shows that is a host (a draft not saved yet is not). */
  hosts: number;
  online: number;
  /** On here and not connected (also while it connects). */
  down: number;
  off: number;
  /** Found in ~/.ssh/config, waiting for a yes. */
  found: number;
  sessions: number | null;
  spendUsd: number | null;
  needs: number;
}

/**
 * The fleet as its rows say it, every row in exactly one count, so the counts add up to the rows
 * shown (2026-11-05 review: "2 of 4 online, 1 off" sat above 6 rows). A host switched off is not
 * online and not "not connected", and never needs a look (it was turned off on purpose).
 */
export function listSummary(rows: RowReport[]): ListSummary {
  let sessions: number | null = null;
  let spendUsd: number | null = null;
  const fleet = rows.filter((r) => r.counted);
  for (const r of fleet) {
    if (r.sessions !== null && !r.off) sessions = (sessions ?? 0) + r.sessions;
    if (r.spendUsd !== null) spendUsd = (spendUsd ?? 0) + r.spendUsd;
  }
  const found = rows.filter((r) => !r.counted && r.found).length;
  return {
    hosts: fleet.length + found,
    online: fleet.filter((r) => !r.off && r.online).length,
    down: fleet.filter((r) => !r.off && !r.online).length,
    off: fleet.filter((r) => r.off).length,
    found,
    sessions,
    spendUsd,
    needs: fleet.filter((r) => r.needsLook && !r.off).length,
  };
}

/** The words of the summary line under the header, in order; a part not known yet, or none, is left out. */
export interface SummaryWords {
  hosts: string;
  online: string;
  down: string | null;
  off: string | null;
  found: string | null;
  sessions: string | null;
  spend: string | null;
}

export function summaryWords(s: ListSummary): SummaryWords {
  return {
    hosts: `${s.hosts} ${s.hosts === 1 ? 'host' : 'hosts'}`,
    online: `${s.online} online`,
    down: s.down ? `${s.down} not connected` : null,
    off: s.off ? `${s.off} off` : null,
    found: s.found ? `${s.found} found in ~/.ssh/config` : null,
    sessions: s.sessions === null ? null : `${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'} open`,
    spend: s.spendUsd === null ? null : `${usd(s.spendUsd)} in 30 days`,
  };
}

/**
 * The header's one count: "3 need a look", then, once pressed, which of them is shown ("1 of 3
 * need a look"). `at` is the index shown last (null before the first press).
 */
export function needsWords(count: number, at: number | null): string {
  if (at === null || at >= count) return `${count} ${count === 1 ? 'needs' : 'need'} a look`;
  return `${at + 1} of ${count} ${count === 1 ? 'needs' : 'need'} a look`;
}

/** The next host a press on the count shows: each press the next one, then back to the first. */
export function nextLook(count: number, at: number | null): number {
  if (count <= 0) return 0;
  return at === null || at + 1 >= count ? 0 : at + 1;
}

/** How a map line reads: the same state the row has (Off, Not connected, or the way and its latency). */
export function mapLinkLabel(r: Pick<RowReport, 'off' | 'online' | 'via' | 'rttMs' | 'local'>): string {
  if (r.local) return 'This Mac';
  if (r.off) return 'Off';
  if (!r.online) return r.via === 'bridge' ? 'Not connected in' : 'Not connected';
  const way = r.via === 'bridge' ? 'Through your cloud companion' : r.via === 'net' ? 'Host network' : 'SSH tunnel';
  return typeof r.rttMs === 'number' && r.rttMs > 0 ? `${way}, ${Math.round(r.rttMs)} ms` : way;
}

/** A host the summary counts as needing a look: not connected, or a problem on its reading. */
export function needsLook(h: FleetHost, now: number): boolean {
  return !isLive(h) || problemsOf(h, now).some((p) => p.tone === 'warn' || p.tone === 'bad');
}

/** A live host's state line: "Online, 12% CPU, 2 sessions" (what is not known is left out). */
export function liveLine(card: FleetHost | undefined, online = 'Online'): string {
  if (!card) return online;
  // A link that keeps dropping is up now, but not to be trusted (host-problem.ts hostFlapOf).
  const flap = card.connection?.unstable;
  const parts = [flap ? `Unstable: dropped ${flap.drops} times in ${flap.windowMin} min` : online];
  const cpu = card.now?.cpuUtil;
  if (typeof cpu === 'number') parts.push(`${pct(cpu)} CPU`);
  const n = card.sessions.running;
  if (typeof n === 'number') parts.push(`${n} ${n === 1 ? 'session' : 'sessions'}`);
  return parts.join(', ');
}

/**
 * The connect action of a host not connected: Retry after a failed try, else Connect now. An SSH
 * host's retry says it is SSH (2026-11-04 review: the row's Retry and Walnut on that host's Retry
 * meant two different things).
 */
export function connectAction(failed: boolean, busy: boolean, via: 'ssh' | 'net' = 'ssh'): { label: string; reserve: string[] } {
  const retry = via === 'ssh' ? 'Retry SSH' : 'Retry';
  const label = failed ? (busy ? 'Retrying...' : retry) : busy ? 'Connecting...' : 'Connect now';
  return { label, reserve: failed ? [retry, 'Retrying...'] : ['Connect now', 'Connecting...'] };
}

/** A hostname as typed: "sam@build7.example.com:2222" names the host, its user and its port. */
export interface HostInput { host: string; user?: string; port?: number }

const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
const USER = /^[a-z0-9._-]+$/i;

/**
 * What a Hostname field holds, or why it is no host (2026-11-05 review: "not a host!!" saved as
 * a host named not-a-host, with a green Saved). A name (letters, digits, dots, dashes; ssh
 * config names may hold "_"), an IPv4 or IPv6 address, each with an optional "user@" before it
 * and ":port" after it (an IPv6 address takes a port only in brackets: [::1]:2222).
 */
export function parseHostInput(text: string): { ok: true; value: HostInput } | { ok: false; problem: string } {
  const t = text.trim();
  if (!t) return { ok: false, problem: 'Type the host Walnut reaches with ssh, like build7.example.com.' };
  if (/\s/.test(t)) return { ok: false, problem: 'A hostname has no spaces. Type one like build7.example.com.' };
  let rest = t;
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!user || !USER.test(user)) return { ok: false, problem: 'The part before "@" is the user: letters, digits, dots, dashes only.' };
  }
  let port: number | undefined;
  let portText: string | undefined;
  const bracket = /^\[([^\]]*)\](?::(\d*))?$/.exec(rest);
  if (bracket) {
    rest = bracket[1];
    portText = bracket[2];
    if (!IPV6.test(rest)) return { ok: false, problem: 'Brackets hold an IPv6 address, like [2001:db8::1].' };
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const colon = rest.indexOf(':');
    portText = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (portText !== undefined) {
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(port >= 1 && port <= 65535)) return { ok: false, problem: 'The part after ":" is the port: a number from 1 to 65535.' };
  }
  const host = rest.replace(/\.$/, '');
  if (!host) return { ok: false, problem: 'Type the host after the "@", like sam@build7.example.com.' };
  const v4 = IPV4.exec(host);
  const valid = v4 ? v4.slice(1).every((n) => Number(n) <= 255)
    : host.includes(':') ? IPV6.test(host)
      : host.length <= 253 && host.split('.').every((label) => DNS_LABEL.test(label));
  if (!valid) {
    const bad = [...host].find((c) => !/[a-z0-9._:-]/i.test(c));
    return { ok: false, problem: bad
      ? `A hostname holds letters, digits, dots and dashes only ("${bad}" is not one). Type one like build7.example.com.`
      : 'That is no hostname: each part between dots starts and ends with a letter or digit, like build7.example.com.' };
  }
  return { ok: true, value: { host, ...(user ? { user } : {}), ...(port !== undefined ? { port } : {}) } };
}

/** Why a Hostname field is no host, or null (an empty field is not refused here: its row says what it waits for). */
export function hostnameProblem(text: string): string | null {
  if (!text.trim()) return null;
  const r = parseHostInput(text);
  return r.ok ? null : r.problem;
}

const PLACEHOLDERS = ['buildbox', 'workstation', 'gpu-server', 'lab-pc', 'server-2'];

/** An alias for the placeholder that no host has (the page would refuse one that is taken). */
export function aliasPlaceholder(taken: ReadonlySet<string>): string {
  return PLACEHOLDERS.find((p) => !taken.has(p)) ?? `host-${taken.size + 1}`;
}

/**
 * The alias a new SSH host gets from its hostname until the person types one (2026-11-04 review:
 * a hostname with no alias was dropped when the pane closed): the first DNS label, lower case, any
 * character an alias may not hold made a dash, and a number after it when another host has it.
 * `build7.example.com` gives `build7`; an IP address keeps all of it (`10-0-0-9`).
 */
export function aliasFromHostname(hostname: string, taken: ReadonlySet<string> = new Set()): string {
  // "sam@build7.example.com:2222" names the host build7.example.com.
  const host = hostname.trim().replace(/^[^@]*@/, '').replace(/:\d*$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return '';
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  const head = ip ? host : host.split('.')[0];
  const base = head.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return '';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Where a second "Add an SSH host" puts the focus in the draft already open: its first empty field. */
export function firstEmptyField(h: Pick<HostEntry, 'hostname' | 'alias' | 'user'>, aliasRefused = false): 'hostname' | 'alias' | 'user' {
  if (!h.hostname.trim()) return 'hostname';
  if (!h.alias.trim() || aliasRefused) return 'alias';
  if (!h.user.trim()) return 'user';
  return 'hostname';
}

/** A new row nobody typed in yet: Cancel and Escape take it away with no confirm. */
export function untouchedDraft(h: HostEntry): boolean {
  return h.savedAlias === undefined && !h.alias && !h.hostname && !h.user && h.port === undefined && !h.label && !h.shell_setup && h.keep === undefined && h.excludeText === undefined;
}
