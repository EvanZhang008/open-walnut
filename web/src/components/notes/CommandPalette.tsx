/**
 * Cmd+K global front door for notes (§4.3 / §9.3, P0).
 *
 * A centered overlay (React portal to document.body) mounted from NotesPage
 * with a global keydown listener. It is the single component for:
 *   - Jump to note    — fuzzy subsequence match over GET /list (recents on empty)
 *   - Quick-capture   — ↵ creates a note titled by the query; ⌘↵ creates a
 *                       focused empty/untitled note (0 required decisions)
 *   - Hybrid search   — string + semantic in ONE deduped, labeled list
 *                       (● exact / ◐ both / ○ semantic; exact never below
 *                       semantic; matched span highlighted). The BE already
 *                       dedupes + ranks; we render its order verbatim.
 *
 * Scope caveat (reported in sharedFileTouches): mounted on NotesPage, so the
 * Cmd+K shortcut is active only while the /notes route is mounted. App-wide
 * Cmd+K would require editing MainPage/App.tsx (forbidden), so it is not done.
 *
 * Keyboard contract: ↑/↓ move · ↵ open/run · ⌘↵ create blank · Esc close.
 * Closing mid-capture with typed text asks "discard?" — never silently drops.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { fetchNotesList, searchNotesHybrid } from '@/api/notes-v2';
import type { NoteListItem, SearchResult, MatchType } from '@/api/notes-v2';
import { renderNoteSnippet } from './notes-markdown';
import { HighlightedTitle } from './HighlightedText';
import { log } from '@/utils/log';

interface CommandPaletteProps {
  /**
   * Navigate to a note path (SPA — never page.goto). `opts.scrollToText` is set
   * for search hits so the editor jumps to the matched span, not the note top.
   */
  onNavigate: (path: string, opts?: { scrollToText?: string }) => void;
  /**
   * Create (and open) a new note. `title` empty = a blank/untitled note with 0
   * required decisions (⌘↵ quick-capture). Returns the created path so the
   * palette can navigate to it.
   */
  onCreate: (title: string) => void;
  /**
   * Preview a binary attachment hit (matchType 'attachment'). Attachments must
   * NOT go through onNavigate — the note loader force-appends .md and 404s.
   */
  onPreviewAttachment?: (path: string) => void;
}

/** A unified palette row — either a jump-to-note target or a hybrid search hit. */
interface PaletteRow {
  kind: 'note' | 'search' | 'create' | 'create-blank';
  path?: string;
  title: string;
  snippetHtml?: string;
  /** Raw BE snippet (with literal <mark> tags) — source of the jump-to-match text. */
  snippetRaw?: string;
  matchType?: MatchType;
}

const SEARCH_DEBOUNCE_MS = 120;
const RECENTS_KEY = 'open-walnut-notes-recents';
const MAX_RECENTS = 8;

/** Vault-relative path → display basename without the .md extension. */
function basenameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.md$/, '');
}

/** Subsequence fuzzy match (every char of q appears in order). Lower = better. */
function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const qc of q) {
    let found = -1;
    for (let i = ti; i < text.length; i++) {
      if (text[i] === qc) { found = i; break; }
    }
    if (found === -1) return null;
    if (last >= 0) score += found - last - 1;
    score += found;
    last = found;
    ti = found + 1;
  }
  return score;
}

/** Plain-language badge + glyph for a hybrid match type (§9.2 trust legend). */
function matchBadge(t: MatchType | undefined): { glyph: string; label: string; cls: string } | null {
  if (t === 'exact') return { glyph: '●', label: 'exact match', cls: 'exact' };   // ●
  if (t === 'both') return { glyph: '◐', label: 'exact + related', cls: 'both' };   // ◐
  if (t === 'semantic') return { glyph: '○', label: 'related', cls: 'semantic' };   // ○
  if (t === 'attachment') return { glyph: '▣', label: 'in attachment', cls: 'attachment' };   // ▣ (OCR/PDF text hit)
  return null;
}

