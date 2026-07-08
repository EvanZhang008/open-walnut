import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { NotesEditor } from './NotesEditor';
import { BacklinksPanel } from './BacklinksPanel';
import { RawMarkdownView } from './RawMarkdownView';
import { fetchNotesList, fetchTags } from '@/api/notes-v2';
import type { NoteListItem, TagCount } from '@/api/notes-v2';
import type { PendingExternalChange } from '@/hooks/useNoteContent';
import { splitFrontmatter, joinFrontmatter } from './frontmatter';
import { normalizeForEditor } from './notes-content-preprocess';
import {
  rememberScrollFraction,
  recallScrollFraction,
  scrollFraction,
  applyScrollFraction,
} from './scroll-memory';
import './notes-width.css';

/**
 * MarkdownEditorPanel — the ONE reusable editor shell for EVERY markdown surface
 * in Walnut (the /notes page, pop-outs, the global-notes widget/popup, and —
 * via save-hook adapters — task description/note and memory files).
 *
 * It bundles the chrome around the pure `NotesEditor` so all surfaces share the
 * SAME toolbar + behavior:
 *   - width toggle (Normal ⇄ Full)               — prop `showWidthToggle`
 *   - raw-markdown ↔ rendered toggle (⌘E)        — prop `showRawToggle`
 *   - save-status indicator + last-updated time
 *   - optional bookmark glyph                     — prop `showBookmark`
 *   - optional breadcrumb header                  — prop `showBreadcrumb`
 *   - optional external-write reload banner       — `pendingExternal`
 *   - optional backlinks panel                    — prop `showBacklinks`
 *
 * Content + save are INJECTED by the caller's hook (useNoteContent / useGlobalNotes
 * / useTaskContent / useMemoryContent) via {content, onEditorUpdate, saveStatus,
 * updatedAt}. The raw-mode flush's cold-start fallback is injected via `rawFlushIO`
 * so a non-vault surface (no frontmatter / no contentHash) works too.
 */

/** Editor width preference (Feature 1) — global, persisted, applied as a CSS class.
 * Two Notion-style stops: 'normal' (comfortable wide column) ⇄ 'full' (edge-to-edge). */
type EditorWidth = 'normal' | 'full';
const LS_WIDTH_KEY = 'open-walnut-notes-width';
const RAW_SAVE_DEBOUNCE_MS = 500;

function readEditorWidth(): EditorWidth {
  try {
    const v = localStorage.getItem(LS_WIDTH_KEY);
    if (v === 'normal') return 'normal';
    // Legacy 3-tier value 'wide' folds into 'full' so old users aren't stuck on
    // a now-invalid stop.
    if (v === 'full' || v === 'wide') return 'full';
  } catch { /* ignore */ }
  return 'normal';
}

/**
 * Read/save adapter for the raw-mode COLD-START fallback (when the user toggles to
 * raw before the rendered TipTap instance was ever captured). Vault surfaces pass
 * frontmatter-preserving notes-v2 IO; flat surfaces (task/memory) pass plain IO
 * with `splitFrontmatter: false`.
 */
export interface RawFlushIO {
  read: (id: string) => Promise<{ content: string; contentHash?: string }>;
  save: (id: string, content: string, contentHash?: string) => Promise<unknown>;
  /** When true, preserve the on-disk frontmatter block across the fallback save. */
  splitFrontmatter?: boolean;
}

export interface MarkdownEditorPanelProps {
  /** Body markdown (frontmatter already stripped by the caller's hook). Null = loading/failed. */
  content: string | null;
  onEditorUpdate: (editor: Editor) => void;
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  updatedAt?: string | null;

