/**
 * Settings > Remote Hosts: one SSH host in the list of machines (HostRow.tsx). Its one action
 * follows its state (useLinkedHostRow.tsx); a host found in ~/.ssh/config asks Connect (Not now
 * is in its menu); a new row offers Cancel. Edit opens the fields in place: hostname, alias, user
 * and port first, the rest under More options. Escape closes them (and takes away a new row
 * nobody typed in).
 *
 * A new row says "Not saved" and keeps its fields open until it saves (2026-11-04 review: a
 * hostname with no alias turned into a normal-looking row and was dropped with the pane). Its
 * alias follows the hostname until the person types one. It saves on Add and connect, or Enter in
 * one of its fields, never when the focus leaves a field (2026-11-05 review: a half-typed host
 * was saved and counted as needing a look), and that save dials it. It has no More menu: Cancel is
 * its one way out. An empty alias is refused under the field only once the person typed in it and
 * left it, or pressed Add (never on tabbing in); so is a hostname that is no host ("not a host!!").
 *
 * A row whose alias is refused (another host has it, or it has none) shows no status and no
 * row id: it is a draft until it has an alias of its own (remote-hosts-model.ts). An alias of
 * its own with no hostname yet already follows that alias's status (C42).
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import { SettingsDisclosure, SettingsRow, SettingsTag } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { SettingsButton } from '../inputs/SettingsButton';
import { HostDetails } from './HostDetails';
import { HostRow, RowLine, type RowMenuItem, type RowPrimary } from './HostRow';
import { ReplicaKeepRows, type ReplicaKeep } from './ReplicaKeepRows';
import { useLinkedHostRow } from './useLinkedHostRow';
import { hostnameProblem, untouchedDraft } from './host-row-model';
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
  /** An empty-alias refusal may show (left empty after typing, or Save pressed). */
  aliasShown: boolean;
  /** config.yaml has this host under its alias now (only then is there anything to connect). */
  saved: boolean;
  /** A hostname refusal may show (the field left holding no host, or Add pressed). */
  hostShown: boolean;
  /** Add and connect was pressed and its save has not landed yet. */
  adding: boolean;
  /** Why the last Add and connect did not save. */
  addError: string | null;
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
  onTurnOn: () => void;
  onHostnameLeft: () => void;
  onAliasLeft: () => void;
  /** Add and connect: the field it still needs (which then takes the focus), or null. */
  onAdd: () => 'hostname' | 'alias' | null;
  /** A Turn on or Connect whose dial waits (Connecting...), and when it was asked. */
  connecting: boolean;
  pressedAt?: number;
  /** What asked it to dial (a Turn on, an Add and connect), for the words of a failure. */
  askedAs?: { as: 'turn-on' | 'add'; at: number };
  /** A found host's answer running now, and its refusal. */
  answering: 'yes' | 'not_now' | null;
  answerError: string | null;
  onAnswer: (answer: 'yes' | 'not_now') => void;
}

