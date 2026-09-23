import { Fragment, useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { RemoteHostStatus, RemoteHostUnreachable } from './RemoteHostStatus';
import { AddLimitRow } from './RemoteHostLimits';
import '@/styles/settings-sections-addons.css';

interface HostEntry {
  _key: number; // stable React key
  alias: string;
  hostname: string;
  user: string;
  port: number | undefined;
  label: string;
  shell_setup: string;
  enabled: boolean;
  discovered: boolean;
}

let nextHostKey = 0;

function emptyHost(): HostEntry {
  return { _key: nextHostKey++, alias: '', hostname: '', user: '', port: undefined, label: '', shell_setup: '', enabled: true, discovered: false };
}

function hostsFromConfig(config: Config): HostEntry[] {
  return Object.entries(config.hosts ?? {}).map(([alias, h]) => ({
    _key: nextHostKey++,
    alias,
    hostname: h.hostname,
    user: h.user ?? '',
    port: h.port,
    label: h.label ?? '',
    shell_setup: h.shell_setup ?? '',
    enabled: h.enabled ?? true,
    discovered: h.discovered ?? false,
  }));
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function RemoteHostsSection({ config, onSave }: Props) {
  // Hydrated on the first render so the auto-save fingerprint matches its baseline at mount.
  const [hosts, setHosts] = useState<HostEntry[]>(() => hostsFromConfig(config));
  const [expanded, setExpanded] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits). Keyed by the same aliases
  // as the hosts above (plus "local"), so they belong on this card.
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);

  useEffect(() => {
    setHosts(hostsFromConfig(config));
    setSessionLimits(config.session_limits ?? {});
  }, [config]);

  const updateHost = <K extends keyof HostEntry>(idx: number, field: K, value: HostEntry[K]) => {
    setHosts((prev) => prev.map((h, i) => (i === idx ? { ...h, [field]: value } : h)));
  };

  const addHost = () => {
    setHosts((prev) => [...prev, emptyHost()]);
    setExpanded(hosts.length);
  };

  const removeHost = (idx: number) => {
    setHosts((prev) => prev.filter((_, i) => i !== idx));
    setExpanded(null);
  };

  // Build the persisted `hosts` map from local entries, dropping incomplete rows (no alias/hostname).
  // Used both by the save call and the auto-save fingerprint so half-typed hosts never get written.
  const buildHostsConfig = (): NonNullable<Config['hosts']> => {
    const hostsConfig: NonNullable<Config['hosts']> = {};
    for (const h of hosts) {
      if (!h.alias || !h.hostname) continue;
      hostsConfig[h.alias] = {
        hostname: h.hostname,
        user: h.user || undefined,
        port: h.port,
        label: h.label || undefined,
        shell_setup: h.shell_setup || undefined,
        enabled: h.enabled,
        discovered: h.discovered,
      };
    }
    return hostsConfig;
  };

  // Normalize the per-host limits to numbers. The KeyValueEditor yields strings while a
  // post-save config round-trip yields numbers; normalizing keeps the auto-save fingerprint
  // stable so semantically-equal values don't trigger repeated writes.
  const normalizeLimits = (raw: Record<string, string | number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === 'number' ? v : parseInt(v, 10) || 0;
    }
    return out;
  };

  const handleSave = async () => {
    await onSave({ hosts: buildHostsConfig(), session_limits: normalizeLimits(sessionLimits) });
  };

  // Re-normalize the persisted hosts through the SAME field order buildHostsConfig produces,
  // so the baseline can't differ from `current` purely by YAML key ordering (which would
  // otherwise loop: save, refresh, reorder mismatch, save again).
  const normalizeHosts = (h: Config['hosts']): NonNullable<Config['hosts']> => {
    const out: NonNullable<Config['hosts']> = {};
    for (const [alias, v] of Object.entries(h ?? {})) {
      out[alias] = {
        hostname: v.hostname,
        user: v.user || undefined,
        port: v.port,
        label: v.label || undefined,
        shell_setup: v.shell_setup || undefined,
        enabled: v.enabled ?? true,
        discovered: v.discovered ?? false,
      };
    }
    return out;
  };

  // Fingerprint the VALIDATED hosts map (not raw entries) so typing a partial host, or a row
  // with no alias yet — doesn't trigger a write until it's a complete, savable entry.
  // A row with an alias or a hostname but not both is mid-edit. Saving then
  // would drop it from `hosts`, so clearing an alias to retype it deleted the
  // host. Hold the autosave until every started row is complete (Remove is the
  // way to delete one); a fresh blank row holds nothing back.
  const midEdit = hosts.some((h) => !h.alias !== !h.hostname);
  useSettingsAutoSave({
    current: JSON.stringify({ hosts: buildHostsConfig(), limits: normalizeLimits(sessionLimits) }),
    baseline: JSON.stringify({ hosts: normalizeHosts(config.hosts), limits: normalizeLimits(config.session_limits ?? {}) }),
    save: handleSave,
    enabled: !midEdit,
  });

  const hostName = (host: HostEntry, idx: number) =>
    // FQDN-only entries (alias == hostname) read better label-first.
    host.alias && host.alias === host.hostname && host.label
      ? host.label
      : host.alias || host.hostname || `Host ${idx + 1}`;
  // The address beside the name, never the label (N3-20): muted mono hostname.
  const hostSub = (host: HostEntry) =>
    host.hostname && host.hostname !== hostName(host, 0) ? host.hostname : '';

  const text = (idx: number, field: 'alias' | 'hostname' | 'user' | 'label', label: string,
    placeholder: string, size: 'short' | 'long', mono = false) => (
    <SettingsRow
      label={label}
      htmlFor={`rh-${field}-${idx}`}
      indent
      wide={size === 'long'}
      control={
        <input
          id={`rh-${field}-${idx}`}
          type="text"
          className={`settings-input settings-input--${size}${mono ? ' settings-input--mono' : ''}`}
          value={hosts[idx][field]}
          onChange={(e) => updateHost(idx, field, e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
      }
    />
  );

  const addButton = (
    <SettingsButton onClick={addHost} data-testid="remote-hosts-add">Add host</SettingsButton>
  );

  return (
    <SectionCard id="remote-hosts" title="Remote Hosts" onSave={handleSave} showSave={false} actions={addButton}>
      {hosts.map((host, idx) => host.alias ? (
        <RemoteHostUnreachable key={`u-${host._key}`} alias={host.alias} name={hostName(host, idx)} />
      ) : null)}
      <SettingsGroup heading="Hosts">
        {hosts.length === 0 && (
          <SettingsRow label="No remote hosts yet." control={addButton} />
        )}
        {hosts.map((host, idx) => {
          const open = expanded === idx;
          const sub = hostSub(host);
          return (
            <Fragment key={host._key}>
              <SettingsRow
                className="rh-host-row"
                data-host-alias={host.alias || undefined}
                label={
                  <span className="settings-addons-inline">
                    <span className="settings-addons-ellipsis" title={hostName(host, idx)}>{hostName(host, idx)}</span>
                    {sub && <span className="settings-addons-mono settings-addons-muted settings-addons-ellipsis" title={sub}>{sub}</span>}
                    {host.discovered && <SettingsTag>Auto-discovered</SettingsTag>}
                  </span>
                }
                help={host.alias ? <RemoteHostStatus alias={host.alias} /> : 'Add an alias and hostname to save this host.'}
                // Off: only the name and address fade; Edit, Remove and the
                // switch that turns it back on stay at full strength (N10).
                data-host-off={host.enabled ? undefined : 'true'}
                control={
                  <>
                    {/* Remove first: its reserved width for "Confirm remove" opens on
                        the copy side, so Remove and Edit sit together (N3-20). */}
                    <InlineConfirmButton aria-label={`Remove ${hostName(host, idx)}`} onConfirm={() => removeHost(idx)} />
                    <SettingsButton variant="text" aria-expanded={open} onClick={() => setExpanded(open ? null : idx)}>
                      {open ? 'Done' : 'Edit'}
                    </SettingsButton>
                    <ToggleSwitch
                      checked={host.enabled}
                      onChange={(v) => updateHost(idx, 'enabled', v)}
                      aria-label={`Use ${hostName(host, idx)}`}
                    />
                  </>
                }
              />
              {open && (
                <>
                  {text(idx, 'alias', 'Alias', 'devbox', 'short', true)}
                  {text(idx, 'hostname', 'Hostname', 'host.example.com', 'long', true)}
                  {text(idx, 'user', 'User', 'SSH user name', 'short')}
                  <SettingsRow
                    label="Port"
                    htmlFor={`rh-port-${idx}`}
                    indent
                    control={
                      <NumberInput id={`rh-port-${idx}`} value={host.port} onChange={(v) => updateHost(idx, 'port', v)}
                        placeholder="22" min={1} max={65535} />
                    }
                  />
                  {text(idx, 'label', 'Label', 'Display name', 'short')}
                  <SettingsRow
                    label="Shell setup"
                    htmlFor={`rh-shell-${idx}`}
                    help="Runs before claude in remote sessions."
                    indent
                    wide
                    // Multi-line editor: label on top, editor across the group (N3-22).
                    className="settings-row-stacked"
                    control={
                      <textarea
                        id={`rh-shell-${idx}`}
                        className="settings-input settings-input--long settings-input--mono"
                        value={host.shell_setup}
                        onChange={(e) => updateHost(idx, 'shell_setup', e.target.value)}
                        rows={3}
                        placeholder="source $HOME/.nvm/nvm.sh"
                      />
                    }
                  />
                </>
              )}
            </Fragment>
          );
        })}
      </SettingsGroup>

      <SettingsGroup heading="Session limits" footer="Most sessions one host runs at once.">
        {/* Each limit is a row: host on the left, its number on the right (N3-21). */}
        {Object.entries(sessionLimits).map(([alias, max]) => (
          <SettingsRow
            key={alias}
            className="rh-limit-row"
            data-limit-host={alias}
            label={alias === 'local' ? 'This Mac' : <span className="settings-addons-mono">{alias}</span>}
            htmlFor={`rh-limit-${alias}`}
            control={
              <>
                <NumberInput
                  id={`rh-limit-${alias}`}
                  value={typeof max === 'number' ? max : parseInt(String(max), 10) || undefined}
                  onChange={(v) => setSessionLimits((prev) => ({ ...prev, [alias]: v ?? 0 }))}
                  min={0}
                  unit="sessions"
                />
                <SettingsButton
                  variant="text"
                  aria-label={`Remove the limit for ${alias}`}
                  onClick={() => setSessionLimits((prev) => { const next = { ...prev }; delete next[alias]; return next; })}
                >
                  Remove
                </SettingsButton>
              </>
            }
          />
        ))}
        <AddLimitRow
          taken={Object.keys(sessionLimits)}
          onAdd={(alias, max) => setSessionLimits((prev) => ({ ...prev, [alias]: max }))}
        />
      </SettingsGroup>
    </SectionCard>
  );
}
