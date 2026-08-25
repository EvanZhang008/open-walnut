/**
 * Settings → Plugins: the whole life of a plugin on one surface.
 *
 * Discover → install → turn on/off → configure → update → remove. Before this it was
 * three places: the store listed SOURCES you had installed (so a builtin plugin was
 * invisible here), Integrations held the config forms, and nothing in the UI could
 * turn a plugin off at all — the only way was a POST from a terminal.
 *
 * Three lists, in the order someone actually needs them:
 *
 *   1. Installed — every discovered plugin, builtin or external or dev-linked, with
 *      its real state (on / off / needs setup / failed / restart to activate), a
 *      switch, and Configure right there.
 *   2. Available — catalog entries not on this machine. A `builtin` one only needs
 *      turning on; a `git`/`npm` one PREFILLS the install form below (it never
 *      installs by itself); an `example` one lives in this checkout, so it shows the
 *      `walnut-plugin link` command instead of a button that could not work.
 *   3. Install from a git repo or an npm package — the free-form input, unchanged,
 *      for anything the catalog does not know.
 *
 * Installing a plugin gives it full access to Walnut and this machine, so the trust
 * checkbox stays a per-install stop: the Add button is disabled until it is ticked and
 * it resets after every successful add. Prefilling from the catalog does NOT pre-tick
 * it — a curated listing is not the user's consent.
 *
 * Turning a plugin off persists: the disable route writes `plugins.<id>.enabled: false`
 * to config.yaml (integration-loader.disableLoadedPlugin), so it stays off across a
 * restart, and turning it on writes `enabled: true` before reloading it.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsSection, SettingsRow, SettingsSubCard, SettingsEmpty, SettingsNotice } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { PluginConfigCards } from './PluginConfigCards';
import { PluginAppControls } from '../PluginAppControls';
import { BuildPluginCard } from '../BuildPluginCard';
// Deliberately NOT '@/plugins/hooks': that module reaches the plugin loader, which
// reaches every view a plugin may mount (NotesPage, CalendarPage, SessionPanel …).
// Importing it here would pull that whole graph into anything that touches the
// settings registry. `plugin:runtime-changed` is the same signal, one WS event away.
import { useEvent } from '@/hooks/useWebSocket';
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events';
import '@/styles/plugin-store.css';

interface StorePlugin {
  dir: string;
  id: string | null;
  name: string | null;
  version: string | null;
  error?: string;
  status: 'loaded' | 'needs-config' | 'unsupported' | 'duplicate' | 'error' | 'pending-restart';
}

interface PluginSource {
  slug: string;
  kind?: 'git' | 'npm';
  type?: 'npm';
  url?: string;
  ref?: string;
  spec?: string;
  resolved?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  enabled: boolean;
  cloned: boolean;
  lastSha?: string;
  lastSyncedAt?: string;
  lastError?: string;
  plugins: StorePlugin[];
  shareSnippet?: string;
}

/** Mirrors PluginRegistryRow in src/core/plugins/plugin-catalog.ts. */
interface RegistryRow {
  id: string;
  name: string;
  description?: string;
  adds?: string[];
  homepage?: string;
  docs?: string;
  source: { kind: 'builtin' | 'git' | 'npm' | 'example'; url?: string; ref?: string; spec?: string; path?: string };
  installed: boolean;
  status: 'active' | 'disabled' | 'needs-config' | 'unsupported' | 'failed' | 'quarantined' | 'pending-restart' | 'available';
  state?: string;
  version?: string;
  builtin: boolean;
  capabilities?: string[];
  missingConfig?: string[];
  reason?: string;
  error?: string;
  configurable: boolean;
  catalog: boolean;
  sourceSlug?: string;
  toggleable: boolean;
}

