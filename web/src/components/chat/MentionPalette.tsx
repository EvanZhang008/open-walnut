/**
 * MentionPalette — the unified "@" popup: ONE panel, two groups.
 *
 *   Sessions — picked row routes/references another session (in-memory fuzzy
 *              over the session-mention index: zero debounce, zero network).
 *   Files    — picked row inserts a file reference; the query doubles as a
 *              path (the part before the last "/" navigates, the tail filters)
 *              exactly like the old FileMentionPopup.
 *
 * `order` decides which group renders first (routeMention): line-start "@"
 * leads with Sessions, mid-text or path-shaped queries lead with Files. Both
 * groups are always present — no modes, no dead ends. Group captions state
 * what picking a row DOES, which is what keeps one symbol doing two jobs
 * without confusing anyone.
 *
 * Keyboard is driven by ChatInput through the imperative handle:
 *   move(±1) / jumpGroup() / primary() / selectCurrent() / up()
 * Selection is tracked by row KEY, not index — async file listings append or
 * reorder rows and must never yank the highlight off the user's choice.
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
  useSyncExternalStore,
  forwardRef,
} from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { formatSize } from '@/utils/format';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { recordRecentFolder } from '@/utils/recentFolders';
import { joinPath, parentPath, relativeTo, parseQuery } from './mention-path';
import {
  fuzzyMatch,
  rankSessionMentions,
  type RankedSessionMention,
} from './session-mention';
import {
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  subscribeSessionMentionIndex,
} from '@/stores/session-mention-index';
import { sessionStatusStore } from '@/stores/session-status-store';

export interface MentionPaletteHandle {
  /** Move selection by delta (wraps across both groups). */
  move: (delta: number) => void;
  /** Jump to the first row of the other group (Tab). */
  jumpGroup: () => void;
  /** Enter: session → pick · dir → descend into it · file → pick. */
  primary: () => void;
  /** Cmd/Ctrl+Enter: pick the highlighted row as-is (a dir becomes the ref). */
  selectCurrent: () => void;
  /** ← : browse to the parent directory (files context only). */
  up: () => void;
}

interface MentionPaletteProps {
  /** Text typed after the "@". */
  query: string;
  /** Which group leads (routeMention decides from the query/position). */
  order: 'sessions-first' | 'files-first';
  /** True when the "@" sits at line start — picking a session ROUTES the
   *  message there; false → it merely inserts a session reference. */
  sessionsRoute: boolean;
  /** Show the Sessions group at all (the caller has session mentions wired). */
  sessionsEnabled: boolean;
  /** Never offer the session the user is already talking to. */
  selfSessionId?: string;
  /** Root for the Files group; undefined → files group hidden. */
  cwd?: string;
  host?: string;
  onPickSession: (sessionId: string) => void;
  onPickFile: (absPath: string) => void;
  /** Rewrite the "@query" to browse an absolute dir (descend / go up). */
  onNavigate: (absDir: string) => void;
  onClose: () => void;
}

type Row =
  | { key: string; kind: 'session'; ranked: RankedSessionMention }
  | { key: string; kind: 'entry'; entry: DirEntry; positions: number[] };

/** Render `text` with the fuzzy-matched positions wrapped in <mark>. */
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  const out: React.ReactNode[] = [];
  let run = '';
  let runMarked = set.has(0);
  for (let i = 0; i <= text.length; i++) {
    const marked = i < text.length ? set.has(i) : !runMarked;
    if (i === text.length || marked !== runMarked) {
      if (run) out.push(runMarked ? <mark key={i}>{run}</mark> : run);
      run = '';
      runMarked = marked;
    }
    if (i < text.length) run += text[i];
  }
  return <>{out}</>;
}

// Half-half budget: with BOTH groups on screen, neither may fill the panel —
// the other group must be VISIBLE without scrolling (a full-height Sessions
// list hid the Files group entirely, so nobody knew files were reachable).
// A group only gets the whole panel when it is alone or the other group came
// back empty.
const SESSION_LIMIT_SOLO = 8;
const SESSION_LIMIT_SHARED = 4;
const FILE_LIMIT_SOLO = 12;
const FILE_LIMIT_SHARED = 5;

