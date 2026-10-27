/**
 * Data-driven plugin config fields for Settings: Plugins.
 *
 * Fetches /api/integrations/settings (every discovered plugin, loaded or
 * skipped for missing required config) and renders one plugin's fields from its
 * manifest configSchema + uiHints as INDENTED ROWS of the plugin's own group
 * (`bare`), or as a group of its own otherwise. Plugins with missing required
 * fields get a warning row naming exactly what to fill in.
 */
import { useState, useEffect, useCallback, useRef, Fragment, type ReactNode } from 'react';
import type { Config } from '@open-walnut/core';
import { Link } from 'react-router-dom';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { MaskedValueError, isSecretKey } from '../../../../../src/core/config-secret-shape';
import {
  SECRET_LIST_HINT,
  editedMaskField,
  fieldBounds,
  fieldKindFor,
  fieldOwnerFor,
  isSecretListField,
  listPlaceholder,
  listTextFor,
  valueForSave,
  type PluginFieldSchema,
} from '../plugin-config-fields';
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events';
import { draftKey, readDraft, readDraftJson, writeDraftJson } from '@/utils/drafts';
import { DRAFT_FLUSH_EVENT, noteDraftWrite, type DraftFlushDetail } from '@/utils/unsaved-work';

/**
 * One plugin's fields typed and not saved yet, kept in the draft store until its Save lands
 * (leaving the pane, a reload, a restart keep them). Secret fields are never kept.
 */
const pluginDraftKey = (pluginId: string) => draftKey('plugin-config', pluginId);

interface PluginSettingsMeta {
  id: string;
  name: string;
  description?: string;
  status: 'loaded' | 'needs-config';
  missing: string[];
  configSchema: { properties?: Record<string, FieldSchema>; required?: string[] } | null;
  uiHints: Record<string, { label?: string; help?: string }> | null;
  values: Record<string, unknown>;
}

/** The slice of JSON Schema these forms understand — see ../plugin-config-fields.ts. */
type FieldSchema = PluginFieldSchema;

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  /** Plugin IDs already rendered by hand elsewhere in the section. */
  excludeIds?: string[];
  /**
   * Render ONLY these plugin ids. The Plugins section uses it to put one plugin's
   * form under its own row, so a plugin is configured where it is turned on. Absent
   * means every configurable plugin, which is the whole-list behaviour.
   */
  onlyIds?: string[];
  /**
   * Render the fields as indented rows WITHOUT a group of their own. The Plugins section
   * already shows the plugin's name, its status tag and Configure on the row above, and
   * the fields continue that row's group (no nested box).
   */
  bare?: boolean;
  /**
   * What to draw while there are no fields yet: still loading, the fetch failed, or no
   * matching plugin has a form. Absent draws nothing, which suits a list; a form standing
   * on its own (PluginSettingsForm) says which of the three it is.
   */
  renderEmpty?: (why: 'loading' | 'failed' | 'none') => ReactNode;
}

/** What the server sends instead of a stored secret. Exported so a test cannot drift from it. */
export const MASKED = '••••••';

/**
 * `step={1}` is a hint to the spinner, not a rule the browser enforces: a typed or pasted `2.5` reaches
 * here intact, and an `integer` field in config.yaml holding 2.5 is a value no plugin asked for.
 * Rounded at save rather than on change, because rounding mid-typing rewrites the box under the user
 * (`2.` parses as 2) and makes the field impossible to edit.
 */
function wholeIfInteger(schema: FieldSchema | undefined, value: unknown): unknown {
  if (fieldKindFor(schema) !== 'integer') return value;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : value;
}

/**
 * The patch one plugin's Save writes — every draft field, in the shape config.yaml holds, minus the two
 * things that must never be written:
 *
 *   . a MASKED secret in a SCALAR field, which stands for "unchanged" and would otherwise store the mask
 *     as the value;
 *   . an emptied SCALAR box, which stands for "unset", so the manifest default applies server-side.
 *     A field the user never touched is not in the draft at all (or still holds the value that came off
 *     the wire), so it is not this filter that protects those.
 *
 * `valueForSave` runs BEFORE both tests, and that order is the whole point. It turns an emptied textarea
 * into `[]`, which is a VALUE and survives, where the old order dropped the key entirely; the server then
 * fell back to the manifest default and the list the user had just emptied came back after a refresh,
 * looking exactly like a save that had silently failed. The same order keeps a list edit: a list of
 * hidden secrets cut down to ONE line has the mask as its whole text, and testing the raw text dropped
 * the edit as "unchanged" (PUT 200, "Saved", nothing deleted). A list is always sent as a list; the
 * server puts each hidden entry back, or refuses one it cannot pair. A list of secrets is split on line
 * breaks only and each line trimmed (`isSecretListField`), so a secret typed in full with a comma in it
 * stays one entry and a hidden line with a stray space is still that hidden line.
 */