interface RegistryResponse {
  rows: RegistryRow[];
  installedCount: number;
  availableCount: number;
  sourcesUnavailable?: boolean;
  cloud?: boolean;
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

/** A git remote the local git can clone; anything else is treated as an npm spec. */
function looksLikeGitUrl(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(value);
}

/** Integrity hashes are long — show enough to compare, not enough to wrap. */
function shortIntegrity(integrity: string): string {
  const [algo, digest = ''] = integrity.split('-');
  return digest.length > 12 ? `${algo}-${digest.slice(0, 12)}…` : integrity;
}

const STATUS_LABELS: Record<StorePlugin['status'], { label: string; className: string }> = {
  loaded: { label: 'active', className: 'badge badge-done' },
  'needs-config': { label: 'needs setup', className: 'badge badge-important' },
  unsupported: { label: 'needs newer Walnut', className: 'badge badge-none' },
  duplicate: { label: 'shadowed', className: 'badge badge-none' },
  error: { label: 'invalid', className: 'badge badge-immediate' },
  'pending-restart': { label: 'restart to activate', className: 'badge badge-important' },
};

/** One word per state, and the same word everywhere it appears. */
const ROW_STATUS: Record<RegistryRow['status'], { label: string; className: string }> = {
  active: { label: 'on', className: 'badge badge-done' },
  disabled: { label: 'off', className: 'badge badge-none' },
  'needs-config': { label: 'needs setup', className: 'badge badge-important' },
  unsupported: { label: 'needs newer Walnut', className: 'badge badge-none' },
  failed: { label: 'failed', className: 'badge badge-immediate' },
  quarantined: { label: 'quarantined', className: 'badge badge-immediate' },
  'pending-restart': { label: 'restart to activate', className: 'badge badge-important' },
  available: { label: 'not installed', className: 'badge badge-none' },
};

/** Where an installed plugin came from, in the user's terms. */
function originLabel(row: RegistryRow): string {
  if (row.builtin) return 'Built in';
  if (row.sourceSlug) return `${row.source.kind === 'npm' ? 'npm' : 'git'} · ${row.sourceSlug}`;
  return 'Linked locally';
}

export function PluginStoreSection({ config, onSave }: Props) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [sources, setSources] = useState<PluginSource[]>([]);
  const [url, setUrl] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 'add' | plugin id | source slug
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    // Two independent reads: a plugin-sources failure must not blank the plugin list.
    const [registryRes, sourcesRes] = await Promise.allSettled([
      fetch('/api/plugin-runtime/registry'),
      fetch('/api/plugin-sources'),
    ]);
    if (registryRes.status === 'fulfilled' && registryRes.value.ok) {
      try { setRegistry(await registryRes.value.json()); } catch { /* keep the last list */ }
    }
    if (sourcesRes.status === 'fulfilled' && sourcesRes.value.ok) {
      try { setSources(await sourcesRes.value.json()); } catch { /* keep the last list */ }
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refetch when a plugin config save activates a plugin, or when the store itself
    // changed something, so a status badge flips without a page reload.
    const onChanged = () => void refresh();
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // A change made anywhere else — another tab, the author CLI, a soft reload after an
  // install — arrives as this event, so the list is never stale-but-confident.
  useEvent('plugin:runtime-changed', () => { void refresh(); });

  const handleAdd = async () => {
    const value = url.trim();
    if (!value || !trusted) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      // A share snippet is JSON and a git remote has a scheme; everything else
      // goes to the npm path so the error message is about the right thing.
      const isSnippet = value.startsWith('{');
      const payload = isSnippet || looksLikeGitUrl(value) ? { url: value } : { spec: value };
      const res = await fetch('/api/plugin-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setUrl('');
      setTrusted(false); // trust is granted per install, never sticky
      const count = body.plugins?.length ?? 0;
      const what = body.resolved ? ` (${body.resolved})` : '';
      setNotice(count > 0
        ? `Added${what}: found ${count} plugin${count === 1 ? '' : 's'}. New plugins are active now; use Configure on a row that needs setup.`
        : `Added${what}, but no plugins found (no manifest.json at the root or in top-level folders).`);
      await refresh();
      emitPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async (slug: string) => {
    setBusy(slug);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/plugin-sources/${slug}/update`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.restartRequired) setRestartNeeded(true);
      // git reports a SHA, npm reports the resolved name@version.
      const to = body.resolved ?? (body.toSha ?? '').slice(0, 7);
      setNotice(body.updated
        ? `Updated ${slug} to ${to}${body.restartRequired ? '. Restart Walnut to run the new code.' : '.'}`
        : `${slug} is already up to date.`);
      await refresh();
      if (body.updated) emitPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      const res = await fetch(`/api/plugin-sources/${slug}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.restartRequired) setRestartNeeded(true);
      await refresh();
      emitPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * ON goes through `reload` and OFF through `disable` — both write the `enabled`
   * flag to config.yaml first, which is what makes the switch survive a restart.
   */
  const handleToggle = async (row: RegistryRow, next: boolean) => {
    setBusy(row.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/plugin-runtime/${encodeURIComponent(row.id)}/${next ? 'reload' : 'disable'}`,
        { method: 'POST' },
      );
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setNotice(next
        ? `${row.name} is on.`
        : `${row.name} is off. It stays off until you turn it back on.`);
      await refresh();
      emitPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleClearQuarantine = async (row: RegistryRow) => {
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/plugin-runtime/${encodeURIComponent(row.id)}/clear-quarantine`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await refresh();
      emitPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** Catalog → the existing install form. Trust is deliberately NOT pre-ticked. */
  const prefillInstall = (row: RegistryRow) => {
    const value = row.source.kind === 'npm' ? row.source.spec ?? row.id : row.source.url ?? '';
    setUrl(value);
    setError(null);
    setNotice(`Ready to install ${row.name}. Tick the trust box, then press Add.`);
    urlInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    urlInputRef.current?.focus();
  };

  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedSlug(key);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const rows = registry?.rows ?? [];
  const installed = rows.filter((row) => row.installed);
  const available = rows.filter((row) => !row.installed);

  return (
    <SettingsSection
      id="plugin-store"
      title="Plugins"
      description="Everything installed on this machine, what each one adds, and a switch for each. Install more from a git repository or an npm package."
    >
      {restartNeeded && (
        <SettingsNotice kind="warn">Restart Walnut to apply updated plugin code.</SettingsNotice>
      )}
      {error && <SettingsNotice kind="error">{error}</SettingsNotice>}
      {notice && <SettingsNotice kind="success">{notice}</SettingsNotice>}

      {/* This section is the start point for everything plugin-shaped, and the
          simplest way in leads: describe a plugin, click, and a session builds it. */}
      <BuildPluginCard />

      {/* ── Installed ── */}
      <div className="plugin-store-group" data-testid="plugin-store-installed">
        <div className="plugin-store-group-head">
          <h4 className="settings-subcard-title">Installed</h4>
          <span className="plugin-store-count">{installed.length}</span>
        </div>
        {installed.length === 0 ? (
          <SettingsEmpty>
            {registry ? 'No plugins on this machine yet.' : 'Loading plugins…'}
          </SettingsEmpty>
        ) : (
          <div className="settings-row-list">
            {installed.map((row) => {
              const status = ROW_STATUS[row.status];
              const isOn = row.status === 'active';
              // Never auto-open. In a LIST, expanding an eight-field form on mount
              // buries every row under it — the row already says NEEDS SETUP, names
              // the missing field, and offers Configure.
              const open = configuring === row.id;
              return (
                <div key={row.id} className="plugin-store-entry">
                  <SettingsRow
                    data-testid={`plugin-row-${row.id}`}
                    data-plugin-status={row.status}
                    actions={(
                      <>
                        {row.configurable && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid={`plugin-configure-${row.id}`}
                            onClick={() => setConfiguring(open ? null : row.id)}
                          >
                            {open ? 'Done' : 'Configure'}
                          </button>
                        )}
                        {row.status === 'quarantined' && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy === row.id}
                            onClick={() => void handleClearQuarantine(row)}
                          >
                            Clear quarantine
                          </button>
                        )}
                        {row.sourceSlug && (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={busy === row.sourceSlug}
                              onClick={() => void handleUpdate(row.sourceSlug!)}
                            >
                              Update
                            </button>
                            <button
                              type="button"
                              className="btn-danger-outline"
                              disabled={busy === row.sourceSlug}
                              onClick={() => void handleRemove(row.sourceSlug!)}
                            >
                              Remove
                            </button>
                          </>
                        )}
                        {/* needs-config, unsupported and quarantined are refused by the
                            plugin manager itself, so a switch would flip straight back.
                            Those rows carry their reason in the copy on the left and
                            whatever action can actually help on the right, so nothing
                            is repeated here. */}
                        {row.toggleable && (
                          <ToggleSwitch
                            id={`plugin-toggle-${row.id}`}
                            checked={isOn}
                            onChange={(next) => void handleToggle(row, next)}
                          />
                        )}
                      </>
                    )}
                  >
                    <strong>
                      {row.name}
                      <span className={status.className}>{status.label}</span>
                      {row.version && <span className="plugin-store-version">v{row.version}</span>}
                    </strong>
                    {row.description && <span>{row.description}</span>}
                    <span>
                      {originLabel(row)}
                      {row.adds?.length ? ` · adds ${row.adds.join(', ')}` : ''}
                      {!row.adds?.length && row.capabilities?.length ? ` · ${row.capabilities.join(', ')}` : ''}
                    </span>
                    {row.status !== 'active' && (row.reason || row.error) && (
                      <span className="plugin-store-why">{row.error ?? row.reason}</span>
                    )}
                  </SettingsRow>
                  {/* The plugin's app entries live HERE, on the plugin itself —
                      an app is not a separate thing to manage on another panel. */}
                  <PluginAppControls pluginId={row.id} />
                  {open && row.configurable && (
                    <div className="plugin-store-config" data-testid={`plugin-config-${row.id}`}>
                      <PluginConfigCards config={config} onSave={onSave} onlyIds={[row.id]} bare />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Available ── */}
      {available.length > 0 && (
        <div className="plugin-store-group" data-testid="plugin-store-available">
          <div className="plugin-store-group-head">
            <h4 className="settings-subcard-title">Available</h4>
            <span className="plugin-store-count">{available.length}</span>
          </div>
          <div className="settings-row-list">
            {available.map((row) => (
              <SettingsRow
                key={row.id}
                data-testid={`plugin-row-${row.id}`}
                data-plugin-status={row.status}
                actions={(
                  <>
                    {row.homepage && (
                      <a
                        className="btn btn-secondary btn-sm"
                        href={row.homepage}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Read more
                      </a>
                    )}
                    {(row.source.kind === 'git' || row.source.kind === 'npm') && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-testid={`plugin-install-${row.id}`}
                        onClick={() => prefillInstall(row)}
                      >
                        Install…
                      </button>
                    )}
                    {row.source.kind === 'example' && row.source.path && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => copy(`walnut-plugin link ${row.source.path}`, `example:${row.id}`)}
                      >
                        {copiedSlug === `example:${row.id}` ? 'Copied ✓' : 'Copy link command'}
                      </button>
                    )}
                  </>
                )}
              >
                <strong>
                  {row.name}
                  <span className={ROW_STATUS.available.className}>{ROW_STATUS.available.label}</span>
                </strong>
                {row.description && <span>{row.description}</span>}
                <span>
                  {row.source.kind === 'builtin'
                    ? 'Ships with Walnut, but not present in this build'
                    : row.source.kind === 'example'
                      ? `In this checkout at ${row.source.path} · install it with walnut-plugin link`
                      : row.source.kind === 'npm'
                        ? `npm · ${row.source.spec ?? row.id}`
                        : `git · ${row.source.url ?? ''}`}
                  {row.adds?.length ? ` · adds ${row.adds.join(', ')}` : ''}
                </span>
              </SettingsRow>
            ))}
          </div>
        </div>
      )}

      {/* ── The free-form install path, for anything the catalog does not list ── */}
      <SettingsSubCard
        title="Install from a git repository or an npm package"
        description="A repo can hold one plugin (manifest.json at the root) or several (one folder per plugin); an npm package holds one, at its root."
      >
        <div className="form-group">
          <label htmlFor="plugin-source-url">Git URL or npm package</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="plugin-source-url"
              ref={urlInputRef}
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
              placeholder="git URL, npm package (name, name@1.2.3, @scope/name), or a teammate's share snippet"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy === 'add' || !url.trim() || !trusted}
              onClick={() => void handleAdd()}
            >
              {busy === 'add' ? 'Installing…' : 'Add'}
            </button>
          </div>
          <p className="text-xs text-muted" style={{ marginTop: 2 }}>
            Git uses your machine&apos;s git (ssh keys / credential helpers), so any remote your shell can clone works.
            npm disables lifecycle scripts, pins an exact version, and verifies the installed tarball receipt.
            Neither kind ever updates itself: you press Update.
          </p>
          {/* Its own class because `.form-group label` UPPERCASES everything, and this
              is the one sentence on the page that has to be read, not skimmed. */}
          <label
            htmlFor="plugin-trust-confirm"
            className="text-xs plugin-trust-label"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 6 }}
          >
            <input
              id="plugin-trust-confirm"
              data-testid="plugin-trust-confirm"
              type="checkbox"
              checked={trusted}
              onChange={e => setTrusted(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I trust this source. Its code runs inside Walnut with full access to my tasks, notes,
              credentials and this machine.
            </span>
          </label>
        </div>
      </SettingsSubCard>

      {/* ── Sources ──
          A source is not a plugin: one repo can carry several, and it is the source
          that gets updated or removed. So it keeps its own list, below the plugins. */}
      {sources.length > 0 && (
        <div className="plugin-store-group" data-testid="plugin-store-sources">
          <div className="plugin-store-group-head">
            <h4 className="settings-subcard-title">Sources</h4>
            <span className="plugin-store-count">{sources.length}</span>
          </div>
          {sources.map(source => (
            <div key={`${source.kind ?? 'git'}:${source.slug}:${source.spec ?? source.url ?? ''}`} className="settings-collapsible" style={{ padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>{source.slug}</strong>
                <span className="badge badge-none">{source.kind === 'npm' ? 'npm' : 'git'}</span>
                <span className="text-xs text-muted">{source.spec ?? source.url}</span>
                {source.resolved && <span className="text-xs text-muted">→ {source.resolved}</span>}
                {source.integrity && (
                  <span className="text-xs text-muted" title={source.integrity}>{shortIntegrity(source.integrity)}</span>
                )}
                {source.lastSha && <span className="text-xs text-muted">@ {source.lastSha.slice(0, 7)}</span>}
                <span style={{ flex: 1 }} />
                {source.shareSnippet && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => copy(source.shareSnippet!, source.slug)}
                  >
                    {copiedSlug === source.slug ? 'Copied ✓' : 'Copy share snippet'}
                  </button>
                )}
                <button type="button" className="btn btn-sm" disabled={busy === source.slug} onClick={() => void handleUpdate(source.slug)}>
                  {busy === source.slug ? 'Working…' : 'Update'}
                </button>
                <button type="button" className="btn-danger-outline" disabled={busy === source.slug} onClick={() => void handleRemove(source.slug)}>
                  Remove
                </button>
              </div>
              {source.lastError && (
                <p className="text-xs" style={{ color: 'var(--priority-immediate)', marginTop: 4 }}>{source.lastError}</p>
              )}
              {!source.cloned ? (
                <p className="text-xs" style={{ color: 'var(--priority-immediate)', marginTop: 6 }}>
                  This source is not installed on this machine. Update to restore it or Remove to clear it.
                </p>
              ) : source.plugins.length === 0 ? (
                <p className="text-xs text-muted" style={{ marginTop: 6 }}>
                  No plugins found in this {source.kind === 'npm' ? 'package' : 'repo'}.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
                  {source.plugins.map(plugin => {
                    const status = STATUS_LABELS[plugin.status] ?? STATUS_LABELS.error;
                    return (
                      <li key={plugin.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                        <span>{plugin.name ?? plugin.id ?? 'unnamed'}</span>
                        {plugin.version && <span className="text-xs text-muted">v{plugin.version}</span>}
                        <span className={status.className}>{status.label}</span>
                        {plugin.error && <span className="text-xs text-muted">{plugin.error}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {registry?.sourcesUnavailable && !registry.cloud && (
        <p className="text-xs text-muted">
          Could not read the installed-source list, so Update and Remove are unavailable on this view.
        </p>
      )}
      {registry?.cloud && (
        <p className="text-xs text-muted">
          Read from your Mac over the bridge. Installing and removing plugin sources happens on the Mac.
        </p>
      )}

    </SettingsSection>
  );
}
