import { Fragment, useState, useEffect, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { RemoteHostDetail, RemoteHostStatus } from './RemoteHostStatus';
import { useLocation, useNavigate } from 'react-router-dom';
import { flashHostsOf, hostRowId, useHostSettingsFocus } from '@/utils/host-settings-nav';
import { landOnRow } from '@/utils/scroll-land';
import { AddLimitRow } from './RemoteHostLimits';
import { HostServersGroup } from './HostServersGroup';
import { CopyHostDiagnosticsButton, DiagnosticsFallback, useCopyDiagnostics } from '../CopyDiagnostics';
import { hasStatusHosts } from '../diagnostics-copy';
import '@/styles/settings-sections-addons.css';
import '@/styles/host-picker-settings.css';

const FLASH_MS = 1500;
/** Each 'Open Settings' request flashes its row once, even across remounts. */
let flashedNonce = 0;

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
  /** Only `false` is ever written (config-only switch, no control here yet). */
  autofix?: boolean;
  /** What the host keeps a read copy of (core/host-replica.ts); undefined = everything. */
  keep?: HostKeep;
  /** The "Leave out folders" text as typed (a trailing comma survives a save). */
  excludeText?: string;
}

type HostKeep = NonNullable<NonNullable<Config['hosts']>[string]['keep']>;

