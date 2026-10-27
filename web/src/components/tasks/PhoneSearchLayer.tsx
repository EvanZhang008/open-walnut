/**
 * The phone's search (spec 4.7 Search, C76). Focusing the home search box opens
 * this full-screen layer (`search`, a history entry): one 16 px search field
 * under the bar, `Cancel` in the bar's right slot (the only way out: no Back
 * beside it, N26), and the results of the
 * existing search APIs grouped as Tasks / Sessions / Notes (rows 48 px). A
 * result opens its own layer above this one (session, task detail), so Back
 * comes back to the results; a note opens the Notes page. It stands in for the
 * desktop's Cmd+Shift+O session finder, which a phone has no way to reach.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { apiGet } from '@/api/client';
import { searchNotesHybrid, type SearchResult as NoteHit } from '@/api/notes-v2';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { log } from '@/utils/log';
import { useHomeTasksById } from './phone-row-behavior';

const DEBOUNCE_MS = 250;
const TIMEOUT_MS = 10_000;

export interface ServerHit {
  type: 'task' | 'session' | 'memory';
  title: string;
  snippet?: string;
  taskId?: string;
  sessionId?: string;
  isAutoExpanded?: boolean;
}

export interface SearchGroups {
  tasks: { taskId: string; title: string; snippet?: string }[];
  sessions: { sessionId: string; taskId?: string; title: string; snippet?: string }[];
  notes: { path: string; title: string; snippet?: string }[];
}

/** Server rows to the three groups: one row per task, one per session. */
export function groupSearchHits(server: readonly ServerHit[], notes: readonly NoteHit[]): SearchGroups {
  const tasks: SearchGroups['tasks'] = [];
  const sessions: SearchGroups['sessions'] = [];
  const seenTasks = new Set<string>();
  const seenSessions = new Set<string>();
  for (const h of server) {
    if (h.isAutoExpanded) continue;
    if (h.type === 'task' && h.taskId && !seenTasks.has(h.taskId)) {
      seenTasks.add(h.taskId);
      tasks.push({ taskId: h.taskId, title: h.title, snippet: h.snippet });
    } else if (h.type === 'session' && h.sessionId && !seenSessions.has(h.sessionId)) {
      seenSessions.add(h.sessionId);
      sessions.push({ sessionId: h.sessionId, taskId: h.taskId, title: h.title, snippet: h.snippet });
    }
  }
  const seenNotes = new Set<string>();
  const noteRows: SearchGroups['notes'] = [];
  for (const n of notes) {
    if (!n.path || seenNotes.has(n.path)) continue;
    seenNotes.add(n.path);
    const base = n.path.split('/').pop()?.replace(/\.md$/i, '') ?? n.path;
    noteRows.push({ path: n.path, title: (n as { title?: string }).title || n.name || base, snippet: n.snippet });
  }
  return { tasks, sessions, notes: noteRows };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/**
 * A result's snippet as plain words (N26): search snippets carry the note or
 * message source (markdown marks, wiki links, highlight tags, entities, line
 * breaks), which a phone row would print as punctuation.
 */
export function plainSnippet(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/<\/?[a-z][^<>]{0,200}>/gi, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|`|~~)/g, '')
    // `_word_` emphasis; an identifier's own underscores (snake_case) stay.
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isEmptyGroups(g: SearchGroups): boolean {
  return g.tasks.length === 0 && g.sessions.length === 0 && g.notes.length === 0;
}

type Phase = 'idle' | 'loading' | 'done' | 'failed';

function useSearch(query: string): { phase: Phase; groups: SearchGroups } {
  const [phase, setPhase] = useState<Phase>('idle');
  const [groups, setGroups] = useState<SearchGroups>({ tasks: [], sessions: [], notes: [] });
  useEffect(() => {
    const q = query.trim();
    if (!q) { setPhase('idle'); setGroups({ tasks: [], sessions: [], notes: [] }); return undefined; }
    setPhase('loading');
    const ac = new AbortController();
    const timer = setTimeout(() => {
      // The UI's verbose rows (taskId, sessionId, snippet), as the desktop list
      // reads them: `slim=1` is the machine shape (id + ref) and its 2 s
      // semantic wait, which this parser does not read.
      const server = apiGet<{ results: ServerHit[] }>('/api/search', { q, types: 'task,session', limit: '40' }, { signal: ac.signal, timeoutMs: TIMEOUT_MS })
        .then((r) => r.results ?? [])
        .catch((err) => { if (!ac.signal.aborted) log.warn('phone-search', 'task search failed', { error: String(err) }); return null; });
      const notes = searchNotesHybrid(q, { limit: 10, signal: ac.signal })
        .then((r) => r.results ?? [])
        .catch((err) => { if (!ac.signal.aborted) log.warn('phone-search', 'notes search failed', { error: String(err) }); return null; });
      void Promise.all([server, notes]).then(([s, n]) => {
        if (ac.signal.aborted) return;
        if (s === null && n === null) { setPhase('failed'); return; }
        setGroups(groupSearchHits(s ?? [], n ?? []));
        setPhase('done');
      });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [query]);
  return { phase, groups };
}

export interface PhoneSearchLayerProps {
  open: boolean;
  onClose: () => void;
  /** A task result: the home row's own open (its session, else its detail). */
  onOpenTask?: (task: Task) => void;
}

export function PhoneSearchLayer({ open, onClose, onOpenTask }: PhoneSearchLayerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const tasksById = useHomeTasksById();
  const afterCloseRef = useRef<(() => void) | null>(null);
  const cancel = useRef<() => void>(() => {});
  const action = useMemo(() => (
    <button type="button" className="phone-search-cancel" onClick={() => cancel.current()}>Cancel</button>
  ), []);
  const layer = usePhoneOverlay({
    id: 'search',
    kind: 'search',
    open,
    bar: { title: 'Search', action },
    onClose: () => {
      inputRef.current?.blur();
      onClose();
      const next = afterCloseRef.current;
      afterCloseRef.current = null;
      if (next) setTimeout(next, 0);
    },
  });
  cancel.current = layer.close;
  const { phase, groups } = useSearch(open ? query : '');

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const openTask = useCallback((taskId: string) => {
    const task = tasksById.get(taskId);
    inputRef.current?.blur();
    if (task && onOpenTask) { onOpenTask(task); return; }
    log.warn('phone-search', 'task result not on the board', { taskId });
  }, [onOpenTask, tasksById]);

  const openSession = useCallback((sessionId: string) => {
    inputRef.current?.blur();
    // MainPage opens it as the session layer, above this one.
    window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId } }));
  }, []);

  const openNote = useCallback((path: string) => {
    // A note is a page of its own: leave the search, then go there.
    afterCloseRef.current = () => navigate(`/notes?path=${encodeURIComponent(path)}`);
    layer.close();
  }, [layer, navigate]);

  if (!open) return null;
  const empty = phase === 'done' && isEmptyGroups(groups);
  return createPortal(
    <div className="phone-search-layer" role="dialog" aria-label="Search" data-testid="phone-search-layer">
      <form className="phone-search-field" role="search" onSubmit={(e) => { e.preventDefault(); inputRef.current?.blur(); }}>
        <input data-no-draft="search"
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          className="phone-search-input"
          placeholder="Search tasks, sessions and notes"
          aria-label="Search tasks, sessions and notes"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); layer.close(); } }}
        />
      </form>
      <div className="phone-search-results" data-phase={phase}>
        {phase === 'loading' && <p className="phone-search-note" role="status">Searching...</p>}
        {phase === 'failed' && <p className="phone-search-note" role="alert">Search did not answer. Try again.</p>}
        {empty && <p className="phone-search-note" role="status">No matches.</p>}
        {phase === 'done' && groups.tasks.length > 0 && (
          <SearchGroup label="Tasks">
            {groups.tasks.map((r) => (
              <ResultRow key={r.taskId} title={r.title} snippet={r.snippet} onOpen={() => openTask(r.taskId)} />
            ))}
          </SearchGroup>
        )}
        {phase === 'done' && groups.sessions.length > 0 && (
          <SearchGroup label="Sessions">
            {groups.sessions.map((r) => (
              <ResultRow key={r.sessionId} title={r.title} snippet={r.snippet} onOpen={() => openSession(r.sessionId)} />
            ))}
          </SearchGroup>
        )}
        {phase === 'done' && groups.notes.length > 0 && (
          <SearchGroup label="Notes">
            {groups.notes.map((r) => (
              <ResultRow key={r.path} title={r.title} snippet={r.snippet} onOpen={() => openNote(r.path)} />
            ))}
          </SearchGroup>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="phone-search-group" aria-label={label}>
      <h2 className="phone-search-group-title">{label}</h2>
      <div className="phone-search-group-rows">{children}</div>
    </section>
  );
}

function ResultRow({ title, snippet, onOpen }: { title: string; snippet?: string; onOpen: () => void }) {
  const words = plainSnippet(snippet);
  return (
    <button type="button" className="phone-search-row" onClick={onOpen}>
      <span className="phone-search-row-title">{plainSnippet(title) || 'Untitled'}</span>
      {words ? <span className="phone-search-row-snippet">{words}</span> : null}
    </button>
  );
}
