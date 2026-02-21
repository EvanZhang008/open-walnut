/**
 * Hook to fetch integration plugin metadata from the server.
 * Used for data-driven sync badges, filter chips, and settings.
 */
import { useState, useEffect } from 'react';

export interface IntegrationMeta {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  externalLinkLabel: string;
}

let cachedIntegrations: IntegrationMeta[] | null = null;

export function useIntegrations(): IntegrationMeta[] {
  const [integrations, setIntegrations] = useState<IntegrationMeta[]>(cachedIntegrations ?? []);

  useEffect(() => {
    if (cachedIntegrations) return;

    fetch('/api/integrations')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: unknown) => {
        if (!Array.isArray(data)) throw new Error('Expected array');
        cachedIntegrations = data as IntegrationMeta[];
        setIntegrations(data as IntegrationMeta[]);
      })
      .catch(() => {
        // Fallback: only include the in-repo integration; external plugins are server-driven
        const fallback: IntegrationMeta[] = [
          { id: 'ms-todo', name: 'Microsoft To-Do', badge: 'M', badgeColor: '#0078D4', externalLinkLabel: 'Microsoft To-Do' },
        ];
        cachedIntegrations = fallback;
        setIntegrations(fallback);
      });
  }, []);

  return integrations;
}

/** Get integration metadata by plugin ID. Returns undefined if not found. */
export function getIntegrationMeta(integrations: IntegrationMeta[], source: string): IntegrationMeta | undefined {
  return integrations.find(i => i.id === source);
}
