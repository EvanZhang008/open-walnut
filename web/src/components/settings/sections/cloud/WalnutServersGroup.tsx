/**
 * "Walnut servers" on All devices: where this Walnut runs (walnut-servers.ts says what each row
 * is). The companion's address comes from the device list's pairing targets; the hosts from GET
 * /api/host-servers, read when the tab opens and again when config.yaml changes, the last answer
 * kept in this browser so a reopened tab paints it at once.
 */
import { useEffect, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { keepLastGood, readLastGood } from '@/utils/last-good';
import { SettingsGroup, SettingsRow, SettingsTag } from '../../SettingsSection';
import type { HostServerEntry, HostServersResponse } from '../host-servers-status';
import { TUNNEL_TITLE, useTunnelName } from './tunnel-name';
import { walnutServerRows } from './walnut-servers';
import '@/styles/browser-access.css';

const KEPT_KEY = 'walnut:last-good:host-servers:v1';

const isHosts = (v: unknown): v is HostServerEntry[] =>
  Array.isArray(v) && v.every((h) => !!h && typeof h === 'object' && typeof (h as HostServerEntry).hostKey === 'string'
    && typeof (h as HostServerEntry).label === 'string' && !!(h as HostServerEntry).settings);

function useHostServers(): HostServerEntry[] | null {
  const [hosts, setHosts] = useState<HostServerEntry[] | null>(() => readLastGood(KEPT_KEY, isHosts)?.value ?? null);
  const load = useLeanCallback(async () => {
    try {
      const res = await apiGet<HostServersResponse>('/api/host-servers', undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      setHosts(res.hosts);
      keepLastGood(KEPT_KEY, res.hosts);
    } catch {
      // An older server or a failed read: the list keeps what it showed (This Mac and the companion still do).
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEvent('config:changed', () => { void load(); });
  useEvent('expose:status-changed', () => { void load(); });
  return hosts;
}

export function WalnutServersGroup({ companion, companionError }: { companion: { origin: string } | null; companionError: string | null }) {
  const hosts = useHostServers();
  const name = useTunnelName();
  const rows = walnutServerRows({ companion, companionError, hosts, tunnelTitle: name?.title ?? TUNNEL_TITLE });
  return (
    <SettingsGroup heading="Walnut servers" headingTrailing={String(rows.length)} data-testid="walnut-servers">
      {rows.map((r) => (
        <SettingsRow
          key={r.id}
          className="walnut-server-row"
          data-server={r.id}
          label={
            <span className="settings-addons-inline devices-name">
              <span className="browser-access-dot" data-dot={r.dot} aria-hidden="true" />
              <span className="settings-addons-ellipsis">{r.name}</span>
              <SettingsTag tone={r.role === 'primary' ? 'success' : 'neutral'}>{r.role === 'primary' ? 'Primary' : 'Copy'}</SettingsTag>
            </span>
          }
          help={<span className="devices-meta">{r.line}</span>}
          control={r.href ? (
            <a className="settings-button settings-button-default" href={r.href} data-testid={`walnut-server-open-${r.id}`}>
              <span className="settings-button-stack"><span className="settings-button-label">Settings</span></span>
            </a>
          ) : undefined}
        />
      ))}
    </SettingsGroup>
  );
}
