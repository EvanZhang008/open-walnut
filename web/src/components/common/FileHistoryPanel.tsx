/**
 * History for the file the user has open — ONE timeline over two sources.
 *
 * Walnut's own snapshots (recorded when the viewer opens a file and when the
 * editor saves one) and git commits that touched the same file are merged and
 * sorted newest-first, so the panel reads the same whether or not the file is in
 * a repo. Git is additive: when it is unavailable the timeline simply has fewer
 * rows, and the only reason worth saying out loud is a daemon that needs an
 * upgrade (something the user can act on by sending a message to that host).
 *
 * Clicking a row loads that version and diffs it against the CURRENT BUFFER, so
 * the question the panel answers is "what would change if I went back to this".
 * Restore never writes to disk — it hands the text to the parent, which drops it
 * into the editor as unsaved work.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Diff, Hunk, parseDiff, type FileData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import {
  fetchFileHistory, fetchFileHistoryVersion,
  type FileHistoryEntry, type FileHistoryCommit, type FileHistoryResponse, type FileHistoryWriter,
} from '@/api/file-history';
import { toGitStylePatch } from '@/components/sessions/diffPatch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import '@/styles/file-history.css';

export interface FileHistoryPanelProps {
  path: string;
  host?: string;
  /** The editor's live text, read when a version is loaded (not on every render). */
  currentText: () => string;
  /** Hand a version's text back to the parent as UNSAVED editor content. */
  onRestore: (content: string, label: string) => void;
  onClose: () => void;
  /** Bump to re-fetch (e.g. after a save) without remounting the panel. */
  refreshToken?: number;
}

/** One row of the merged timeline. */
type Row =
  | { kind: 'snapshot'; key: string; at: number; entry: FileHistoryEntry }
  | { kind: 'commit'; key: string; at: number; commit: FileHistoryCommit };

