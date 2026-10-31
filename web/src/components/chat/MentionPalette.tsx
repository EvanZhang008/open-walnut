/**
 * MentionPalette — the unified "@" popup: ONE panel, Tasks + Files.
 *
 *   Tasks — ONE level. A task and its session are one thing here (the session
 *           is the task's runtime), so a row is a task with its run state: a
 *           dot (running / waiting on you / idle) and the state's word in the
 *           meta line. Picking a row INSERTS an inline `@[title]` reference
 *           where the "@" was (a `<task-ref/>` tag in the sent message, see
 *           composer-refs.ts); the message still goes to the CURRENT session,
 *           whose agent gets a compact reference card appended server-side
 *           (the task and its state) and reaches the task with task_get /
 *           task_send. Nothing is routed by the composer. No Sessions group,
 *           no Projects group: a project is reached through its tasks.
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
 * Sources (Notes, Slack, Mail, any a plugin adds: core/mention-sources/ on the
 * server) get a tab each after "All" (mention-sources-model.ts has the rules):
 * Tab/Shift+Tab or ←/→ at the edges of the query cycle them, and "@slack deploy"
 * (keyword + space) jumps to one. "All" is the mixed view: the Tasks and Files
 * groups, plus a source row only when the query names it exactly. A picked
 * source row inserts a `<source-ref/>` pill; the server resolves it into a
 * reference card for the model at send time.
 *
 * Keyboard is driven by ChatInput through the imperative handle:
 *   move(±1) / cycleSource(±1) / jumpGroup() / primary() / selectCurrent() / up()
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
import { ICON_FILE, ICON_FOLDER, ICON_MAIL, ICON_NOTE, ICON_PERSON } from '@/components/common/Icons';
import { fetchDirList, type DirEntry } from '@/api/files';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';
import { recordRecentFolder } from '@/utils/recentFolders';
import { sourceRefTag, taskRefTag } from '@/utils/entity-ref-tags';
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
import { useMentionSources, useSourceSearch } from '@/stores/source-search';
import {
  ALL_SOURCE_DEBOUNCE_MS,
  ALL_SOURCE_MIN_CHARS,
  ALL_TAB,
  cycleTab,
  parseKeywordScope,
  preciseRowsForAll,
  tabsOf,
  type MentionSourceRow,
} from './mention-sources-model';
import { sessionStatusStore } from '@/stores/session-status-store';

export interface MentionPaletteHandle {
  /** Move selection by delta (wraps across all groups). */
  move: (delta: number) => void;
  /** Jump to the first row of the NEXT group (Tab when there are no source tabs). */
  jumpGroup: () => void;
  /** Tab / Shift+Tab / ←→: the next or previous source tab. False when there are none. */
  cycleSource: (delta: number) => boolean;
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
  /** Same, for a composer that has a task but no session yet (a bound draft). */
  selfTaskId?: string;
  /** Root for the Files group; undefined → files group hidden. */
  cwd?: string;
  host?: string;
  /** A task or a source row was picked: `tag` is the ready-to-insert reference pill. */
  onPickRef: (tag: string, entity?: MentionEntity) => void;
  /** Rewrite the "@query" (leaving a keyword's tab drops the keyword). */
  onSetQuery?: (query: string) => void;
  onPickFile: (absPath: string) => void;
  /** Rewrite the "@query" to browse an absolute dir (descend / go up). */
  onNavigate: (absDir: string) => void;
  onClose: () => void;
}

type Row =
  | { key: string; kind: 'entity'; group: 'task'; ranked: RankedEntity }
  | { key: string; kind: 'entry'; group: 'files'; entry: DirEntry; positions: number[] }
  | { key: string; kind: 'source'; group: string; sourceId: string; item: MentionSourceRow };

/** Rows a source tab asks for, and what "All" asks each source for (exact matches only). */
const SOURCE_TAB_LIMIT = 12;
const SOURCE_ALL_LIMIT = 6;

