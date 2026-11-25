/**
 * The shapes GET /api/host-servers answers (src/web/routes/host-servers.ts) and
 * the one sentence the "Walnut on a host" group says for each host. Pure:
 * HostServersGroup renders it, tests read it.
 */

import type { ExposeProviderInfo, ExposeStatus, StatusDot } from './cloud/browser-access-status';
import { timeAgo } from '@/utils/time';

export type HostServerPhase = 'off' | 'waiting-for-host' | 'unsupported' | 'checking' | 'installing' | 'starting' | 'running' | 'error'
  /** On by default, but the host cannot run one well now (`gate` says why). */
  | 'not-eligible';

export interface HostServerView {
  hostKey: string;
  enabled: boolean;
  phase: HostServerPhase;
  message?: string;
  since: number;
  build?: string;
  port?: number;
  /** While it runs: why it runs an older build than this computer's (Try again starts this one). */
  notice?: string;
  server?: HostServerReport | null;
  /** The server's last report, kept while it does not answer now (an older server sends none). */
  lastReport?: HostServerReport;
  /** When that report came in, on this computer's clock. */
  lastReportAt?: number;
  /** Phase `not-eligible`: the condition the host did not meet, and when it is looked at again. */
  gate?: { reason: 'no-build' | 'memory' | 'disk' | 'this-computer' | 'another-name'; checkedAt: number; recheckAt?: number };
  /** Phase `error`: when Walnut tries again by itself. */
  retryAt?: number;
  /** While the program goes up to the host: the bytes it holds so far. */
  upload?: { sent: number; total: number };
  /** It runs the host's service without a copy of your data (core/host-server/copyless.ts). */
  copyless?: boolean;
}

/** A host whose service runs without a copy of your data (experiment service_without_copy). */
export const COPYLESS_RUNNING_TEXT = 'Runs without a copy of your data: no copy kept here, no port opened, no console. Its sessions keep going while this Mac is away.';
/** Its switch off with that experiment on: what off means now. */
export const COPYLESS_OFF_TEXT = 'Off: Walnut runs here only as its service. It keeps no copy of your data, opens no port and has no console.';

export interface HostServerReport {
  route?: { kind: string; why?: string };
  expose?: ExposeStatus;
  version?: string;
  commit?: string | null;
}

/** Which kinds the Mac copies to a replica (core/replication/kinds/copy-kind.ts CopyChoice): every one on by default. */
export interface HostCopyChoice {
  sessions: boolean; requests: boolean; boards: boolean; inbox: boolean; inbox_bodies: boolean
  routines: boolean; conversations: boolean; conversation_bodies: boolean; prefs: boolean; config: boolean; personas: boolean
}

export const DEFAULT_HOST_COPY_CHOICE: Readonly<HostCopyChoice> = Object.freeze({
  sessions: true, requests: true, boards: true, inbox: true, inbox_bodies: true,
  routines: true, conversations: true, conversation_bodies: true, prefs: true, config: true, personas: true,
});

/**
 * The copy choices in the order Settings lists them, each with its label. A row with
 * `with` rides with that one: off when it is off (bodies ride with their index).
 */
export const HOST_COPY_ROWS: ReadonlyArray<{ key: keyof HostCopyChoice; label: string; with?: keyof HostCopyChoice }> = [
  // Each label names every copy its switch covers (the kinds whose `choice` is the key, kinds/*.ts).
  { key: 'sessions', label: 'Sessions and model lists' },
  { key: 'requests', label: 'Reply requests' },
  { key: 'boards', label: 'Boards' },
  { key: 'inbox', label: 'Inbox and notification cards' },
  { key: 'inbox_bodies', label: 'Letter bodies', with: 'inbox' },
  { key: 'conversations', label: 'Chat list' },
  { key: 'conversation_bodies', label: 'Chat messages', with: 'conversations' },
  { key: 'routines', label: 'Routines' },
  { key: 'personas', label: 'Agents and their model picks' },
  { key: 'prefs', label: 'Layout and favorites' },
  { key: 'config', label: 'Settings and speech vocabulary' },
];

/** The choice from what the server stored, defaults filled in (an older server sends fewer keys). */
export function copyChoiceOf(raw: Partial<HostCopyChoice> | undefined | null): HostCopyChoice {
  const out = { ...DEFAULT_HOST_COPY_CHOICE };
  for (const k of Object.keys(out) as Array<keyof HostCopyChoice>) if (typeof raw?.[k] === 'boolean') out[k] = raw[k] as boolean;
  if (!out.inbox) out.inbox_bodies = false;
  if (!out.conversations) out.conversation_bodies = false;
  return out;
}

/** The folded copy rows' summary: `All 11 kinds copied`, `8 of 11 copied`. */
export function copiesSummary(raw: Partial<HostCopyChoice> | undefined | null): string {
  const choice = copyChoiceOf(raw);
  const on = HOST_COPY_ROWS.filter((row) => choice[row.key]).length;
  const all = HOST_COPY_ROWS.length;
  return on === all ? `All ${all} kinds copied` : on === 0 ? 'Nothing copied' : `${on} of ${all} copied`;
}

/** The change one row's click writes: turning an index off turns the rows riding with it off too. */
export function copyChoicePatch(key: keyof HostCopyChoice, on: boolean): Partial<HostCopyChoice> {
  const patch: Partial<HostCopyChoice> = { [key]: on };
  if (!on) for (const row of HOST_COPY_ROWS) if (row.with === key) patch[row.key] = false;
  return patch;
}

