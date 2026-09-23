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
import { useEffect, useState, type ReactNode } from 'react';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { CodeText } from './code-text';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
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

export function fileLabel(files: EngineSettingsFileView[], id: string): string {
  return files.find((f) => f.id === id)?.label ?? id;
}

/**
 * The one status line under a row's help text: which layer the value in force
 * comes from.
 *
 * The legacy case deliberately degrades: the view names the older location only
 * when the server sends it, and inventing a path from the file list would
 * confidently point at the wrong file on any engine with more than two.
 */
export function settingStatusLine(item: EngineSettingView, files: EngineSettingsFileView[]): string {
  if (item.source === 'file') return `Set in ${fileLabel(files, item.file)}`;
  if (item.source === 'overlay') {
    const id = item.overlay?.file;
    const file = id ? files.find((f) => f.id === id) : undefined;
    const label = file?.label ?? id ?? 'this project';
    return file?.readOnly ? `Set in ${label}, committed with the repo` : `Set in ${label}`;
  }
  if (item.source === 'legacy') {
    return item.legacy?.path
      ? `From ${item.legacy.path} (older location, still read)`
      : 'From an older location that the engine still reads';
  }
  return item.defaultLabel && item.value === null ? `Default: ${item.defaultLabel}` : 'Default';
}

/**
 * Which file a change to this row lands in, when that is not the row's own
 * (user-wide) file. A project-scoped save, or a key the engine's own config
 * screen keeps per project, says so before the user commits to it.
 */
export function settingWriteTargetLine(item: EngineSettingView, files: EngineSettingsFileView[]): string | null {
  const target = item.writeTarget;
  if (!target || target.file === item.file) return null;
  return `Saves to ${fileLabel(files, target.file)}`;
}

/** The write target holds the key today, so a Reset takes it back out of that file. */
export function settingRemovable(item: EngineSettingView): boolean {
  return item.writeTarget ? item.writeTarget.holds : item.source === 'file';
}

/** The file whose parse error would refuse a write for this row. */
export function settingWriteFileId(item: EngineSettingView): string {
  return item.writeTarget?.file ?? item.file;
}

