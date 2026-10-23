/**
 * The shapes GET /api/host-servers answers (src/web/routes/host-servers.ts) and
 * the one sentence the "Walnut on a host" group says for each host. Pure:
 * HostServersGroup renders it, tests read it.
 */

import type { ExposeProviderInfo, ExposeStatus, StatusDot } from './cloud/browser-access-status';

export type HostServerPhase = 'off' | 'waiting-for-host' | 'unsupported' | 'checking' | 'installing' | 'starting' | 'running' | 'error';

export interface HostServerView {
  hostKey: string;
  enabled: boolean;
  phase: HostServerPhase;
  message?: string;
  since: number;
  build?: string;
  port?: number;
  server?: {
    route?: { kind: string; why?: string };
    expose?: ExposeStatus;
    version?: string;
  } | null;
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
  { key: 'sessions', label: 'Sessions' },
  { key: 'requests', label: 'Reply requests' },
  { key: 'boards', label: 'Boards' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'inbox_bodies', label: 'Letter bodies', with: 'inbox' },
  { key: 'conversations', label: 'Chat list' },
  { key: 'conversation_bodies', label: 'Chat messages', with: 'conversations' },
  { key: 'routines', label: 'Routines' },
  { key: 'personas', label: 'Agents' },
  { key: 'prefs', label: 'Layout and favorites' },
  { key: 'config', label: 'Settings' },
];

/** The choice from what the server stored, defaults filled in (an older server sends fewer keys). */
export function copyChoiceOf(raw: Partial<HostCopyChoice> | undefined | null): HostCopyChoice {
  const out = { ...DEFAULT_HOST_COPY_CHOICE };
  for (const k of Object.keys(out) as Array<keyof HostCopyChoice>) if (typeof raw?.[k] === 'boolean') out[k] = raw[k] as boolean;
  if (!out.inbox) out.inbox_bodies = false;
  if (!out.conversations) out.conversation_bodies = false;
  return out;
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
    enabled: boolean;
    /** Why the host's own tunnel does not run although it is on (it would take this computer's address). */
    expose: { enabled: boolean; provider: string | null; options: Record<string, string>; blocked?: string };
    node?: string;
    /** This computer's tunnel (Open from a browser) runs on this host, so its server runs whatever its switch said. */
    carriesTunnel?: boolean;
    /** What the Mac copies to the host's replica (WP4), defaults filled in by the server. */
    copies?: Partial<HostCopyChoice>;
    program?: 'replica' | 'host-server';
  };
  view: HostServerView | null;
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

export function describeHostServer(entry: HostServerEntry): HostServerLine {
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
      return { dot: 'action', text: v.message ?? 'This host\'s Walnut daemon needs an update first.', retry: false };
    case 'checking':
    case 'installing':
    case 'starting':
      return { dot: 'pending', text: v.message ?? 'Setting it up...', retry: false };
    case 'running':
      return { dot: 'done', text: routeText(v.server?.route), retry: false };
    case 'error':
      return { dot: 'error', text: v.message ?? 'It stopped on an error.', retry: true };
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
