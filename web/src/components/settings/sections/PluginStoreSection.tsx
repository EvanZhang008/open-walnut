/**
 * Settings → Plugin Store: install plugins from git repos.
 *
 * Paste a git URL → Walnut clones it, scans for plugins (dirs with a
 * manifest.json), and loads new ones immediately (soft reload — no restart).
 * Updating a source whose plugins are already loaded requires a restart to
 * pick up the new code; the UI says so honestly.
 */
import { useState, useEffect, useCallback } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events';

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
  url: string;
  ref?: string;
  enabled: boolean;
  cloned: boolean;
  lastSha?: string;
  lastSyncedAt?: string;
  lastError?: string;
  plugins: StorePlugin[];
  shareSnippet?: string;
}

const STATUS_LABELS: Record<StorePlugin['status'], { label: string; className: string }> = {
  loaded: { label: 'active', className: 'badge badge-done' },
  'needs-config': { label: 'needs setup', className: 'badge badge-important' },
  unsupported: { label: 'needs newer Walnut', className: 'badge badge-none' },
  duplicate: { label: 'shadowed', className: 'badge badge-none' },
  error: { label: 'invalid', className: 'badge badge-immediate' },
  'pending-restart': { label: 'restart to activate', className: 'badge badge-important' },
};

export function PluginStoreSection() {
  const [sources, setSources] = useState<PluginSource[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'add' | slug
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/plugin-sources');
      if (res.ok) setSources(await res.json());
    } catch { /* server unreachable — keep current list */ }
  }, []);

  useEffect(() => {
    void refresh();
    // Also refetch when a plugin config save activates a plugin — its per-plugin
    // status badge here flips from "needs setup" to "active".
    const onChanged = () => void refresh();
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const handleAdd = async () => {
    if (!url.trim()) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/plugin-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setUrl('');
      const count = body.plugins?.length ?? 0;
      setNotice(count > 0
        ? `Added — found ${count} plugin${count === 1 ? '' : 's'}. New plugins are active now; configure them under Integrations.`
        : 'Added, but no plugins found in this repo (no manifest.json at root or in top-level folders).');
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
      setNotice(body.updated
        ? `Updated ${slug} to ${(body.toSha ?? '').slice(0, 7)}${body.restartRequired ? ' — restart Walnut to run the new code.' : '.'}`
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

  return (
    <SectionCard
      id="plugin-store"
      title="Plugin Store"
      description="Install plugins from git repositories. A repo can hold one plugin (manifest.json at the root) or several (one folder per plugin)."
    >
      {restartNeeded && (
        <p className="text-sm" style={{ color: 'var(--priority-important)' }}>
          Restart Walnut to apply updated plugin code.
        </p>
      )}

      <div className="form-group">
        <label htmlFor="plugin-source-url">Git repository URL</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="plugin-source-url"
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            placeholder="Paste a git URL — or a share snippet from a teammate"
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-sm" disabled={busy === 'add' || !url.trim()} onClick={() => void handleAdd()}>
            {busy === 'add' ? 'Cloning…' : 'Add'}
          </button>
        </div>
        <p className="text-xs text-muted" style={{ marginTop: 2 }}>
          Uses your machine&apos;s git (ssh keys / credential helpers), so any remote your shell can clone works.
          Plugins run with full access to Walnut and your machine — only add repos you trust.
        </p>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--priority-immediate)' }}>{error}</p>}
      {notice && <p className="text-sm" style={{ color: 'var(--success)' }}>{notice}</p>}

      {sources.map(source => (
        <div key={source.slug} className="settings-collapsible" style={{ padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong>{source.slug}</strong>
            <span className="text-xs text-muted">{source.url}</span>
            {source.lastSha && <span className="text-xs text-muted">@ {source.lastSha.slice(0, 7)}</span>}
            <span style={{ flex: 1 }} />
            {source.shareSnippet && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(source.shareSnippet!);
                  setCopiedSlug(source.slug);
                  setTimeout(() => setCopiedSlug(null), 2000);
                }}
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
          {source.plugins.length === 0 ? (
            <p className="text-xs text-muted" style={{ marginTop: 6 }}>No plugins found in this repo.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {source.plugins.map(plugin => {
                const status = STATUS_LABELS[plugin.status] ?? STATUS_LABELS.error;
                return (
                  <li key={plugin.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                    <span>{plugin.name ?? plugin.id ?? 'unnamed'}</span>
                    {plugin.version && <span className="text-xs text-muted">v{plugin.version}</span>}
                    <span className={status.className}>{status.label}</span>
                    {plugin.status === 'needs-config' && (
                      <a href="#integrations" className="text-xs">Configure in Integrations</a>
                    )}
                    {plugin.error && <span className="text-xs text-muted">{plugin.error}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {sources.length === 0 && (
        <p className="text-sm text-muted">No plugin sources yet. Paste a git URL above to install plugins.</p>
      )}
    </SectionCard>
  );
}
