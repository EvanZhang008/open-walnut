/**
 * What Settings calls the tunnel way of reaching Walnut (Phones & Cloud's third tab). A plugin that
 * brings its tunnel (it registers a provider through `walnut.expose`) names the way after itself, on
 * the tab, its intro and its row in the nav. With no plugin tunnel it is Walnut's own "Tunnel" (a
 * tunnel command the person sets up).
 *
 * 2026-11-18, the user: the tab first read "Browser link" and only some time later the plugin's
 * name ("why this was browser link before and only after some time become <plugin>"), and "browser
 * link" was a confusing concept of its own. So there is no "browser link" any more, and the tab
 * never shows a name it then changes: the last name this browser saw is kept (utils/last-good.ts)
 * and painted at once; with none kept yet, the name is `null` (unknown) until GET /api/expose
 * answers, and the tab shows a blank placeholder meanwhile. A provider that config.yaml names but
 * that is not registered yet (its plugin still loads after a restart) is unknown too, never the
 * plain name.
 */
import { useEffect, useState } from 'react';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { keepLastGood, readLastGood } from '@/utils/last-good';
import type { ExposeResponse } from './browser-access-status';

export const TUNNEL_TITLE = 'Tunnel';

export interface TunnelName {
  /** The way's name: the plugin tunnel's title, else "Tunnel". */
  title: string;
  /** The provider's title when a plugin brings it (for "Added by the ... plugin"), else null. */
  plugin: string | null;
}

const PLAIN: TunnelName = { title: TUNNEL_TITLE, plugin: null };

/** The built-in provider: a command the person writes (registry.ts). */
const COMMAND_PROVIDER = 'command';

/**
 * The provider the tunnel uses (or would use): the one picked when a plugin brings it, else the only
 * plugin provider there is. Walnut's own command tunnel (owner `core`) keeps the plain name. Null
 * (not known yet) when the picked provider is not registered: a plugin still loading.
 */
export function tunnelName(resp: Pick<ExposeResponse, 'providers' | 'settings'> | null): TunnelName | null {
  if (!resp) return null;
  const fromPlugins = (resp.providers ?? []).filter((p) => p.owner && p.owner !== 'core');
  const pickedId = resp.settings?.provider ?? null;
  if (pickedId && pickedId !== COMMAND_PROVIDER && !(resp.providers ?? []).some((p) => p.id === pickedId)) return null;
  const picked = pickedId ? fromPlugins.find((p) => p.id === pickedId) : undefined;
  const provider = picked ?? (fromPlugins.length === 1 && !pickedId ? fromPlugins[0] : undefined);
  return provider ? { title: provider.title, plugin: provider.title } : PLAIN;
}

/** The line under the way's title: what it is, and who added it. */
export function tunnelSubtitle(name: TunnelName): string {
  return name.plugin
    ? `Added by the ${name.plugin} plugin: an HTTPS address that opens this Walnut in any browser, from anywhere, after you sign in.`
    : 'A tunnel command you set up gives this Walnut an HTTPS address that opens it in any browser, from anywhere, after you sign in.';
}

const KEPT_KEY = 'walnut:last-good:tunnel-name:v1';

const isName = (v: unknown): v is TunnelName =>
  !!v && typeof v === 'object' && typeof (v as TunnelName).title === 'string' && !!(v as TunnelName).title
  && ((v as TunnelName).plugin === null || typeof (v as TunnelName).plugin === 'string');

let shared: TunnelName | null = null;
let sharedRead = false;
const listeners = new Set<(name: TunnelName | null) => void>();
let inflight: Promise<void> | null = null;

/** The name this browser knows now: the one read this page, else the one kept from before. */
function current(): TunnelName | null {
  if (!sharedRead) {
    sharedRead = true;
    shared = readLastGood(KEPT_KEY, isName)?.value ?? null;
  }
  return shared;
}

/** How long a provider config.yaml names may stay unregistered before the tab says "Tunnel". */
const UNKNOWN_GIVE_UP_MS = 15_000;

function publish(next: TunnelName): void {
  shared = next;
  for (const listen of listeners) listen(next);
}

function refresh(): Promise<void> {
  inflight ??= apiGet<ExposeResponse>('/api/expose', undefined, { timeoutMs: 10_000, quietStatuses: [404] })
    .then((resp) => {
      const next = tunnelName(resp);
      // Not known yet (a plugin still loading): keep what is shown; the plugin's arrival reads again.
      // With nothing to show, the plain name after a while (a plugin since removed never arrives).
      if (!next) {
        if (!current()) setTimeout(() => { if (!current()) publish(PLAIN); }, UNKNOWN_GIVE_UP_MS);
        return;
      }
      keepLastGood(KEPT_KEY, next);
      const was = current();
      if (was && next.title === was.title && next.plugin === was.plugin) return;
      publish(next);
    })
    // A 404 (an older server) or a failure: the plain name rather than a blank tab for good.
    .catch(() => { if (!current()) publish(PLAIN); })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Test seam: forget the name read this page (the kept one is read again). */
export function resetTunnelNameForTest(): void {
  shared = null;
  sharedRead = false;
  listeners.clear();
  inflight = null;
}

/**
 * The tunnel way's name, read once per page and again when a plugin or the tunnel changes; null
 * while it is not known yet (nothing kept in this browser, and no answer yet).
 */
export function useTunnelName(): TunnelName | null {
  // A replica answering without the Mac has no tunnel of its own: those pages are the Mac's.
  const replica = useIsReplicaServer();
  const [name, setName] = useState(current);
  useEffect(() => {
    if (replica) return;
    listeners.add(setName);
    setName(current());
    void refresh();
    return () => { listeners.delete(setName); };
  }, [replica]);
  const again = () => { if (!replica) void refresh(); };
  useEvent('plugin:runtime-changed', again);
  useEvent('expose:status-changed', again);
  useEvent('config:changed', again);
  return replica ? PLAIN : name;
}
