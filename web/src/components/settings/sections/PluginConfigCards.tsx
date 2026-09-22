/**
 * Data-driven plugin config forms for Settings → Integrations.
 *
 * Fetches /api/integrations/settings (every discovered plugin — loaded or
 * skipped for missing required config) and renders a form per plugin from its
 * manifest configSchema + uiHints. Plugins with missing required fields get an
 * attention banner listing exactly what to fill in and where to find it.
 */
import { useState, useEffect, useCallback, Fragment } from 'react';
import type { Config } from '@open-walnut/core';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import {
  fieldKindFor,
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
   * Render the fields WITHOUT the collapsible `<details>` shell. The Plugins section
   * already shows the plugin's name, its status badge and an expand control on the row
   * above, so the shell would repeat all three.
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
 * textarea into `[]`, which is a VALUE and survives, where the old order dropped the key entirely — the
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

/** Render help text with clickable http(s) links. */
function HelpText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s,)]+)/g);
  return (
    <p className="text-xs text-muted" style={{ marginTop: 2 }}>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part)
          ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>
          : <Fragment key={i}>{part}</Fragment>
      )}
    </p>
  );
}

export function PluginConfigCards({ config, onSave, excludeIds = [], onlyIds, bare = false }: Props) {
  const [plugins, setPlugins] = useState<PluginSettingsMeta[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

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

  const setField = (pluginId: string, key: string, value: unknown) => {
    setDrafts(d => ({ ...d, [pluginId]: { ...d[pluginId], [key]: value } }));
  };

  const savePlugin = async (plugin: PluginSettingsMeta) => {
    const draft = drafts[plugin.id] ?? {};
    const schemas = plugin.configSchema?.properties ?? {};
    const cleaned = pluginSavePayload(draft, schemas);
    setSaving(plugin.id);
    try {
      await onSave({
        plugins: {
          ...config.plugins,
          [plugin.id]: { ...(config.plugins?.[plugin.id] ?? {}), ...cleaned, enabled: true },
        },
      } as Partial<Config>);
      setSavedId(plugin.id);
      setTimeout(() => setSavedId(null), 2500);
      // Server soft-reloads the plugin on CONFIG_CHANGED (async) — poll a couple
      // of echoes so the "needs setup" badge flips to active without a reload.
      emitPluginsChanged([1200, 3500]);
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

        const body = (
            <div className="settings-collapsible-body">
              {!bare && plugin.description && (
                <p className="text-xs text-muted" style={{ marginTop: 0 }}>{plugin.description}</p>
              )}
              {needsConfig && (
                <p className="text-xs" style={{ color: 'var(--priority-immediate)', marginTop: 4 }}>
                  Not active yet — fill in {missingLabels.join(', ')} below and save.
                </p>
              )}
              {Object.entries(props).map(([key, schema]) => {
                const hint = plugin.uiHints?.[key];
                const label = hint?.label ?? key;
                const isMissing = plugin.missing.includes(key);
                const value = draft[key];
                const fieldId = `plugin-${plugin.id}-${key}`;

                const kind = fieldKindFor(schema);

                if (kind === 'boolean') {
                  return (
                    <div className="form-group" key={key}>
                      <ToggleSwitch
                        id={fieldId}
                        checked={(value as boolean) ?? (schema.default as boolean) ?? false}
                        onChange={v => setField(plugin.id, key, v)}
                        label={label}
                      />
                      {hint?.help && <HelpText text={hint.help} />}
                    </div>
                  );
                }
                if (kind === 'list') {
                  return (
                    <div className="form-group" key={key}>
                      <label htmlFor={fieldId}>
                        {label}
                        {required.has(key) && <span style={{ color: 'var(--priority-immediate)' }}> *</span>}
                      </label>
                      <textarea
                        id={fieldId}
                        rows={3}
                        // The draft holds the RAW text once the user types; re-joining a parsed array
                        // on every keystroke would eat the separator as it was typed.
                        value={listTextFor(value)}
                        onChange={e => setField(plugin.id, key, e.target.value)}
                        placeholder={listPlaceholder(schema)}
                        style={isMissing ? { borderColor: 'var(--priority-immediate)' } : undefined}
                      />
                      {hint?.help && <HelpText text={hint.help} />}
                    </div>
                  );
                }
                if (kind === 'text' || kind === 'number' || kind === 'integer') {
                  const numeric = kind !== 'text';
                  return (
                    <div className="form-group" key={key}>
                      <label htmlFor={fieldId}>
                        {label}
                        {required.has(key) && <span style={{ color: 'var(--priority-immediate)' }}> *</span>}
                      </label>
                      <input
                        id={fieldId}
                        type={numeric ? 'number' : 'text'}
                        step={kind === 'integer' ? 1 : undefined}
                        value={(value as string | number) ?? ''}
                        onChange={e => setField(plugin.id, key,
                          numeric
                            ? (e.target.value === '' ? '' : Number(e.target.value))
                            : e.target.value)}
                        placeholder={schema.default !== undefined ? `default: ${schema.default}` : undefined}
                        style={isMissing ? { borderColor: 'var(--priority-immediate)' } : undefined}
                      />
                      {hint?.help && <HelpText text={hint.help} />}
                    </div>
                  );
                }
                // object fields, and arrays of anything but strings: config.yaml-only for now
                return null;
              })}
              <div className="form-group">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={saving === plugin.id}
                  onClick={() => void savePlugin(plugin)}
                >
                  {saving === plugin.id ? 'Saving…' : savedId === plugin.id ? 'Saved ✓' : 'Save'}
                </button>
                {needsConfig && (
                  <p className="text-xs text-muted" style={{ marginTop: 4 }}>
                    The plugin activates automatically after saving.
                  </p>
                )}
              </div>
            </div>
        );

        if (bare) return <div key={plugin.id}>{body}</div>;
        return (
          <details key={plugin.id} className="settings-collapsible" open={needsConfig}>
            <summary className="settings-collapsible-title">
              {plugin.name}
              {needsConfig && (
                <span className="badge badge-immediate" style={{ marginLeft: 8 }}>
                  needs setup
                </span>
              )}
            </summary>
            {body}
          </details>
        );
      })}
    </>
  );
}
