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
  settings: { enabled: boolean; provider: string | null; options: Record<string, string>; port?: number };
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
  const retryAt = status.nextRetryAt ? ` Trying again at ${clock(status.nextRetryAt)}.` : '';
  switch (status.state) {
    case 'off':
      return { dot: 'pending', text: `Runs ${name} while Walnut runs, so a browser you sign in can open Walnut from anywhere.`, retry: false };
    case 'starting':
      return { dot: 'pending', text: `Starting ${name}...`, retry: false };
    case 'connected':
      return { dot: 'done', text: `Connected through ${name}.`, retry: false };
    case 'needs-sign-in':
      return { dot: 'action', text: `${status.hint ?? status.lastError ?? `${name} needs you to sign in again.`}${retryAt}`, retry: true };
    case 'missing':
      return { dot: 'action', text: [status.lastError, status.hint].filter(Boolean).join(' ') + retryAt, retry: true };
    case 'retrying':
      return { dot: 'error', text: `${status.lastError ?? `${name} stopped.`}${retryAt}`, retry: true };
    case 'unavailable':
      return { dot: 'error', text: status.lastError ?? `${name} cannot run.`, retry: false };
  }
}

/** Poll often while the state is moving or waiting on the person, rarely once it settled. */
export function exposePollMs(status: ExposeStatus | null): number {
  if (!status) return 3_000;
  return status.state === 'off' || status.state === 'connected' || status.state === 'unavailable' ? 30_000 : 3_000;
}