export const MentionPalette = forwardRef<MentionPaletteHandle, MentionPaletteProps>(
  function MentionPalette(
    { query, order, sessionsRoute, sessionsEnabled, selfSessionId, cwd, host, onPickSession, onPickFile, onNavigate, onClose },
    ref,
  ) {
    // ---- Sessions group: synchronous, in-memory -------------------------
    const index = useSyncExternalStore(subscribeSessionMentionIndex, getSessionMentionIndex);
    useEffect(() => { if (sessionsEnabled) void ensureSessionMentionIndex(); }, [sessionsEnabled]);
    const sessionRowsAll = useMemo<RankedSessionMention[]>(() => {
      if (!sessionsEnabled) return [];
      return rankSessionMentions(query, index, { excludeId: selfSessionId, limit: SESSION_LIMIT_SOLO });
    }, [sessionsEnabled, query, index, selfSessionId]);

    // ---- Files group: the query doubles as a path (parseQuery) ----------
    const filesEnabled = !!cwd;
    const [browseDir, setBrowseDir] = useState<string>(cwd ?? '');
    const [rootPath, setRootPath] = useState<string>(cwd ?? '');
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [filesLoading, setFilesLoading] = useState(filesEnabled);
    const [filesError, setFilesError] = useState<string | null>(null);
    const inFlightRef = useRef<string | null>(null);

    const loadDir = useCallback(async (dirPath: string, opts: { isRoot?: boolean } = {}) => {
      if (inFlightRef.current === dirPath) return;
      inFlightRef.current = dirPath;
      setFilesLoading(true);
      setFilesError(null);
      try {
        const res = await fetchDirList(dirPath, host, false);
        if (inFlightRef.current !== dirPath) return; // superseded by a newer navigation
        const canonical = res.path || dirPath;
        setBrowseDir(canonical);
        if (opts.isRoot) setRootPath(canonical);
        // Persist deliberately-visited folders for "@?" (same rule as the old
        // popup: never on the root open, which fires on every palette open).
        if (!opts.isRoot) recordRecentFolder(canonical, host);
        setEntries(res.entries);
      } catch (err) {
        if (inFlightRef.current !== dirPath) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.error('mention-palette', 'failed to list dir', { dirPath, host, error: msg });
        setFilesError(msg);
        setEntries([]);
      } finally {
        if (inFlightRef.current === dirPath) {
          inFlightRef.current = null;
          setFilesLoading(false);
        }
      }
    }, [host]);

    useEffect(() => {
      if (!filesEnabled) return;
      setRootPath(cwd!);
      setBrowseDir(cwd!);
      void loadDir(cwd!, { isRoot: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd, host]);

    const { dir: targetDir, filter: filterTerm } = parseQuery(query, cwd ?? '');
    useEffect(() => {
      if (!filesEnabled) return;
      const norm = (p: string) => p.replace(/\/+$/, '') || '/';
      if (norm(targetDir) !== norm(browseDir)) void loadDir(targetDir);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetDir, filesEnabled]);

    const fileRowsAll = useMemo(() => {
      if (!filesEnabled) return [] as Array<{ entry: DirEntry; positions: number[] }>;
      const q = filterTerm.trim();
      if (!q) return entries.slice(0, FILE_LIMIT_SOLO).map((entry) => ({ entry, positions: [] as number[] }));
      const hits: Array<{ entry: DirEntry; positions: number[]; score: number }> = [];
      for (const entry of entries) {
        const m = fuzzyMatch(q, entry.name);
        if (m) hits.push({ entry, positions: m.positions, score: m.score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, FILE_LIMIT_SOLO);
    }, [filesEnabled, entries, filterTerm]);

    // Apply the half-half budget. Sessions shrink as soon as the files group
    // occupies screen space (rows OR the loading skeleton — otherwise the list
    // would snap from 8 to 4 rows when the async listing lands); files shrink
    // when any session matched. Either group takes the full budget back the
    // moment the other is empty.
    const filesTakeSpace = filesEnabled && (filesLoading || fileRowsAll.length > 0);
    const sessionRows = useMemo(
      () => (filesTakeSpace ? sessionRowsAll.slice(0, SESSION_LIMIT_SHARED) : sessionRowsAll),
      [sessionRowsAll, filesTakeSpace],
    );
    const fileLimit = sessionRowsAll.length > 0 ? FILE_LIMIT_SHARED : FILE_LIMIT_SOLO;
    const fileRows = useMemo(() => fileRowsAll.slice(0, fileLimit), [fileRowsAll, fileLimit]);

    // ---- Flat row model (selection by key, stable across async loads) ---
    const rows = useMemo<Row[]>(() => {
      const sess: Row[] = sessionRows.map((ranked) => ({ key: `s:${ranked.session.id}`, kind: 'session', ranked }));
      const files: Row[] = fileRows.map(({ entry, positions }) => ({ key: `f:${entry.type}:${entry.name}`, kind: 'entry', entry, positions }));
      return order === 'sessions-first' ? [...sess, ...files] : [...files, ...sess];
    }, [sessionRows, fileRows, order]);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const selectedIndex = Math.max(0, rows.findIndex((r) => r.key === selectedKey));
    useEffect(() => {
      if (rows.length === 0) { setSelectedKey(null); return; }
      if (!rows.some((r) => r.key === selectedKey)) setSelectedKey(rows[0].key);
    }, [rows, selectedKey]);

    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = listRef.current?.querySelector('[data-selected="true"]');
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedKey]);

    // Global Escape (capture) — works after the user clicked into the popup.
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); }
      };
      window.addEventListener('keydown', handler, true);
      return () => window.removeEventListener('keydown', handler, true);
    }, [onClose]);

    const pick = useCallback((row: Row, opts: { forceSelect?: boolean } = {}) => {
      if (row.kind === 'session') { onPickSession(row.ranked.session.id); return; }
      const abs = joinPath(browseDir, row.entry.name);
      if (row.entry.type === 'dir' && !opts.forceSelect) onNavigate(abs);
      else onPickFile(abs);
    }, [browseDir, onPickSession, onPickFile, onNavigate]);

    useImperativeHandle(ref, (): MentionPaletteHandle => ({
      move: (delta) => {
        if (rows.length === 0) return;
        const next = (selectedIndex + delta + rows.length) % rows.length;
        setSelectedKey(rows[next].key);
      },
      jumpGroup: () => {
        const current = rows[selectedIndex];
        if (!current) return;
        const other = rows.find((r) => r.kind !== current.kind);
        if (other) setSelectedKey(other.key);
      },
      primary: () => { const r = rows[selectedIndex]; if (r) pick(r); },
      selectCurrent: () => { const r = rows[selectedIndex]; if (r) pick(r, { forceSelect: true }); },
      up: () => {
        if (!filesEnabled) return;
        const parent = parentPath(browseDir);
        if (parent !== browseDir) onNavigate(parent);
      },
    }), [rows, selectedIndex, pick, filesEnabled, browseDir, onNavigate]);

    // ---- Render ----------------------------------------------------------
    const renderSessionRow = (row: Extract<Row, { kind: 'session' }>) => {
      const { session, matchField, positions } = row.ranked;
      const live = sessionStatusStore.getStatus(session.id);
      const status = live?.process_status ?? session.status;
      const waiting = !!live?.pendingPermissionTool;
      const hostLabel = session.host && session.host !== '__local__' ? session.host : 'local';
      const shortId = session.id.slice(0, 8);
      const dotClass = waiting ? 'waiting' : status === 'running' ? 'running' : status === 'error' ? 'error' : 'idle';
      return (
        <div
          key={row.key}
          className={`mention-row${row.key === selectedKey ? ' selected' : ''}`}
          data-selected={row.key === selectedKey || undefined}
          onMouseEnter={() => setSelectedKey(row.key)}
          onMouseDown={(e) => { e.preventDefault(); pick(row); }}
          title={`${session.title || '(untitled)'} — ${hostLabel} · ${status}`}
        >
          <span className={`mention-dot ${dotClass}`} />
          <span className="mention-main">
            <span className="mention-title">
              {matchField === 'title'
                ? <Highlighted text={session.title || '(untitled)'} positions={positions} />
                : (session.title || '(untitled)')}
            </span>
            <span className="mention-meta">
              {matchField === 'host' ? <Highlighted text={hostLabel} positions={positions} /> : hostLabel}
              {' · '}{waiting ? 'waiting on you' : status}
              {session.lastActiveAt ? <> · {timeAgo(session.lastActiveAt)}</> : null}
            </span>
          </span>
          <span className="mention-id">
            {matchField === 'id' ? <Highlighted text={shortId} positions={positions} /> : shortId}
          </span>
        </div>
      );
    };

    const renderEntryRow = (row: Extract<Row, { kind: 'entry' }>) => {
      const { entry, positions } = row;
      return (
        <div
          key={row.key}
          className={`mention-row${row.key === selectedKey ? ' selected' : ''}`}
          data-selected={row.key === selectedKey || undefined}
          onMouseEnter={() => setSelectedKey(row.key)}
          onMouseDown={(e) => { e.preventDefault(); pick(row); }}
          title={joinPath(browseDir, entry.name)}
        >
          <span className="mention-ficon">{entry.type === 'dir' ? '📁' : '📄'}</span>
          <span className="mention-main">
            <span className="mention-title"><Highlighted text={entry.name} positions={positions} /></span>
          </span>
          {entry.type === 'dir' && <span className="mention-into">→</span>}
          {entry.type === 'file' && entry.size != null && (
            <span className="mention-size">{formatSize(entry.size)}</span>
          )}
          {entry.type === 'dir' && (
            <button
              className="mention-pick-btn"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); pick(row, { forceSelect: true }); }}
              title="Reference this folder (⌘⏎)"
            >
              Select
            </button>
          )}
        </div>
      );
    };

    const sessionsGroup = sessionsEnabled && (sessionRows.length > 0 || !filesEnabled) ? (
      <div key="g-sessions">
        <div className="mention-group-head">
          <span className="mention-group-name">Sessions</span>
          <span className="mention-group-verb">
            {sessionsRoute ? '⏎ sends this message to it' : '⏎ inserts a session ref'}
          </span>
        </div>
        {sessionRows.length === 0 && <div className="mention-empty">No matching session</div>}
        {sessionRows.map((ranked) => renderSessionRow({ key: `s:${ranked.session.id}`, kind: 'session', ranked }))}
      </div>
    ) : null;

    const atRoot = browseDir.replace(/\/+$/, '') === rootPath.replace(/\/+$/, '');
    const filesGroup = filesEnabled ? (
      <div key="g-files">
        <div className="mention-group-head">
          <span className="mention-group-name">Files</span>
          <span className="mention-group-verb">
            ⏎ inserts a file ref{atRoot ? '' : ` · in ${relativeTo(rootPath, browseDir)}`}
          </span>
        </div>
        {filesError && <div className="mention-empty">{filesError}</div>}
        {!filesError && filesLoading && entries.length === 0 && (
          <div className="mention-skeleton"><span className="sk-icon" /><span className="sk-line" /></div>
        )}
        {!filesError && !filesLoading && fileRows.length === 0 && (
          <div className="mention-empty">No matching file</div>
        )}
        {fileRows.map(({ entry, positions }) =>
          renderEntryRow({ key: `f:${entry.type}:${entry.name}`, kind: 'entry', entry, positions }))}
      </div>
    ) : null;

    return (
      <div className="mention-palette" role="listbox" aria-label="Mention picker">
        <div className="mention-list" ref={listRef}>
          {order === 'sessions-first' ? <>{sessionsGroup}{filesGroup}</> : <>{filesGroup}{sessionsGroup}</>}
        </div>
        <div className="mention-hintbar">
          <span><b>↑↓</b> move</span>
          {sessionsEnabled && filesEnabled && <span><b>⇥</b> group</span>}
          <span><b>⏎</b> select</span>
          {filesEnabled && <span><b>←</b> parent</span>}
          {filesEnabled && <span><b>@?</b> recents</span>}
          <span><b>esc</b> close</span>
        </div>
      </div>
    );
  },
);