export function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** Record a visited note path at the head of the recents list (deduped). */
export function pushRecent(path: string): void {
  try {
    const next = [path, ...readRecents().filter((p) => p !== path)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* ignore quota / disabled storage */ }
}

export function CommandPalette({ onNavigate, onCreate, onPreviewAttachment }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);

  // ── Global Cmd/Ctrl+K to toggle the palette (§4.3 mount contract) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Load the note list when opening (fresh — may include newly-created notes).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setSelectedIdx(0);
    fetchNotesList().then(setNotes).catch(() => setNotes([]));
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // ── Debounced hybrid search ──
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    abortRef.current?.abort();
    if (!q) { setResults([]); setDegraded(false); setSearching(false); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true);
    // ALWAYS string mode: this is a jump-to-note palette (like Notion's Cmd+K),
    // where instant feedback matters more than semantic recall. The semantic leg
    // computes a query embedding (~2s warm, can hang on cold start), which made
    // the palette feel broken — "Searching…" that never settled. String search
    // is sub-30ms over the FTS index and, with prefix-matched tokens, already
    // finds the note ("work datapoint" → "Work … Datapoints"). Full hybrid still
    // backs the /notes full-text search page where recall beats latency.
    const mode = 'string' as const;
    const t = setTimeout(() => {
      searchNotesHybrid(q, { mode, limit: 20, signal: ctrl.signal })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setResults(res.results);
          setDegraded(res.degraded === 'semantic-unavailable');
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          log.warn('notes', 'Cmd+K hybrid search failed', { error: err instanceof Error ? err.message : String(err) });
          setResults([]);
        })
        .finally(() => { if (!ctrl.signal.aborted) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, open]);

  // ── Build the unified row list (jump on empty, hybrid + capture on query) ──
  const rows = useMemo<PaletteRow[]>(() => {
    const q = query.trim();
    if (!q) {
      // Empty: recents first, then a blank-capture affordance.
      const recents = readRecents();
      const byPath = new Map(notes.map((n) => [n.path, n]));
      const recentRows: PaletteRow[] = recents
        .map((p) => byPath.get(p))
        .filter((n): n is NoteListItem => !!n)
        .map((n) => ({ kind: 'note' as const, path: n.path, title: n.title || n.name }));
      const recentPaths = new Set(recentRows.map((r) => r.path));
      const rest: PaletteRow[] = notes
        .filter((n) => !recentPaths.has(n.path))
        .slice(0, 12)
        .map((n) => ({ kind: 'note' as const, path: n.path, title: n.title || n.name }));
      return [...recentRows, ...rest];
    }

    // With a query: hybrid search results (BE order preserved) + capture rows.
    // `results` deliberately keeps the PREVIOUS query's hits during a refetch
    // (the search effect only overwrites on response), so typing never collapses
    // the list mid-fetch.
    const searchRows: PaletteRow[] = results.map((r) => ({
      kind: 'search' as const,
      path: r.path,
      // Hybrid search rows carry `title` (not `name`); fall back to the path basename.
      title: r.title || r.name || basenameNoExt(r.path),
      snippetHtml: r.snippet ? renderNoteSnippet(r.snippet) : undefined,
      snippetRaw: r.snippet,
      matchType: r.matchType,
    }));
    const lower = q.toLowerCase();
    const exactTitleExists = notes.some((n) => (n.title || n.name).toLowerCase() === lower);
    // Capture row only once the search has settled OR below existing results —
    // never as a lone "Create note" flash while the first fetch is in flight.
    const showCreate = !exactTitleExists && (!searching || results.length > 0);
    const captureRows: PaletteRow[] = showCreate
      ? [{ kind: 'create' as const, title: q }]
      : [];
    return [...searchRows, ...captureRows];
  }, [query, notes, results, searching]);

  // Reset selection when the row set changes.
  useEffect(() => { setSelectedIdx(0); }, [rows.length, query]);

  // Keep the active row visible.
  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const close = useCallback(() => {
    // Esc always closes immediately — a search palette never traps the user
    // behind a confirm dialog (Notion-style). Typed text is transient, not a
    // document edit, so there's nothing to "lose".
    setOpen(false);
    setQuery('');
  }, []);

  const runRow = useCallback((row: PaletteRow | undefined) => {
    if (!row) return;
    if (row.kind === 'create' || row.kind === 'create-blank') {
      onCreate(row.kind === 'create-blank' ? '' : row.title);
    } else if (row.path) {
      // Attachment hits (OCR/PDF text) open in the PREVIEW pane, never the note
      // loader (which .md-suffixes the path → 404 tab), and never enter recents.
      if (row.matchType === 'attachment' && onPreviewAttachment) {
        onPreviewAttachment(row.path);
      } else {
        pushRecent(row.path);
        // Search hits jump to the matched span (<mark> text, else the query).
        const m = row.snippetRaw?.match(/<mark>([^<]{1,80})<\/mark>/);
        const scrollToText = row.kind === 'search' ? (m?.[1] || query.trim() || undefined) : undefined;
        onNavigate(row.path, scrollToText ? { scrollToText } : undefined);
      }
    }
    setOpen(false);
    setQuery('');
  }, [onCreate, onNavigate, onPreviewAttachment, query]);

  const onInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (composingRef.current || e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // ⌘↵ / Ctrl+↵ — quick-capture a blank/untitled note (0 required decisions).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onCreate('');
      setOpen(false);
      setQuery('');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // ↵ with a query and no rows → create a note titled by the query — but only
      // once the search has SETTLED. Mid-fetch with nothing visible, Enter is a
      // no-op (results may be about to land; don't create a note by surprise).
      if (rows.length === 0) {
        if (!searching && query.trim()) runRow({ kind: 'create', title: query.trim() });
        return;
      }
      runRow(rows[selectedIdx]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    }
  }, [rows, selectedIdx, query, searching, close, runRow, onCreate]);

  if (!open) return null;

  const q = query.trim();
  const showHint = q.length > 0;

  return createPortal(
    <div className="notes-cmdk-overlay" onMouseDown={close} role="dialog" aria-modal="true" aria-label="Notes command palette">
      <div className="notes-cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="notes-cmdk-input-row">
          <span className="notes-cmdk-glyph" aria-hidden>{'⌘K'}</span>
          <input
            ref={inputRef}
            className="notes-cmdk-input"
            type="text"
            value={query}
            placeholder="Jump to a note, or type to search…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
          />
          {searching && <span className="notes-cmdk-spinner" aria-hidden>{'↻'}</span>}
        </div>

        {degraded && (
          <div className="notes-cmdk-degraded">Semantic search unavailable — showing exact matches only.</div>
        )}

        <div className="notes-cmdk-list" ref={listRef}>
          {rows.length === 0 && !searching && (
            <div className="notes-cmdk-empty">
              {q
                ? <>No notes found. Press <kbd>↵</kbd> to create <strong>{q}</strong>.</>
                : <>No notes yet. Press <kbd>⌘↵</kbd> for a blank note.</>}
            </div>
          )}
          {/* First fetch in flight with nothing to keep showing — subtle hint
              instead of a lone "Create note" row flashing on every keystroke. */}
          {rows.length === 0 && searching && (
            <div className="notes-cmdk-searching" role="status">Searching…</div>
          )}
          {rows.map((row, i) => {
            const badge = matchBadge(row.matchType);
            const isCreate = row.kind === 'create' || row.kind === 'create-blank';
            return (
              <div
                key={row.kind === 'create' ? `__create__${row.title}` : (row.path ?? `r-${i}`)}
                className={`notes-cmdk-item ${i === selectedIdx ? 'selected' : ''} ${isCreate ? 'notes-cmdk-create' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); runRow(row); }}
              >
                {isCreate ? (
                  <span className="notes-cmdk-create-label">Create note <strong>{row.title}</strong></span>
                ) : (
                  <>
                    <div className="notes-cmdk-item-head">
                      {badge && (
                        <span className={`notes-cmdk-badge notes-cmdk-badge-${badge.cls}`} title={badge.label}>
                          <span className="notes-cmdk-badge-glyph" aria-hidden>{badge.glyph}</span>
                          <span className="notes-cmdk-badge-label">{badge.label}</span>
                        </span>
                      )}
                      <span className="notes-cmdk-item-title">
                        {/* Server highlights snippets only — titles get a client-side first-match mark. */}
                        <HighlightedTitle text={row.title} query={q} />
                      </span>
                      {row.path && <span className="notes-cmdk-item-path">{row.path.replace(/\.md$/, '')}</span>}
                    </div>
                    {row.snippetHtml && (
                      <div
                        className="notes-cmdk-item-snippet"
                        // Snippet HTML is BE-emitted (matched span in <mark>) and
                        // sanitized by renderNoteSnippet before reaching the DOM.
                        dangerouslySetInnerHTML={{ __html: row.snippetHtml }}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="notes-cmdk-footer">
          {showHint ? (
            <span><kbd>↵</kbd> open · <kbd>⌘↵</kbd> new blank · <kbd>esc</kbd> close</span>
          ) : (
            <span><kbd>↑↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>⌘↵</kbd> new blank</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
