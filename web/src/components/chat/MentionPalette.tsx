/**
 * MentionPalette — the unified "@" popup: ONE panel, Walnut entities + Files.
 *
 *   Tasks / Sessions / Projects — picking a row INSERTS A REFERENCE pill
 *              (`<task-ref/>`, `<session-ref/>`, `<project-ref/>`) into the
 *              message. The message still goes to the CURRENT session; its
 *              agent gets a compact reference card appended server-side and
 *              decides what to do (read the task, message that session, …).
 *              Nothing is routed by the composer.
 *   Files    — picked row inserts a Claude-Code-native `@path`; the query
 *              doubles as a path (the part before the last "/" navigates, the
 *              tail filters), exactly like the old FileMentionPopup.
 *
 * Search is two-layered so it never waits on the network: an in-memory fuzzy
 * pass over the browser's own task list / session index / project registry
 * paints on every keystroke, and the hybrid `/api/search` hits (full-text +
 * vector — the engine behind the task search box) re-rank each group when
 * they land a beat later. `order` (routeMention) decides whether the entity
 * groups or Files lead; every non-empty group stays visible at once thanks to
 * the shared row budget (groupRowBudget).
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
  useSyncExternalStore,
  forwardRef,
} from 'react';
import type { Task } from '@open-walnut/core';
import { fetchDirList, type DirEntry } from '@/api/files';
import type { ProjectSummary } from '@/api/projects';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { formatSize } from '@/utils/format';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { recordRecentFolder } from '@/utils/recentFolders';
import { projectRefTag, sessionRefTag, taskRefTag } from '@/utils/entity-ref-tags';
import { joinPath, parentPath, relativeTo, parseQuery } from './mention-path';
import { fuzzyMatch, type SessionMentionCandidate } from './session-mention';
import {
  groupRowBudget,
  mergeServerHits,
  rankEntities,
  type MentionEntity,
  type MentionEntityKind,
  type RankedEntity,
} from './mention-entities';
import {
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  subscribeSessionMentionIndex,
} from '@/stores/session-mention-index';
import {
  ensureProjectsIndex,
  getProjectsIndex,
  subscribeProjectsIndex,
  useEntitySearch,
  type EntitySearchHit,
} from '@/stores/mention-search';
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
  /** Show the Tasks / Sessions / Projects groups at all. */
  entitiesEnabled: boolean;
  /** Never offer the session the user is already talking to. */
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
  | { key: string; kind: 'entity'; group: MentionEntityKind; ranked: RankedEntity }
  | { key: string; kind: 'entry'; group: 'files'; entry: DirEntry; positions: number[] };

type GroupId = MentionEntityKind | 'files';

