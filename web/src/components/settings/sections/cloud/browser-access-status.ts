/**
 * The shapes GET /api/expose answers (src/web/routes/expose.ts) and the words the
 * "Open from a browser" group says for each tunnel state. Pure: BrowserAccessGroup
 * renders it, tests read it.
 */

export type ExposeState = 'off' | 'starting' | 'connected' | 'retrying' | 'needs-sign-in' | 'missing' | 'unavailable';

export interface ExposeStatus {
  enabled: boolean;
  provider: string | null;
  providerTitle?: string;
  state: ExposeState;
  since: number;
  url?: string;
  port?: number;
  lastError?: string;
  hint?: string;
  nextRetryAt?: number;
  /** Set while a host's Walnut server runs the tunnel instead of this computer. */
  runsOn?: { hostKey: string; label: string; auto: boolean };
}

/** One place the tunnel can run: `here`, or a host key. */
export interface ExposePlace {
  id: string;
  label: string;
  alwaysOn: boolean;
}

export interface ExposeProviderOption {
  key: string;
  label: string;
  default?: string;
  help?: string;
  pattern?: string;
}

export interface ExposeProviderInfo {
  id: string;
  title: string;
  description?: string;
  owner: string;
  options: ExposeProviderOption[];
}

export interface ExposeResponse {
  status: ExposeStatus;
  providers: ExposeProviderInfo[];
  /** Where it can run; empty or absent (an older server): this computer only. */
  places?: ExposePlace[];
  settings: {
    enabled: boolean; provider: string | null; options: Record<string, string>; port?: number;
    /** The person's pick (`here` or a host key); null follows the provider. */
    runOn?: string | null;
    /** Where it runs now. */
    placedOn?: string;
  };
}

export type StatusDot = 'pending' | 'action' | 'done' | 'error';

export interface StatusLine {
  dot: StatusDot;
  text: string;
  /** Offer Retry: the provider is waiting to start again. */
  retry: boolean;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** One sentence for the switch row; the URL itself has its own row while connected. */
export function describeExpose(status: ExposeStatus | null, title: string): StatusLine {
  if (!status) return { dot: 'pending', text: 'Reading the tunnel state...', retry: false };
  const name = status.providerTitle ?? title;
  const on = status.runsOn ? ` on ${status.runsOn.label}` : '';
  const retryAt = status.nextRetryAt ? ` Trying again at ${clock(status.nextRetryAt)}.` : '';
  switch (status.state) {
    case 'off':
      return { dot: 'pending', text: `Runs ${name} while Walnut runs, so a browser you sign in can open Walnut from anywhere.`, retry: false };
    case 'starting':
      // On a host: what it waits for (the host to connect, Walnut to install there).
      return { dot: 'pending', text: status.runsOn && status.lastError ? status.lastError : `Starting ${name}${on}...`, retry: false };
    case 'connected':
      return { dot: 'done', text: `Connected through ${name}${on}.`, retry: false };
    case 'needs-sign-in':
      return { dot: 'action', text: `${status.hint ?? status.lastError ?? `${name} needs you to sign in again.`}${retryAt}`, retry: true };
    case 'missing':
      return { dot: 'action', text: [status.lastError, status.hint].filter(Boolean).join(' ') + retryAt, retry: true };
    case 'retrying':
      return { dot: 'error', text: `${status.lastError ?? `${name} stopped${on}.`}${retryAt}`, retry: true };
    case 'unavailable':
      return { dot: 'error', text: status.lastError ?? `${name} cannot run.`, retry: false };
  }
}

/** Poll often while the state is moving or waiting on the person, rarely once it settled. */
export function exposePollMs(status: ExposeStatus | null): number {
  if (!status) return 3_000;
  return status.state === 'off' || status.state === 'connected' || status.state === 'unavailable' ? 30_000 : 3_000;
}
