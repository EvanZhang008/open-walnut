/**
 * Settings > Remote Hosts: one SSH host in the Hosts list. The row: its name (the label the
 * banner and the picker use), alias and hostname, an SSH tag, its status line, then Remove,
 * Edit and its Use switch (a host found in ~/.ssh/config asks Connect to it? instead). Edit
 * opens its fields, what it keeps, and "What Walnut knows" about it.
 *
 * A row whose alias is refused (another host has it, or it has none) shows no status and no
 * row id: it is a draft until it has an alias of its own (remote-hosts-model.ts). An alias of
 * its own with no hostname yet already follows that alias's status (C42).
 */
import type { ReactNode } from 'react';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { RemoteHostDetail, RemoteHostStatus } from './RemoteHostStatus';
import { HostProfileDisclosure } from './HostProfileDisclosure';
import { ReplicaKeepRows, type ReplicaKeep } from './ReplicaKeepRows';
import { hostName, waitsForYes, type HostEntry } from './remote-hosts-model';
import { hostRowId } from '@/utils/host-settings-nav';

type TextField = 'alias' | 'hostname' | 'user' | 'label';

interface Props {
  host: HostEntry;
  idx: number;
  open: boolean;
  /** Why its alias is refused, shown under the Alias field (and under the name while closed). */
  refusal: string | null;
  /** The refusal holds the save (not the companion's alias on the host saved under it). */
  blocking: boolean;
  /** config.yaml has this host under its alias now (only then is there anything to connect). */
  saved: boolean;
  onToggle: () => void;
  onField: <K extends keyof HostEntry>(field: K, value: HostEntry[K]) => void;
  onKeep: (patch: Partial<ReplicaKeep>) => void;
  onRemove: () => void;
  /** A found host's answer running now, and its refusal. */
  answering: 'yes' | 'not_now' | null;
  answerError: string | null;
  onAnswer: (answer: 'yes' | 'not_now') => void;
}