const KIND_ICON: Record<string, React.ReactNode> = { person: ICON_PERSON, channel: '#', message: ICON_MAIL, note: ICON_NOTE };

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
    { query, order, entitiesEnabled, selfSessionId, selfTaskId, cwd, host, onPickRef, onSetQuery, onPickFile, onNavigate, onClose },
    ref,
  ) {
    // ---- Source tabs ------------------------------------------------------
    // The keyword ("@slack deploy") wins over the tab the user cycled to; leaving
    // its tab drops the keyword (cycleSource), so the two never disagree for long.
    const sources = useMentionSources();
    // A composer without references (files only) gets no source tabs: a picked
    // row is a reference pill, which only a reference composer can carry.
    const tabs = useMemo(() => (entitiesEnabled ? tabsOf(sources) : [ALL_TAB]), [sources, entitiesEnabled]);
    const [pickedTab, setPickedTab] = useState<string>(ALL_TAB);
    const scope = useMemo(() => (entitiesEnabled ? parseKeywordScope(query, sources) : null), [query, sources, entitiesEnabled]);
    const tab = scope?.sourceId ?? (tabs.includes(pickedTab) ? pickedTab : ALL_TAB);
    const onAll = tab === ALL_TAB;
    const sourceQuery = scope ? scope.rest : query;
    const activeSource = onAll ? undefined : sources.find((src) => src.id === tab);
    const allSourceIds = useMemo(() => {
      const q = query.trim();
      if (!entitiesEnabled || !onAll || q.length < ALL_SOURCE_MIN_CHARS || q.includes('/')) return [] as string[];
      return sources.filter((src) => src.inAll !== false && q.length >= src.minChars).map((src) => src.id);
    }, [entitiesEnabled, onAll, query, sources]);
    const tabSearch = useSourceSearch(activeSource ? [activeSource.id] : [], sourceQuery, SOURCE_TAB_LIMIT);
    const allSearch = useSourceSearch(allSourceIds, query, SOURCE_ALL_LIMIT, ALL_SOURCE_DEBOUNCE_MS);

    // ---- Tasks group: instant local layer --------------------------------
    // The status epoch is a dependency so a task that starts or stops running
    // while the palette is open moves its dot (the store is WS-fed).
    const tasksCtx = useTasksContextSafe();
    const statusEpoch = useSessionStatusEpoch();
    const { taskEntities, ownTaskId } = useMemo(() => {
      if (!entitiesEnabled || !tasksCtx) return { taskEntities: [] as MentionEntity[], ownTaskId: selfTaskId ?? null };
      let selfId: string | null = selfTaskId ?? null;
      const out: MentionEntity[] = [];
      for (const t of tasksCtx.tasks) {
        const sid = resolveTaskSessionId(t);
        if ((selfSessionId && sid === selfSessionId) || (selfTaskId && t.id === selfTaskId)) { selfId = t.id; continue; }
        out.push(taskEntity(t, sessionStatusStore.getStatus(sid)));
      }
      return { taskEntities: out, ownTaskId: selfId };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entitiesEnabled, tasksCtx, selfSessionId, selfTaskId, statusEpoch]);
    const taskById = useMemo(() => new Map(taskEntities.map((e) => [e.id, e])), [taskEntities]);

    // ---- Tasks group: hybrid search layer (debounced, folded in) ---------
    const search = useEntitySearch(query, entitiesEnabled && onAll && order === 'entities-first');
    const searchCurrent = search.forQuery === query.trim() && search.forQuery !== '';
    const serverTasks = useMemo<MentionEntity[]>(
      () => (searchCurrent ? hitsAsTasks(search.hits, taskById, ownTaskId) : []),
      [search.hits, searchCurrent, taskById, ownTaskId],
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
    // "All": a source row joins only when the query names it exactly.
    const preciseRows = useMemo<Row[]>(() => {
      if (!onAll || allSearch.forQuery !== query.trim()) return [];
      const answers = allSourceIds.map((id) => ({ sourceId: id, rows: allSearch.answers.get(id)?.rows ?? [] }));
      return preciseRowsForAll(query, answers).map(({ sourceId, row }) =>
        ({ key: `s:${sourceId}:${row.ref}`, kind: 'source' as const, group: `src:${sourceId}`, sourceId, item: row }));
    }, [onAll, allSearch, allSourceIds, query]);

    const tabAnswer = activeSource ? tabSearch.answers.get(activeSource.id) : undefined;
    const tabLoading = !!activeSource && (tabSearch.forQuery !== sourceQuery.trim() || tabSearch.loading.has(activeSource.id));
    const sourceRows = useMemo<Row[]>(() => {
      if (!activeSource || !tabAnswer) return [];
      return tabAnswer.rows.map((row) =>
        ({ key: `s:${activeSource.id}:${row.ref}`, kind: 'source' as const, group: `src:${activeSource.id}`, sourceId: activeSource.id, item: row }));
    }, [activeSource, tabAnswer]);

    const rows = useMemo<Row[]>(() => {
      if (!onAll) return sourceRows;
      const entityRows: Row[] = taskRows.map((ranked) =>
        ({ key: `task:${ranked.entity.id}`, kind: 'entity' as const, group: 'task' as const, ranked }));
      const files: Row[] = fileRows.map(({ entry, positions }) =>
        ({ key: `f:${entry.type}:${entry.name}`, kind: 'entry' as const, group: 'files' as const, entry, positions }));
      const both = order === 'entities-first' ? [...entityRows, ...files] : [...files, ...entityRows];
      return [...both, ...preciseRows];
    }, [onAll, sourceRows, taskRows, fileRows, order, preciseRows]);

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
    // Only in "All": on a source tab the user asked that source on purpose, so an
    // empty answer stays on screen (Esc closes) instead of vanishing mid-thought.
    const settledEmpty = onAll && rows.length === 0 && !filesLoading
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
      if (row.kind === 'source') { onPickRef(sourceRefTag(row.sourceId, row.item.ref, row.item.title)); return; }
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
      cycleSource: (delta) => {
        if (tabs.length <= 1) return false;
        const next = cycleTab(tabs, tab, delta);
        setPickedTab(next);
        // Leaving a keyword's tab drops the keyword: "@slack memory" ⇥ → "@memory".
        if (scope && next !== scope.sourceId) onSetQuery?.(scope.rest);
        return true;
      },
      primary: () => { const r = rows[selectedIndex]; if (r) pick(r); },
      selectCurrent: () => { const r = rows[selectedIndex]; if (r) pick(r, { forceSelect: true }); },
      up: () => {
        if (!filesEnabled) return;
        const parent = parentPath(browseDir);
        if (parent !== browseDir) onNavigate(parent);
      },
    }), [rows, selectedIndex, pick, filesEnabled, browseDir, onNavigate, tabs, tab, scope, onSetQuery]);

    // ---- Render ----------------------------------------------------------
    const renderEntityRow = (row: Extract<Row, { kind: 'entity' }>) => {
      const { entity, positions, matchField, source } = row.ranked;
      // A purely semantic hit has nothing to highlight: show the snippet that
      // matched instead, so the row explains itself.
      const semanticOnly = source === 'server' && positions.length === 0 && !!entity.summary;
      return (
        <div
          key={row.key}
          className={`mention-row mention-row-task${row.key === selectedKey ? ' selected' : ''}`}
          data-selected={row.key === selectedKey || undefined}
          data-kind="task"
          data-state={entity.state}
          onMouseEnter={() => setSelectedKey(row.key)}
          onMouseDown={(e) => { e.preventDefault(); pick(row); }}
          title={`${entity.title} — ${entity.meta}`}
        >
          <span className={`mention-dot ${entity.state}`} />
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
          <span className="mention-ficon" aria-hidden="true">{entry.type === 'dir' ? ICON_FOLDER : ICON_FILE}</span>
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

    const renderSourceRow = (row: Extract<Row, { kind: 'source' }>) => (
      <div
        key={row.key}
        className={`mention-row mention-row-source${row.key === selectedKey ? ' selected' : ''}`}
        data-selected={row.key === selectedKey || undefined}
        data-kind="source"
        data-source={row.sourceId}
        onMouseEnter={() => setSelectedKey(row.key)}
        onMouseDown={(e) => { e.preventDefault(); pick(row); }}
        title={row.item.subtitle ? `${row.item.title} · ${row.item.subtitle}` : row.item.title}
      >
        <span className="mention-ficon" aria-hidden="true">{KIND_ICON[row.item.kind ?? ''] ?? '•'}</span>
        <span className="mention-main">
          <span className="mention-title">{row.item.title}</span>
          {row.item.subtitle && <span className="mention-meta">{row.item.subtitle}</span>}
        </span>
      </div>
    );

    const labelOf = (id: string) => sources.find((src) => src.id === id)?.label ?? id;
    const preciseGroups: React.ReactNode[] = [];
    let headFor = '';
    for (const row of preciseRows) {
      if (row.kind !== 'source') continue;
      if (headFor !== row.sourceId) {
        headFor = row.sourceId;
        preciseGroups.push(
          <div key={`pg-${row.sourceId}`} className="mention-group-head" data-group={`src:${row.sourceId}`}>
            <span className="mention-group-name">{labelOf(row.sourceId)}</span>
            <span className="mention-group-verb">exact match · ⏎ inserts a reference</span>
          </div>,
        );
      }
      preciseGroups.push(renderSourceRow(row));
    }

    const sourceTab = activeSource ? (
      <div data-group={`src:${activeSource.id}`}>
        <div className="mention-group-head">
          <span className="mention-group-name">{activeSource.label}</span>
          <span className="mention-group-verb">
            {sourceQuery.trim() ? '⏎ inserts a reference' : 'Recent · type to search · ⏎ inserts a reference'}
          </span>
          {tabLoading && <span className="mention-searching" title="Searching…" />}
        </div>
        {tabAnswer?.error && sourceRows.length === 0 && (
          <div className="mention-empty">
            {tabAnswer.error === 'timeout' ? `${activeSource.label} did not answer in time.` : `${activeSource.label} is not available right now.`}
          </div>
        )}
        {!tabAnswer && tabLoading && (
          <div className="mention-skeleton"><span className="sk-icon" /><span className="sk-line" /></div>
        )}
        {tabAnswer && !tabAnswer.error && !tabLoading && sourceRows.length === 0 && (
          <div className="mention-empty">
            {sourceQuery.trim() ? `No match in ${activeSource.label}` : `Nothing in ${activeSource.label} yet`}
          </div>
        )}
        {sourceRows.map((row) => row.kind === 'source' ? renderSourceRow(row) : null)}
      </div>
    ) : null;

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
        {tabs.length > 1 && (
          <div className="mention-tabs" role="tablist" aria-label="Sources">
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === tab}
                className={`mention-tab${id === tab ? ' on' : ''}`}
                data-tab={id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPickedTab(id);
                  if (scope && id !== scope.sourceId) onSetQuery?.(scope.rest);
                }}
              >
                {id === ALL_TAB ? 'All' : labelOf(id)}
              </button>
            ))}
          </div>
        )}
        <div className="mention-list" ref={listRef}>
          {onAll
            ? <>{order === 'entities-first' ? <>{entityGroups}{filesGroup}</> : <>{filesGroup}{entityGroups}</>}{preciseGroups}</>
            : sourceTab}
        </div>
        <div className="mention-hintbar">
          <span><b>↑↓</b> move</span>
          {tabs.length > 1 && <span><b>⇥</b> source</span>}
          {tabs.length <= 1 && entitiesEnabled && filesEnabled && <span><b>⇥</b> group</span>}
          <span><b>⏎</b> reference</span>
          {onAll && filesEnabled && <span><b>←</b> parent</span>}
          {onAll && filesEnabled && <span><b>@?</b> recents</span>}
          <span><b>esc</b> close</span>
        </div>
      </div>
    );
  },
);