export interface ControlProps {
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
        {current === '' && <option value="">{item.defaultLabel ? optionLabel(item.defaultLabel) : 'Default'}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.help}>{optionLabel(o.label)}</option>
        ))}
        {/* A stored value outside the list is still the value in force, so the
            select lists it rather than silently showing something else. */}
        {!known && current !== '' && <option value={current}>{current}</option>}
        {item.allowCustom && <option value={CUSTOM_OPTION}>Custom...</option>}
      </select>
      {custom !== null && (
        <input
          type="text"
          className="engine-setting-custom"
          // Safe to steal focus: this input exists only because the user just
          // picked "Custom..." in the select next to it.
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
  // A value held by a layer this row does not write (an older file, a shared
  // project file, the user file under a project-only scope) cannot be "removed"
  // from here; On/Off still work when the write target outranks that layer.
  const removable = settingRemovable(item);
  const elsewhere = !removable && item.source !== 'default';
  const heldIn = item.overriddenBy?.path ?? item.legacy?.path ?? item.overlay?.path ?? 'another file';
  return (
    <select
      id={id}
      className="engine-setting-select"
      value={current}
      onChange={(e) => {
        const next = e.target.value;
        if (next === current) return;
        if (next === '') { if (removable) onReset(item.key); return; }
        onSet(item.key, next === 'true');
      }}
    >
      <option
        value=""
        disabled={elsewhere}
        title={elsewhere ? `Set in ${heldIn}; remove it there to use the default` : undefined}
      >
        {item.defaultLabel ? `Default (${item.defaultLabel})` : 'Default'}
      </option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  );
}

export function EngineSettingControl(props: ControlProps & { onReset: (key: string) => void }) {
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
/**
   * Optional: drawn right after the status line, inside the row (a caller's own
   * sentence about this row, such as "Does not change this session."). Nothing
   * renders when absent; the Settings page passes none.
 */
  statusExtra?: ReactNode;
  /**
   * 'pane' = the Settings page look (one sentence of help, a source tag and a
   * reserved Reset slot beside the control). Default keeps the popover's
   * original layout, which the composer's popover and its specs rely on.
   */
  variant?: 'popover' | 'pane';
  /** Pane only: a child row of a disclosure, inset like every child row (N12). */
  indent?: boolean;
  /** Pane only: the engine's display name, so a bare model label names its owner. */
  engineLabel?: string;
}

export function EngineSettingRow(props: EngineSettingRowProps) {
  if (props.variant === 'pane') return <EnginePaneSettingRow {...props} />;
  return <EngineSettingPopoverRow {...props} />;
}

function EngineSettingPopoverRow({ engine, item, files, saving, onSet, onReset, statusExtra }: EngineSettingRowProps) {
  const id = controlId(engine, item.key);
  // A file the server could not parse refuses every write; a live control on
  // such a row would only collect a 409. (A wrong-TYPE value keeps its control:
  // setting it is exactly how the user repairs that.)
  const writeFile = settingWriteFileId(item);
  const fileUnreadable = Boolean(files.find((f) => f.id === writeFile)?.error);
  const writeTargetLine = settingWriteTargetLine(item, files);
  return (
    <SettingsRow
      className="engine-setting-row"
      data-testid={`engine-setting-row-${item.key}`}
      data-source={item.source}
      data-write-target={writeFile}
      actions={(
        <fieldset className="engine-setting-control" disabled={saving || fileUnreadable} aria-busy={saving || undefined}>
          <EngineSettingControl id={id} item={item} onSet={onSet} onReset={onReset} />
          {/* Only a value stored in the file a save would touch can be taken back out of it. */}
          {settingRemovable(item) && (
            <button
              type="button"
              className="engine-setting-reset"
              data-testid={`engine-setting-reset-${item.key}`}
              title={`Remove ${item.key} from ${fileLabel(files, writeFile)} and use the default again`}
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
      {statusExtra}
      {writeTargetLine && <span className="engine-setting-target">{writeTargetLine}</span>}
      {item.overriddenBy && (
        <span className="engine-setting-env">
          Overridden by {item.overriddenBy.path}, a shared project file; a change here would not take effect until that entry is removed
        </span>
      )}
      {item.envOverride && (
        <span className="engine-setting-env">
          Overridden by {item.envOverride.name}={item.envOverride.value} in the environment
        </span>
      )}
      {item.invalid && <span className="engine-setting-invalid">{item.invalid}</span>}
    </SettingsRow>
  );
}

// ---------------------------------------------------------------------------
// Settings pane look (variant="pane")
// ---------------------------------------------------------------------------

/**
 * First sentence of a server help text: cut at the first `. ` that is outside
 * backticks and not an abbreviation (`e.g. `, `i.e. `). The full text rides
 * on the row's title.
 */
export function firstSentence(text: string): string {
  let inCode = false;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch === '`') inCode = !inCode;
    if (inCode || ch !== '.' || text[i + 1] !== ' ') continue;
    const before = text.slice(Math.max(0, i - 3), i + 1).toLowerCase();
    if (before === 'e.g.' || before === 'i.e.') continue;
    return text.slice(0, i + 1);
  }
  return text;
}

export interface EngineSourceTag {
  text: 'User' | 'Project' | 'Shared project' | 'Default' | 'Environment' | 'Older file';
  title?: string;
  tone: 'neutral' | 'warning';
}

/** Where the value in force comes from, as the short tag left of the control. */
export function engineSourceTag(item: EngineSettingView, files: EngineSettingsFileView[]): EngineSourceTag {
  if (item.envOverride) return { text: 'Environment', title: item.envOverride.name, tone: 'warning' };
  if (item.overriddenBy) return { text: 'Shared project', title: item.overriddenBy.path, tone: 'warning' };
  if (item.source === 'legacy') return { text: 'Older file', title: item.legacy?.path, tone: 'neutral' };
  if (item.source === 'overlay') {
    const file = files.find((f) => f.id === item.overlay?.file);
    return { text: file?.readOnly ? 'Shared project' : 'Project', title: item.overlay?.path ?? file?.path, tone: 'neutral' };
  }
  if (item.source === 'file') {
    const file = files.find((f) => f.id === item.file);
    return { text: file?.scope === 'project' ? 'Project' : 'User', title: file?.path, tone: 'neutral' };
  }
  return { text: 'Default', title: item.defaultLabel ?? undefined, tone: 'neutral' };
}

/**
 * A bare `Model` / `Default model` label says whose model it is (`Claude Code
 * model`): the settings page never shows an unowned "model" row.
 */
export function paneSettingLabel(label: string, engineLabel: string | undefined): string {
  return engineLabel && /^(default )?model$/i.test(label.trim()) ? `${engineLabel} model` : label;
}

/** A row whose change would not take effect: what wins over it, else null. */
export function engineOverride(item: EngineSettingView): { code: string } | null {
  if (item.envOverride) return { code: item.envOverride.name };
  if (item.overriddenBy) return { code: item.overriddenBy.path };
  return null;
}

/** "auto" -> "Auto": a word option reads in sentence case; ids (dashes, dots, digits) stay as sent (N12). */
export function optionLabel(label: string): string {
  return /^[a-z][a-z ]*$/.test(label) ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/** A closed enum of up to 3 short words is a segmented control, not a menu (N12). */
export function isSmallEnum(item: Pick<EngineSettingView, 'type' | 'options' | 'allowCustom'>): boolean {
  const opts = item.options ?? [];
  return item.type === 'select' && !item.allowCustom && opts.length >= 2 && opts.length <= 3
    && opts.every((o) => o.label.length <= 12);
}

function PaneSegmentedSelect({ id, item, onSet }: ControlProps) {
  const options = item.options ?? [];
  const current = item.value === null ? '' : String(item.value);
  // Unset: the segment the engine uses by default is the one shown, the tag says Default.
  const effective = current || options.find((o) => o.value === String(item.default) || o.label === item.defaultLabel)?.value || '';
  return (
    <SegmentedControl<string>
      id={id}
      aria-label={item.label}
      value={effective}
      options={options.map((o) => ({ value: o.value, label: optionLabel(o.label), title: o.help }))}
      onChange={(next) => { if (next !== current) onSet(item.key, next); }}
    />
  );
}

function PaneTriStateControl({ id, item, onSet, onReset }: ControlProps & { onReset: (key: string) => void }) {
  const current = item.value === true ? 'true' : item.value === false ? 'false' : 'default';
  const removable = settingRemovable(item);
  return (
    <SegmentedControl<'default' | 'true' | 'false'>
      id={id}
      aria-label={item.label}
      value={current}
      options={[
        // "Auto": the tag beside it already says the value is the default (N3-06).
        { value: 'default', label: 'Auto', title: item.defaultLabel ? `Default: ${item.defaultLabel}` : 'Default' },
        { value: 'true', label: 'On' },
        { value: 'false', label: 'Off' },
      ]}
      onChange={(next) => {
        if (next === current) return;
        if (next === 'default') { if (removable) onReset(item.key); return; }
        onSet(item.key, next === 'true');
      }}
    />
  );
}

/** Which control a pane row draws; the layout keys off it (N3-01). Pure. */
export function paneControlKind(item: Pick<EngineSettingView, 'type' | 'default' | 'options' | 'allowCustom'>):
  'switch' | 'segmented' | 'select' | 'number' | 'text' {
  if (item.type === 'boolean') return item.default === null ? 'segmented' : 'switch';
  if (item.type === 'number') return 'number';
  if (item.type === 'select') return isSmallEnum(item) ? 'segmented' : 'select';
  return 'text';
}

/** A free-text value that is code (a model id, a path) is mono; a language is prose (N3-07). Pure. */
export function textIsCode(item: Pick<EngineSettingView, 'key' | 'label'>): boolean {
  return !/language|locale|name|title/i.test(`${item.key} ${item.label}`);
}

function EnginePaneSettingRow({ engine, item, files, saving, onSet, onReset, statusExtra, engineLabel, indent }: EngineSettingRowProps) {
  const id = controlId(engine, item.key);
  const writeFile = settingWriteFileId(item);
  const fileUnreadable = Boolean(files.find((f) => f.id === writeFile)?.error);
  const override = engineOverride(item);
  const writeTarget = settingWriteTargetLine(item, files);
  const tag = engineSourceTag(item, files);
  const removable = settingRemovable(item);
  // Warnings outrank the plain help: an override first, then a foreign target.
  // Commands, flags and paths in the engine's help are set in code (N28).
  let help: ReactNode = <CodeText text={firstSentence(item.help)} />;
  let state: 'warning' | undefined;
  if (override) {
    help = <>Overridden by <code>{override.code}</code>; changes here won&apos;t apply.</>;
    state = 'warning';
  } else if (item.invalid) {
    help = item.invalid;
    state = 'warning';
  } else if (writeTarget) {
    help = `${writeTarget}.`;
  }
  const triState = item.type === 'boolean' && item.default === null;
  const control = triState
    ? <PaneTriStateControl id={id} item={item} onSet={onSet} onReset={onReset} />
    : isSmallEnum(item)
      ? <PaneSegmentedSelect id={id} item={item} onSet={onSet} />
      : <EngineSettingControl id={id} item={item} onSet={onSet} onReset={onReset} />;
  // Every row shows its source, so the tags form one column (N3-06).
  const kind = paneControlKind(item);
  // An overridden row changes nothing: all of its controls are off, Reset too (N3-17).
  const locked = saving || fileUnreadable || Boolean(override);
  return (
    <SettingsRow
      className="engine-setting-row engine-setting-row-pane"
      data-testid={`engine-setting-row-${item.key}`}
      data-source={item.source}
      data-write-target={writeFile}
      data-control={kind}
      data-mono={kind === 'text' ? String(textIsCode(item)) : undefined}
      indent={indent}
      // Free text is the only wide control: it alone wraps under a 600px group (N04).
      wide={!['boolean', 'number', 'select'].includes(item.type)}
      label={paneSettingLabel(item.label, engineLabel)}
      htmlFor={item.type === 'boolean' && item.default !== null ? id : undefined}
      help={<span className="engine-setting-help" title={item.help}>{help}</span>}
      state={state}
      disabled={override ? true : undefined}
      control={
        <span className="engine-pane-controls">
          <span className="engine-pane-tag-slot">
            <SettingsTag tone={tag.tone} title={tag.title}>
              <span className="engine-setting-status" data-testid={`engine-setting-source-${item.key}`}>{tag.text}</span>
            </SettingsTag>
          </span>
          <fieldset className="engine-setting-control" disabled={locked} aria-busy={saving || undefined}>
            {control}
          </fieldset>
          <span className="engine-pane-reset-slot">
            <button
              type="button"
              className="engine-setting-reset settings-button settings-button-text"
              data-testid={removable ? `engine-setting-reset-${item.key}` : undefined}
              data-visible={removable ? 'true' : 'false'}
              tabIndex={removable && !locked ? 0 : -1}
              aria-hidden={removable ? undefined : true}
              disabled={!removable || locked}
              title={`Remove ${item.key} from ${fileLabel(files, writeFile)} and use the default again`}
              onClick={() => onReset(item.key)}
            >
              Reset
            </button>
          </span>
        </span>
      }
    >
      {statusExtra}
    </SettingsRow>
  );
}
