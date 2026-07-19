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

interface FieldSchema {
  type?: string;
  default?: unknown;
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  /** Plugin IDs already rendered by hand elsewhere in the section. */
  excludeIds?: string[];
}

const MASKED = '••••••';

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

export function PluginConfigCards({ config, onSave, excludeIds = [] }: Props) {
  const [plugins, setPlugins] = useState<PluginSettingsMeta[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch('/api/integrations/settings')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: PluginSettingsMeta[]) => {
        const visible = data.filter(p => !excludeIds.includes(p.id) && p.configSchema?.properties);
        setPlugins(visible);
        // Merge: keep in-flight edits, seed fields for newly-appeared plugins
        setDrafts(d => Object.fromEntries(visible.map(p => [p.id, { ...p.values, ...d[p.id] }])));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Drop masked secrets (unchanged) and empty strings so defaults apply server-side
    const cleaned = Object.fromEntries(
      Object.entries(draft).filter(([, v]) => v !== MASKED && v !== ''),
    );
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
            <div className="settings-collapsible-body">
              {plugin.description && (
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

                if (schema.type === 'boolean') {
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
                if (schema.type === 'string' || schema.type === 'number') {
                  return (
                    <div className="form-group" key={key}>
                      <label htmlFor={fieldId}>
                        {label}
                        {required.has(key) && <span style={{ color: 'var(--priority-immediate)' }}> *</span>}
                      </label>
                      <input
                        id={fieldId}
                        type={schema.type === 'number' ? 'number' : 'text'}
                        value={(value as string | number) ?? ''}
                        onChange={e => setField(plugin.id, key,
                          schema.type === 'number'
                            ? (e.target.value === '' ? '' : Number(e.target.value))
                            : e.target.value)}
                        placeholder={schema.default !== undefined ? `default: ${schema.default}` : undefined}
                        style={isMissing ? { borderColor: 'var(--priority-immediate)' } : undefined}
                      />
                      {hint?.help && <HelpText text={hint.help} />}
                    </div>
                  );
                }
                // array/object fields: config.yaml-only for now
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
          </details>
        );
      })}
    </>
  );
}
