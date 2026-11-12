/**
 * What Settings calls the browser link. A plugin that brings its tunnel (it registers a provider
 * through `walnut.expose`) adds this way of reaching Walnut, so the way wears the plugin's name
 * ("<provider title>", a line under it saying the plugin added it), on the Phones & Cloud card,
 * its sub-page and its row in the nav. With no plugin tunnel it is Walnut's own "Browser link".
 */
import { useEffect, useState } from 'react';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import type { ExposeResponse } from './browser-access-status';

export const BROWSER_LINK_TITLE = 'Browser link';

export interface BrowserLinkName {
  /** The way's name: the plugin tunnel's title, else "Browser link". */
  title: string;
  /** The provider's title when a plugin brings it (for "Added by the ... plugin"), else null. */
  plugin: string | null;
}

const PLAIN: BrowserLinkName = { title: BROWSER_LINK_TITLE, plugin: null };

/**
 * The provider the link uses (or would use): the one picked when a plugin brings it, else the only
 * plugin provider there is. Walnut's own command tunnel (owner `core`) keeps the plain name.
 */
export function browserLinkName(resp: Pick<ExposeResponse, 'providers' | 'settings'> | null): BrowserLinkName {
  if (!resp) return PLAIN;
  const fromPlugins = (resp.providers ?? []).filter((p) => p.owner && p.owner !== 'core');
  const picked = resp.settings?.provider ? fromPlugins.find((p) => p.id === resp.settings.provider) : undefined;
  const provider = picked ?? (fromPlugins.length === 1 && !resp.settings?.provider ? fromPlugins[0] : undefined);
  return provider ? { title: provider.title, plugin: provider.title } : PLAIN;
}

/** The line under the way's title: what it is, and who added it. */
export function browserLinkSubtitle(name: BrowserLinkName): string {
  return name.plugin
    ? `A browser link, added by the ${name.plugin} plugin: an HTTPS address that opens Walnut in any browser.`
    : 'An HTTPS address that opens Walnut in any browser after you sign in.';
}

let shared: BrowserLinkName = PLAIN;
const listeners = new Set<(name: BrowserLinkName) => void>();
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  inflight ??= apiGet<ExposeResponse>('/api/expose', undefined, { timeoutMs: 10_000, quietStatuses: [404] })
    .then((resp) => {
      const next = browserLinkName(resp);
      if (next.title === shared.title && next.plugin === shared.plugin) return;
      shared = next;
      for (const listen of listeners) listen(next);
    })
    .catch(() => { /* keep the name shown */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The browser link's name, read once per page and again when a plugin or the link changes. */
export function useBrowserLinkName(): BrowserLinkName {
  // A replica answering without the Mac has no browser link of its own: those pages are the Mac's.
  const replica = useIsReplicaServer();
  const [name, setName] = useState(shared);
  useEffect(() => {
    if (replica) return;
    listeners.add(setName);
    setName(shared);
    void refresh();
    return () => { listeners.delete(setName); };
  }, [replica]);
  const again = () => { if (!replica) void refresh(); };
  useEvent('plugin:runtime-changed', again);
  useEvent('expose:status-changed', again);
  useEvent('config:changed', again);
  return replica ? PLAIN : name;
}