export function pluginSavePayload(
  draft: Record<string, unknown>,
  schemas: Record<string, FieldSchema>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(draft)
      .map(([k, v]) => [k, wholeIfInteger(schemas[k], valueForSave(schemas[k], v, { secret: isSecretListField(k, schemas[k]) }))] as const)
      .filter(([, v]) => v !== MASKED && v !== ''),
  );
}

/** Help text with clickable http(s) links (inline: it sits in the row's help line). */
function HelpText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s,)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part)
          ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>
          : <Fragment key={i}>{part}</Fragment>
      )}
    </>
  );
}

export function PluginConfigCards({ config, onSave, excludeIds = [], onlyIds, bare = false, renderEmpty }: Props) {
  const [plugins, setPlugins] = useState<PluginSettingsMeta[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);
  const { notifySaveFailed } = useSettingsSaved();

  // `onlyIds` is joined into the dep key so switching which row is expanded refetches
  // instead of showing the previous plugin's fields.
  const scope = onlyIds ? onlyIds.join(',') : '';

  // Fields the user edited since the last save, per plugin. Only those (plus
  // seeded values config does not hold yet) are sent: the draft also holds every
  // field as first loaded, and re-sending one that changed elsewhere meanwhile
  // (a calendar hidden from Calendar Accounts) would put its old value back.
  const touched = useRef<Record<string, Set<string>>>({});

  const refresh = useCallback(() => {
    fetch('/api/integrations/settings')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: PluginSettingsMeta[]) => {
        const wanted = scope ? new Set(scope.split(',')) : null;
        const visible = data.filter(p =>
          !excludeIds.includes(p.id)
          && (!wanted || wanted.has(p.id))
          // An empty `properties` object is a schema with nothing to fill in; showing
          // it renders a card that is just a Save button.
          && Object.keys(p.configSchema?.properties ?? {}).length > 0);
        setPlugins(visible);
        setPhase('ready');
        // Merge: keep in-flight edits, seed fields for newly-appeared plugins. Edits kept
        // in the draft store (typed before a reload) come back as edits.
        const kept = Object.fromEntries(visible.map(p => [p.id, readDraftJson<Record<string, unknown>>(pluginDraftKey(p.id)) ?? {}]));
        for (const [id, fields] of Object.entries(kept)) for (const k of Object.keys(fields)) (touched.current[id] ??= new Set()).add(k);
        setDrafts(d => Object.fromEntries(visible.map(p => [p.id, { ...p.values, ...kept[p.id], ...d[p.id] }])));
      })
      // A failed refetch keeps the fields already shown; only a first load can fail.
      .catch(() => { setPhase((current) => (current === 'ready' ? current : 'failed')); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    refresh();
    // Refetch when the Plugin Store adds/updates/removes a source (or another
    // card saves) so newly-discovered plugins appear without a page reload.
    window.addEventListener(PLUGINS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const setField = (pluginId: string, key: string, value: unknown) => {
    (touched.current[pluginId] ??= new Set()).add(key);
    setDrafts(d => ({ ...d, [pluginId]: { ...d[pluginId], [key]: value } }));
    if (isSecretKey(key)) return;
    const kept = readDraftJson<Record<string, unknown>>(pluginDraftKey(pluginId)) ?? {};
    const original = plugins.find(p => p.id === pluginId)?.values[key];
    if (JSON.stringify(value) === JSON.stringify(original)) delete kept[key];
    else kept[key] = value;
    writeDraftJson(pluginDraftKey(pluginId), Object.keys(kept).length > 0 ? kept : undefined);
    noteDraftWrite();
  };

  // Written at once on every change, so a reload's unsaved-work check only needs to be told so.
  useEffect(() => {
    const onFlush = (e: Event) => {
      const claims = (e as CustomEvent<DraftFlushDetail>).detail?.claims;
      if (!claims) return;
      for (const element of Array.from(document.querySelectorAll('[data-draft-key^="draft:plugin-config:"]'))) {
        const key = element.getAttribute('data-draft-key')!;
        claims.push({ element, key, text: readDraft(key) });
      }
    };
    window.addEventListener(DRAFT_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(DRAFT_FLUSH_EVENT, onFlush);
  }, []);

  const savePlugin = async (plugin: PluginSettingsMeta) => {
    const draft = drafts[plugin.id] ?? {};
    const schemas = plugin.configSchema?.properties ?? {};
    const edited = touched.current[plugin.id] ?? new Set<string>();
    const stored = (config.plugins?.[plugin.id] ?? {}) as Record<string, unknown>;
    const cleaned = Object.fromEntries(
      Object.entries(pluginSavePayload(draft, schemas)).filter(([k]) => edited.has(k) || stored[k] === undefined),
    );
    // A hidden value with other text typed next to it is neither the hidden value nor a new one: say so
    // before any request, with the server's own message (it refuses the same value as `edited_mask`).
    const editedMask = editedMaskField(cleaned, `plugins.${plugin.id}`);
    if (editedMask !== null) {
      const message = new MaskedValueError(editedMask, 'edited_mask').message;
      setSaveError({ id: plugin.id, message });
      notifySaveFailed(message);
      return;
    }
    setSaving(plugin.id);
    setSaveError(null);
    try {
      await onSave({
        plugins: {
          ...config.plugins,
          [plugin.id]: { ...(config.plugins?.[plugin.id] ?? {}), ...cleaned, enabled: true },
        },
      } as Partial<Config>);
      for (const k of Object.keys(cleaned)) edited.delete(k);
      const kept = readDraftJson<Record<string, unknown>>(pluginDraftKey(plugin.id)) ?? {};
      for (const k of Object.keys(cleaned)) delete kept[k];
      writeDraftJson(pluginDraftKey(plugin.id), Object.keys(kept).length > 0 ? kept : undefined);
      noteDraftWrite();
      // A save clamps to the manifest's bounds, so show what was stored (15), not what was typed (5).
      setDrafts(d => ({ ...d, [plugin.id]: { ...d[plugin.id], ...cleaned } }));
      // Server soft-reloads the plugin on CONFIG_CHANGED (async); poll a couple
      // of echoes so the "needs setup" badge flips to active without a reload.
      emitPluginsChanged([1200, 3500]);
    } catch (err) {
      // The page-wrapped onSave already shows `Not saved`; the row says why, until the next Save.
      setSaveError({ id: plugin.id, message: saveErrorMessage(err) });
    } finally {
      setSaving(null);
    }
  };

  if (plugins.length === 0) return renderEmpty ? <>{renderEmpty(phase === 'ready' ? 'none' : phase)}</> : null;

  return (
    <>
      {plugins.map(plugin => {
        const props = plugin.configSchema?.properties ?? {};
        const required = new Set(plugin.configSchema?.required ?? []);
        const draft = drafts[plugin.id] ?? {};
        const needsConfig = plugin.status === 'needs-config';
        const missingLabels = plugin.missing.map(f => plugin.uiHints?.[f]?.label ?? f);
        const requiredTag = (key: string) => (required.has(key) ? <> <SettingsTag>Required</SettingsTag></> : null);

        const rows = (
          <>
            {needsConfig && (
              <SettingsRow
                indent
                state="warning"
                label="Not active yet"
                help={`Fill in ${missingLabels.join(', ')} and save.`}
              />
            )}
            {Object.entries(props).map(([key, schema]) => {
              const hint = plugin.uiHints?.[key];
              const label = hint?.label ?? key;
              const isMissing = plugin.missing.includes(key);
              const value = draft[key];
              const fieldId = `plugin-${plugin.id}-${key}`;
              const help = hint?.help ? <HelpText text={hint.help} /> : undefined;

              const kind = fieldKindFor(schema);
              // Owned by another pane: one link row in place of its keys (N3-04).
              const owner = fieldOwnerFor(plugin.id, key);
              if (owner) {
                if (owner.keys.find((k) => k in props) !== key) return null;
                // A route link: this form renders on the Apps page, where a bare `#pane` names no Settings pane.
                return (
                  <SettingsRow
                    key={`owner-${owner.pane}`}
                    indent
                    className="plugin-config-owned"
                    data-testid={`plugin-config-owned-${plugin.id}`}
                    label={owner.label}
                    help={owner.help}
                    control={<Link className="settings-button settings-button-text" to={`/settings#${owner.pane}`}>{owner.link}</Link>}
                  />
                );
              }

              if (kind === 'boolean') {
                return (
                  <SettingsRow
                    key={key}
                    indent
                    label={label}
                    htmlFor={fieldId}
                    help={help}
                    control={
                      <ToggleSwitch
                        id={fieldId}
                        checked={(value as boolean) ?? (schema.default as boolean) ?? false}
                        onChange={v => setField(plugin.id, key, v)}
                      />
                    }
                  />
                );
              }
              if (kind === 'list') {
                const secretList = isSecretListField(key, schema);
                return (
                  <SettingsRow
                    key={key}
                    indent
                    wide
                    // A multi-line editor: label on top, editor across the group (N3-22).
                    className="settings-row-stacked"
                    label={<>{label}{requiredTag(key)}</>}
                    htmlFor={fieldId}
                    help={secretList ? <>{help}{help ? ' ' : null}{SECRET_LIST_HINT}</> : help}
                    state={isMissing ? 'warning' : undefined}
                    control={
                      <textarea
                        id={fieldId}
                        // A list of secrets keeps no draft (setField skips it).
                        data-draft-key={secretList ? undefined : pluginDraftKey(plugin.id)}
                        rows={3}
                        className="settings-input settings-input--long settings-input--mono"
                        aria-invalid={isMissing || undefined}
                        // The draft holds the RAW text once the user types; re-joining a parsed array
                        // on every keystroke would eat the separator as it was typed.
                        value={listTextFor(value)}
                        onChange={e => setField(plugin.id, key, e.target.value)}
                        placeholder={listPlaceholder(schema, { secret: secretList })}
                      />
                    }
                  />
                );
              }
              if (kind === 'text' || kind === 'number' || kind === 'integer') {
                const numeric = kind !== 'text';
                return (
                  <SettingsRow
                    key={key}
                    indent
                    wide={!numeric}
                    label={<>{label}{requiredTag(key)}</>}
                    htmlFor={fieldId}
                    help={help}
                    state={isMissing ? 'warning' : undefined}
                    control={
                      <input
                        id={fieldId}
                        // A secret field keeps no draft (setField skips it).
                        data-draft-key={isSecretKey(key) ? undefined : pluginDraftKey(plugin.id)}
                        type={numeric ? 'number' : 'text'}
                        className={`settings-input ${numeric ? 'settings-input--number' : 'settings-input--long settings-input--mono'}`}
                        aria-invalid={isMissing || undefined}
                        {...(numeric ? fieldBounds(schema) : {})}
                        value={(value as string | number) ?? ''}
                        onChange={e => setField(plugin.id, key,
                          numeric
                            ? (e.target.value === '' ? '' : Number(e.target.value))
                            : e.target.value)}
                        placeholder={schema.default !== undefined ? `Default ${String(schema.default)}` : undefined}
                      />
                    }
                  />
                );
              }
              // object fields, and arrays of anything but strings: config.yaml-only for now
              return null;
            })}
            <SettingsRow
              indent
              label="Save these settings"
              help={needsConfig ? 'The plugin turns on after saving.' : undefined}
              error={saveError?.id === plugin.id ? couldntSave(saveError.message) : undefined}
              control={
                <SettingsButton
                  variant="primary"
                  busy={saving === plugin.id}
                  busyLabel="Saving..."
                  data-testid={`plugin-config-save-${plugin.id}`}
                  onClick={() => void savePlugin(plugin)}
                >
                  Save
                </SettingsButton>
              }
            />
          </>
        );

        if (bare) return <Fragment key={plugin.id}>{rows}</Fragment>;
        return (
          <SettingsGroup
            key={plugin.id}
            heading={plugin.name}
            headingTrailing={needsConfig ? <SettingsTag tone="warning">Needs setup</SettingsTag> : undefined}
            footer={plugin.description}
          >
            {rows}
          </SettingsGroup>
        );
      })}
    </>
  );
}
