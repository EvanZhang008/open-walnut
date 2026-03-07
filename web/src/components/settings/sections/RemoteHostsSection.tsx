import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';

interface HostEntry {
  _key: number; // stable React key
  alias: string;
  hostname: string;
  user: string;
  port: number | undefined;
  label: string;
  shell_setup: string;
}

let nextHostKey = 0;

function emptyHost(): HostEntry {
  return { _key: nextHostKey++, alias: '', hostname: '', user: '', port: undefined, label: '', shell_setup: '' };
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function RemoteHostsSection({ config, onSave }: Props) {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    const entries = Object.entries(config.hosts ?? {}).map(([alias, h]) => ({
      _key: nextHostKey++,
      alias,
      hostname: h.hostname,
      user: h.user ?? '',
      port: h.port,
      label: h.label ?? '',
      shell_setup: h.shell_setup ?? '',
    }));
    setHosts(entries);
  }, [config]);

  const updateHost = (idx: number, field: keyof HostEntry, value: string | number | undefined) => {
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

  const handleSave = async () => {
    const hostsConfig: Config['hosts'] = {};
    for (const h of hosts) {
      if (!h.alias || !h.hostname) continue;
      hostsConfig[h.alias] = {
        hostname: h.hostname,
        user: h.user || undefined,
        port: h.port,
        label: h.label || undefined,
        shell_setup: h.shell_setup || undefined,
      };
    }
    await onSave({ hosts: hostsConfig });
  };

  return (
    <SectionCard id="remote-hosts" title="Remote Hosts" description="SSH hosts for running remote Claude Code sessions." onSave={handleSave}>
      {hosts.map((host, idx) => (
        <details
          key={host._key}
          className="settings-collapsible"
          open={expanded === idx}
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open) setExpanded(idx);
            else if (expanded === idx) setExpanded(null);
          }}
        >
          <summary className="settings-collapsible-title">
            {host.alias || host.hostname || `Host ${idx + 1}`}
            {host.label && <span className="text-sm text-muted" style={{ marginLeft: 8 }}>({host.label})</span>}
          </summary>
          <div className="settings-collapsible-body">
            <div className="form-row">
              <div className="form-group">
                <label>Alias (config key)</label>
                <input
                  type="text"
                  value={host.alias}
                  onChange={(e) => updateHost(idx, 'alias', e.target.value)}
                  placeholder="e.g., devbox"
                />
              </div>
              <div className="form-group">
                <label>Hostname</label>
                <input
                  type="text"
                  value={host.hostname}
                  onChange={(e) => updateHost(idx, 'hostname', e.target.value)}
                  placeholder="host.example.com"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>User</label>
                <input
                  type="text"
                  value={host.user}
                  onChange={(e) => updateHost(idx, 'user', e.target.value)}
                  placeholder="ssh username"
                />
              </div>
              <div className="form-group">
                <label>Port</label>
                <NumberInput
                  value={host.port}
                  onChange={(v) => updateHost(idx, 'port', v)}
                  placeholder="22"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="form-group">
                <label>Label</label>
                <input
                  type="text"
                  value={host.label}
                  onChange={(e) => updateHost(idx, 'label', e.target.value)}
                  placeholder="Display name"
                />
              </div>
            </div>

            <div className="form-group">
              <label>Shell Setup</label>
              <textarea
                value={host.shell_setup}
                onChange={(e) => updateHost(idx, 'shell_setup', e.target.value)}
                rows={3}
                className="settings-textarea"
                placeholder="source $HOME/.nvm/nvm.sh"
              />
              <p className="text-sm text-muted" style={{ marginTop: 2 }}>
                Shell snippet run before claude on remote sessions.
              </p>
            </div>

            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => removeHost(idx)}
              style={{ marginTop: 4 }}
            >
              Remove Host
            </button>
          </div>
        </details>
      ))}

      <button type="button" className="btn btn-sm" onClick={addHost} style={{ marginTop: 8 }}>
        + Add Host
      </button>
    </SectionCard>
  );
}
