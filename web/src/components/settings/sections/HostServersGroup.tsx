/**
 * "Walnut on a host" in Remote Hosts (docs/plan/walnut-servers-everywhere.md,
 * "A server on a host"): for each host, a switch that keeps a Walnut running
 * there, one sentence of state, and, while it is on, the host's own tunnel (which
 * provider, its options, the switch, its address).
 *
 * State comes from GET /api/host-servers, every 3s while a host is being set up
 * or its tunnel moves and every 30s once settled, never while the tab is hidden,
 * and at once when the hosts in config.yaml change (a label, a host added or
 * removed in the Hosts group above).
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { apiGet, apiPost, apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { CopyButton } from '../inputs/CopyButton';
import { saveErrorMessage } from '../settings-pane-context';
import { describeExpose } from './cloud/browser-access-status';
import { describeHostServer, hostServersPollMs, type HostServerEntry, type HostServersResponse } from './host-servers-status';
import '@/styles/browser-access.css';

const PATH = '/api/host-servers';

interface ExposePatch { enabled?: boolean; provider?: string; options?: Record<string, string> }

export function HostServersGroup({ hosts }: { hosts: Config['hosts'] }) {
  const [data, setData] = useState<HostServersResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Option fields being typed in, per host: a poll must not overwrite them. */
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const readSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await apiGet<HostServersResponse>(PATH, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      if (seq === readSeq.current) setData(res);
    } catch (err) {
      log.warn('settings', 'host server state read failed', { error: String(err) });
    }
  }, []);

  const hostsKey = JSON.stringify(hosts ?? {});
  useEffect(() => { void load(); }, [load, hostsKey]);

  const interval = hostServersPollMs(data);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, interval);
    return () => clearInterval(timer);
  }, [interval, load]);

  const replaceHost = (host: HostServerEntry) => {
    setData((prev) => (prev ? { ...prev, hosts: prev.hosts.map((h) => (h.hostKey === host.hostKey ? host : h)) } : prev));
  };

  const call = async (hostKey: string, run: () => Promise<{ host: HostServerEntry | null }>) => {
    setBusy(hostKey);
    setErrors((prev) => { const next = { ...prev }; delete next[hostKey]; return next; });
    readSeq.current++;
    try {
      const res = await run();
      if (res.host) replaceHost(res.host);
    } catch (err) {
      log.warn('settings', 'host server setting not saved', { hostKey, error: saveErrorMessage(err) });
      setErrors((prev) => ({ ...prev, [hostKey]: saveErrorMessage(err) }));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const write = (hostKey: string, body: { enabled?: boolean; expose?: ExposePatch }) =>
    call(hostKey, () => apiPut<{ host: HostServerEntry | null }>(`${PATH}/${encodeURIComponent(hostKey)}`, body));

  if (!data || data.hosts.length === 0) return null;
  const providers = data.providers;

  return (
    <SettingsGroup
      heading="Walnut on a host"
      footer="A browser opening it signs in with a code (Phones & Cloud, Open from a browser)."
      data-testid="host-servers"
    >
      {data.hosts.map((host) => {
        const line = describeHostServer(host);
        const on = host.settings.enabled;
        const exposeSettings = host.settings.expose;
        const providerId = exposeSettings.provider ?? providers[0]?.id ?? null;
        const provider = providers.find((p) => p.id === providerId) ?? null;
        const tunnel = host.view?.server?.expose ?? null;
        const tunnelLine = describeExpose(tunnel, provider?.title ?? 'the tunnel');
        const draft = drafts[host.hostKey] ?? {};
        const optionValue = (key: string) => draft[key] ?? exposeSettings.options[key] ?? '';
        const saveOption = (key: string) => {
          const value = draft[key];
          setDrafts((prev) => { const next = { ...(prev[host.hostKey] ?? {}) }; delete next[key]; return { ...prev, [host.hostKey]: next }; });
          if (value === undefined || (exposeSettings.options[key] ?? '') === value) return;
          void write(host.hostKey, { expose: { options: { ...exposeSettings.options, [key]: value } } });
        };
        const running = host.view?.phase === 'running';
        return (
          <Fragment key={host.hostKey}>
            <SettingsRow
              data-testid={`host-server-${host.hostKey}`}
              data-phase={on ? host.view?.phase ?? 'unknown' : 'off'}
              label={host.label}
              htmlFor={`host-server-enabled-${host.hostKey}`}
              help={
                <span className="browser-access-state" data-testid={`host-server-state-${host.hostKey}`}>
                  <span className="browser-access-dot" data-dot={line.dot} aria-hidden="true" />
                  <span>{line.text}</span>
                </span>
              }
              error={errors[host.hostKey]}
              control={
                <span className="settings-addons-inline">
                  {on && line.retry && (
                    <SettingsButton variant="text" onClick={() => { void call(host.hostKey, () => apiPost(`${PATH}/${encodeURIComponent(host.hostKey)}/retry`)); }} data-testid={`host-server-retry-${host.hostKey}`}>
                      Try again
                    </SettingsButton>
                  )}
                  <ToggleSwitch
                    id={`host-server-enabled-${host.hostKey}`}
                    checked={on}
                    busy={busy === host.hostKey}
                    aria-label={`Run Walnut on ${host.label}`}
                    data-testid={`host-server-enabled-${host.hostKey}`}
                    onChange={(v) => { void write(host.hostKey, { enabled: v }); }}
                  />
                </span>
              }
            />
            {on && (providers.length === 0 ? (
              <SettingsRow indent label="Tunnel" help="No tunnel is set up for hosts; add a tunnel plugin." data-testid={`host-server-no-provider-${host.hostKey}`} />
            ) : (
              <>
                {providers.length > 1 && (
                  <SettingsRow
                    indent
                    label="Tunnel"
                    help={provider?.description}
                    control={
                      <SegmentedControl
                        aria-label={`Tunnel on ${host.label}`}
                        value={providerId ?? ''}
                        disabled={busy === host.hostKey}
                        onChange={(v) => { void write(host.hostKey, { expose: { provider: v } }); }}
                        options={providers.map((p) => ({ value: p.id, label: p.title, testId: `host-server-provider-${host.hostKey}-${p.id}` }))}
                      />
                    }
                  />
                )}
                {(provider?.options ?? []).map((option) => (
                  <SettingsRow
                    indent
                    key={option.key}
                    label={option.label}
                    htmlFor={`host-server-option-${host.hostKey}-${option.key}`}
                    help={option.help}
                    control={
                      <input
                        id={`host-server-option-${host.hostKey}-${option.key}`}
                        type="text"
                        className="settings-input settings-input--short"
                        value={optionValue(option.key)}
                        placeholder={option.default}
                        spellCheck={false}
                        data-testid={`host-server-option-${host.hostKey}-${option.key}`}
                        onChange={(e) => {
                          const value = e.target.value;
                          setDrafts((prev) => ({ ...prev, [host.hostKey]: { ...(prev[host.hostKey] ?? {}), [option.key]: value } }));
                        }}
                        onBlur={() => saveOption(option.key)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOption(option.key); } }}
                      />
                    }
                  />
                ))}
                <SettingsRow
                  indent
                  label="Open from anywhere"
                  htmlFor={`host-server-expose-${host.hostKey}`}
                  help={
                    <span className="browser-access-state" data-testid={`host-server-tunnel-state-${host.hostKey}`}>
                      <span className="browser-access-dot" data-dot={running ? tunnelLine.dot : 'pending'} aria-hidden="true" />
                      <span>{running ? tunnelLine.text : `${provider?.title ?? 'The tunnel'} starts on the host once Walnut runs there.`}</span>
                    </span>
                  }
                  control={
                    <span className="settings-addons-inline">
                      {running && exposeSettings.enabled && tunnelLine.retry && (
                        <SettingsButton variant="text" onClick={() => { void call(host.hostKey, () => apiPost(`${PATH}/${encodeURIComponent(host.hostKey)}/expose/retry`)); }} data-testid={`host-server-tunnel-retry-${host.hostKey}`}>
                          Retry
                        </SettingsButton>
                      )}
                      <ToggleSwitch
                        id={`host-server-expose-${host.hostKey}`}
                        checked={exposeSettings.enabled}
                        busy={busy === host.hostKey}
                        aria-label={`Open Walnut on ${host.label} from anywhere`}
                        data-testid={`host-server-expose-${host.hostKey}`}
                        onChange={(v) => { void write(host.hostKey, { expose: { enabled: v, ...(providerId ? { provider: providerId } : {}) } }); }}
                      />
                    </span>
                  }
                />
                {running && tunnel?.state === 'connected' && tunnel.url && (
                  <SettingsRow
                    indent
                    label="Address"
                    help={<a className="settings-addons-link browser-access-url" href={tunnel.url} target="_blank" rel="noopener noreferrer" data-testid={`host-server-url-${host.hostKey}`}>{tunnel.url.replace(/^https?:\/\//, '')}</a>}
                    control={<CopyButton text={tunnel.url} data-testid={`host-server-copy-url-${host.hostKey}`} />}
                  />
                )}
              </>
            ))}
          </Fragment>
        );
      })}
    </SettingsGroup>
  );
}
