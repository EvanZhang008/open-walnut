/**
 * Data-driven plugin config fields for Settings: Plugins.
 *
 * Fetches /api/integrations/settings (every discovered plugin, loaded or
 * skipped for missing required config) and renders one plugin's fields from its
 * manifest configSchema + uiHints as INDENTED ROWS of the plugin's own group
 * (`bare`), or as a group of its own otherwise. Plugins with missing required
 * fields get a warning row naming exactly what to fill in.
 */
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import type { Config } from '@open-walnut/core';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage } from '../settings-pane-context';
import {
  fieldKindFor,
  fieldOwnerFor,
  listPlaceholder,
  listTextFor,
  valueForSave,
  type PluginFieldSchema,
} from '../plugin-config-fields';
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events';

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
 *   . a MASKED secret, which stands for "unchanged" and would otherwise store the mask as the value;
 *   . an emptied SCALAR box, which stands for "unset", so the manifest default applies server-side.
 *     A field the user never touched is not in the draft at all (or still holds the value that came off
 *     the wire), so it is not this filter that protects those.
 *
 * `valueForSave` runs BEFORE the empty test, and that order is the whole point: it turns an emptied
 * textarea into `[]`, which is a VALUE and survives, where the old order dropped the key entirely; the
 * server then fell back to the manifest default and the list the user had just emptied came back after
 * a refresh, looking exactly like a save that had silently failed.
 */
export function pluginSavePayload(
  draft: Record<string, unknown>,
  schemas: Record<string, FieldSchema>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(draft)
      .filter(([, v]) => v !== MASKED)
      .map(([k, v]) => [k, wholeIfInteger(schemas[k], valueForSave(schemas[k], v))] as const)
      .filter(([, v]) => v !== ''),
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

export function PluginConfigCards({ config, onSave, excludeIds = [], onlyIds, bare = false }: Props) {
  const [plugins, setPlugins] = useState<PluginSettingsMeta[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);

  // `onlyIds` is joined into the dep key so switching which row is expanded refetches
  // instead of showing the previous plugin's fields.
  const scope = onlyIds ? onlyIds.join(',') : '';

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
        // Merge: keep in-flight edits, seed fields for newly-appeared plugins
        setDrafts(d => Object.fromEntries(visible.map(p => [p.id, { ...p.values, ...d[p.id] }])));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    refresh();
    // Refetch when the Plugin Store adds/updates/removes a source (or another
    // card saves) so newly-discovered plugins appear without a page reload.
    window.addEventListener(PLUGINS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, refresh);
  }, [refresh]);

  // Fields the user edited since the last save, per plugin. Only those (plus
  // seeded values config does not hold yet) are sent: the draft also holds every
  // field as first loaded, and re-sending one that changed elsewhere meanwhile
  // (a calendar hidden from Calendar Accounts) would put its old value back.
  const touched = useRef<Record<string, Set<string>>>({});
  const setField = (pluginId: string, key: string, value: unknown) => {
    (touched.current[pluginId] ??= new Set()).add(key);
    setDrafts(d => ({ ...d, [pluginId]: { ...d[pluginId], [key]: value } }));
  };

  const savePlugin = async (plugin: PluginSettingsMeta) => {
    const draft = drafts[plugin.id] ?? {};
    const schemas = plugin.configSchema?.properties ?? {};
    const edited = touched.current[plugin.id] ?? new Set<string>();
    const stored = (config.plugins?.[plugin.id] ?? {}) as Record<string, unknown>;
    const cleaned = Object.fromEntries(
      Object.entries(pluginSavePayload(draft, schemas)).filter(([k]) => edited.has(k) || stored[k] === undefined),
    );
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

  if (plugins.length === 0) return null;

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
                return (
                  <SettingsRow
                    key={`owner-${owner.pane}`}
                    indent
                    className="plugin-config-owned"
                    data-testid={`plugin-config-owned-${plugin.id}`}
                    label={owner.label}
                    help={owner.help}
                    control={<a className="settings-button settings-button-text" href={`#${owner.pane}`}>{owner.link}</a>}
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
                return (
                  <SettingsRow
                    key={key}
                    indent
                    wide
                    // A multi-line editor: label on top, editor across the group (N3-22).
                    className="settings-row-stacked"
                    label={<>{label}{requiredTag(key)}</>}
                    htmlFor={fieldId}
                    help={help}
                    state={isMissing ? 'warning' : undefined}
                    control={
                      <textarea
                        id={fieldId}
                        rows={3}
                        className="settings-input settings-input--long settings-input--mono"
                        aria-invalid={isMissing || undefined}
                        // The draft holds the RAW text once the user types; re-joining a parsed array
                        // on every keystroke would eat the separator as it was typed.
                        value={listTextFor(value)}
                        onChange={e => setField(plugin.id, key, e.target.value)}
                        placeholder={listPlaceholder(schema)}
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
                        type={numeric ? 'number' : 'text'}
                        className={`settings-input ${numeric ? 'settings-input--number' : 'settings-input--long settings-input--mono'}`}
                        aria-invalid={isMissing || undefined}
                        step={kind === 'integer' ? 1 : undefined}
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