  // ── Editor feature flags (passed through to NotesEditor) ──
  enableWikiLinks?: boolean;
  enableBlockTools?: boolean;
  /** Wiki-link autocomplete corpus. If enableWikiLinks and omitted, the shell fetches it. */
  wikiLinkNotes?: NoteListItem[];
  /** #tag autocomplete corpus. If enableWikiLinks and omitted, the shell fetches it. */
  tagSuggestions?: TagCount[];
  onWikiLinkClick?: (path: string) => void;
  /**
   * Vault-relative note path — set ONLY by vault surfaces (/notes, note pop-outs).
   * Routes pasted images into the note's `_attachment/` folder as `![[...]]`
   * embeds instead of the chat image store (see NotesEditor.attachmentNotePath).
   */
  attachmentNotePath?: string | null;
  tasks?: React.ComponentProps<typeof NotesEditor>['tasks'];
  focusedTaskId?: string | null;
  onTaskClick?: (taskId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;

  // ── Chrome flags ──
  showWidthToggle?: boolean;
  showRawToggle?: boolean;
  showBookmark?: boolean;
  showBreadcrumb?: boolean;
  showBacklinks?: boolean;
  /** Show a "locate in sidebar tree" button (only /notes, which owns the tree). */
  showLocate?: boolean;
  /** Path string for the breadcrumb + as the doc key fed to rawFlushIO / NotesEditor `key`. */
  breadcrumbPath?: string | null;
  onNavigate?: (path: string) => void;
  /** Locate the current doc in the sidebar tree (#1 button). */
  onLocate?: () => void;
  /**
   * Reveal a breadcrumb folder segment in the sidebar tree (#4). When provided,
   * breadcrumb segments become clickable; folder segments call this with their
   * cumulative path, the leaf (current note) calls onLocate.
   */
  onBreadcrumbNavigate?: (folderPath: string) => void;

  isFavorite?: boolean;
  onToggleFavorite?: () => void;

  // ── External-write reload banner (only surfaces with contentHash locking) ──
  pendingExternal?: PendingExternalChange | null;
  onApplyExternal?: () => void;
  onDismissExternal?: () => void;

  // ── Raw-flush cold-start IO (required if showRawToggle) ──
  rawFlushIO?: RawFlushIO;
  /** Key fed to rawFlushIO and used as the NotesEditor remount key. */
  docId?: string | null;

  /** Fallback shown when content === null (loading / failed). */
  loadingFallback?: React.ReactNode;
}

export function MarkdownEditorPanel({
  content,
  onEditorUpdate,
  saveStatus,
  updatedAt,
  enableWikiLinks = false,
  enableBlockTools = false,
  wikiLinkNotes,
  tagSuggestions,
  onWikiLinkClick,
  attachmentNotePath,
  tasks,
  focusedTaskId,
  onTaskClick,
  placeholder,
  autoFocus,
  showWidthToggle = false,
  showRawToggle = false,
  showBookmark = false,
  showBreadcrumb = false,
  showBacklinks = false,
  showLocate = false,
  breadcrumbPath,
  onNavigate,
  onLocate,
  onBreadcrumbNavigate,
  isFavorite,
  onToggleFavorite,
  pendingExternal,
  onApplyExternal,
  onDismissExternal,
  rawFlushIO,
  docId,
  loadingFallback,
}: MarkdownEditorPanelProps) {
  // Wiki/tag corpora: caller may inject, else the shell fetches when wikilinks are on.
  const [fetchedNotes, setFetchedNotes] = useState<NoteListItem[]>([]);
  const [fetchedTags, setFetchedTags] = useState<TagCount[]>([]);
  const notesList = wikiLinkNotes ?? fetchedNotes;
  const tagList = tagSuggestions ?? fetchedTags;

  // The doc key used for the editor remount + raw buffer ownership.
  const key = docId ?? breadcrumbPath ?? null;

  // ── Per-doc scroll memory (Obsidian parity) ──
  // One capture-phase listener on .notes-editor-content records the scroll
  // FRACTION for the current doc — capture catches both the rendered surface
  // (the content div itself) and the raw CodeMirror .cm-scroller inside it
  // (scroll events don't bubble but do propagate in capture). Restores on doc
  // switch, on raw↔rendered toggle, and across route changes / refresh.
  const contentElRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentElRef.current;
    if (!el || !key) return;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t || t !== el && !t.classList?.contains('cm-scroller')) return;
      // Ignore clamp events from a collapsed container (entering raw mode
      // shrinks the content div → scrollTop clamps to 0 → would clobber memory).
      if (t.scrollHeight - t.clientHeight <= 0) return;
      rememberScrollFraction(key, scrollFraction(t));
    };
    el.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => el.removeEventListener('scroll', onScroll, { capture: true });
  }, [key]);

  // ── Feature 1: editor width control (global, persisted) ──
  const [width, setWidth] = useState<EditorWidth>(readEditorWidth);
  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH_KEY, width); } catch { /* ignore */ }
  }, [width]);

  // ── Feature 2: raw markdown ↔ rendered toggle ──
  // `rawMode` shows a monospace source view of the CURRENT body. The rendered
  // NotesEditor stays MOUNTED but hidden while in raw mode so its TipTap instance
  // survives; on flush we push the raw text into it via setContent(emitUpdate:true)
  // → the normal onEditorUpdate → caller's debounced save. ONE save path, ONE
  // frontmatter owner (the caller's hook).
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const editorRef = useRef<Editor | null>(null);
  const rawDirtyRef = useRef(false);
  const rawSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawPathRef = useRef<string | null>(null);
  // ALWAYS-current mirror of rawText — flushRaw reads from here, not a stale closure.
  const rawTextRef = useRef('');

  // Always-current key mirror + which doc the captured editor instance belongs
  // to. NotesEditor remounts per key but editorRef is only (re)captured on the
  // first edit in a doc — without this tag, a doc switch followed by a raw
  // toggle could read the PREVIOUS doc's editor.
  const keyRef = useRef(key);
  keyRef.current = key;
  const editorKeyRef = useRef<string | null>(null);
  const rawModeRef = useRef(rawMode);
  rawModeRef.current = rawMode;

  const handleEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    editorKeyRef.current = keyRef.current;
    // Raw view open with no local raw edits → mirror editor-side changes into
    // the buffer. Covers async edits landing AFTER the raw seed (e.g. an image
    // paste whose upload+insert completes right as the user toggles to source).
    if (rawModeRef.current && !rawDirtyRef.current) {
      const md = editor.storage.markdown.getMarkdown() as string;
      setRawText(md);
      rawTextRef.current = md;
    }
    onEditorUpdate(editor);
  }, [onEditorUpdate]);

  const hasContent = content !== null;
  // Restore the remembered position on doc open AND on raw↔rendered toggle
  // (the fraction is mode-agnostic, so the location carries across surfaces).
  // Staggered retries because TipTap/CodeMirror paint async — scrollHeight isn't
  // final on the first frame; re-applying the same fraction is idempotent.
  useEffect(() => {
    if (!key || !hasContent) return;
    const frac = recallScrollFraction(key);
    if (frac === undefined) return;
    const apply = () => {
      const el = contentElRef.current;
      if (!el) return;
      const target = rawMode ? el.querySelector<HTMLElement>('.cm-scroller') : el;
      if (target) applyScrollFraction(target, frac);
    };
    const raf = requestAnimationFrame(apply);
    const t1 = setTimeout(apply, 60);
    const t2 = setTimeout(apply, 200);
    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); };
  }, [key, rawMode, hasContent]);

  /**
   * Flush the current raw buffer into the rendered editor (happy path), or — as a
   * cold-start fallback when no editor instance was captured yet — write straight
   * through rawFlushIO. Safe to call when not dirty.
   */
  const flushRaw = useCallback(async (path: string | null) => {
    if (rawSaveTimerRef.current) { clearTimeout(rawSaveTimerRef.current); rawSaveTimerRef.current = null; }
    if (!rawDirtyRef.current || !path) { rawDirtyRef.current = false; return; }
    rawDirtyRef.current = false;
    const body = rawTextRef.current; // ref, not state — avoid stale closure

    const editor = editorRef.current;
    if (editor && !editor.isDestroyed && editorKeyRef.current === path && rawPathRef.current === path) {
      // Happy path: only setContent if the body changed, so we don't emit a
      // spurious save. emitUpdate:true → onDirty → caller's hook save.
      // normalizeForEditor: same parse-side normalization the rendered editor
      // applies (orphan-checkbox ZWSP) — without it a bare `- [ ]` serializes
      // ESCAPED (`- \[ \]`), corrupting those lines.
      const currentMd = editor.storage.markdown.getMarkdown();
      if (currentMd !== body) {
        editor.commands.setContent(normalizeForEditor(body), { emitUpdate: true });
      }
      return;
    }

    // Cold-start fallback: no editor instance yet. Save through the injected IO.
    if (!rawFlushIO) return;
    try {
      if (rawFlushIO.splitFrontmatter) {
        const { content: onDisk, contentHash } = await rawFlushIO.read(path);
        const { frontmatter } = splitFrontmatter(onDisk);
        await rawFlushIO.save(path, joinFrontmatter(frontmatter, body), contentHash);
      } else {
        await rawFlushIO.save(path, body);
      }
    } catch {
      // Last resort: save the body as-is rather than drop the edit.
      try { await rawFlushIO.save(path, body); } catch { /* surfaced via save status next edit */ }
    }
  }, [rawFlushIO]);

  // Seed / re-seed the raw buffer when entering raw mode or the body changes while
  // in raw mode (and we have no pending local raw edits to lose).
  //
  // Seed from the LIVE TipTap doc when it belongs to this key — the `content`
  // prop is only the last LOADED body: editor-first edits (typing, image paste)
  // are saved by the caller's hook WITHOUT flowing back into that prop (the WS
  // self-echo is deliberately suppressed). Seeding from the prop showed a STALE
  // source (user-reported: a pasted image's `![[...]]` missing in raw view) and,
  // worse, editing that stale raw then flushed it back over the live doc —
  // wiping the embed from disk.
  useEffect(() => {
    if (!rawMode) return;
    if (rawDirtyRef.current && rawPathRef.current === key) return;
    const editor = editorRef.current;
    const live = editor && !editor.isDestroyed && editorKeyRef.current === key
      ? (editor.storage.markdown.getMarkdown() as string)
      : null;
    const body = live ?? content ?? '';
    setRawText(body);
    rawTextRef.current = body;
    rawPathRef.current = key;
    rawDirtyRef.current = false;
  }, [rawMode, content, key]);

  // Switching doc: flush previous doc's raw buffer (to the OLD key) before reset.
  const prevPathRef = useRef<string | null>(key);
  useEffect(() => {
    const prev = prevPathRef.current;
    if (prev !== key) {
      if (rawDirtyRef.current) void flushRaw(prev);
      prevPathRef.current = key;
      rawPathRef.current = key;
    }
  }, [key, flushRaw]);

  // Flush any pending raw edit on unmount.
  useEffect(() => {
    return () => { if (rawDirtyRef.current) void flushRaw(rawPathRef.current); };
  }, [flushRaw]);

  const onRawChange = useCallback((next: string) => {
    setRawText(next);
    rawTextRef.current = next;
    rawDirtyRef.current = true;
    rawPathRef.current = key;
    if (rawSaveTimerRef.current) clearTimeout(rawSaveTimerRef.current);
    rawSaveTimerRef.current = setTimeout(() => { void flushRaw(key); }, RAW_SAVE_DEBOUNCE_MS);
  }, [key, flushRaw]);

  const toggleRawMode = useCallback(() => {
    setRawMode((on) => {
      if (on) { if (rawDirtyRef.current) void flushRaw(key); }
      return !on;
    });
  }, [key, flushRaw]);

  // Cmd/Ctrl+E toggles raw ↔ rendered (Obsidian parity). Only when raw is enabled.
  useEffect(() => {
    if (!showRawToggle || !key) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        toggleRawMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showRawToggle, key, toggleRawMode]);

  // Fetch wiki-link + tag corpora when wikilinks are on and the caller didn't inject them.
  useEffect(() => {
    if (!enableWikiLinks || wikiLinkNotes) return;
    fetchNotesList().then(setFetchedNotes).catch(() => {});
  }, [enableWikiLinks, wikiLinkNotes, key]);
  useEffect(() => {
    if (!enableWikiLinks || tagSuggestions) return;
    fetchTags().then(setFetchedTags).catch(() => {});
  }, [enableWikiLinks, tagSuggestions, key]);

  if (content === null) {
    return (
      <>{loadingFallback ?? (
        <div className="notes-editor-empty">
          <div className="notes-editor-empty-content"><p>Failed to load</p></div>
        </div>
      )}</>
    );
  }

  const breadcrumb = showBreadcrumb && breadcrumbPath
    ? breadcrumbPath.replace(/\.md$/, '').split('/')
    : null;

  const hasToolbar = showWidthToggle || showRawToggle || showBookmark || showLocate || saveStatus !== 'idle' || !!updatedAt;
  // Breadcrumb segments are clickable only when a navigate handler is wired
  // (the /notes page owns the tree; pop-outs have no tree → plain text).
  const breadcrumbClickable = !!onBreadcrumbNavigate;

  return (
    <div className={`notes-editor-panel notes-width-${width}`}>
      {(breadcrumb || hasToolbar) && (
        <div className="notes-editor-header">
          {breadcrumb ? (
            <div className="notes-editor-breadcrumb">
              {breadcrumb.map((part, i) => {
                const isLast = i === breadcrumb.length - 1;
                // Cumulative vault path for this segment. Folder segments have no
                // .md; the leaf is the current note (breadcrumbPath, with .md).
                const segPath = isLast
                  ? (breadcrumbPath ?? breadcrumb.slice(0, i + 1).join('/'))
                  : breadcrumb.slice(0, i + 1).join('/');
                const cls = isLast ? 'notes-breadcrumb-current' : 'notes-breadcrumb-parent';
                return (
                  <span key={i}>
                    {i > 0 && <span className="notes-breadcrumb-sep">/</span>}
                    {breadcrumbClickable ? (
                      <button
                        type="button"
                        className={`${cls} notes-breadcrumb-link`}
                        onClick={() => (isLast ? onLocate?.() : onBreadcrumbNavigate?.(segPath))}
                        title={isLast ? 'Locate in sidebar' : `Reveal “${part}” in sidebar`}
                      >
                        {part}
                      </button>
                    ) : (
                      <span className={cls}>{part}</span>
                    )}
                  </span>
                );
              })}
            </div>
          ) : <div />}
          <div className="notes-editor-meta">
            {showLocate && onLocate && (
              <button
                className="notes-bookmark-btn notes-locate-btn"
                onClick={onLocate}
                aria-label="Locate in sidebar"
                title="Locate in sidebar"
              >
                <LocateIcon />
              </button>
            )}
            {showWidthToggle && <WidthToggleButton width={width} onChange={setWidth} />}
            {showRawToggle && (
              <button
                className={`notes-bookmark-btn notes-raw-toggle-btn ${rawMode ? 'active' : ''}`}
                onClick={toggleRawMode}
                aria-pressed={rawMode}
                aria-label={rawMode ? 'Show rendered editor' : 'Show raw markdown'}
                title={rawMode ? 'Rendered (⌘E)' : 'Raw markdown (⌘E)'}
              >
                <CodeIcon />
              </button>
            )}
            {showBookmark && onToggleFavorite && (
              <button
                className={`notes-bookmark-btn ${isFavorite ? 'active' : ''}`}
                onClick={onToggleFavorite}
                aria-pressed={!!isFavorite}
                aria-label={isFavorite ? 'Remove bookmark' : 'Bookmark this note'}
                title={isFavorite ? 'Remove bookmark' : 'Bookmark this note'}
              >
                <BookmarkIcon filled={!!isFavorite} />
              </button>
            )}
            <SaveStatusIndicator status={saveStatus} />
            {updatedAt && (
              <span className="notes-editor-updated">{new Date(updatedAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
      {pendingExternal && pendingExternal.path === key && (
        <ReloadBanner
          kind={pendingExternal.kind}
          onApply={onApplyExternal}
          onDismiss={onDismissExternal}
        />
      )}
      <div className="notes-editor-content" ref={contentElRef}>
        {/* Both surfaces stay mounted; raw mode hides the rendered editor so the
            TipTap instance survives a flush. */}
        <div style={rawMode ? { display: 'none' } : undefined} className="notes-rendered-wrap">
          <NotesEditor
            key={key ?? 'editor'}
            content={content}
            onDirty={handleEditorUpdate}
            autoFocus={autoFocus}
            placeholder={placeholder ?? 'Start writing...'}
            enableWikiLinks={enableWikiLinks}
            enableBlockTools={enableBlockTools}
            wikiLinkNotes={notesList}
            tagSuggestions={tagList}
            onWikiLinkClick={onWikiLinkClick}
            attachmentNotePath={attachmentNotePath ?? undefined}
            tasks={tasks}
            focusedTaskId={focusedTaskId ?? undefined}
            onTaskClick={onTaskClick}
          />
        </div>
        {rawMode && showRawToggle && (
          <RawMarkdownView value={rawText} onChange={onRawChange} />
        )}
      </div>
      {showBacklinks && key && onNavigate && (
        <BacklinksPanel notePath={key} onNavigate={onNavigate} />
      )}
    </div>
  );
}

/**
 * Single Normal⇄Full width toggle (Feature 1, Notion-style). One button: click to
 * flip between a comfortable wide column and edge-to-edge. Active (accent) = Full.
 * The outward double-arrow icon reads universally as "make it wider".
 */
function WidthToggleButton({ width, onChange }: { width: EditorWidth; onChange: (w: EditorWidth) => void }) {
  const isFull = width === 'full';
  return (
    <button
      className={`notes-width-btn ${isFull ? 'active' : ''}`}
      onClick={() => onChange(isFull ? 'normal' : 'full')}
      aria-pressed={isFull}
      aria-label={isFull ? 'Switch to normal width' : 'Switch to full width'}
      title={isFull ? 'Full width' : 'Wider editor'}
    >
      <WidthArrowsIcon />
    </button>
  );
}

/** Outward double-arrow ↔ — "expand width" affordance. */
function WidthArrowsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="3.5" x2="8" y2="12.5" opacity="0.45" />
      <line x1="2" y1="8" x2="6" y2="8" />
      <polyline points="4 6 2 8 4 10" />
      <line x1="14" y1="8" x2="10" y2="8" />
      <polyline points="12 6 14 8 12 10" />
    </svg>
  );
}

/** Crosshair/target glyph — "locate this note in the sidebar tree". */
function LocateIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" />
      <line x1="8" y1="1.5" x2="8" y2="3.5" />
      <line x1="8" y1="12.5" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3.5" y2="8" />
      <line x1="12.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

/** </> glyph for the raw-markdown toggle. */
function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 4 1.5 8 5 12" />
      <polyline points="11 4 14.5 8 11 12" />
    </svg>
  );
}

/**
 * Non-destructive reload affordance for a deferred external/AI write (§6.2).
 */
function ReloadBanner({
  kind,
  onApply,
  onDismiss,
}: {
  kind: PendingExternalChange['kind'];
  onApply?: () => void;
  onDismiss?: () => void;
}) {
  const conflict = kind === 'conflict';
  return (
    <div className={`notes-reload-banner ${conflict ? 'conflict' : ''}`} role="status">
      <span className="notes-reload-banner-text">
        {conflict
          ? 'This note was changed elsewhere while you were typing. Your last unsaved edit may be lost — load the latest version?'
          : 'This note changed on disk. Reload to see the latest?'}
      </span>
      <div className="notes-reload-banner-actions">
        <button className="notes-reload-banner-btn primary" onClick={onApply}>
          {conflict ? 'Load latest' : 'Reload'}
        </button>
        {!conflict && (
          <button className="notes-reload-banner-btn" onClick={onDismiss}>
            Keep editing
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ALWAYS renders a fixed-width slot — mounting/unmounting on every debounced save
 * made the header row reflow on each keystroke (read as the page "flashing").
 */
function SaveStatusIndicator({ status }: { status: string }) {
  const label =
    status === 'saving' ? 'Saving...' :
    status === 'saved' ? 'Saved' :
    status === 'error' ? 'Save failed' : '';
  return (
    <span
      className={`notes-save-status ${status}`}
      style={{ opacity: label ? 1 : 0 }}
      aria-live="polite"
    >
      {label || 'Saved'}
    </span>
  );
}

/** Bookmark glyph — filled when favorited, outline otherwise. */
function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M3.5 2.5h9a1 1 0 0 1 1 1v10l-5.5-3-5.5 3v-10a1 1 0 0 1 1-1z" />
    </svg>
  );
}
