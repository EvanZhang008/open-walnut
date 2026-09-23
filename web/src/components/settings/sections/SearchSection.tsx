import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import {
  SettingsEmpty, SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow, SettingsSection, SettingsTag,
} from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
import { useConfirm } from '@/hooks/useConfirm';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
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
export function parseExcludedFolders(text: string): string[] {
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


const STATUS_TAG: Record<IndexStatus['status'], { text: string; tone: 'success' | 'neutral' | 'warning' }> = {
  ready: { text: 'Ready', tone: 'success' },
  indexing: { text: 'Indexing', tone: 'neutral' },
  error: { text: 'Error', tone: 'warning' },
};

/** `Tasks 6,367, Sessions 40` for the stores that report (pure, unit tested). */
export function indexedSummary(stores: Record<string, StoreStats | null>): string {
  return STORE_LABELS
    .filter(([key]) => stores[key])
    .map(([key, label]) => `${label} ${stores[key]!.totalIndexed.toLocaleString('en-US')}`)
    .join(', ');
}

/** Hybrid keyword and semantic index: its health, a rebuild, the excluded folders. */
export function SearchSection({ config, onSave }: Props) {
  const confirm = useConfirm();
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [draft, setDraft] = useState('');
  const pollRef = useRef<(() => void) | undefined>(undefined);

  const save = useSerialSave(config, onSave);
  const excluded = useOptimisticSetting<string[]>(
    config.search?.excluded_folders ?? [],
    (next) => save((c) => ({ search: { ...c.search, excluded_folders: next.length > 0 ? next : undefined } }), { rowKey: 'search.excluded' }),
    { rowKey: 'search.excluded' },
  );

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
    void fetchStatus(ac.signal);
    return () => ac.abort();
  }, [fetchStatus]);

  // Poll while indexing; visibleInterval skips hidden tabs (a rebuild takes minutes).
  useEffect(() => {
    pollRef.current?.();
    if (indexStatus?.status === 'indexing') pollRef.current = visibleInterval(fetchStatus, 5000);
    return () => { pollRef.current?.(); };
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

  const add = () => {
    const merged = parseExcludedFolders([...excluded.value, draft].join('\n'));
    setDraft('');
    if (merged.length !== excluded.value.length) excluded.set(merged);
  };

  const isBusy = indexStatus?.status === 'indexing';
  const tag = indexStatus ? STATUS_TAG[indexStatus.status] : null;
  const summary = indexStatus ? indexedSummary(indexStatus.stores ?? {}) : '';

  return (
    <SettingsSection id="search" title="Search">
      <SettingsGroup heading="Index">
        {loading && !indexStatus ? <SettingsLoadingRow /> : (
          <>
            <SettingsRow
              label="Status"
              help={indexStatus?.error ? `Error: ${indexStatus.error}` : summary || undefined}
              state={indexStatus?.error ? 'warning' : undefined}
              control={
                <span className="settings-control-cluster">
                  {tag && <SettingsTag tone={tag.tone}>{tag.text}</SettingsTag>}
                  <SettingsButton
                    busy={isBusy || actionPending}
                    busyLabel="Rebuilding..."
                    onClick={() => void handleReindex()}
                    data-testid="search-index-reindex-btn"
                  >
                    Rebuild index
                  </SettingsButton>
                </span>
              }
            />
            {indexStatus && (
              <SettingsRow label="Embedding model" control={indexStatus.model.name && indexStatus.model.name !== 'disabled'
                ? <code className="settings-mono-value">{indexStatus.model.name}</code>
                : <span className="settings-addons-muted">Off, keyword search only</span>} />
            )}
          </>
        )}
        {fetchError && (
          <SettingsNotice kind="error" role="alert" action={<SettingsButton variant="text" onClick={() => void fetchStatus()}>Retry</SettingsButton>}>
            Couldn&apos;t load the index status: {fetchError}
          </SettingsNotice>
        )}
      </SettingsGroup>

      <SettingsGroup
        heading="Excluded folders"
        footer="Hidden from results with their subfolders; content stays indexed, so removing one restores it at once."
        data-testid="search-excluded-folders"
      >
        {excluded.value.length === 0 && <SettingsEmpty>Nothing excluded.</SettingsEmpty>}
        {excluded.value.map((folder) => (
          <SettingsRow
            key={folder}
            label={<code className="settings-mono-value">{folder}</code>}
            data-testid="search-excluded-folder"
            control={
              <InlineConfirmButton
                aria-label={`Remove ${folder}`}
                onConfirm={() => excluded.set(excluded.value.filter((f) => f !== folder))}
              />
            }
          />
        ))}
        <SettingsRow
          wide
          label="Add folder"
          htmlFor="search-excluded-folders"
          error={excluded.error}
          control={
            <span className="settings-control-cluster">
              <input
                id="search-excluded-folders"
                type="text"
                className="settings-input settings-input--long settings-input--mono"
                placeholder="Folder name"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); add(); }
                }}
                data-testid="search-excluded-folders-input"
              />
              <SettingsButton disabled={!draft.trim()} title={draft.trim() ? undefined : 'Type a folder first.'} onClick={add} data-testid="search-excluded-folders-add">Add</SettingsButton>
            </span>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