const WRITER_LABEL: Record<FileHistoryWriter, string> = {
  baseline: 'Opened',
  user: 'You',
  live: 'Live',
  merge: 'Merged',
  agent: 'Agent',
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `timeAgo` takes a date string; the wire carries epoch ms. */
function agoOf(at: number): string {
  return at > 0 ? timeAgo(new Date(at).toISOString()) : '';
}

function buildRows(data: FileHistoryResponse | null): Row[] {
  if (!data) return [];
  const rows: Row[] = [];
  for (const entry of data.entries) {
    rows.push({ kind: 'snapshot', key: `s:${entry.id}`, at: entry.at, entry });
  }
  for (const commit of data.git.commits ?? []) {
    rows.push({ kind: 'commit', key: `g:${commit.sha}`, at: commit.at, commit });
  }
  // Newest first. Ties keep git under the snapshot (a save and its commit in the
  // same second read better in that order).
  rows.sort((a, b) => b.at - a.at || (a.kind === b.kind ? 0 : a.kind === 'snapshot' ? -1 : 1));
  return rows;
}

/** A version the user selected, plus the buffer it was compared against. */
interface LoadedVersion {
  rowKey: string;
  label: string;
  content: string;
  current: string;
}

export function FileHistoryPanel({
  path, host, currentText, onRestore, onClose, refreshToken,
}: FileHistoryPanelProps) {
  const [data, setData] = useState<FileHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedVersion | null>(null);
  const [versionLoading, setVersionLoading] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  // Held in a ref so `loadVersion` (and therefore every memoized row) stays
  // stable when the parent passes a fresh closure each render.
  const currentTextRef = useRef(currentText);
  currentTextRef.current = currentText;

  // Fetch on mount and when the file, host, or refreshToken changes — never per
  // render. `cancelled` keeps a slow answer for the PREVIOUS file from landing
  // in the panel after the user moved on.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);
    setVersionError(null);
    fetchFileHistory(path, host)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('file-history', 'history fetch failed', { path, host, error: msg });
        setError(msg);
        setData(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, host, refreshToken]);

  const rows = useMemo(() => buildRows(data), [data]);

  const loadVersion = useCallback(async (row: Row) => {
    const label = row.kind === 'snapshot'
      ? `${WRITER_LABEL[row.entry.writer]} · ${agoOf(row.at)}`
      : `git ${shortSha(row.commit.sha)}`;
    setVersionLoading(row.key);
    setVersionError(null);
    try {
      const res = await fetchFileHistoryVersion(
        path, host,
        row.kind === 'snapshot' ? { id: row.entry.id } : { sha: row.commit.sha },
      );
      // Capture the buffer NOW, so the diff below is a pure function of state
      // instead of re-reading the editor on every render.
      setLoaded({ rowKey: row.key, label, content: res.content, current: currentTextRef.current() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('file-history', 'version fetch failed', { path, host, row: row.key, error: msg });
      setVersionError(msg);
      setLoaded(null);
    } finally {
      setVersionLoading(null);
    }
  }, [path, host]);

  const fileName = path.split('/').pop() || path;
  const gitUnavailableNote = data && !data.git.available && data.git.reason === 'daemon_needs_upgrade'
    ? 'Git history needs a daemon upgrade on this host'
    : null;
  const empty = !loading && !error && rows.length === 0;

  return (
    <div className="fh-panel">
      <div className="fh-header">
        <span className="fh-title">History</span>
        <span className="fh-file" title={path}>{fileName}</span>
        <button type="button" className="fh-close" onClick={onClose} title="Close history" aria-label="Close history">✕</button>
      </div>

      {loading && <div className="fh-loading"><LoadingSpinner /></div>}
      {error && <div className="fh-error">Couldn’t load history: {error}</div>}
      {empty && <div className="fh-empty">No history yet</div>}
      {gitUnavailableNote && <div className="fh-note">{gitUnavailableNote}</div>}

      {rows.length > 0 && (
        <ul className="fh-list">
          {rows.map((row) => (
            <FileHistoryRow
              key={row.key}
              row={row}
              selected={loaded?.rowKey === row.key}
              busy={versionLoading === row.key}
              onSelect={loadVersion}
            />
          ))}
        </ul>
      )}

      {versionError && <div className="fh-error">Couldn’t load that version: {versionError}</div>}

      {loaded && (
        <FileHistoryDiff
          loaded={loaded}
          fileName={fileName}
          onRestore={() => onRestore(loaded.content, loaded.label)}
        />
      )}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

const FileHistoryRow = memo(function FileHistoryRow({
  row, selected, busy, onSelect,
}: {
  row: Row;
  selected: boolean;
  busy: boolean;
  onSelect: (row: Row) => void;
}) {
  const pill = row.kind === 'snapshot' ? WRITER_LABEL[row.entry.writer] : `git ${shortSha(row.commit.sha)}`;
  const detail = row.kind === 'snapshot' ? formatSize(row.entry.size) : row.commit.subject;
  return (
    <li>
      <button
        type="button"
        className={`fh-row${selected ? ' is-selected' : ''}`}
        onClick={() => onSelect(row)}
        title={row.kind === 'commit' ? `${row.commit.subject} — ${row.commit.author}` : detail}
      >
        <span className={`fh-pill fh-pill-${row.kind === 'snapshot' ? row.entry.writer : 'commit'}`}>{pill}</span>
        <span className="fh-when">{agoOf(row.at)}</span>
        <span className="fh-detail">{detail}</span>
        {busy && <span className="fh-row-busy">…</span>}
      </button>
    </li>
  );
});

// ── Diff of the selected version against the current buffer ───────────────────

function FileHistoryDiff({
  loaded, fileName, onRestore,
}: {
  loaded: LoadedVersion;
  fileName: string;
  onRestore: () => void;
}) {
  // Same pipeline the Changed tab uses (diffPatch → react-diff-view), so a diff
  // here renders and folds identically. A parse failure must never throw out of
  // the memo and blank the panel.
  const file = useMemo<FileData | null>(() => {
    if (loaded.content === loaded.current) return null;
    try {
      const patch = toGitStylePatch(fileName, loaded.content, loaded.current);
      if (!patch) return null;
      return parseDiff(patch, { nearbySequences: 'zip' })[0] ?? null;
    } catch {
      return null;
    }
  }, [loaded, fileName]);

  return (
    <div className="fh-diff">
      <div className="fh-diff-head">
        <span className="fh-diff-label">{loaded.label} → now</span>
        <button type="button" className="fh-restore" onClick={onRestore}>Restore this version</button>
      </div>
      <div className="fh-restore-hint">Loads into the editor; save when you’re happy.</div>
      <div className="fh-diff-body">
        {file
          ? (
            <Diff viewType="unified" diffType={file.type} hunks={file.hunks} className="fh-diff-table">
              {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
            </Diff>
          )
          : <div className="fh-same">Identical to what’s in the editor now</div>}
      </div>
    </div>
  );
}
