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

export interface HostServerEntry {
  hostKey: string;
  label: string;
  settings: { enabled: boolean; expose: { enabled: boolean; provider: string | null; options: Record<string, string> }; node?: string };
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
