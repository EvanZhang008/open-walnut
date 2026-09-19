/**
 * One row per engine setting, rendered from the server's descriptor.
 *
 * Nothing here knows an engine or a key: the row's type, options, suggestions,
 * bounds and help text all arrive as data, so a new setting on any engine is a
 * data change on the server and no code change here.
 *
 * Three rules the rows encode:
 *   - A row says WHERE its value comes from (the file, an older location the
 *     engine still reads, or the engine's default) and when an environment
 *     variable is winning over the file. A control that looks effective while a
 *     variable overrides it is the bug this line exists to prevent.
 *   - Text and number fields commit on blur or Enter, never per keystroke: every
 *     write is a read-modify-write of a file the engine owns.
 *   - A saving row is disabled through a native `<fieldset disabled>`, which
 *     really disables its controls (keyboard included) without teaching every
 *     shared input a `disabled` prop.
 */
import { useEffect, useState } from 'react';
import { SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import type {
  EngineSettingValue,
  EngineSettingView,
  EngineSettingsFileView,
} from '@/api/engine-settings';

/** Sentinel option value for "type a value that is not in the list". */
const CUSTOM_OPTION = '__walnut_custom__';

export function controlId(engine: string, key: string): string {
  return `engine-setting-${engine}-${key}`;
}

function fileLabel(files: EngineSettingsFileView[], id: string): string {
  return files.find((f) => f.id === id)?.label ?? id;
}

/**
 * The one status line under a row's help text.
 *
 * The legacy case deliberately degrades: the view names the older location only
 * when the server sends it, and inventing a path from the file list would
 * confidently point at the wrong file on any engine with more than two.
 */
export function settingStatusLine(item: EngineSettingView, files: EngineSettingsFileView[]): string {
  if (item.source === 'file') return `Set in ${fileLabel(files, item.file)}`;
  if (item.source === 'legacy') {
    return item.legacy?.path
      ? `From ${item.legacy.path} (older location, still read)`
      : 'From an older location that the engine still reads';
  }
  return item.defaultLabel && item.value === null ? `Default: ${item.defaultLabel}` : 'Default';
}

interface ControlProps {
  id: string;
  item: EngineSettingView;
  onSet: (key: string, value: EngineSettingValue) => void;
}

function NumberSettingControl({ id, item, onSet }: ControlProps) {
  const stored = typeof item.value === 'number' ? item.value : undefined;
  const [draft, setDraft] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  // A fresh server value (our own write landing, or a reload) ends the edit.
  useEffect(() => { setDraft(undefined); setEditing(false); }, [item.value, item.source]);

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    // An emptied number field is not a value: only text fields mean "unset" when
    // cleared, so this falls back to what is stored instead of writing null.
    if (draft === undefined || draft === stored) { setDraft(undefined); return; }
    onSet(item.key, draft);
  };

  return (
    <NumberInput
      id={id}
      value={editing ? draft : stored}
      onChange={(v) => { setDraft(v); setEditing(true); }}
      onBlur={commit}
      onEnter={commit}
      min={item.min}
      max={item.max}
      placeholder={item.placeholder ?? 'default'}
    />
  );
}

function TextSettingControl({ id, item, onSet }: ControlProps) {
  const stored = typeof item.value === 'string' ? item.value : '';
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [item.value, item.source]);

  const listId = item.suggestions?.length ? `${id}-suggestions` : undefined;

  const commit = () => {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    // Empty means "back to the engine's default" by contract; unchanged means
    // nothing to write, so a blur after a stray keystroke costs no file rewrite.
    if (next === stored) return;
    onSet(item.key, next);
  };

  return (
    <>
      <input
        id={id}
        type="text"
        className="engine-setting-text"
        value={draft ?? stored}
        list={listId}
        placeholder={item.placeholder ?? 'default'}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
        }}
      />
      {listId && (
        <datalist id={listId}>
          {item.suggestions?.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </>
  );
}

function SelectSettingControl({ id, item, onSet }: ControlProps) {
  const options = item.options ?? [];
  const current = item.value === null ? '' : String(item.value);
  const known = options.some((o) => o.value === current);
  /** Non-null while the custom text input is open. */
  const [custom, setCustom] = useState<string | null>(null);
  useEffect(() => { setCustom(null); }, [item.value, item.source]);

  const commitCustom = () => {
    const next = (custom ?? '').trim();
    setCustom(null);
    if (!next || next === current) return;
    onSet(item.key, next);
  };

  return (
    <>
      <select
        id={id}
        className="engine-setting-select"
        value={custom !== null ? CUSTOM_OPTION : current}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_OPTION) { setCustom(known ? '' : current); return; }
          setCustom(null);
          // The placeholder row is what "unset" already looks like; picking it is
          // not a write (Reset is the way back to the default).
          if (next === '' || next === current) return;
          onSet(item.key, next);
        }}
      >
        {current === '' && <option value="">{item.defaultLabel ?? 'Default'}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.help}>{o.label}</option>
        ))}
        {/* A stored value outside the list is still the value in force, so the
            select lists it rather than silently showing something else. */}
        {!known && current !== '' && <option value={current}>{current}</option>}
        {item.allowCustom && <option value={CUSTOM_OPTION}>Custom…</option>}
      </select>
      {custom !== null && (
        <input
          type="text"
          className="engine-setting-custom"
          // Safe to steal focus: this input exists only because the user just
          // picked "Custom…" in the select next to it.
          autoFocus
          value={custom}
          placeholder={item.placeholder ?? 'custom value'}
          aria-label={`Custom value for ${item.label}`}
          spellCheck={false}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
            else if (e.key === 'Escape') { e.preventDefault(); setCustom(null); }
          }}
        />
      )}
    </>
  );
}

