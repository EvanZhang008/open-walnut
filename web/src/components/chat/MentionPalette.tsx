/**
 * MentionPalette — the unified "@" popup: ONE panel, Tasks + Files.
 *
 *   Tasks — picking a row INSERTS A `<task-ref/>` pill into the message. The
 *           message still goes to the CURRENT session; its agent gets a compact
 *           reference card appended server-side (the task, its session and that
 *           session's status) and decides what to do (read the task, message
 *           its session, …). Nothing is routed by the composer. There is no
 *           Sessions group and no Projects group: every session belongs to a
 *           task, so the task row carries it (a status dot, "running" /
 *           "waiting on you" in the meta line), and a project is reached
 *           through its tasks.
 *   Files — picked row inserts a Claude-Code-native `@path`; the query doubles
 *           as a path (the part before the last "/" navigates, the tail
 *           filters), exactly like the old FileMentionPopup.
 *
 * Search is two-layered so it never waits on the network: an in-memory fuzzy
 * pass over the browser's own task list paints on every keystroke, and the
 * hybrid `/api/search` hits (full-text + vector — the engine behind the task
 * search box; transcript hits fold into their task) re-rank the group when
 * they land a beat later. `order` (routeMention) decides whether Tasks or
 * Files lead; both stay visible at once thanks to the shared row budget
 * (groupRowBudget).
 *
 * Keyboard is driven by ChatInput through the imperative handle:
 *   move(±1) / jumpGroup() / primary() / selectCurrent() / up()
 * Selection is tracked by row KEY, not index — async listings append or
 * reorder rows and must never yank the highlight off the user's choice.
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';
import { recordRecentFolder } from '@/utils/recentFolders';
import { taskRefTag } from '@/utils/entity-ref-tags';
import { resolveTaskSessionId } from '@/utils/session-status';
import { joinPath, parentPath, relativeTo, parseQuery } from './mention-path';
import { fuzzyMatch } from './session-mention';
import {
  groupRowBudget,
  hitsAsTasks,
  mergeServerHits,
  rankEntities,
  taskEntity,
  type MentionEntity,
  type RankedEntity,
} from './mention-entities';
import { useEntitySearch } from '@/stores/mention-search';
import { sessionStatusStore } from '@/stores/session-status-store';

export interface MentionPaletteHandle {
  /** Move selection by delta (wraps across all groups). */
  move: (delta: number) => void;
  /** Jump to the first row of the NEXT group (Tab). */
  jumpGroup: () => void;
  /** Enter: entity → insert its reference · dir → descend · file → pick. */
  primary: () => void;
  /** Cmd/Ctrl+Enter: pick the highlighted row as-is (a dir becomes the ref). */
  selectCurrent: () => void;
  /** ← : browse to the parent directory (files context only). */
  up: () => void;
}

interface MentionPaletteProps {
  /** Text typed after the "@". */
  query: string;
  /** Which half leads (routeMention decides from the query's shape). */
  order: 'entities-first' | 'files-first';
  /** Show the Tasks group at all. */
  entitiesEnabled: boolean;
  /** Never offer the task the user is already talking to (by its session). */
  selfSessionId?: string;
  /** Root for the Files group; undefined → files group hidden. */
  cwd?: string;
  host?: string;
  /** An entity was picked: `tag` is the ready-to-insert reference pill. */
  onPickRef: (tag: string, entity: MentionEntity) => void;
  onPickFile: (absPath: string) => void;
  /** Rewrite the "@query" to browse an absolute dir (descend / go up). */
  onNavigate: (absDir: string) => void;
  onClose: () => void;
}

type Row =
  | { key: string; kind: 'entity'; group: 'task'; ranked: RankedEntity }
  | { key: string; kind: 'entry'; group: 'files'; entry: DirEntry; positions: number[] };

type GroupId = 'task' | 'files';

const GROUP_LABEL: Record<GroupId, string> = { task: 'Tasks', files: 'Files' };
const GROUP_VERB: Record<GroupId, string> = {
  task: '⏎ inserts a task reference',
  files: '⏎ inserts a file ref',
};

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

const FILE_SOLO_LIMIT = 12;

