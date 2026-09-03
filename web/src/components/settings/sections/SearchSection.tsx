import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
import { useAutoSave } from '@/hooks/useAutoSave';
import { useConfirm } from '@/hooks/useConfirm';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

/**
 * Search settings.
 *
 * There is no model picker any more: the embedding model is an ONNX model the
 * embed worker fetches on first use (env override WALNUT_SEARCH_EMBED_MODEL for
 * experiments), so there is nothing for a user to choose or download. What the
 * panel still owns: index health, a manual re-index, and the excluded-folders
 * list.
 */

/**
 * Parse the excluded-folders input (comma/newline separated) into normalized
 * vault-relative prefixes: trimmed, slashes stripped from both ends, deduped
 * case-insensitively. Mirrors the server's normalizeExcludeFolders.
 */
function parseExcludedFolders(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,\n]/)) {
    const f = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!f) continue;
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ── Types for API responses (see src/web/routes/search-index.ts) ──

interface ModelInfo {
  name: string;
  file: string;
  size: string | null;
  path: string | null;
  downloaded: boolean | null;
}

interface StoreStats {
  collections: number;
  totalIndexed: number;
  totalEmbedded: number | null;
  totalChunks: number | null;
}

interface IndexStatus {
  model: ModelInfo;
  stores: Record<string, StoreStats | null>;
  status: 'ready' | 'indexing' | 'error';
  error: string | null;
}

const STORE_LABELS: Array<[string, string]> = [
  ['tasks', 'Tasks'],
  ['sessions', 'Sessions'],
  ['notes', 'Notes'],
  ['memory', 'Memory'],
  ['skills', 'Skills'],
];

const PULSE_KEYFRAMES = `
@keyframes search-index-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
`;