/**
 * A boolean whose default the engine decides (plan-gated features): a toggle
 * would have to show ON or OFF for a value that is neither, so it is a
 * three-way select instead. "Default" means the key is absent from the file.
 */
function TriStateBooleanControl({ id, item, onSet, onReset }: ControlProps & { onReset: (key: string) => void }) {
  const current = item.value === true ? 'true' : item.value === false ? 'false' : '';
  // A value read from an older file cannot be "removed" from the file this row
  // writes; On/Off still work because the newer file wins over the older one.
  const legacy = item.source === 'legacy';
  return (
    <select
      id={id}
      className="engine-setting-select"
      value={current}
      onChange={(e) => {
        const next = e.target.value;
        if (next === current) return;
        if (next === '') { if (item.source === 'file') onReset(item.key); return; }
        onSet(item.key, next === 'true');
      }}
    >
      <option
        value=""
        disabled={legacy}
        title={legacy ? `Set in ${item.legacy?.path ?? 'an older file'}; remove it there to use the default` : undefined}
      >
        {item.defaultLabel ? `Default (${item.defaultLabel})` : 'Default'}
      </option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  );
}

function EngineSettingControl(props: ControlProps & { onReset: (key: string) => void }) {
  const { id, item, onSet } = props;
  switch (item.type) {
    case 'boolean':
      if (item.default === null) return <TriStateBooleanControl {...props} />;
      return <ToggleSwitch id={id} checked={item.value === true} onChange={(v) => onSet(item.key, v)} />;
    case 'number':
      return <NumberSettingControl {...props} />;
    case 'select':
      return <SelectSettingControl {...props} />;
    default:
      return <TextSettingControl {...props} />;
  }
}

export interface EngineSettingRowProps {
  engine: string;
  item: EngineSettingView;
  files: EngineSettingsFileView[];
  /** A write for this key is in flight: its controls are disabled, the rest of the section is not. */
  saving: boolean;
  onSet: (key: string, value: EngineSettingValue) => void;
  onReset: (key: string) => void;
}

export function EngineSettingRow({ engine, item, files, saving, onSet, onReset }: EngineSettingRowProps) {
  const id = controlId(engine, item.key);
  // A file the server could not parse refuses every write; a live control on
  // such a row would only collect a 409. (A wrong-TYPE value keeps its control:
  // setting it is exactly how the user repairs that.)
  const fileUnreadable = Boolean(files.find((f) => f.id === item.file)?.error);
  return (
    <SettingsRow
      className="engine-setting-row"
      data-testid={`engine-setting-row-${item.key}`}
      data-source={item.source}
      actions={(
        <fieldset className="engine-setting-control" disabled={saving || fileUnreadable} aria-busy={saving || undefined}>
          <EngineSettingControl id={id} item={item} onSet={onSet} onReset={onReset} />
          {/* Only a value stored in the file can be taken back out of it. */}
          {item.source === 'file' && (
            <button
              type="button"
              className="engine-setting-reset"
              data-testid={`engine-setting-reset-${item.key}`}
              title={`Remove ${item.key} from ${fileLabel(files, item.file)} and use the default again`}
              onClick={() => onReset(item.key)}
            >
              Reset
            </button>
          )}
        </fieldset>
      )}
    >
      <strong><label htmlFor={id}>{item.label}</label></strong>
      <span className="engine-setting-help">{item.help}</span>
      <span className="engine-setting-status">{settingStatusLine(item, files)}</span>
      {item.envOverride && (
        <span className="engine-setting-env">
          Overridden by {item.envOverride.name}={item.envOverride.value} in the environment
        </span>
      )}
      {item.invalid && <span className="engine-setting-invalid">{item.invalid}</span>}
    </SettingsRow>
  );
}
