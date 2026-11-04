import { Fragment, useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS, companionAliasRefusal } from '@open-walnut/companion-keep';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { answerFoundHost } from '@/api/hosts';
import { RemoteHostDetail, RemoteHostStatus } from './RemoteHostStatus';
import { useLocation, useNavigate } from 'react-router-dom';
import { flashHostsOf, hostRowId, useHostSettingsFocus } from '@/utils/host-settings-nav';
import { landOnRow } from '@/utils/scroll-land';
import { ContextMenu, type ContextMenuPoint } from '@/components/common/ContextMenu';
import { AddLimitRow } from './RemoteHostLimits';
import { HostServersGroup } from './HostServersGroup';
import { HostExecGrantsGroup } from './HostExecGrantsGroup';
import { SecretsGroup } from './SecretsGroup';
import { HostFleetGroup } from './HostFleetGroup';
import { useJoinedTwins } from './useJoinedTwins';
import { HostNetworkGroup } from './HostNetworkGroup';
import { HostProfileDisclosure } from './HostProfileDisclosure';
import { ReplicaRemovalGroup } from './ReplicaRemovalGroup';
import { ReplicaKeepRows, normalizeKeep, splitKeepEntries, type ReplicaKeep } from './ReplicaKeepRows';
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
  /** A found host's answer to "Connect to it?" (src/core/hosts/found-hosts.ts); absent on a host added by hand. */
  connect?: FoundAnswer;
  /** Only `false` is ever written (config-only switch, no control here yet). */
  autofix?: boolean;
  /** What the host keeps a read copy of (core/host-replica.ts); undefined = everything. */
  keep?: HostKeep;
  /** The "Leave out folders or notes" text as typed (a trailing comma survives a save). */
  excludeText?: string;
}

type HostKeep = ReplicaKeep;
type FoundAnswer = 'ask' | 'yes' | 'not_now';