const ENTITY_GROUPS: MentionEntityKind[] = ['task', 'session', 'project'];
const GROUP_LABEL: Record<GroupId, string> = { task: 'Tasks', session: 'Sessions', project: 'Projects', files: 'Files' };
const GROUP_VERB: Record<GroupId, string> = {
  task: '⏎ inserts a task reference',
  session: '⏎ inserts a session reference',
  project: '⏎ inserts a project reference',
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

function taskEntity(t: Task): MentionEntity {
  return {
    kind: 'task',
    id: t.id,
    title: t.title || '(untitled)',
    meta: `${t.phase} · ${t.project || 'Inbox'}`,
    pinned: !!t.pinned || t.focus_tier === 'focus',
    active: t.phase !== 'COMPLETE',
    recencyKey: t.updated_at ?? '',
  };
}

function sessionEntity(s: SessionMentionCandidate): MentionEntity {
  const live = sessionStatusStore.getStatus(s.id);
  const status = live?.process_status ?? s.status;
  const waiting = !!live?.pendingPermissionTool;
  const hostLabel = s.host && s.host !== '__local__' ? s.host : 'local';
  return {
    kind: 'session',
    id: s.id,
    title: s.title || '(untitled)',
    meta: `${hostLabel} · ${waiting ? 'waiting on you' : status}${s.lastActiveAt ? ` · ${timeAgo(s.lastActiveAt)}` : ''}`,
    active: status === 'running' || waiting,
    recencyKey: s.lastActiveAt ?? '',
    status: waiting ? 'waiting' : status,
  };
}

function projectEntity(p: ProjectSummary): MentionEntity {
  const c = p.counts;
  return {
    kind: 'project',
    id: p.name,
    title: p.name,
    meta: `${c.active} active · ${c.todo} todo · ${c.done} done`,
    pinned: p.favorite,
    active: c.active > 0,
    // No timestamps on a project row: rank the busier project first.
    recencyKey: String(c.active + c.todo).padStart(6, '0'),
  };
}

/** A server hit as an entity, borrowing live meta from the local row when known. */
function hitEntity(h: EntitySearchHit, sessions: Map<string, MentionEntity>): MentionEntity | null {
  if (h.type === 'task') {
    return {
      kind: 'task',
      id: h.id,
      title: h.title || '(untitled)',
      meta: `${h.phase ?? 'task'} · ${h.project || 'Inbox'}`,
      active: h.phase !== 'COMPLETE',
      summary: h.summary,
    };
  }
  if (h.type === 'session') {
    const local = sessions.get(h.id);
    return local
      ? { ...local, summary: h.summary }
      : { kind: 'session', id: h.id, title: h.title || '(untitled)', meta: 'session', summary: h.summary };
  }
  return null;
}

function refTagFor(entity: MentionEntity): string {
  if (entity.kind === 'task') return taskRefTag(entity.id, entity.title);
  if (entity.kind === 'session') return sessionRefTag(entity.id, entity.title);
  return projectRefTag(entity.id);
}

const FILE_SOLO_LIMIT = 12;

export const MentionPalette = forwardRef<MentionPaletteHandle, MentionPaletteProps>(
  function MentionPalette(
    { query, order, entitiesEnabled, selfSessionId, cwd, host, onPickRef, onPickFile, onNavigate, onClose },
    ref,
  ) {
    // ---- Entity groups: instant local layer -----------------------------
    const tasksCtx = useTasksContextSafe();
    const sessionIndex = useSyncExternalStore(subscribeSessionMentionIndex, getSessionMentionIndex);
    const projectIndex = useSyncExternalStore(subscribeProjectsIndex, getProjectsIndex);
    useEffect(() => {
      if (!entitiesEnabled) return;
      void ensureSessionMentionIndex();
      void ensureProjectsIndex();
    }, [entitiesEnabled]);

    const taskEntities = useMemo<MentionEntity[]>(
      () => (entitiesEnabled && tasksCtx ? tasksCtx.tasks.map(taskEntity) : []),
      [entitiesEnabled, tasksCtx],
    );
    const sessionEntities = useMemo<MentionEntity[]>(
      () => (entitiesEnabled
        ? sessionIndex.filter((s) => s.id !== selfSessionId).map(sessionEntity)
        : []),
      [entitiesEnabled, sessionIndex, selfSessionId],
    );
    const sessionById = useMemo(() => new Map(sessionEntities.map((e) => [e.id, e])), [sessionEntities]);
    const projectEntities = useMemo<MentionEntity[]>(
      () => (entitiesEnabled ? projectIndex.map(projectEntity) : []),
      [entitiesEnabled, projectIndex],
    );

    // ---- Entity groups: hybrid search layer (debounced, folded in) -------
    const search = useEntitySearch(query, entitiesEnabled && order === 'entities-first');
    const searchCurrent = search.forQuery === query.trim() && search.forQuery !== '';
    const serverByKind = useMemo(() => {
      const out: Record<MentionEntityKind, MentionEntity[]> = { task: [], session: [], project: [] };
      if (!searchCurrent) return out;
      for (const h of search.hits) {
        const e = hitEntity(h, sessionById);
        if (e && !(e.kind === 'session' && e.id === selfSessionId)) out[e.kind].push(e);
      }
      return out;
    }, [search.hits, searchCurrent, sessionById, selfSessionId]);

    const rankedAll = useMemo<Record<MentionEntityKind, RankedEntity[]>>(() => {
      const rank = (items: MentionEntity[], kind: MentionEntityKind) =>
        mergeServerHits(query, rankEntities(query, items, { limit: 12 }), serverByKind[kind]);
      return {
        task: rank(taskEntities, 'task'),
        session: rank(sessionEntities, 'session'),
        project: rank(projectEntities, 'project'),
      };
    }, [query, taskEntities, sessionEntities, projectEntities, serverByKind]);

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
    const nonEmpty = ENTITY_GROUPS.filter((k) => rankedAll[k].length > 0).length + (filesEnabled ? 1 : 0);
    const budget = groupRowBudget(nonEmpty);
    const groupRows = useMemo<Record<MentionEntityKind, RankedEntity[]>>(() => ({
      task: rankedAll.task.slice(0, budget.entity),
      session: rankedAll.session.slice(0, budget.entity),
      project: rankedAll.project.slice(0, budget.entity),
    }), [rankedAll, budget.entity]);
    const fileRows = useMemo(() => fileRowsAll.slice(0, budget.files), [fileRowsAll, budget.files]);

    // ---- Flat row model (selection by key, stable across async loads) ---
    const rows = useMemo<Row[]>(() => {
      const entityRows: Row[] = ENTITY_GROUPS.flatMap((group) =>
        groupRows[group].map((ranked) => ({ key: `${group}:${ranked.entity.id}`, kind: 'entity' as const, group, ranked })));
      const files: Row[] = fileRows.map(({ entry, positions }) =>
        ({ key: `f:${entry.type}:${entry.name}`, kind: 'entry' as const, group: 'files' as const, entry, positions }));
      return order === 'entities-first' ? [...entityRows, ...files] : [...files, ...entityRows];
    }, [groupRows, fileRows, order]);

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
      if (row.kind === 'entity') { onPickRef(refTagFor(row.ranked.entity), row.ranked.entity); return; }
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
      const dotClass = entity.kind === 'session'
        ? (entity.status === 'waiting' ? 'waiting' : entity.status === 'running' ? 'running' : entity.status === 'error' ? 'error' : 'idle')
        : null;
      // A purely semantic hit has nothing to highlight: show the snippet that
      // matched instead, so the row explains itself.
      const semanticOnly = source === 'server' && positions.length === 0 && !!entity.summary;
      return (
        <div
          key={row.key}
          className={`mention-row mention-row-${entity.kind}${row.key === selectedKey ? ' selected' : ''}`}
          data-selected={row.key === selectedKey || undefined}
          data-kind={entity.kind}
          onMouseEnter={() => setSelectedKey(row.key)}
          onMouseDown={(e) => { e.preventDefault(); pick(row); }}
          title={`${entity.title} — ${entity.meta}`}
        >
          {dotClass
            ? <span className={`mention-dot ${dotClass}`} />
            : <span className={`mention-kind mention-kind-${entity.kind}`} aria-hidden="true">{entity.kind === 'task' ? '▢' : '▣'}</span>}
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
          {entity.kind === 'session' && (
            <span className="mention-id">
              {matchField === 'id' ? <Highlighted text={entity.id.slice(0, 8)} positions={positions} /> : entity.id.slice(0, 8)}
            </span>
          )}
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

    const anyEntityRows = ENTITY_GROUPS.some((k) => groupRows[k].length > 0);
    const entityGroups = entitiesEnabled ? (
      <div key="g-entities">
        {ENTITY_GROUPS.map((group) => groupRows[group].length > 0 && (
          <div key={`g-${group}`} data-group={group}>
            <div className="mention-group-head">
              <span className="mention-group-name">{GROUP_LABEL[group]}</span>
              <span className="mention-group-verb">{GROUP_VERB[group]}</span>
              {search.loading && group !== 'project' && <span className="mention-searching" title="Searching…" />}
            </div>
            {groupRows[group].map((ranked) =>
              renderEntityRow({ key: `${group}:${ranked.entity.id}`, kind: 'entity', group, ranked }))}
          </div>
        ))}
        {!anyEntityRows && (query.trim() || !filesEnabled) && (
          <div className="mention-group-head">
            <span className="mention-group-name">Walnut</span>
            <span className="mention-group-verb">
              {search.loading ? 'Searching…' : 'No matching task, session or project'}
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