export function SearchSection({ config, onSave }: Props) {
  const confirm = useConfirm();
  const search = config.search ?? {};
  // Excluded-folders editor: raw text (comma/newline separated), parsed on save.
  const [excludedText, setExcludedText] = useState(() => (search.excluded_folders ?? []).join('\n'));

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);

  const pollRef = useRef<(() => void) | undefined>(undefined);
  const userEditedRef = useRef(false);
  const mountedRef = useRef(false);

  // ── Sync from config prop (only on initial mount or if user hasn't edited) ──
  useEffect(() => {
    if (mountedRef.current && userEditedRef.current) return;
    mountedRef.current = true;
    const s = config.search ?? {};
    setExcludedText((s.excluded_folders ?? []).join('\n'));
  }, [config]);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/search-index/status', { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: IndexStatus = await res.json();
      setIndexStatus(data);
      setFetchError(null);
      return data;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      log.warn('settings', 'search index status fetch failed', { error: msg });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchStatus(ac.signal);
    return () => ac.abort();
  }, [fetchStatus]);

  // Poll while indexing. visibleInterval: a rebuild takes minutes — hidden tabs
  // skip the poll.
  useEffect(() => {
    pollRef.current?.();
    if (indexStatus?.status === 'indexing') {
      pollRef.current = visibleInterval(fetchStatus, 5000);
    }
    return () => {
      pollRef.current?.();
    };
  }, [indexStatus?.status, fetchStatus]);

  const handleReindex = async () => {
    if (!(await confirm({
      title: 'Rebuild the search index?',
      message: 'Re-reads every task, session, note, memory file and skill. This may take a few minutes; search keeps working while it runs.',
      confirmLabel: 'Rebuild',
    }))) return;
    setActionPending(true);
    try {
      const res = await fetch('/api/search-index/reindex', { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      log.info('settings', 'search index rebuild triggered');
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('settings', 'search index rebuild trigger failed', { error: msg });
      setFetchError(msg);
    } finally {
      setActionPending(false);
    }
  };

  const handleSave = async () => {
    const excluded = parseExcludedFolders(excludedText);
    await onSave({
      search: {
        ...config.search,
        excluded_folders: excluded.length > 0 ? excluded : undefined,
      },
    });
    userEditedRef.current = false;
  };

  useAutoSave({
    current: JSON.stringify({ excluded_folders: parseExcludedFolders(excludedText) }),
    baseline: JSON.stringify({ excluded_folders: config.search?.excluded_folders ?? [] }),
    save: handleSave,
  });

  const isBusy = indexStatus?.status === 'indexing';
  const stores = indexStatus?.stores ?? {};
  const hasAnyStore = STORE_LABELS.some(([key]) => stores[key]);

  return (
    <SectionCard
      id="search"
      title="Search"
      description="Hybrid keyword + semantic index over tasks, sessions, notes, memory and skills. Changes save automatically."
      onSave={handleSave}
      showSave={false}
    >
      <style>{PULSE_KEYFRAMES}</style>

      {/* ── Index status ── */}
      <div className="form-group">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontWeight: 500 }}>
          Index Status
          <StatusBadge status={indexStatus?.status ?? null} loading={loading} />
        </div>

        {loading && !indexStatus && <p className="text-sm text-muted">Loading status...</p>}

        {fetchError && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            {indexStatus ? 'Last status update failed: ' : 'Failed to fetch status: '}{fetchError}
          </p>
        )}

        {indexStatus && (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>
              <span className="text-muted">Embedding model:</span>{' '}
              <code style={{ fontSize: 12 }}>{indexStatus.model.name}</code>
            </div>
            {indexStatus.error && (
              <div style={{ color: 'var(--error)', marginTop: 4 }}>Error: {indexStatus.error}</div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={actionPending || isBusy}
            onClick={handleReindex}
            data-testid="search-index-reindex-btn"
          >
            {isBusy ? 'Rebuilding...' : 'Rebuild index'}
          </button>
        </div>
      </div>

      {/* ── Index statistics ── */}
      {indexStatus && hasAnyStore && (
        <div className="form-group">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>Indexed Documents</div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {STORE_LABELS.map(([key, label]) => {
              const stats = stores[key];
              return stats ? <StoreStatsCard key={key} label={label} stats={stats} /> : null;
            })}
          </div>
        </div>
      )}

      {/* ── Excluded Folders ── */}
      <div className="form-group">
        <label htmlFor="search-excluded-folders">Excluded Folders</label>
        <textarea
          id="search-excluded-folders"
          value={excludedText}
          onChange={(e) => {
            setExcludedText(e.target.value);
            userEditedRef.current = true;
          }}
          placeholder={'archive\nArchive/old-stuff'}
          rows={3}
          spellCheck={false}
          style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}
          data-testid="search-excluded-folders-input"
        />
        <p className="text-sm text-muted" style={{ marginTop: 4 }}>
          Vault folders hidden from search results — one per line (or comma-separated), e.g. <code>archive</code>. Matching is case-insensitive and covers all subfolders. Content stays indexed, so removing an entry restores it instantly (no re-index).
        </p>
      </div>
    </SectionCard>
  );
}

// ── Sub-components ──

function StatusBadge({ status, loading }: { status: IndexStatus['status'] | null; loading: boolean }) {
  if (loading && !status) return <span className="text-sm text-muted">(checking...)</span>;

  const map: Record<IndexStatus['status'], { color: string; label: string }> = {
    ready: { color: 'var(--success)', label: 'Ready' },
    indexing: { color: 'var(--warning, #e8a838)', label: 'Indexing...' },
    error: { color: 'var(--error)', label: 'Error' },
  };

  const info = status ? map[status] : null;
  if (!info) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 500, color: info.color }}>
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: info.color,
        display: 'inline-block',
        animation: status === 'indexing' ? 'search-index-pulse 1.5s infinite' : undefined,
      }} />
      {info.label}
    </span>
  );
}

function StoreStatsCard({ label, stats }: { label: string; stats: StoreStats }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--text-muted)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>Documents</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats.totalIndexed}</span>
        </div>
      </div>
    </div>
  );
}