/** Only what differs from "keep everything" is written, so a saved host round-trips unchanged. */
function normalizeKeep(keep: HostKeep | undefined): HostKeep | undefined {
  if (!keep) return undefined;
  const exclude = (keep.notes_exclude ?? []).map((f) => f.trim()).filter(Boolean);
  const out: HostKeep = {
    ...(keep.notes === false ? { notes: false } : {}),
    ...(exclude.length > 0 ? { notes_exclude: exclude } : {}),
    ...(keep.memory === false ? { memory: false } : {}),
    ...(keep.skills === false ? { skills: false } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function splitFolders(text: string): string[] {
  return text.split(',').map((f) => f.trim()).filter(Boolean);
}

/**
 * The persisted `hosts` map from local entries, dropping incomplete rows (no
 * alias/hostname). Used both by the save call and the auto-save fingerprint so
 * half-typed hosts never get written.
 */
function entriesToHosts(hosts: HostEntry[]): NonNullable<Config['hosts']> {
  const hostsConfig: NonNullable<Config['hosts']> = {};
  for (const h of hosts) {
    if (!h.alias || !h.hostname) continue;
    const keep = normalizeKeep(h.excludeText === undefined ? h.keep : { ...(h.keep ?? {}), notes_exclude: splitFolders(h.excludeText) });
    hostsConfig[h.alias] = {
      hostname: h.hostname,
      user: h.user || undefined,
      port: h.port,
      label: h.label || undefined,
      shell_setup: h.shell_setup || undefined,
      enabled: h.enabled,
      discovered: h.discovered,
      // Kept through a save: the editor has no control for it, and dropping it
      // would silently turn a host's automatic fixes back on.
      ...(h.autofix === false ? { autofix: false } : {}),
      ...(keep ? { keep } : {}),
    };
  }
  return hostsConfig;
}

/**
 * The persisted hosts through the SAME field order entriesToHosts produces, so
 * the baseline can't differ from `current` purely by YAML key ordering (which
 * would otherwise loop: save, refresh, reorder mismatch, save again).
 */
function normalizeHosts(h: Config['hosts']): NonNullable<Config['hosts']> {
  const out: NonNullable<Config['hosts']> = {};
  for (const [alias, v] of Object.entries(h ?? {})) {
    const keep = normalizeKeep(v.keep);
    out[alias] = {
      hostname: v.hostname,
      user: v.user || undefined,
      port: v.port,
      label: v.label || undefined,
      shell_setup: v.shell_setup || undefined,
      enabled: v.enabled ?? true,
      discovered: v.discovered ?? false,
      ...(v.autofix === false ? { autofix: false } : {}),
      ...(keep ? { keep } : {}),
    };
  }
  return out;
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
    ...(h.autofix === false ? { autofix: false } : {}),
    ...(h.keep ? { keep: h.keep } : {}),
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
  // Diagnostics cover SAVED, enabled hosts (the server's listStatusHosts), never a draft row.
  const hostCopy = useCopyDiagnostics('hosts');

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);

  // A config that already says what the rows say (this editor's own save coming
  // back) keeps the rows as typed: rebuilding them would drop a comma typed in
  // "Leave out folders" before the save, and any draft row.
  useEffect(() => {
    setHosts((prev) => (JSON.stringify(entriesToHosts(prev)) === JSON.stringify(normalizeHosts(config.hosts)) ? prev : hostsFromConfig(config)));
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

  const buildHostsConfig = (): NonNullable<Config['hosts']> => entriesToHosts(hosts);

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

  // The row title is the label, the same name the banner and the picker use (G14);
  // the alias follows it in muted mono, then the hostname (the only part that truncates).
  const hostName = (host: HostEntry, idx: number) =>
    host.label || host.alias || host.hostname || `Host ${idx + 1}`;
  const hostAlias = (host: HostEntry) => (host.label && host.alias && host.alias !== host.label ? host.alias : '');
  const hostSub = (host: HostEntry, idx: number) =>
    host.hostname && host.hostname !== hostName(host, idx) && host.hostname !== host.alias ? host.hostname : '';

  // 'Open Settings' from a banner row, the picker or an error bar: scroll to that
  // host's row and flash it, on every request (a nonce, not the hash: the same
  // hash twice fires nothing).
  const focus = useHostSettingsFocus();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!focus.alias || focus.nonce <= flashedNonce) return;
    const nonce = focus.nonce;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(hostRowId(focus.alias!));
      if (!el) return;
      flashedNonce = nonce;
      // Upper part of the pane, held through late layout, focus on the row (N3-2).
      landRef.current?.();
      landRef.current = landOnRow(el);
      el.classList.remove('rh-row-flash');
      void el.offsetWidth; // restart the animation for a second request
      el.classList.add('rh-row-flash');
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => el.classList.remove('rh-row-flash'), FLASH_MS);
    });
    return () => cancelAnimationFrame(raf);
  }, [focus.nonce, focus.alias, hosts.length]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); landRef.current?.(); }, []);

  // 'and N more' on the banner: the rows its cap hid each flash once (same class
  // and length), the first scrolls into view. The state is used once, then
  // replaced away, so a reload does not flash again.
  const location = useLocation();
  const navigate = useNavigate();
  const flashKey = flashHostsOf(location.state).join('\n');
  useEffect(() => {
    if (!flashKey || hosts.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const els = flashKey.split('\n').map((a) => document.getElementById(hostRowId(a))).filter((el): el is HTMLElement => !!el);
      if (els[0]) { landRef.current?.(); landRef.current = landOnRow(els[0], { focus: false }); }
      for (const el of els) {
        el.classList.remove('rh-row-flash');
        void el.offsetWidth; // restart the animation for a second request
        el.classList.add('rh-row-flash');
        setTimeout(() => el.classList.remove('rh-row-flash'), FLASH_MS);
      }
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashKey, hosts.length]);

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

  const updateKeep = (idx: number, patch: Partial<HostKeep>) => {
    setHosts((prev) => prev.map((h, i) => (i === idx ? { ...h, keep: { ...(h.keep ?? {}), ...patch } } : h)));
  };

  // What the host keeps a read copy of, for its sessions while this Mac cannot
  // answer. Its own work is always kept; the rest is the user's choice.
  const keepRows = (idx: number) => {
    const keep = hosts[idx].keep ?? {};
    const name = hostName(hosts[idx], idx);
    return (
      <>
        <SettingsRow
          label="Its own work"
          help="Its sessions, their tasks, triggers, the team Board and replies are always kept."
          indent
          control={<SettingsTag>Always kept</SettingsTag>}
        />
        <SettingsRow
          label="Notes"
          htmlFor={`rh-keep-notes-${idx}`}
          help="A copy of the note text (no attachments), so its sessions read notes while this Mac is away."
          indent
          control={<ToggleSwitch id={`rh-keep-notes-${idx}`} checked={keep.notes !== false} onChange={(v) => updateKeep(idx, { notes: v })} aria-label={`Keep notes on ${name}`} />}
        />
        {keep.notes !== false && (
          <SettingsRow
            label="Leave out folders"
            htmlFor={`rh-keep-exclude-${idx}`}
            help="Folders of the vault never copied to this host, separated by commas."
            indent
            wide
            control={
              <input
                id={`rh-keep-exclude-${idx}`}
                type="text"
                className="settings-input settings-input--long"
                value={hosts[idx].excludeText ?? (keep.notes_exclude ?? []).join(', ')}
                onChange={(e) => updateHost(idx, 'excludeText', e.target.value)}
                placeholder="health, finance"
                spellCheck={false}
              />
            }
          />
        )}
        <SettingsRow
          label="Memory"
          htmlFor={`rh-keep-memory-${idx}`}
          help="MEMORY.md and USER.md."
          indent
          control={<ToggleSwitch id={`rh-keep-memory-${idx}`} checked={keep.memory !== false} onChange={(v) => updateKeep(idx, { memory: v })} aria-label={`Keep memory on ${name}`} />}
        />
        <SettingsRow
          label="Skills"
          htmlFor={`rh-keep-skills-${idx}`}
          help="The skills sessions read with skill_read."
          indent
          control={<ToggleSwitch id={`rh-keep-skills-${idx}`} checked={keep.skills !== false} onChange={(v) => updateKeep(idx, { skills: v })} aria-label={`Keep skills on ${name}`} />}
        />
      </>
    );
  };

  const addButton = (
    <SettingsButton onClick={addHost} data-testid="remote-hosts-add">Add host</SettingsButton>
  );

  return (
    <SectionCard
      id="remote-hosts"
      title="Remote Hosts"
      onSave={handleSave}
      showSave={false}
      actions={<>{hasStatusHosts(config) && <CopyHostDiagnosticsButton copy={hostCopy} />}{addButton}</>}
    >
      <DiagnosticsFallback copy={hostCopy} testId="remote-hosts-diagnostics-fallback" />
      <SettingsGroup heading="Hosts">
        {hosts.length === 0 && (
          <SettingsRow label="No remote hosts yet." control={addButton} />
        )}
        {hosts.map((host, idx) => {
          const open = expanded === idx;
          const sub = hostSub(host, idx);
          const alias = hostAlias(host);
          return (
            <Fragment key={host._key}>
              <SettingsRow
                className="rh-host-row"
                id={host.alias ? hostRowId(host.alias) : undefined}
                data-host-alias={host.alias || undefined}
                label={
                  <span className="settings-addons-inline">
                    <span className="rh-host-name" title={hostName(host, idx)}>{hostName(host, idx)}</span>
                    {alias && <span className="rh-host-alias">{alias}</span>}
                    {sub && <span className="settings-addons-mono settings-addons-muted settings-addons-ellipsis rh-host-hostname" title={sub}>{sub}</span>}
                    {host.discovered && <SettingsTag>Auto-discovered</SettingsTag>}
                  </span>
                }
                help={host.alias ? <RemoteHostStatus alias={host.alias} name={hostName(host, idx)} enabled={host.enabled} /> : 'Add an alias and hostname to save this host.'}
                // The failure and the readiness lines, below the status line (spec 5.2 / 5.3).
                children={host.alias ? <RemoteHostDetail alias={host.alias} name={hostName(host, idx)} enabled={host.enabled} /> : undefined}
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
                  {keepRows(idx)}
                </>
              )}
            </Fragment>
          );
        })}
      </SettingsGroup>

      <HostServersGroup hosts={config.hosts} />

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