export const MentionPalette = forwardRef<MentionPaletteHandle, MentionPaletteProps>(
  function MentionPalette(
    { query, order, entitiesEnabled, selfSessionId, cwd, host, onPickRef, onPickFile, onNavigate, onClose },
    ref,
  ) {
    // ---- Tasks group: instant local layer --------------------------------
    // The status epoch is a dependency so a session that starts or stops while
    // the palette is open moves its task's dot (the store is WS-fed).
    const tasksCtx = useTasksContextSafe();
    const statusEpoch = useSessionStatusEpoch();
    const { taskEntities, selfTaskId } = useMemo(() => {
      if (!entitiesEnabled || !tasksCtx) return { taskEntities: [] as MentionEntity[], selfTaskId: null as string | null };
      let selfId: string | null = null;
      const out: MentionEntity[] = [];
      for (const t of tasksCtx.tasks) {
        const sid = resolveTaskSessionId(t);
        if (selfSessionId && sid === selfSessionId) { selfId = t.id; continue; }
        out.push(taskEntity(t, sessionStatusStore.getStatus(sid)));
      }
      return { taskEntities: out, selfTaskId: selfId };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entitiesEnabled, tasksCtx, selfSessionId, statusEpoch]);
    const taskById = useMemo(() => new Map(taskEntities.map((e) => [e.id, e])), [taskEntities]);

    // ---- Tasks group: hybrid search layer (debounced, folded in) ---------
    const search = useEntitySearch(query, entitiesEnabled && order === 'entities-first');
    const searchCurrent = search.forQuery === query.trim() && search.forQuery !== '';
    const serverTasks = useMemo<MentionEntity[]>(
      () => (searchCurrent ? hitsAsTasks(search.hits, taskById, { taskId: selfTaskId, sessionId: selfSessionId }) : []),
      [search.hits, searchCurrent, taskById, selfTaskId, selfSessionId],
    );

    const rankedTasks = useMemo<RankedEntity[]>(
      () => mergeServerHits(query, rankEntities(query, taskEntities, { limit: 12 }), serverTasks),
      [query, taskEntities, serverTasks],
    );

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
      if (!q) return entries.slice(0, FILE_SOLO_LIMIT).map((entry) => ({ entry, positions: [] as number[] }));
      const hits: Array<{ entry: DirEntry; positions: number[]; score: number }> = [];
      for (const entry of entries) {
        const m = fuzzyMatch(q, entry.name);
        if (m) hits.push({ entry, positions: m.positions, score: m.score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, FILE_SOLO_LIMIT);
    }, [filesEnabled, entries, filterTerm]);

    // ---- Shared row budget: every non-empty group stays visible ----------
    // The Files group always renders when enabled (rows, skeleton, or the
    // "No matching file" line), so it always counts — otherwise the entity
    // groups would snap from tall to short when the async listing lands.
    const nonEmpty = (rankedTasks.length > 0 ? 1 : 0) + (filesEnabled ? 1 : 0);
    const budget = groupRowBudget(nonEmpty);
    const taskRows = useMemo(() => rankedTasks.slice(0, budget.entity), [rankedTasks, budget.entity]);
    const fileRows = useMemo(() => fileRowsAll.slice(0, budget.files), [fileRowsAll, budget.files]);

    // ---- Flat row model (selection by key, stable across async loads) ---
    const rows = useMemo<Row[]>(() => {
      const entityRows: Row[] = taskRows.map((ranked) =>
        ({ key: `task:${ranked.entity.id}`, kind: 'entity' as const, group: 'task' as const, ranked }));
      const files: Row[] = fileRows.map(({ entry, positions }) =>
        ({ key: `f:${entry.type}:${entry.name}`, kind: 'entry' as const, group: 'files' as const, entry, positions }));
      return order === 'entities-first' ? [...entityRows, ...files] : [...files, ...entityRows];
    }, [taskRows, fileRows, order]);

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

    // A multi-word query that DEFINITIVELY matches nothing (local layer empty,
    // hybrid search answered for this exact query, files settled) closes the
    // palette: the trigger only allows spaces while we are open, so this hands
    // Enter back to "send" instead of swallowing it on an empty list forever.
    const settledEmpty = rows.length === 0 && !filesLoading
      && (!entitiesEnabled || (!search.loading && search.forQuery === query.trim()));
    useEffect(() => {
      if (settledEmpty && /\s/.test(query)) onClose();
    }, [settledEmpty, query, onClose]);

    // Global Escape (capture) — works after the user clicked into the popup.
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); }
      };
      window.addEventListener('keydown', handler, true);
      return () => window.removeEventListener('keydown', handler, true);
    }, [onClose]);

    const pick = useCallback((row: Row, opts: { forceSelect?: boolean } = {}) => {
      if (row.kind === 'entity') { onPickRef(taskRefTag(row.ranked.entity.id, row.ranked.entity.title), row.ranked.entity); return; }
      const abs = joinPath(browseDir, row.entry.name);
      if (row.entry.type === 'dir' && !opts.forceSelect) onNavigate(abs);
      else onPickFile(abs);
    }, [browseDir, onPickRef, onPickFile, onNavigate]);

    useImperativeHandle(ref, (): MentionPaletteHandle => ({
      move: (delta) => {
        if (rows.length === 0) return;
        const next = (selectedIndex + delta + rows.length) % rows.length;
        setSelectedKey(rows[next].key);
      },
      jumpGroup: () => {
        const current = rows[selectedIndex];
        if (!current) return;
        // First row of the next group after the current one, wrapping around.
        const after = rows.slice(selectedIndex + 1).find((r) => r.group !== current.group)
          ?? rows.find((r) => r.group !== current.group);
        if (after) setSelectedKey(after.key);
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
    const renderEntityRow = (row: Extract<Row, { kind: 'entity' }>) => {
      const { entity, positions, matchField, source } = row.ranked;
      // A task with a session shows that session's state as the dot; one
      // without shows the plain task glyph.
      const dotClass = entity.sessionId
        ? (entity.status === 'waiting' ? 'waiting' : entity.status === 'running' ? 'running' : entity.status === 'error' ? 'error' : 'idle')
        : null;
      // A purely semantic hit has nothing to highlight: show the snippet that
      // matched instead, so the row explains itself.
      const semanticOnly = source === 'server' && positions.length === 0 && !!entity.summary;
      return (
        <div
          key={row.key}
          className={`mention-row mention-row-task${row.key === selectedKey ? ' selected' : ''}`}
          data-selected={row.key === selectedKey || undefined}
          data-kind="task"
          data-session-status={entity.sessionId ? entity.status : undefined}
          onMouseEnter={() => setSelectedKey(row.key)}
          onMouseDown={(e) => { e.preventDefault(); pick(row); }}
          title={`${entity.title} — ${entity.meta}`}
        >
          {dotClass
            ? <span className={`mention-dot ${dotClass}`} />
            : <span className="mention-kind mention-kind-task" aria-hidden="true">▢</span>}
          <span className="mention-main">
            <span className="mention-title">
              {matchField === 'title'
                ? <Highlighted text={entity.title} positions={positions} />
                : entity.title}
            </span>
            <span className="mention-meta">
              {entity.meta}
              {semanticOnly && <span className="mention-summary"> · {entity.summary}</span>}
            </span>
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

    const entityGroups = entitiesEnabled ? (
      <div key="g-entities">
        {taskRows.length > 0 && (
          <div data-group="task">
            <div className="mention-group-head">
              <span className="mention-group-name">{GROUP_LABEL.task}</span>
              <span className="mention-group-verb">{GROUP_VERB.task}</span>
              {search.loading && <span className="mention-searching" title="Searching…" />}
            </div>
            {taskRows.map((ranked) =>
              renderEntityRow({ key: `task:${ranked.entity.id}`, kind: 'entity', group: 'task', ranked }))}
          </div>
        )}
        {taskRows.length === 0 && (query.trim() || !filesEnabled) && (
          <div className="mention-group-head">
            <span className="mention-group-name">{GROUP_LABEL.task}</span>
            <span className="mention-group-verb">
              {search.loading ? 'Searching…' : 'No matching task'}
            </span>
          </div>
        )}
      </div>
    ) : null;

    const atRoot = browseDir.replace(/\/+$/, '') === rootPath.replace(/\/+$/, '');
    const filesGroup = filesEnabled ? (
      <div key="g-files" data-group="files">
        <div className="mention-group-head">
          <span className="mention-group-name">{GROUP_LABEL.files}</span>
          <span className="mention-group-verb">
            {GROUP_VERB.files}{atRoot ? '' : ` · in ${relativeTo(rootPath, browseDir)}`}
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
          renderEntryRow({ key: `f:${entry.type}:${entry.name}`, kind: 'entry', group: 'files', entry, positions }))}
      </div>
    ) : null;

    return (
      <div className="mention-palette" role="listbox" aria-label="Mention picker">
        <div className="mention-list" ref={listRef}>
          {order === 'entities-first' ? <>{entityGroups}{filesGroup}</> : <>{filesGroup}{entityGroups}</>}
        </div>
        <div className="mention-hintbar">
          <span><b>↑↓</b> move</span>
          {entitiesEnabled && filesEnabled && <span><b>⇥</b> group</span>}
          <span><b>⏎</b> reference</span>
          {filesEnabled && <span><b>←</b> parent</span>}
          {filesEnabled && <span><b>@?</b> recents</span>}
          <span><b>esc</b> close</span>
        </div>
      </div>
    );
  },
);
