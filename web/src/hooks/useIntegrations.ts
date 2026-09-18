/**
 * Hook to fetch integration plugin metadata from the server.
 * Used for data-driven sync badges, filter chips, and settings.
 *
 * ONE request per page, ever. Two things here are load-bearing:
 *
 *  - The memo holds the PROMISE, not the result. Caching only the result left the
 *    guard useless for the case that actually happens: every task row calling this
 *    mounts in the SAME tick, so all of them saw an empty cache and all of them
 *    fetched. Measured 2026-09-17 on a board of 6,431 tasks: 66,318 requests in
 *    10.5 hours, a sustained 104.6 per minute for one small never-changing list.
 *  - It goes through `apiGet`, not bare `fetch`. Bare fetch bypasses the six-slot
 *    admission gate in api/client.ts, so that traffic competed for the browser's
 *    connections while the gate believed it was holding the line — the gate can
 *    only pace requests it can see.
 */
import { useState, useEffect } from 'react';
import { apiGet } from '@/api/client';

export interface IntegrationMeta {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  externalLinkLabel: string;
}

/** Only the in-repo integration; external plugins are server-driven. */
const FALLBACK: IntegrationMeta[] = [
  { id: 'ms-todo', name: 'Microsoft To-Do', badge: 'M', badgeColor: '#0078D4', externalLinkLabel: 'Microsoft To-Do' },
];

let cachedIntegrations: IntegrationMeta[] | null = null;
let inflight: Promise<IntegrationMeta[]> | null = null;

function loadIntegrations(): Promise<IntegrationMeta[]> {
  if (cachedIntegrations) return Promise.resolve(cachedIntegrations);
  // Deliberately NOT cleared on failure: the fallback is a complete answer, and a
  // hook this widely mounted must not turn one bad response into a retry per row.
  inflight ??= apiGet<IntegrationMeta[]>('/api/integrations')
    .then((data) => {
      if (!Array.isArray(data)) throw new Error('Expected array');
      cachedIntegrations = data;
      return data;
    })
    .catch(() => {
      cachedIntegrations = FALLBACK;
      return FALLBACK;
    });
  return inflight;
}

export function useIntegrations(): IntegrationMeta[] {
  const [integrations, setIntegrations] = useState<IntegrationMeta[]>(cachedIntegrations ?? []);

  useEffect(() => {
    if (cachedIntegrations) {
      // A later mount adopts the loaded value without asking the server again.
      setIntegrations(cachedIntegrations);
      return;
    }
    let alive = true;
    void loadIntegrations().then((list) => { if (alive) setIntegrations(list); });
    return () => { alive = false; };
  }, []);

  return integrations;
}

/** Get integration metadata by plugin ID. Returns undefined if not found. */
export function getIntegrationMeta(integrations: IntegrationMeta[], source: string): IntegrationMeta | undefined {
  return integrations.find(i => i.id === source);
}

/** Test hook — lets a spec start from a cold cache. */
export function resetIntegrationsCacheForTesting(): void {
  cachedIntegrations = null;
  inflight = null;
}