export interface HostServerEntry {
  hostKey: string;
  label: string;
  settings: {
    /** What runs: the person's switch, or the default where they never set it (`chosenBy`). */
    enabled: boolean;
    /** Whose `enabled` is: the person's, or the default's (an older server sends none). */
    chosenBy?: 'user' | 'default';
    /** On only because every host runs one by default (never for the host carrying this Walnut's tunnel). */
    byDefault?: boolean;
    /** Why the host's own tunnel does not run although it is on (it would take this computer's address). */
    expose: { enabled: boolean; provider: string | null; options: Record<string, string>; blocked?: string };
    /** This computer's tunnel (Browser from anywhere) runs on this host, so its server runs whatever its switch said. */
    carriesTunnel?: boolean;
    /** What the Mac copies to the host's replica (WP4), defaults filled in by the server. */
    copies?: Partial<HostCopyChoice>;
    program?: 'replica' | 'host-server';
  };
  view: HostServerView | null;
  /** This row is another alias of a machine the person knows under the row `hostKey`, by `label`. */
  knownAs?: { hostKey: string; label: string };
}

export interface HostServersResponse {
  hosts: HostServerEntry[];
  providers: ExposeProviderInfo[];
}

export interface HostServerLine {
  dot: StatusDot;
  text: string;
  /** Offer "Try again": the setup stopped on an error. */
  retry: boolean;
}

/** Where browsers of this host reach right now, in words. */
function routeText(route: { kind: string; why?: string } | undefined): string {
  if (!route) return 'Running.';
  if (route.kind === 'leader') return 'Running. A browser there reaches this Mac.';
  if (route.kind === 'companion') return 'Running. This Mac is away, so a browser there reaches your cloud companion.';
  return 'Running on its own: neither this Mac nor your cloud companion answers it right now.';
}

/**
 * While the server does not answer now: what it said last and how long ago, so its build and
 * address stay readable ('' when nothing came in yet).
 */
export function lastReportText(v: HostServerView, now = Date.now()): string {
  const r = v.lastReport;
  if (!r || v.phase === 'running' || typeof v.lastReportAt !== 'number') return '';
  const build = r.version ? `Walnut ${r.version}${r.commit ? ` (${r.commit})` : ''}` : '';
  const url = r.expose?.url ? `at ${r.expose.url.replace(/^https?:\/\//, '')}` : '';
  const what = [build, url].filter(Boolean).join(', ');
  return `Last answered ${timeAgo(new Date(v.lastReportAt).toISOString(), { long: true, now })}${what ? `: ${what}` : ''}.`;
}

/** The tooltip of hostServerSwitchWords' words. */
export const HOST_SERVER_BY_DEFAULT_TITLE = 'Every host runs one by default; turning it off keeps it off.';

/**
 * The words beside the host's switch when it is on only because every host runs one by default
 * (the server sends `settings.byDefault`); null when the person set it, it is off, it carries this
 * Walnut's tunnel (on for that, its switch greyed), or an older server says nothing.
 */
export function hostServerSwitchWords(entry: HostServerEntry): string | null {
  const s = entry.settings;
  return s.enabled && s.byDefault === true && !s.carriesTunnel ? 'On (default)' : null
}

export function describeHostServer(entry: HostServerEntry, now = Date.now()): HostServerLine {
  const line = describeHostServerNow(entry);
  const kept = entry.settings.enabled && entry.view ? lastReportText(entry.view, now) : '';
  return kept ? { ...line, text: `${line.text} ${kept}` } : line;
}

function describeHostServerNow(entry: HostServerEntry): HostServerLine {
  const v = entry.view;
  if (!entry.settings.enabled) {
    return { dot: 'pending', text: 'Keeps a Walnut on this host that opens in a browser through its own tunnel, also while this Mac sleeps.', retry: false };
  }
  if (!v) return { dot: 'pending', text: 'Reading its state...', retry: false };
  switch (v.phase) {
    case 'off':
    case 'waiting-for-host':
      return { dot: 'pending', text: v.message ?? 'Starts when Walnut next connects to this host.', retry: false };
    case 'unsupported':
      return { dot: 'action', text: v.message ?? 'Walnut\'s helper on this host needs an update first: it updates the next time Walnut connects.', retry: false };
    case 'checking':
    case 'installing':
    case 'starting':
      return { dot: 'pending', text: v.message ?? 'Setting it up...', retry: false };
    case 'running':
      if (v.copyless) return { dot: 'done', text: COPYLESS_RUNNING_TEXT, retry: false };
      if (v.notice) return { dot: 'action', text: `${routeText(v.server?.route)} ${v.notice}`, retry: true };
      return { dot: 'done', text: routeText(v.server?.route), retry: false };
    case 'error':
      return { dot: 'error', text: v.message ?? 'It stopped on an error.', retry: true };
    case 'not-eligible':
      return { dot: 'pending', text: v.message ?? 'This host cannot run Walnut well right now.', retry: true };
    default:
      // A phase a newer server knows: its own sentence.
      return { dot: 'pending', text: v.message ?? 'Setting it up...', retry: false };
  }
}

/** Poll often while a host is being set up or its tunnel moves, rarely once settled. */
export function hostServersPollMs(data: HostServersResponse | null): number {
  if (!data) return 3_000;
  const moving = data.hosts.some((h) => {
    if (!h.settings.enabled || !h.view) return false;
    if (h.view.phase === 'checking' || h.view.phase === 'installing' || h.view.phase === 'starting') return true;
    const tunnel = h.view.server?.expose?.state;
    return h.settings.expose.enabled && tunnel !== undefined && tunnel !== 'connected' && tunnel !== 'off' && tunnel !== 'unavailable';
  });
  return moving ? 3_000 : 30_000;
}