/** A found host Walnut does not connect to until the person says so (asked, or Not now). */
function waitsForYes(h: Pick<HostEntry, 'discovered' | 'connect'>): boolean {
  return h.discovered && (h.connect === 'ask' || h.connect === 'not_now');
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
    const keep = normalizeKeep(h.excludeText === undefined ? h.keep : { ...(h.keep ?? {}), notes_exclude: splitKeepEntries(h.excludeText) });
    hostsConfig[h.alias] = {
      hostname: h.hostname,
      user: h.user || undefined,
      port: h.port,
      label: h.label || undefined,
      shell_setup: h.shell_setup || undefined,
      enabled: h.enabled,
      discovered: h.discovered,
      ...(h.discovered && h.connect ? { connect: h.connect } : {}),
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
    if (v.transport === 'net') continue;
    const keep = normalizeKeep(v.keep);
    out[alias] = {
      hostname: v.hostname,
      user: v.user || undefined,
      port: v.port,
      label: v.label || undefined,
      shell_setup: v.shell_setup || undefined,
      enabled: v.enabled ?? true,
      discovered: v.discovered ?? false,
      ...(v.discovered && v.connect ? { connect: v.connect } : {}),
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

/** The SSH hosts this editor writes; a machine on the host network has its own group (HostNetworkGroup). */
function hostsFromConfig(config: Config): HostEntry[] {
  return Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport !== 'net').map(([alias, h]) => ({
    _key: nextHostKey++,
    alias,
    hostname: h.hostname,
    user: h.user ?? '',
    port: h.port,
    label: h.label ?? '',
    shell_setup: h.shell_setup ?? '',
    enabled: h.enabled ?? true,
    discovered: h.discovered ?? false,
    ...(h.discovered && h.connect ? { connect: h.connect } : {}),
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
  // A found row that is a joined machine shows once, as that machine (it is still saved).
  const twins = useJoinedTwins(config.hosts);
  const [expanded, setExpanded] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits). Keyed by the same aliases
  // as the hosts above (plus "local"), so they belong on this card.
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  // Diagnostics cover SAVED, enabled hosts (the server's listStatusHosts), never a draft row.
  const hostCopy = useCopyDiagnostics('hosts');
  const hostLabels = Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [key, h?.label?.trim() || key]));

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);

  // A config that already says what the rows say (this editor's own save coming
  // back) keeps the rows as typed: rebuilding them would drop a comma typed in
  // "Leave out folders" before the save, and any draft row.
  // The same goes for the echo of a save sent before the latest typing (a label typed while
  // the Connect save was still out): the rows are newer than it, and the autosave writes them.
  const sentHostsRef = useRef<string | null>(null);
  useEffect(() => {
    const incoming = JSON.stringify(normalizeHosts(config.hosts));
    setHosts((prev) => (JSON.stringify(entriesToHosts(prev)) === incoming || incoming === sentHostsRef.current ? prev : hostsFromConfig(config)));
    setSessionLimits(config.session_limits ?? {});
  }, [config]);

  // Editing a found host that waits for the yes keeps it waiting: only Connect says yes
  // (src/core/hosts/found-hosts.ts), so a changed label never dials a host.
  const updateHost = <K extends keyof HostEntry>(idx: number, field: K, value: HostEntry[K]) => {
    setHosts((prev) => prev.map((h, i) => (i === idx ? { ...h, [field]: value } : h)));
  };

  // Connect / Not now on a found host: the server writes the answer (and dials on a yes);
  // the row takes it at once, and the config that comes back says the same.
  const [answering, setAnswering] = useState<{ alias: string; answer: 'yes' | 'not_now' } | null>(null);
  const [answerError, setAnswerError] = useState<{ alias: string; text: string } | null>(null);
  const answerFound = async (alias: string, answer: 'yes' | 'not_now') => {
    setAnswering({ alias, answer });
    setAnswerError(null);
    try {
      await answerFoundHost(alias, answer);
      setHosts((prev) => prev.map((h) => (h.alias === alias ? { ...h, connect: answer, enabled: answer === 'yes' } : h)));
    } catch (err) {
      setAnswerError({ alias, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setAnswering(null);
    }
  };

  const addHost = () => {
    setHosts((prev) => [...prev, emptyHost()]);
    setExpanded(hosts.length);
    setNewHostAt(hosts.length);
  };

  // Add host offers both ways in: the one-line join (no SSH) and an SSH host. 2026-11-04: it
  // only appended an empty SSH row at the bottom of the page, off screen, so a press looked
  // like nothing happened, and the join was not reachable from it at all.
  const [addMenu, setAddMenu] = useState<{ point: ContextMenuPoint; from: HTMLElement } | null>(null);
  const [joinNonce, setJoinNonce] = useState(0);
  const [newHostAt, setNewHostAt] = useState<number | null>(null);
  const openAddMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAddMenu({ point: { x: r.left, y: r.bottom + 4 }, from: e.currentTarget });
  };
  // The new SSH row: in view, its Alias field focused.
  useEffect(() => {
    if (newHostAt === null) return;
    const raf = requestAnimationFrame(() => {
      const input = document.getElementById(`rh-alias-${newHostAt}`);
      const row = input?.closest<HTMLElement>('.settings-row') ?? input;
      if (row) { landRef.current?.(); landRef.current = landOnRow(row, { focus: false }); }
      input?.focus({ preventScroll: true });
      setNewHostAt(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [newHostAt]);

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
    const sent = buildHostsConfig();
    sentHostsRef.current = JSON.stringify(normalizeHosts(sent));
    await onSave({ hosts: sent, session_limits: normalizeLimits(sessionLimits) });
  };

  // Fingerprint the VALIDATED hosts map (not raw entries) so typing a partial host, or a row
  // with no alias yet — doesn't trigger a write until it's a complete, savable entry.
  // A row with an alias or a hostname but not both is mid-edit. Saving then
  // would drop it from `hosts`, so clearing an alias to retype it deleted the
  // host. Hold the autosave until every started row is complete (Remove is the
  // way to delete one); a fresh blank row holds nothing back.
  const midEdit = hosts.some((h) => !h.alias !== !h.hostname);
  // `companion` names the cloud companion (its keep choice, its copy rounds): a new host may
  // not take it, and nothing saves while one row asks to. A host an older build saved under
  // it keeps saving, and its row asks for another alias.
  const savedUnderCompanion = !!config.hosts?.[COMPANION_ALIAS]?.hostname;
  const aliasRefusal = (h: HostEntry): string | null => companionAliasRefusal(h.alias, { saved: savedUnderCompanion });
  const aliasTaken = !savedUnderCompanion && hosts.some((h) => aliasRefusal(h) !== null);
  useSettingsAutoSave({
    current: JSON.stringify({ hosts: buildHostsConfig(), limits: normalizeLimits(sessionLimits) }),
    baseline: JSON.stringify({ hosts: normalizeHosts(config.hosts), limits: normalizeLimits(config.session_limits ?? {}) }),
    save: handleSave,
    enabled: !midEdit && !aliasTaken,
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
      error={field === 'alias' ? aliasRefusal(hosts[idx]) ?? undefined : undefined}
      control={
        <input
          id={`rh-${field}-${idx}`}
          type="text"
          data-no-draft="autosave"
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
    return (
      <ReplicaKeepRows
        idOf={(field) => `rh-keep-${field}-${idx}`}
        name={hostName(hosts[idx], idx)}
        keep={keep}
        excludeText={hosts[idx].excludeText ?? (keep.notes_exclude ?? []).join(', ')}
        onKeep={(patch) => updateKeep(idx, patch)}
        onExcludeText={(text) => updateHost(idx, 'excludeText', text)}
        ownWork="Its sessions, their tasks, triggers, the team Board and replies are always kept."
      />
    );
  };

  const addButton = (
    <SettingsButton onClick={openAddMenu} aria-haspopup="menu" aria-expanded={!!addMenu} data-testid="remote-hosts-add">Add host</SettingsButton>
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
      <HostFleetGroup />
      <SettingsGroup heading="Hosts">
        {hosts.every((h) => twins[h.alias]) && (
          <SettingsRow label="No remote hosts yet." control={addButton} />
        )}
        {hosts.map((host, idx) => {
          if (twins[host.alias]) return null;
          const open = expanded === idx;
          const sub = hostSub(host, idx);
          const alias = hostAlias(host);
          // Found in ~/.ssh/config and not connected yet: the question instead of the switch.
          const found = host.alias && waitsForYes(host) ? host.connect : null;
          const busyAnswer = answering?.alias === host.alias;
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
                help={found
                  ? <span data-testid="rh-found-question">{found === 'ask'
                    ? `Walnut found ${host.alias} in ~/.ssh/config. Connect to it?`
                    : `Found in ~/.ssh/config. Walnut does not connect to it.`}</span>
                  : host.alias ? <RemoteHostStatus alias={host.alias} name={hostName(host, idx)} enabled={host.enabled} /> : 'Add an alias and hostname to save this host.'}
                // The failure and the readiness lines, below the status line (spec 5.2 / 5.3).
                children={found
                  ? (answerError?.alias === host.alias ? <span className="rh-status-error">{answerError.text}</span> : undefined)
                  : host.alias ? <RemoteHostDetail alias={host.alias} name={hostName(host, idx)} enabled={host.enabled} /> : undefined}
                data-found={found ?? undefined}
                // Off: only the name and address fade; Edit, Remove and the
                // switch that turns it back on stay at full strength (N10).
                data-host-off={host.enabled || found ? undefined : 'true'}
                control={
                  <>
                    {/* Remove first: its reserved width for "Confirm remove" opens on
                        the copy side, so Remove and Edit sit together (N3-20). */}
                    <InlineConfirmButton aria-label={`Remove ${hostName(host, idx)}`} onConfirm={() => removeHost(idx)} />
                    <SettingsButton variant="text" aria-expanded={open} onClick={() => setExpanded(open ? null : idx)}>
                      {open ? 'Done' : 'Edit'}
                    </SettingsButton>
                    {found ? (
                      <>
                        {found === 'ask' && (
                          <SettingsButton variant="text" disabled={busyAnswer} onClick={() => void answerFound(host.alias, 'not_now')} data-testid="rh-found-not-now">
                            Not now
                          </SettingsButton>
                        )}
                        <SettingsButton disabled={busyAnswer} onClick={() => void answerFound(host.alias, 'yes')} data-testid="rh-found-connect"
                          aria-label={`Connect to ${hostName(host, idx)}`}>
                          {busyAnswer && answering?.answer === 'yes' ? 'Connecting...' : 'Connect'}
                        </SettingsButton>
                      </>
                    ) : (
                      <ToggleSwitch
                        checked={host.enabled}
                        onChange={(v) => updateHost(idx, 'enabled', v)}
                        aria-label={`Use ${hostName(host, idx)}`}
                      />
                    )}
                  </>
                }
              />
              {/* What Walnut has learned about the host: collapsed, loads on open. */}
              {host.alias && host.hostname && !open && <HostProfileDisclosure alias={host.alias} name={hostName(host, idx)} />}
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
                        data-no-draft="autosave"
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

      <HostNetworkGroup addNonce={joinNonce} />
      {addMenu && (
        <ContextMenu
          point={addMenu.point}
          ariaLabel="Add a host"
          testId="remote-hosts-add-menu"
          returnFocus={addMenu.from}
          onClose={() => setAddMenu(null)}
          items={[
            { key: 'join', label: 'A machine, with a one-line command (no SSH)', title: 'Makes a one-use link you run on the new machine', onSelect: () => setJoinNonce((n) => n + 1) },
            { key: 'ssh', label: 'An SSH host', title: 'A host this machine reaches with ssh', onSelect: addHost },
          ]}
        />
      )}
      <HostServersGroup hosts={config.hosts} />
      <HostExecGrantsGroup hostLabels={hostLabels} />
      <SecretsGroup hostLabels={hostLabels} />
      <ReplicaRemovalGroup
        only="host"
        labels={Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [`host:${key}`, h?.label?.trim() || key]))}
      />

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
