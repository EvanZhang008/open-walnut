/**
 * Settings > Remote Hosts: one SSH host in the list of machines (HostRow.tsx). Its one action
 * follows its state (useLinkedHostRow.tsx); a host found in ~/.ssh/config asks Connect (Not now
 * is in its menu); an untouched new row offers Cancel. Edit opens the fields in place: hostname,
 * alias, user and port first, the rest under More options. Escape closes them (and takes away
 * a new row nobody typed in).
 *
 * A row whose alias is refused (another host has it, or it has none) shows no status and no
 * row id: it is a draft until it has an alias of its own (remote-hosts-model.ts). An alias of
 * its own with no hostname yet already follows that alias's status (C42).
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import { SettingsDisclosure, SettingsRow, SettingsTag } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { SettingsButton } from '../inputs/SettingsButton';
import { HostDetails } from './HostDetails';
import { HostRow, RowLine, type RowMenuItem, type RowPrimary } from './HostRow';
import { ReplicaKeepRows, type ReplicaKeep } from './ReplicaKeepRows';
import { useLinkedHostRow } from './useLinkedHostRow';
import { untouchedDraft } from './host-row-model';
import { hostName, waitsForYes, type HostEntry } from './remote-hosts-model';
import type { ActionState } from './useHostFleet';
import { hostRowId } from '@/utils/host-settings-nav';

type TextField = 'alias' | 'hostname' | 'user' | 'label';

interface Props {
  host: HostEntry;
  idx: number;
  editing: boolean;
  detailsOpen: boolean;
  /** Why its alias is refused, shown under the Alias field (and as the state line while closed). */
  refusal: string | null;
  /** The refusal holds the save (not the companion's alias on the host saved under it). */
  blocking: boolean;
  /** config.yaml has this host under its alias now (only then is there anything to connect). */
  saved: boolean;
  /** The save that wrote it just landed: the row says Saved for a moment. */
  justSaved: boolean;
  aliasPlaceholder: string;
  card?: FleetHost;
  now: number;
  boot?: ActionState;
  onBootStart: () => void;
  onEdit: (open: boolean) => void;
  onDetails: (open: boolean) => void;
  onField: <K extends keyof HostEntry>(field: K, value: HostEntry[K]) => void;
  onKeep: (patch: Partial<ReplicaKeep>) => void;
  onRemove: () => void;
  /** A found host's answer running now, and its refusal. */
  answering: 'yes' | 'not_now' | null;
  answerError: string | null;
  onAnswer: (answer: 'yes' | 'not_now') => void;
}

