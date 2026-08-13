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

// ── Model presets ──

const MODEL_PRESETS = [
  { label: 'Qwen3-Embedding-0.6B (Default, multilingual, ~640 MB)', value: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf' },
  { label: 'EmbeddingGemma (Compact, ~300 MB)', value: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf' },
  { label: 'BGE-M3 (Multilingual, ~1.16 GB)', value: 'hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf' },
  { label: 'Custom...', value: 'custom' },
];

// Server default is defined in src/core/qmd-model.ts - keep in sync.
const DEFAULT_MODEL = MODEL_PRESETS[0].value;

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

// ── Types for API responses ──

interface QmdModelInfo {
  name: string;
  file: string;
  size: string | null;
  path: string | null;
  downloaded: boolean | null;
}

interface StoreStats {
  collections: Record<string, { indexed: number; embedded: number; chunks: number }>;
  totalIndexed: number;
  totalEmbedded: number;
  totalChunks: number;
}

interface EmbedProgress {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  store: string;
}

interface QmdStatus {
  model: QmdModelInfo;
  stores: {
    memory: StoreStats | null;
    notes: StoreStats | null;
    tasks: StoreStats | null;
    sessions: StoreStats | null;
  };
  status: 'ready' | 'indexing' | 'downloading' | 'error';
  error: string | null;
  progress: EmbedProgress | null;
}

// ── Pulse keyframe style (injected once) ──

const PULSE_KEYFRAMES = `
@keyframes qmd-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
`;

// ── Component ──

export function SearchSection({ config, onSave }: Props) {
  const confirm = useConfirm();
  const search = config.search ?? {};
  const [selectedModel, setSelectedModel] = useState(() => {
    const saved = search.qmd_model ?? DEFAULT_MODEL;
    const isPreset = MODEL_PRESETS.some((p) => p.value === saved);
    return isPreset ? saved : 'custom';
  });
  const [customUrl, setCustomUrl] = useState(() => {
    const saved = search.qmd_model ?? '';
    const isPreset = MODEL_PRESETS.some((p) => p.value === saved);
    return isPreset ? '' : saved;
  });
  const [customUrlError, setCustomUrlError] = useState<string | null>(null);
  // Excluded-folders editor: raw text (comma/newline separated), parsed on save.
  const [excludedText, setExcludedText] = useState(() => (search.excluded_folders ?? []).join('\n'));

  // QMD status from server
  const [qmdStatus, setQmdStatus] = useState<QmdStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);

  const pollRef = useRef<(() => void) | undefined>(undefined);
  // Track whether user has made unsaved edits (suppress config->state sync)
  const userEditedRef = useRef(false);
  // Track initial mount for config sync
  const mountedRef = useRef(false);

  // ── Sync from config prop (only on initial mount or if user hasn't edited) ──
  useEffect(() => {
    if (mountedRef.current && userEditedRef.current) return;
    mountedRef.current = true;
    const s = config.search ?? {};
    const saved = s.qmd_model ?? DEFAULT_MODEL;
    const isPreset = MODEL_PRESETS.some((p) => p.value === saved);
    setSelectedModel(isPreset ? saved : 'custom');
    setCustomUrl(isPreset ? '' : saved);
    setExcludedText((s.excluded_folders ?? []).join('\n'));
  }, [config]);

  // ── Fetch status (CRITICAL-1: AbortController) ──
  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/qmd/status', { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: QmdStatus = await res.json();
      setQmdStatus(data);
      setFetchError(null);
      return data;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      log.warn('settings', 'QMD status fetch failed', { error: msg });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Initial fetch with AbortController ──
  useEffect(() => {
    const ac = new AbortController();
    fetchStatus(ac.signal);
    return () => ac.abort();
  }, [fetchStatus]);

  // ── Poll while downloading or indexing (CRITICAL-2: clear before create) ──
  // visibleInterval: model downloads take minutes — hidden tabs skip the poll.
  useEffect(() => {
    pollRef.current?.();
    if (qmdStatus?.status === 'downloading' || qmdStatus?.status === 'indexing') {
      pollRef.current = visibleInterval(fetchStatus, 5000);
    }
    return () => {
      pollRef.current?.();
    };
  }, [qmdStatus?.status, fetchStatus]);

  // ── Actions (CRITICAL-3: actionPending guard) ──
  const handleDownload = async () => {
    setActionPending(true);
    try {
      const res = await fetch('/api/qmd/download', { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      log.info('settings', 'QMD download triggered');
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('settings', 'QMD download trigger failed', { error: msg });
      setFetchError(msg);
    } finally {
      setActionPending(false);
    }
  };

  const handleReindex = async () => {
    // MEDIUM-2: Confirmation before reindex
    if (!(await confirm({ title: 'Re-index all documents?', message: 'This may take a few minutes.', confirmLabel: 'Re-index' }))) return;
    setActionPending(true);
    try {
      const res = await fetch('/api/qmd/reindex', { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      log.info('settings', 'QMD reindex triggered');
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('settings', 'QMD reindex trigger failed', { error: msg });
      setFetchError(msg);
    } finally {
      setActionPending(false);
    }
  };

  // ── Save config (CRITICAL-4: validate custom URL) ──
  const handleSave = async () => {
    setCustomUrlError(null);
    if (selectedModel === 'custom') {
      const trimmed = customUrl.trim();
      if (!trimmed) {
        setCustomUrlError('Model URL is required');
        return;
      }
      if (!trimmed.startsWith('hf:')) {
        setCustomUrlError('Model URL must start with "hf:" (e.g. hf:org/repo/file.gguf)');
        return;
      }
    }
    const modelValue = selectedModel === 'custom' ? customUrl.trim() : selectedModel;
    const excluded = parseExcludedFolders(excludedText);
    await onSave({
      search: {
        ...config.search,
        qmd_model: modelValue || undefined,
        excluded_folders: excluded.length > 0 ? excluded : undefined,
      },
    });
    await fetchStatus();
    // Reset user-edited flag after successful save
    userEditedRef.current = false;
  };

  // ── Auto-save ──
  // The model value that WOULD be persisted. Custom + invalid URL (empty or not hf:) is gated
  // out via `enabled` so a half-typed custom URL never auto-writes — handleSave would reject it
  // anyway, but gating avoids the wasted call + error flash on every keystroke.
  const effectiveModel = selectedModel === 'custom' ? customUrl.trim() : selectedModel;
  const customValid = selectedModel !== 'custom' || (!!customUrl.trim() && customUrl.trim().startsWith('hf:'));
  useAutoSave({
    enabled: customValid,
    current: JSON.stringify({
      qmd_model: effectiveModel || undefined,
      excluded_folders: parseExcludedFolders(excludedText),
    }),
    baseline: JSON.stringify({
      qmd_model: (config.search?.qmd_model ?? DEFAULT_MODEL) || undefined,
      excluded_folders: config.search?.excluded_folders ?? [],
    }),
    save: handleSave,
  });

  // ── Derived state ──
  const isBusy = qmdStatus?.status === 'downloading' || qmdStatus?.status === 'indexing';
  const buttonsDisabled = actionPending || isBusy;
  const modelDownloaded = qmdStatus?.model.downloaded ?? false;

  return (
    <SectionCard id="search" title="Search & Embeddings" description="Local embedding model for semantic search (QMD). Changes save automatically." onSave={handleSave} showSave={false}>
      {/* Inject pulse keyframes */}
      <style>{PULSE_KEYFRAMES}</style>

      {/* ── Model Status ── */}
      <div className="form-group">
        {/* MEDIUM-3: div instead of label for non-form display */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontWeight: 500 }}>
          Model Status
          <StatusBadge status={qmdStatus?.status ?? null} loading={loading} />
        </div>

        {loading && !qmdStatus && (
          <p className="text-sm text-muted">Loading status...</p>
        )}

        {/* HIGH-3: Show fetch error alongside stale data */}
        {fetchError && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            {qmdStatus ? 'Last status update failed: ' : 'Failed to fetch status: '}{fetchError}
          </p>
        )}

        {qmdStatus && (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div><span className="text-muted">Model:</span> {qmdStatus.model.name}</div>
            <div><span className="text-muted">File:</span> <code style={{ fontSize: 12 }}>{qmdStatus.model.file}</code></div>
            <div><span className="text-muted">Size:</span> {qmdStatus.model.size}</div>
            {qmdStatus.error && (
              <div style={{ color: 'var(--error)', marginTop: 4 }}>
                Error: {qmdStatus.error}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={buttonsDisabled}
            onClick={handleDownload}
            data-testid="qmd-download-btn"
          >
            {/* MEDIUM-1: Label changes when already downloaded */}
            {qmdStatus?.status === 'downloading' ? 'Downloading...' : modelDownloaded ? 'Re-download Model' : 'Download Model'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={buttonsDisabled || !modelDownloaded}
            onClick={handleReindex}
            data-testid="qmd-reindex-btn"
          >
            {qmdStatus?.status === 'indexing' ? 'Indexing...' : 'Re-index'}
          </button>
        </div>

        {/* ── Embedding Progress Bar ── */}
        {qmdStatus?.status === 'indexing' && qmdStatus.progress && qmdStatus.progress.totalChunks > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Embedding {qmdStatus.progress.store}: {qmdStatus.progress.chunksEmbedded} / {qmdStatus.progress.totalChunks} chunks ({Math.round(qmdStatus.progress.chunksEmbedded / qmdStatus.progress.totalChunks * 100)}%)
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary, #333)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                borderRadius: 3,
                background: 'var(--accent, #4a9eff)',
                width: `${Math.round(qmdStatus.progress.chunksEmbedded / qmdStatus.progress.totalChunks * 100)}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Index Statistics ── */}
      {qmdStatus && (qmdStatus.stores.memory || qmdStatus.stores.notes || qmdStatus.stores.tasks || qmdStatus.stores.sessions) && (
        <div className="form-group">
          {/* MEDIUM-3: div instead of label */}
          <div style={{ marginBottom: 8, fontWeight: 500 }}>Index Statistics</div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {qmdStatus.stores.memory && (
              <StoreStatsCard label="Memory" stats={qmdStatus.stores.memory} />
            )}
            {qmdStatus.stores.notes && (
              <StoreStatsCard label="Notes" stats={qmdStatus.stores.notes} />
            )}
            {qmdStatus.stores.tasks && (
              <StoreStatsCard label="Tasks" stats={qmdStatus.stores.tasks} />
            )}
            {qmdStatus.stores.sessions && (
              <StoreStatsCard label="Sessions" stats={qmdStatus.stores.sessions} />
            )}
          </div>
        </div>
      )}

      {/* ── Model Selection ── */}
      <div className="form-group">
        <label htmlFor="qmd-model">Embedding Model</label>
        <select
          id="qmd-model"
          value={selectedModel}
          onChange={(e) => {
            setSelectedModel(e.target.value);
            setCustomUrlError(null);
            userEditedRef.current = true;
          }}
          data-testid="qmd-model-select"
        >
          {MODEL_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {selectedModel === 'custom' && (
          <>
            <input
              type="text"
              value={customUrl}
              onChange={(e) => {
                setCustomUrl(e.target.value);
                setCustomUrlError(null);
                userEditedRef.current = true;
              }}
              placeholder="hf:org/repo/file.gguf"
              style={{ marginTop: 8, ...(customUrlError ? { borderColor: 'var(--error)' } : {}) }}
              data-testid="qmd-custom-url-input"
            />
            {customUrlError && (
              <p className="text-sm" style={{ color: 'var(--error)', marginTop: 4 }}>
                {customUrlError}
              </p>
            )}
          </>
        )}
        <p className="text-sm text-muted" style={{ marginTop: 4 }}>
          Changing the model requires re-downloading and re-indexing all documents.
        </p>
        {/* HIGH-1: Warning that model change requires restart / re-download */}
        <p className="text-sm" style={{ marginTop: 2, color: 'var(--warning, #e8a838)' }}>
          Model change takes effect after clicking Download Model to fetch and apply the new model.
        </p>
      </div>

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

function StatusBadge({ status, loading }: { status: QmdStatus['status'] | null; loading: boolean }) {
  if (loading && !status) return <span className="text-sm text-muted">(checking...)</span>;

  // LOW-2: Type-safe status map
  const map: Record<QmdStatus['status'], { color: string; label: string }> = {
    ready: { color: 'var(--success)', label: 'Ready' },
    downloading: { color: 'var(--warning, #e8a838)', label: 'Downloading...' },
    indexing: { color: 'var(--warning, #e8a838)', label: 'Indexing...' },
    error: { color: 'var(--error)', label: 'Error' },
  };

  const info = status ? map[status] : null;
  if (!info) return null;

  // HIGH-2: Use the injected qmd-pulse keyframe
  const isAnimating = status === 'downloading' || status === 'indexing';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12,
        fontWeight: 500,
        color: info.color,
      }}
    >
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: info.color,
        display: 'inline-block',
        animation: isAnimating ? 'qmd-pulse 1.5s infinite' : undefined,
      }} />
      {info.label}
    </span>
  );
}

function StoreStatsCard({ label, stats }: { label: string; stats: StoreStats }) {
  const entries = Object.entries(stats.collections).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return (
      <div style={{ minWidth: 180 }}>
        <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No indexed documents yet
        </div>
      </div>
    );
  }

  const allEmbedded = stats.totalEmbedded >= stats.totalIndexed;

  return (
    <div style={{ minWidth: 180 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--text-muted)' }}>
        {entries.map(([name, col]) => (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span>{name}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{col.indexed} docs</span>
          </div>
        ))}
        {/* Totals row */}
        <div style={{
          borderTop: '1px solid var(--border)',
          marginTop: 4,
          paddingTop: 4,
          fontWeight: 500,
          display: 'flex',
          justifyContent: 'space-between',
        }}>
          <span>Indexed</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats.totalIndexed} docs</span>
        </div>
        {/* Embedding health row */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontWeight: 500,
          color: allEmbedded ? 'var(--success)' : 'var(--warning, #e8a838)',
        }}>
          <span>Embedded</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {stats.totalEmbedded}/{stats.totalIndexed} {allEmbedded ? '\u2713' : '\u26a0'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Chunks</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats.totalChunks}</span>
        </div>
      </div>
    </div>
  );
}
