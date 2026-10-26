/**
 * The org's own names (src/core/org/org-settings.ts), shared by every component that shows
 * them: the Org page's title and the user's role on the org chart. Read once, then again on
 * every config:changed, so a rename in one window shows in every other at once.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchOrgSettings, saveOrgSettings, type OrgSettings } from '@/api/org';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

export const ORG_DEFAULTS: OrgSettings = { name: 'Org', founderTitle: 'Founder' };

let known: OrgSettings | null = null;
const listeners = new Set<(s: OrgSettings) => void>();
let reading: Promise<void> | null = null;

function publish(s: OrgSettings): void {
  known = s;
  for (const l of listeners) l(s);
}

function refresh(): Promise<void> {
  reading ??= fetchOrgSettings()
    .then(publish)
    .catch((err) => log.warn('org-page', 'org names read failed', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => { reading = null; });
  return reading;
}

export function useOrgSettings(): { settings: OrgSettings; save: (patch: Partial<OrgSettings>) => Promise<void> } {
  const [settings, setSettings] = useState<OrgSettings>(known ?? ORG_DEFAULTS);
  useEffect(() => {
    listeners.add(setSettings);
    if (known) setSettings(known); else void refresh();
    return () => { listeners.delete(setSettings); };
  }, []);
  useEvent('config:changed', () => { void refresh(); });
  const save = useCallback(async (patch: Partial<OrgSettings>) => {
    // Shown at once; the server's answer (its trims and defaults) replaces it.
    publish({ ...(known ?? ORG_DEFAULTS), ...patch });
    try {
      publish(await saveOrgSettings(patch));
      log.info('org-page', 'org names saved', { fields: Object.keys(patch) });
    } catch (err) {
      log.warn('org-page', 'org names not saved', { error: err instanceof Error ? err.message : String(err) });
      await refresh();
      throw err;
    }
  }, []);
  return { settings, save };
}