export function RemoteHostSshRow(props: Props) {
  const { host, idx, editing, detailsOpen, refusal, blocking, saved, justSaved, card, now } = props;
  // A row with nothing typed yet is the new host, not "Host 5".
  const name = host.label || host.alias || host.hostname ? hostName(host, idx) : 'New SSH host';
  // The row title is the label; the alias follows it in muted mono, then the hostname (the only part that truncates).
  const alias = host.label && host.alias && host.alias !== host.label ? host.alias : '';
  const sub = host.hostname && host.hostname !== name && host.hostname !== host.alias ? host.hostname : '';
  // Its status and row id follow its alias once the alias is its own.
  const named = !!host.alias && (!refusal || !blocking);
  const saveable = named && !!host.hostname;
  // Found in ~/.ssh/config and not connected yet: the question instead of a status.
  const found = saveable && waitsForYes(host) ? host.connect : null;
  const linked = saveable && saved;
  const live = useLinkedHostRow({
    alias: named ? host.alias : `draft-${host._key}`, name, enabled: host.enabled, saved: linked, card, now,
    boot: props.boot, onBootStart: props.onBootStart,
  });
  const fresh = untouchedDraft(host);

  let state: ReactNode = live.state;
  let primary: RowPrimary | null = live.primary;
  const lines: ReactNode[] = [];
  if (found) {
    state = <span data-testid="rh-found-question">{found === 'ask' ? `Walnut found ${host.alias} in ~/.ssh/config. Connect to it?` : 'Found in ~/.ssh/config. Walnut does not connect to it.'}</span>;
    primary = {
      label: props.answering === 'yes' ? 'Connecting...' : 'Connect', reserve: ['Connect', 'Connecting...'], disabled: props.answering !== null,
      testId: 'rh-found-connect', ariaLabel: `Connect to ${name}`, onClick: () => props.onAnswer('yes'),
    };
    if (props.answerError) lines.push(<RowLine key="ae" tone="bad">{props.answerError}</RowLine>);
  } else if (!linked) {
    state = refusal && !editing ? refusal
      : refusal && host.alias.trim() ? 'Not saved until it has an alias of its own.'
      : saveable ? 'Saving...'
      : `Add ${[!host.hostname.trim() && 'a hostname', !host.alias.trim() && 'an alias'].filter(Boolean).join(' and ')} to save this host.`;
    primary = fresh ? { label: 'Cancel', testId: 'rh-draft-cancel', ariaLabel: 'Cancel the new host', onClick: props.onRemove } : null;
  } else if (!host.enabled) {
    primary = { label: 'Turn on', testId: 'rh-turn-on', ariaLabel: `Turn on ${name}`, onClick: () => props.onField('enabled', true) };
  }
  // A refusal that does not hold the save (the companion's alias, kept): said under the state.
  if (refusal && !blocking && linked && !editing) lines.push(<RowLine key="rf" tone="warn">{refusal}</RowLine>);
  if (justSaved) lines.push(<RowLine key="saved" tone="good" testId="rh-row-saved">Saved.</RowLine>);

  const menu: RowMenuItem[] = [
    { key: 'edit', label: editing ? 'Done editing' : 'Edit', onSelect: () => props.onEdit(!editing) },
    ...(found === 'ask' ? [{ key: 'not-now', label: 'Not now', disabled: props.answering !== null, onSelect: () => props.onAnswer('not_now') }] : []),
    ...(linked && !found ? [{ key: 'details', label: detailsOpen ? 'Hide details' : 'Details', onSelect: () => props.onDetails(!detailsOpen) }] : []),
    ...(linked && !found && host.enabled ? [{ key: 'turn-off', label: 'Turn off', title: 'Walnut stops connecting to it; sessions there stop.', onSelect: () => props.onField('enabled', false) }] : []),
    ...(live.hidden ? [{ key: 'show-again', label: 'Show again on the home page', onSelect: live.showOnBanner }] : []),
  ];

  const closeEdit = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    if (fresh) props.onRemove(); else props.onEdit(false);
  };

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
          onChange={(e) => props.onField(field, e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={field === 'alias' && refusal ? true : undefined}
        />
      }
    />
  );

  const edit = editing && (
    <div className="rh-edit" data-testid="rh-edit" onKeyDown={closeEdit}>
      {text('hostname', 'Hostname', 'host.example.com', 'long', true)}
      {text('alias', 'Alias', props.aliasPlaceholder, 'short', true)}
      {text('user', 'User', 'SSH user name', 'short')}
      <SettingsRow
        label="Port"
        htmlFor={`rh-port-${idx}`}
        indent
        control={<NumberInput id={`rh-port-${idx}`} value={host.port} onChange={(v) => props.onField('port', v)} placeholder="22" min={1} max={65535} />}
      />
      <SettingsDisclosure id={`rh-more-options-${host._key}`} label="More options" summary="Label, shell setup, what it keeps" indent data-testid="rh-more-options">
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
              onChange={(e) => props.onField('shell_setup', e.target.value)}
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
          onKeep={props.onKeep}
          onExcludeText={(t) => props.onField('excludeText', t)}
          ownWork="Its sessions, their tasks, triggers, the team Board and replies are always kept."
        />
      </SettingsDisclosure>
      <SettingsRow
        indent
        className="rh-edit-done"
        help={linked ? 'Changes save as you type.' : 'It saves once it has a hostname and an alias of its own.'}
        // An untouched new row's one way out is its Cancel, on the row (never a second one here).
        control={fresh ? undefined : <SettingsButton variant="text" onClick={() => props.onEdit(false)} data-testid="rh-edit-done">Done</SettingsButton>}
      />
    </div>
  );

  return (
    <HostRow
      rowKey={`ssh:${host._key}`}
      id={named ? hostRowId(host.alias) : undefined}
      alias={named ? host.alias : undefined}
      name={name}
      sub={
        <>
          {alias && <span className="rh-host-alias">{alias}</span>}
          {sub && <span className="settings-addons-mono settings-addons-muted settings-addons-ellipsis rh-host-hostname" title={sub}>{sub}</span>}
        </>
      }
      tag={<SettingsTag title={host.discovered ? 'Found in ~/.ssh/config: Walnut reaches it with ssh' : 'Walnut reaches it with ssh'}>SSH</SettingsTag>}
      dot={live.dot}
      state={state}
      lines={[...live.lines, ...lines]}
      primary={primary}
      menu={menu}
      onRemove={fresh ? undefined : props.onRemove}
      removeNote={linked ? 'Walnut stops connecting to it. Its sessions stop; nothing on the host is deleted.' : undefined}
      off={!host.enabled && !found}
      needsLook={linked && !found && live.needsLook}
      data={{ 'data-found': found ?? undefined }}
      panel={
        <>
          {edit}
          {detailsOpen && linked && <HostDetails alias={host.alias} name={name} card={card} now={now} linked={host.enabled} profile />}
        </>
      }
    />
  );
}