export function RemoteHostSshRow(props: Props) {
  const { host, idx, editing, detailsOpen, refusal, blocking, saved, card, now } = props;
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
  // A new row not saved yet: "Not saved", its fields open, Cancel its one way out.
  const unsaved = host.savedAlias === undefined && !linked;
  const live = useLinkedHostRow({
    alias: named ? host.alias : `draft-${host._key}`, name, enabled: host.enabled, saved: linked, card, now,
    boot: props.boot, onBootStart: props.onBootStart, via: 'ssh', connecting: props.connecting || props.answering === 'yes', pressedAt: props.pressedAt, askedAs: props.askedAs,
  });
  const fresh = untouchedDraft(host);
  // The empty-alias refusal waits until the person left the field empty or pressed Save.
  const emptyAlias = !host.alias.trim();
  const aliasError = refusal && (!emptyAlias || props.aliasShown) ? refusal : null;
  const badHost = hostnameProblem(host.hostname);
  const hostError = props.hostShown ? badHost ?? (!host.hostname.trim() && unsaved ? 'Type the host Walnut reaches with ssh, like build7.example.com.' : null) : null;
  const open = editing || unsaved;

  let state: ReactNode = live.state;
  let primary: RowPrimary | null = live.primary;
  const lines: ReactNode[] = [];
  if (found) {
    state = <span data-testid="rh-found-question">{found === 'ask' ? `Walnut found ${host.alias} in ~/.ssh/config. Connect to it?` : 'Found in ~/.ssh/config. Walnut does not connect to it.'}</span>;
    primary = {
      label: props.answering === 'yes' ? 'Connecting...' : 'Connect now', reserve: ['Connect now', 'Connecting...'], disabled: props.answering !== null,
      testId: 'rh-found-connect', ariaLabel: `Connect now: ${name}`, onClick: () => props.onAnswer('yes'),
    };
    if (props.answerError) lines.push(<RowLine key="ae" tone="bad">{props.answerError}</RowLine>);
  } else if (!linked) {
    state = refusal && !emptyAlias ? 'Not saved until it has an alias of its own.'
      : !host.hostname.trim() ? 'Add a hostname to save this host.'
      : badHost ? 'Not saved: its hostname is not one Walnut can reach.'
      : emptyAlias ? 'Add an alias to save this host.'
      : props.adding ? 'Saving...'
      : unsaved ? 'Not saved yet: Add and connect saves it.'
      : 'Saving...';
    primary = unsaved ? { label: 'Cancel', testId: 'rh-draft-cancel', ariaLabel: fresh ? 'Cancel the new host' : `Cancel ${name}: it is not saved`, onClick: props.onRemove } : null;
    if (props.addError) lines.push(<RowLine key="ae" tone="bad" testId="rh-add-error">{props.addError}</RowLine>);
  } else if (!host.enabled) {
    primary = { label: 'Turn on', reserve: ['Turn on', 'Connecting...'], testId: 'rh-turn-on', ariaLabel: `Turn on ${name}`, onClick: props.onTurnOn };
  }
  // A refusal that does not hold the save (the companion's alias, kept): said under the state.
  if (refusal && !blocking && linked && !editing) lines.push(<RowLine key="rf" tone="warn">{refusal}</RowLine>);

  const menu: RowMenuItem[] = unsaved ? [] : [
    { key: 'edit', label: editing ? 'Done editing' : 'Edit', onSelect: () => props.onEdit(!editing) },
    ...(found === 'ask' ? [{ key: 'not-now', label: 'Not now', disabled: props.answering !== null, onSelect: () => props.onAnswer('not_now') }] : []),
    ...(linked && !found ? [{ key: 'details', label: detailsOpen ? 'Hide details' : 'Details', onSelect: () => props.onDetails(!detailsOpen) }] : []),
    ...(linked && !found && host.enabled ? [{ key: 'turn-off', label: 'Turn off', title: 'Walnut stops connecting to it; sessions there stop.', onSelect: () => props.onField('enabled', false) }] : []),
  ];

  // Add and connect: the field it still needs takes the focus (its reason is under it).
  const editRef = useRef<HTMLDivElement>(null);
  const add = () => {
    const field = props.onAdd();
    if (field) requestAnimationFrame(() => editRef.current?.querySelector<HTMLInputElement>(`#rh-${field}-${idx}`)?.focus());
  };
  // Escape closes the fields of a saved host; a new row keeps them open (it is not saved), and
  // one nobody typed in goes. Enter in a new row's field is Add and connect.
  const closeEdit = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && unsaved && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // The field's own leave runs first, so "sam@build7:2222" is split before the check.
      if (e.target.id === `rh-hostname-${idx}`) props.onHostnameLeft();
      add();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (fresh) props.onRemove(); else if (!unsaved) props.onEdit(false);
  };

  // Typed in Alias since it took the focus: leaving it empty then is a refusal to show.
  const typedAlias = useRef(false);
  const text = (field: TextField, label: string, placeholder: string, size: 'short' | 'long', mono = false) => (
    <SettingsRow
      label={label}
      htmlFor={`rh-${field}-${idx}`}
      indent
      wide={size === 'long'}
      error={field === 'alias' ? aliasError ?? undefined : field === 'hostname' ? hostError ?? undefined : undefined}
      control={
        <input
          id={`rh-${field}-${idx}`}
          type="text"
          data-no-draft="autosave"
          className={`settings-input settings-input--${size}${mono ? ' settings-input--mono' : ''}`}
          value={host[field]}
          onChange={(e) => { if (field === 'alias') typedAlias.current = true; props.onField(field, e.target.value); }}
          onFocus={() => { if (field === 'alias') typedAlias.current = false; }}
          onBlur={(e) => {
            if (field === 'hostname') props.onHostnameLeft();
            if (field === 'alias' && typedAlias.current && !e.currentTarget.value.trim()) props.onAliasLeft();
          }}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={(field === 'alias' && aliasError) || (field === 'hostname' && hostError) ? true : undefined}
        />
      }
    />
  );

  const edit = open && (
    <div className="rh-edit" data-testid="rh-edit" onKeyDown={closeEdit} ref={editRef}>
      {text('hostname', 'Hostname', 'host.example.com', 'long', true)}
      {text('alias', 'Alias', props.aliasPlaceholder, 'short', true)}
      {text('user', 'User', 'Your user name there', 'short')}
      <SettingsRow
        label="Port"
        htmlFor={`rh-port-${idx}`}
        indent
        control={<NumberInput id={`rh-port-${idx}`} value={host.port} onChange={(v) => props.onField('port', v)} placeholder="22" min={1} max={65535} />}
      />
      <SettingsDisclosure id={`rh-more-options-${host._key}`} label="More options" summary="Label, setup commands, what it keeps" indent data-testid="rh-more-options">
        {text('label', 'Label', 'Display name', 'short')}
        <SettingsRow
          label="Setup commands"
          htmlFor={`rh-shell-${idx}`}
          help="Run on the host before each session starts there."
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
      {/* A new row saves only here (or on Enter in one of its fields); its way out is the Cancel
          on the row. */}
      {unsaved && (
        <SettingsRow
          indent
          className="rh-edit-done"
          help="Enter in a field does the same."
          control={
            <SettingsButton variant="primary" holdFocus busy={props.adding} busyLabel="Adding..." reserve={['Add and connect', 'Adding...']} onClick={add} data-testid="rh-add-connect">
              Add and connect
            </SettingsButton>
          }
        />
      )}
      {!unsaved && (
        <SettingsRow
          indent
          className="rh-edit-done"
          help={linked ? 'Changes save as you type.' : undefined}
          control={<SettingsButton variant="text" onClick={() => props.onEdit(false)} data-testid="rh-edit-done">Done</SettingsButton>}
        />
      )}
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
      onRemove={unsaved ? undefined : props.onRemove}
      removeNote={linked ? 'Walnut stops connecting to it. Its sessions stop; nothing on the host is deleted.' : undefined}
      off={!host.enabled && !found}
      needsLook={linked && !found && live.needsLook}
      unsaved={unsaved}
      report={found ? {
        // A row of the list, waiting for a yes: in the summary's "found" count, not the fleet's.
        host: host.alias, counted: false, found: true, online: false, off: false, local: false, via: 'ssh',
        rttMs: null, sessions: null, spendUsd: null, sub: host.hostname,
      } : linked ? {
        host: host.alias, counted: true, online: live.online, off: !host.enabled, local: false, via: 'ssh', phone: card?.server?.phone === 'connected',
        rttMs: card?.connection.connected ? card.connection.rttMs ?? null : null,
        sessions: card?.sessions.running ?? null, spendUsd: card?.spend?.last30dUsd ?? null,
        sub: card?.system?.os ?? host.hostname,
      } : undefined}
      data={{ 'data-found': found ?? undefined }}
      panel={
        <>
          {edit}
          {detailsOpen && linked && <HostDetails alias={host.alias} name={name} card={card} now={now} linked={host.enabled} profile kind="ssh" onClose={() => props.onDetails(false)} />}
        </>
      }
    />
  );
}