export function RemoteHostSshRow({ host, idx, open, refusal, blocking, saved, onToggle, onField, onKeep, onRemove, answering, answerError, onAnswer }: Props) {
  const name = hostName(host, idx);
  // The row title is the label; the alias follows it in muted mono, then the hostname (the only part that truncates).
  const alias = host.label && host.alias && host.alias !== host.label ? host.alias : '';
  const sub = host.hostname && host.hostname !== name && host.hostname !== host.alias ? host.hostname : '';
  // Its status and row id follow its alias once the alias is its own.
  const named = !!host.alias && (!refusal || !blocking);
  const saveable = named && !!host.hostname;
  // Found in ~/.ssh/config and not connected yet: the question instead of the switch.
  const found = saveable && waitsForYes(host) ? host.connect : null;
  const busy = answering !== null;
  const switchId = `rh-use-${host._key}`;

  const text = (field: TextField, label: string, placeholder: string, size: 'short' | 'long', mono = false) => (
    <SettingsRow
      label={label}
      htmlFor={`rh-${field}-${idx}`}
      indent
      wide={size === 'long'}
      error={field === 'alias' ? refusal ?? undefined : undefined}
      control={
        <input
          id={`rh-${field}-${idx}`}
          type="text"
          data-no-draft="autosave"
          className={`settings-input settings-input--${size}${mono ? ' settings-input--mono' : ''}`}
          value={host[field]}
          onChange={(e) => onField(field, e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={field === 'alias' && refusal ? true : undefined}
        />
      }
    />
  );

  let help: ReactNode;
  if (found) {
    help = <span data-testid="rh-found-question">{found === 'ask' ? `Walnut found ${host.alias} in ~/.ssh/config. Connect to it?` : 'Found in ~/.ssh/config. Walnut does not connect to it.'}</span>;
  } else if (named) {
    help = <RemoteHostStatus alias={host.alias} name={name} enabled={host.enabled} canConnect={saved} />;
  } else {
    // Open, the refusal sits under Alias; the row says only why it is not saved.
    help = refusal && !open ? refusal
      : refusal && host.alias.trim() ? 'Not saved until it has an alias of its own.'
      : 'Add an alias and hostname to save this host.';
  }

  return (
    <>
      <SettingsRow
        className="rh-host-row"
        id={named ? hostRowId(host.alias) : undefined}
        data-host-alias={named ? host.alias : undefined}
        data-row-key={`ssh:${host._key}`}
        state={refusal && !open ? 'warning' : undefined}
        label={
          <span className="settings-addons-inline">
            <span className="rh-host-name" title={name}>{name}</span>
            {alias && <span className="rh-host-alias">{alias}</span>}
            {sub && <span className="settings-addons-mono settings-addons-muted settings-addons-ellipsis rh-host-hostname" title={sub}>{sub}</span>}
            <SettingsTag title={host.discovered ? 'Found in ~/.ssh/config: Walnut reaches it with ssh' : 'Walnut reaches it with ssh'}>SSH</SettingsTag>
          </span>
        }
        help={help}
        // The failure and the readiness lines, below the status line (spec 5.2 / 5.3).
        children={found
          ? (answerError ? <span className="rh-status-error">{answerError}</span> : undefined)
          : named ? (
            <>
              {/* A refusal that does not hold the save (the companion's alias, kept): said under the status. */}
              {refusal && !open && <span className="rh-readiness-note">{refusal}</span>}
              <RemoteHostDetail alias={host.alias} name={name} enabled={host.enabled} />
            </>
          ) : undefined}
        data-found={found ?? undefined}
        // Off: only the name and address fade; Edit, Remove and the switch stay at full strength (N10).
        data-host-off={host.enabled || found ? undefined : 'true'}
        control={
          <>
            {/* Remove first: its reserved width for "Confirm remove" opens on the copy side (N3-20). */}
            <InlineConfirmButton quiet aria-label={`Remove ${name}`} onConfirm={onRemove} />
            <SettingsButton variant="text" aria-expanded={open} onClick={onToggle}>{open ? 'Done' : 'Edit'}</SettingsButton>
            {found ? (
              <>
                {found === 'ask' && (
                  <SettingsButton variant="text" disabled={busy} onClick={() => onAnswer('not_now')} data-testid="rh-found-not-now">Not now</SettingsButton>
                )}
                <SettingsButton variant="text" disabled={busy} reserve={['Connect', 'Connecting...']} onClick={() => onAnswer('yes')} data-testid="rh-found-connect" aria-label={`Connect to ${name}`}>
                  {answering === 'yes' ? 'Connecting...' : 'Connect'}
                </SettingsButton>
              </>
            ) : (
              <span className="rh-use">
                <label className="rh-use-label" htmlFor={switchId}>Use</label>
                <ToggleSwitch id={switchId} checked={host.enabled} onChange={(v) => onField('enabled', v)} aria-label={`Use ${name}`} />
              </span>
            )}
          </>
        }
      />
      {open && (
        <>
          {text('alias', 'Alias', 'devbox', 'short', true)}
          {text('hostname', 'Hostname', 'host.example.com', 'long', true)}
          {text('user', 'User', 'SSH user name', 'short')}
          <SettingsRow
            label="Port"
            htmlFor={`rh-port-${idx}`}
            indent
            control={<NumberInput id={`rh-port-${idx}`} value={host.port} onChange={(v) => onField('port', v)} placeholder="22" min={1} max={65535} />}
          />
          {text('label', 'Label', 'Display name', 'short')}
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
                onChange={(e) => onField('shell_setup', e.target.value)}
                rows={3}
                placeholder="source $HOME/.nvm/nvm.sh"
              />
            }
          />
          {/* What the host keeps a read copy of, for its sessions while this Mac cannot answer. */}
          <ReplicaKeepRows
            idOf={(field) => `rh-keep-${field}-${idx}`}
            name={name}
            keep={host.keep ?? {}}
            excludeText={host.excludeText ?? (host.keep?.notes_exclude ?? []).join(', ')}
            onKeep={onKeep}
            onExcludeText={(t) => onField('excludeText', t)}
            ownWork="Its sessions, their tasks, triggers, the team Board and replies are always kept."
          />
          {/* What Walnut has learned about the host (a saved one): collapsed, loads on open. */}
          {saveable && saved && <HostProfileDisclosure alias={host.alias} name={name} />}
        </>
      )}
    </>
  );
}
