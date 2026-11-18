/**
 * "Your Walnut runs on": one line at the top of Phones & Cloud, above the tabs, naming every place
 * this Walnut runs (walnut-servers.ts says what each is). 2026-11-18: the user asked for the
 * replica servers "under general tab", and the lead put them at the top of Phones & Cloud as an
 * overview, out of All devices (a server is no device).
 *
 * The companion's address comes from the device list's pairing targets; the hosts from GET
 * /api/host-servers, read when the pane opens and again when config.yaml or the tunnel changes, the
 * last answer kept in this browser so a reopened pane paints it at once. Each server but this Mac
 * opens its own settings; its full sentence is its tooltip and its accessible name.
 */
import { useEffect, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { keepLastGood, readLastGood } from '@/utils/last-good';
import type { HostServerEntry, HostServersResponse } from '../host-servers-status';
import { TUNNEL_TITLE, useTunnelName } from './tunnel-name';
import { walnutServerRows, type WalnutServerRow } from './walnut-servers';
import '@/styles/browser-access.css';

const KEPT_KEY = 'walnut:last-good:host-servers:v1';

const isHosts = (v: unknown): v is HostServerEntry[] =>
  Array.isArray(v) && v.every((h) => !!h && typeof h === 'object' && typeof (h as HostServerEntry).hostKey === 'string'
    && typeof (h as HostServerEntry).label === 'string' && !!(h as HostServerEntry).settings);

/** When the list was last read: each tab mounts the line again, and a read a moment ago is still good. */
let readAt = 0;
const FRESH_MS = 30_000;

function useHostServers(): HostServerEntry[] | null {
  const [hosts, setHosts] = useState<HostServerEntry[] | null>(() => readLastGood(KEPT_KEY, isHosts)?.value ?? null);
  const load = useLeanCallback(async (force: boolean) => {
    if (!force && hosts && Date.now() - readAt < FRESH_MS) return;
    readAt = Date.now();
    try {
      const res = await apiGet<HostServersResponse>('/api/host-servers', undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      setHosts(res.hosts);
      keepLastGood(KEPT_KEY, res.hosts);
    } catch {
      // An older server or a failed read: the line keeps what it showed (This Mac and the companion still do).
    }
  }, []);
  useEffect(() => { void load(false); }, [load]);
  useEvent('config:changed', () => { void load(true); });
  useEvent('expose:status-changed', () => { void load(true); });
  return hosts;
}

function ServerPill({ row }: { row: WalnutServerRow }) {
  const body = (
    <>
      <span className="browser-access-dot" data-dot={row.dot} aria-hidden="true" />
      <span className="pc-server-name">{row.name}</span>
      <span className="pc-server-short">{row.short}</span>
    </>
  );
  const label = `${row.name}: ${row.line}`;
  return row.href
    ? <a className="pc-server" href={row.href} title={row.line} aria-label={label} data-server={row.id} data-testid={`walnut-server-${row.id}`}>{body}</a>
    : (
      <span className="pc-server" title={row.line} data-server={row.id} data-testid={`walnut-server-${row.id}`}>
        {body}
        <span className="settings-visually-hidden">: {row.line}</span>
      </span>
    );
}

export function WalnutServersStrip({ companion, companionError }: { companion: { origin: string } | null; companionError: string | null }) {
  const hosts = useHostServers();
  const name = useTunnelName();
  const rows = walnutServerRows({ companion, companionError, hosts, tunnelTitle: name?.title ?? TUNNEL_TITLE });
  return (
    <div className="pc-servers" data-testid="walnut-servers">
      <span className="pc-servers-key">Your Walnut runs on</span>
      <span className="pc-servers-list">
        {rows.map((r) => <ServerPill key={r.id} row={r} />)}
      </span>
    </div>
  );
}
