/**
 * FileContentView — shared file-content renderer AND editor.
 *
 * Fetches a file from /api/file-content (local + remote via host) and renders
 * it with line numbers + optional line highlight/scroll-to. Used by both the
 * full-screen FileViewer overlay and the inline right pane of SessionFileExplorer.
 *
 * Editable files render an EDITOR as their default view — there is no Edit
 * button and no separate read mode:
 *  - markdown on the Preview tab = the Notes WYSIWYG editor (edit the rendered
 *    doc directly, like /notes);
 *  - the Source tab and every plain code file = CodeMirror.
 * Saving stays EXPLICIT (Save / ⌘S → PUT /api/file-content) with an optimistic
 * lock on the read's contentHash — never auto-save: an agent may be editing the
 * same repo in the same second. Non-editable files (truncated/binary/raw kinds)
 * keep the read-only views.
 *  - QUOTE: selecting text raises an "Ask about this" pill that prefills the
 *    session chat with a located, code-quoted reference (same affordance and the
 *    same buildSelectionPrefill composer as the Changed tab). In the WYSIWYG
 *    editor the same action lives in the selection bubble menu ("Ask").
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchFileContent, rawFileContentUrl, downloadFileUrl, saveFileContent,
  FileSaveConflictError, type FileContentResponse,
} from '@/api/files';
import { formatSize } from '@/utils/format';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { loadFileScroll, saveFileScroll } from '@/utils/file-view-state';
import { highlightLines } from '@/utils/code-highlight';
import { vaultRelativeNotePath } from '@/utils/notes-link';
import { useRevealFile } from '@/hooks/useRevealFile';
import { useConfirm } from '@/hooks/useConfirm';
import { ICON_NEW_TAB } from '@/components/common/Icons';
import { FileSourceEditor, type FileSourceEditorHandle } from '@/components/common/FileSourceEditor';
import { FileMarkdownEditor } from '@/components/common/FileMarkdownEditor';
import { SelectionAskPill, selectionClientRect } from '@/components/common/SelectionAskPill';
import { openPopout } from '@/popout/openPopout';
import { log } from '@/utils/log';

interface FileContentViewProps {
  path: string;
  line?: number;
  host?: string;
  /** Hide the "pop out to window" button (e.g. when already rendered inside a pop-out). */
  hidePopout?: boolean;
  /**
   * Bump to force a re-fetch of the same path (the explorer's Refresh button).
   * `key={path}` alone can't do this — the path is unchanged, only the file's
   * bytes on disk moved.
   */
  reloadToken?: number;
  /**
   * Quote-to-ask target. When provided, selecting text in the source or the
   * markdown preview raises an "Ask about this" pill that hands the selection up
   * (file path, line, text) to be composed into a chat prefill. Absent (e.g. the
   * pop-out window, the "@" mention preview) → no pill, since there's no chat
   * input in reach to prefill.
   */
  onSelectCode?: (filePath: string, line: number | undefined, code: string) => void;
  /** Fired after a successful save, so the container can refresh sibling views
   *  (the explorer re-lists, a Changed tab recomputes). */
  onSaved?: (filePath: string) => void;
}

/** Build line-numbered HTML from raw file content. Lines get Prism syntax
 *  coloring when the language is known (highlightLines); plain escape otherwise. */
function buildLineNumberedHtml(content: string, path: string, highlightLine?: number): string {
  const lines = content.split('\n');
  const colored = highlightLines(content, path);
  const rows = lines.map((lineText, i) => {
    const lineNum = i + 1;
    const isHighlighted = lineNum === highlightLine;
    const html = colored ? colored[i]! : lineText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div class="fv-line${isHighlighted ? ' fv-line-highlight' : ''}" data-line="${lineNum}"><span class="fv-line-num">${lineNum}</span><span class="fv-line-text">${html}</span></div>`;
  });
  return rows.join('');
}

/** Whether a file extension is HTML and thus previewable as rendered markup. */
function isHtmlExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'html' || e === 'htm';
}

/** Whether a file extension is Markdown and thus previewable as rendered markup. */
function isMarkdownExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'md' || e === 'markdown' || e === 'mdx';
}

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);
// PDFs and rasters are rendered by the BROWSER's own viewer (PDF.js / image
// decoder) from the raw-bytes URL — we deliberately don't bundle a PDF renderer
// or build a zoom/rotate UI. Chrome and Firefox already have a better one.
const DOC_EXTS = new Set(['pdf']);
// svg is NOT here: it's text, so the source/preview toggle is more useful (and
// the markdown/HTML path already renders it when embedded).
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'tiff', 'tif']);

/** Speed steps shared by the toolbar select and the </> keyboard shortcuts. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Files served as RAW BYTES and rendered by a native browser control, never
 * through the JSON content fetch — a whole-file text read would corrupt them
 * (and a remote 100MB video would kill the tunnel).
 *   video/audio → <video>/<audio> (+ our speed/skip toolbar)
 *   doc         → <iframe> → the browser's built-in PDF viewer
 *   image       → <img>
 */
function rawKind(path: string): 'video' | 'audio' | 'doc' | 'image' | null {
  const e = (path.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (DOC_EXTS.has(e)) return 'doc';
  if (IMAGE_EXTS.has(e)) return 'image';
  return null;
}

/** The subset of rawKind that owns the playback toolbar (speed / skip keys). */
function isPlayable(kind: ReturnType<typeof rawKind>): kind is 'video' | 'audio' {
  return kind === 'video' || kind === 'audio';
}

/**
 * The element that actually scrolls the file body.
 *
 * It differs by render mode, which is why this is resolved from the DOM instead
 * of hardcoded: the markdown preview (`.fv-md-preview`) scrolls itself, while the
 * plain-source `<pre>` only scrolls HORIZONTALLY — its vertical scroller is an
 * ancestor (the explorer's preview pane, the fullscreen overlay, or the pop-out
 * root). Walk up until one can actually scroll.
 */
function findScroller(start: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = start;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (/auto|scroll|overlay/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

export function FileContentView({
  path: filePath, line, host, hidePopout, reloadToken = 0, onSelectCode, onSaved,
}: FileContentViewProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Re-fetch of the file already on screen (Refresh): keep the old content
  // visible instead of flashing to blank, and show a small "Reloading…" badge.
  const [reloading, setReloading] = useState(false);
  // For HTML/Markdown files, default to the rendered preview; toggle to source on demand.
  const [showSource, setShowSource] = useState(false);
  // Fullscreen the preview (md/html) — CSS-fixed overlay, no remount.
  const [fullscreen, setFullscreen] = useState(false);
  // Media playback speed — applied to the <video>/<audio> element directly.
  const [playbackRate, setPlaybackRate] = useState(1);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Editing ────────────────────────────────────────────────────────────────
  // Editable files render an EDITOR as their default view — no Edit button, no
  // separate mode (markdown Preview = the Notes WYSIWYG editor, everything else
  // = CodeMirror). Saving stays EXPLICIT: a Walnut session's agent may be
  // writing the same file in the same second, and the whole point of the
  // contentHash lock below is to make that collision visible rather than
  // silently pick a winner.
  //
  // Dirty is TWO flags because the buffer can outlive one editor instance: the
  // live editor reports `editorDirty`; switching Preview⇄Source captures the
  // buffer into `draftRef` (the next editor seeds from it) and sets
  // `draftDirty` — sticky until save/discard, because the new editor's own
  // dirty-tracking compares against the DRAFT, not against disk.
  const [editorDirty, setEditorDirty] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const dirty = editorDirty || draftDirty;
  // App-wide themed dialog (never window.confirm — see handleDiscard).
  const confirm = useConfirm();
  const draftRef = useRef<string | null>(null);
  // Bumped by Discard to force a remount back onto the on-disk bytes.
  const [seedNonce, setSeedNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // The hash of the bytes the editor was seeded from. Its ONLY job is the
  // editor remount key: it advances on a fresh READ (so a Refresh that landed
  // new bytes reseeds the editor) — deliberately NOT on save, which would
  // remount mid-typing and yank the caret/scroll to the top on every ⌘S.
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined);
  // The CURRENT optimistic-lock token — what PUT sends as expectedHash. A ref,
  // not state: it advances on every successful save without touching the key.
  const lockHashRef = useRef<string | undefined>(undefined);
  // Lock token learned from a CONFLICT response. Kept apart from lockHashRef
  // because it means something different: "the user has NOT seen these bytes".
  // Sending it is an explicit overwrite (Save pressed again after the warning);
  // it is cleared on cancel so a later re-edit can't silently clobber the other
  // writer, and on any fresh read / successful save.
  const conflictHashRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<FileSourceEditorHandle>(null);

  // Skip: back 3s (small — re-hear the last sentence), forward 10s (skip dead air).
  const skipBy = (deltaSec: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = Math.min(Math.max(0, el.currentTime + deltaSec), dur);
  };

  // `raw` = rendered by a native browser control from the bytes URL.
  // `media` = the playable subset that owns the speed/skip toolbar.
  const raw = rawKind(filePath);
  const media = isPlayable(raw) ? raw : null;

  // View state (source/preview toggle, fullscreen, speed) belongs to the FILE,
  // not to a reload — a Refresh must not kick you back out of Preview mode.
  // Source-vs-Preview is restored from the last visit to THIS file (same store as
  // the scroll offset) so reopening a file returns you to how you were reading it.
  useEffect(() => {
    setShowSource(loadFileScroll(host, filePath)?.source === true);
    setFullscreen(false);
    setPlaybackRate(1);
    // Draft/dirty state is per-FILE: switching files drops the previous file's
    // buffer state (the beforeunload guard + explicit-save UX own data safety).
    setEditorDirty(false);
    setDraftDirty(false);
    draftRef.current = null;
    setSaveError(null);
  }, [filePath, host]);

  // Distinguishes "first load of this file" (blank → spinner) from "Refresh of
  // the file already on screen" (keep content, badge it as reloading).
  const lastTokenRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isReload = lastTokenRef.current !== null && lastTokenRef.current !== reloadToken;
    lastTokenRef.current = reloadToken;
    if (isReload) setReloading(true);
    else { setLoading(true); setData(null); }
    // Media/PDF/images render straight from the raw-bytes URL — no JSON content
    // fetch (which would whole-file-read a potentially huge binary on the remote
    // side, and text-decode bytes that aren't text).
    if (rawKind(filePath)) { setLoading(false); setReloading(false); return; }
    // A reload must bypass the HTTP cache, else a 200-from-cache hands back the
    // stale bytes and Refresh looks like a no-op.
    fetchFileContent(filePath, host, { noCache: isReload })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Seed / re-seed the optimistic-lock token from whatever we just read;
        // a fresh read supersedes any pending conflict hash. baseHash moves too,
        // remounting any open editor onto the new bytes — so an explicit Refresh
        // also drops any unsaved draft (deliberate: Refresh = "give me disk").
        conflictHashRef.current = undefined;
        lockHashRef.current = d.contentHash;
        draftRef.current = null;
        setDraftDirty(false);
        setEditorDirty(false);
        setBaseHash(d.contentHash);
      })
      .catch((err) => {
        if (cancelled) return;
        setData({
          content: null, size: 0, truncated: false, binary: false,
          error: err instanceof Error ? err.message : String(err),
          extension: '',
        });
      })
      .finally(() => { if (!cancelled) { setLoading(false); setReloading(false); } });
    return () => { cancelled = true; };
  }, [filePath, host, reloadToken]);

  // Scroll to highlighted line after content renders
  useEffect(() => {
    if (!line || !contentRef.current) return;
    const el = contentRef.current.querySelector(`[data-line="${line}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [line, data]);

  // ── Resume reading position ────────────────────────────────────────────────
  // Restore this file's last scroll offset once its content is on screen, then
  // keep it up to date. Without this, every reopen of a file (panel toggle,
  // session switch, reload) dumped you back at line 1 of a long document.
  //
  // Skipped when `line` is set — an explicit deep-link to a line wins over the
  // remembered offset (that effect above owns the scroll in that case).
  const restoredForRef = useRef<string | null>(null);
  // Last offset OBSERVED while the scroller was live, per file. The unmount flush
  // must use this instead of re-reading the element: by teardown the node is
  // detached, `scrollTop` reads 0, and saving that DELETES the entry we were
  // trying to preserve — which is exactly why the first version of this restore
  // silently never worked (localStorage came back as `{}` after closing).
  const lastSeenRef = useRef<{ key: string; top: number } | null>(null);
  useEffect(() => {
    // Raw kinds (media/PDF/image) have no text body and never fetch `content`;
    // their scroll position belongs to the native control, not to us.
    if (!data?.content || raw) return;
    // Latch per FILE, not per render mode: a Refresh or a Preview⇄Source toggle
    // re-runs this effect and must only RE-ATTACH the listener. Re-restoring
    // would yank the user back to the saved offset mid-read (and a Preview
    // offset is meaningless in Source view, which has different line heights).
    const key = `${host ?? 'local'} ${filePath}`;
    const firstRestore = restoredForRef.current !== key;
    restoredForRef.current = key;

    let raf = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    // ── Save: capture-phase listener on document, not a listener on one node.
    // The body is an ASYNC-mounting editor now (TipTap fills after mount,
    // CodeMirror measures on its own rAF), so "find the scroller once, attach
    // there" raced the mount: when findScroller came up empty on frame 1 the
    // listener was never attached and NOTHING was ever saved — the reported
    // "doesn't remember the scroll location". Scroll events don't bubble but
    // they DO capture, so one document-level listener hears every current and
    // FUTURE scroller; we filter to elements related to this file's body.
    const saved = firstRestore && !line ? loadFileScroll(host, filePath) : null;
    let chaseTop: number | null = saved ? saved.top : null;
    let lastSetTop = -1;
    const chaseDeadline = Date.now() + 5000;

    const onScrollCapture = (e: Event) => {
      const t = e.target;
      const rootEl = contentRef.current;
      if (!(t instanceof HTMLElement) || !rootEl) return;
      // The vertical scroller is either inside the body (editors, md preview)
      // or an ancestor pane (read-only <pre> case). Anything else on the page
      // is not ours. Horizontal-only scrollers (the <pre> itself) are skipped —
      // saving their scrollTop of 0 would delete the entry being preserved.
      if (!rootEl.contains(t) && !t.contains(rootEl)) return;
      if (t.scrollHeight <= t.clientHeight + 1) return;
      const top = t.scrollTop;
      // A scroll that isn't the echo of our own programmatic set means the
      // user took over — stop chasing the saved offset, never fight them.
      if (chaseTop != null && Math.abs(top - lastSetTop) > 1) chaseTop = null;
      lastSeenRef.current = { key, top };
      clearTimeout(saveTimer);
      // Debounced: a scroll gesture fires dozens of events; one write per rest.
      saveTimer = setTimeout(() => {
        const seen = lastSeenRef.current;
        if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top, source: showSource });
      }, 250);
    };
    document.addEventListener('scroll', onScrollCapture, { capture: true, passive: true });

    // ── Restore: CHASE the saved offset across frames instead of applying it
    // once. At any single frame the scroller may not exist yet or its
    // scrollHeight may be a fraction of the final document (editor mount,
    // syntax highlight, image loads) — a one-shot restore clamped the offset
    // against that fraction, so long files always "resumed" near the top.
    // Chasing stops when the full offset is reachable, the user scrolls, or
    // the deadline passes (never-scrollable short files).
    const tick = () => {
      if (chaseTop != null) {
        const body = contentRef.current?.querySelector<HTMLElement>(
          '.fv-md-preview, .file-viewer-code, .fv-source-editor .cm-scroller, .fv-wysiwyg-editor',
        );
        const scroller = findScroller(body ?? contentRef.current);
        if (scroller) {
          const max = scroller.scrollHeight - scroller.clientHeight;
          // Clamp to what's renderable NOW; keep chasing until the document
          // has grown enough to hold the full saved offset.
          const top = Math.max(0, Math.min(chaseTop, max));
          if (Math.abs(scroller.scrollTop - top) > 1) {
            lastSetTop = top;
            scroller.scrollTop = top;
            // Seed the tracker so an immediate close re-persists the restored
            // value rather than flushing a 0 (a programmatic scrollTop set
            // fires no synchronous event).
            lastSeenRef.current = { key, top };
          }
          if (max >= chaseTop) chaseTop = null; // full saved offset reached
        }
      }
      if (chaseTop != null && Date.now() < chaseDeadline) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(saveTimer);
      document.removeEventListener('scroll', onScrollCapture, { capture: true } as EventListenerOptions);
      // Flush the last LIVE value — closing the panel is the most common way to
      // leave a file, and the debounce would otherwise drop that last position.
      const seen = lastSeenRef.current;
      if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top, source: showSource });
    };
  }, [data, filePath, host, showSource, raw, line]);

  // Media keyboard shortcuts. Capture phase so we beat the browser's native
  // focused-<video> handling; preventDefault stops a double-seek. Skipped while
  // typing in an input/textarea/editor. These fire in NATIVE video fullscreen
  // too (keydown still reaches window) — the only way to change speed there,
  // since the toolbar select isn't part of the fullscreened <video> element.
  //   ← back 3s   → forward 10s   > speed up   < slow down (YouTube-style)
  useEffect(() => {
    if (!media) return;
    const handler = (e: KeyboardEvent) => {
      const isSeek = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const isSpeed = e.key === '>' || e.key === '<';
      if (!isSeek && !isSpeed) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (isSeek) {
        skipBy(e.key === 'ArrowLeft' ? -3 : 10);
        return;
      }
      setPlaybackRate((prev) => {
        const idx = PLAYBACK_RATES.indexOf(prev);
        const at = idx === -1 ? PLAYBACK_RATES.indexOf(1) : idx;
        const next = PLAYBACK_RATES[Math.min(Math.max(at + (e.key === '>' ? 1 : -1), 0), PLAYBACK_RATES.length - 1)];
        if (mediaRef.current) mediaRef.current.playbackRate = next;
        return next;
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [media]);

  // Escape exits fullscreen (capture phase so it fires before the FileViewer's own
  // Escape-to-close handler, letting the first Escape just leave fullscreen).
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [fullscreen]);

  const isHtml = data?.content != null && isHtmlExt(data.extension, filePath);
  const isMarkdown = data?.content != null && isMarkdownExt(data.extension, filePath);
  const isRenderable = isHtml || isMarkdown;
  // Which editor the file gets follows the CURRENT tab: markdown on the Preview
  // tab edits WYSIWYG (the Notes TipTap editor over the rendered view — same
  // affordance as /notes); the Source tab and every plain code file edit raw
  // text in CodeMirror. MDX is excluded from WYSIWYG: its JSX blocks would not
  // survive the TipTap round-trip, so it renders read-only in Preview.
  const ext = (data?.extension || filePath.split('.').pop() || '').toLowerCase();
  const canWysiwyg = isMarkdown && ext !== 'mdx';

  /**
   * Whether this file can be edited at all. The gate is deliberately narrow: we
   * only offer an editor for bytes the viewer actually holds in full.
   *  - `raw` kinds (video/audio/pdf/image) were never text-decoded.
   *  - `binary` files were refused by the read path (server rejects the write too).
   *  - `truncated` files are only the first 512 KB — saving would delete the tail,
   *    which is exactly why the server omits contentHash for them.
   *  - a read `error` means there's nothing loaded to edit.
   * A missing contentHash is the single source of truth for the last two, so the
   * FE can't drift from the server's own rule.
   */
  const canEdit = !loading && !raw && data != null && !data.binary && !data.error
    && data.content != null && !data.truncated && data.contentHash != null;

  // Editors ARE the default view for editable files. Preview tab: WYSIWYG for
  // plain markdown, read-only render for HTML (iframe) and MDX. Source tab /
  // non-renderable text: CodeMirror. Non-editable files keep the read views.
  const editingWysiwyg = canEdit && canWysiwyg && !showSource;
  const editingSource = canEdit && (showSource || !isRenderable);
  const editing = editingWysiwyg || editingSource;
  const showPreview = isRenderable && !showSource && !editingWysiwyg;

  // Prism-highlighted rows for the read-only <pre> fallback ONLY (non-editable
  // text, e.g. truncated reads). Editable files render an editor instead — and
  // CodeMirror highlights itself — so skip the (quadratic-ish) work for them.
  const lineNumberedHtml = useMemo(() => {
    if (!data?.content || editing) return '';
    return buildLineNumberedHtml(data.content, filePath, line);
  }, [data, filePath, line, editing]);

  const handleSave = useCallback(async () => {
    const text = editorRef.current?.getValue();
    if (text == null) return;
    setSaving(true);
    setSaveError(null);
    try {
      // A pending conflict hash wins: pressing Save after a conflict IS the
      // user's "overwrite it with mine" decision, so send the hash the server
      // just told us is current rather than the stale seed hash (which would
      // 409 forever).
      const expectedHash = conflictHashRef.current ?? lockHashRef.current;
      const res = await saveFileContent(filePath, text, { host, expectedHash });
      // Advance the lock token WITHOUT remounting the editor (baseHash stays):
      // a remount reseeds the doc and yanks the caret/scroll to the top, which
      // made every ⌘S mid-document a jump-to-line-1. markClean re-baselines
      // dirty-tracking in place instead.
      conflictHashRef.current = undefined;
      lockHashRef.current = res.contentHash;
      setData((prev) => (prev ? { ...prev, content: text, size: res.size, contentHash: res.contentHash } : prev));
      editorRef.current?.markClean();
      draftRef.current = null;
      setDraftDirty(false);
      setEditorDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      log.info('file-editor', 'file saved', { path: filePath, host, size: res.size });
      onSaved?.(filePath);
    } catch (err) {
      if (err instanceof FileSaveConflictError) {
        // Do NOT auto-resolve: the user's text and the on-disk text are both real
        // work. Keep the buffer intact, name the situation, and let them choose
        // (Reload discards theirs; Save again — now an explicit overwrite — wins).
        //
        // CRITICAL: advance the lock token WITHOUT remounting the editor. The
        // editor is keyed on baseHash, and it seeds from `data.content` (the last
        // READ), so a naive setBaseHash here remounted it onto the pre-edit text
        // and the user's unsaved work vanished from the screen — the exact
        // outcome this branch exists to prevent (caught in UI verification).
        // conflictHashRef is read by handleSave but is NOT part of the key.
        conflictHashRef.current = err.currentHash;
        setSaveError('This file changed on disk since you opened it. Press Save again to overwrite it with your version, or Discard and reopen the file to get the new one.');
        log.warn('file-editor', 'save conflict', { path: filePath, host });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
        log.error('file-editor', 'save failed', { path: filePath, host, error: msg });
      }
    } finally {
      setSaving(false);
    }
  }, [filePath, host, onSaved]);

  // Throw away the unsaved buffer and remount the editor on the on-disk bytes.
  // The only deliberate-loss path — hence the confirm.
  //
  // useConfirm, NOT window.confirm: on localhost Chrome offers "don't allow this
  // site to prompt you again", after which window.confirm silently returns false
  // and Discard becomes a permanently dead button. That is why the app-wide dialog
  // layer exists; every sibling destructive action already uses it.
  const handleDiscard = useCallback(async () => {
    const ok = await confirm({
      title: 'Discard your unsaved changes to this file?',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    draftRef.current = null;
    setDraftDirty(false);
    setEditorDirty(false);
    setSaveError(null);
    conflictHashRef.current = undefined;
    setSeedNonce((n) => n + 1);
  }, [confirm]);

  // Preview⇄Source both EDIT the same file in different representations, so an
  // unsaved buffer must survive the switch: capture the live editor's value as
  // the draft the next editor seeds from. (A dirty WYSIWYG buffer arrives in
  // Source as its serialized markdown — exactly the bytes Save would write.)
  const switchTab = useCallback((toSource: boolean) => {
    if (editorRef.current) {
      if (dirty) {
        draftRef.current = editorRef.current.getValue();
        setDraftDirty(true);
      }
      setEditorDirty(false);
    }
    setShowSource(toSource);
  }, [dirty]);

  // Last-ditch guard for the whole-tab case (reload, close, navigate away). The
  // in-app paths (file switch, Cancel) have their own explicit confirms.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ── Quote to ask ───────────────────────────────────────────────────────────
  // Select text → floating pill → prefill the session chat with a located,
  // code-quoted reference. Mirrors the Changed tab's affordance (same pill, same
  // buildSelectionPrefill composer upstream) so a quoted reference reads the same
  // whether it came from a diff or from a whole file. Four sources feed it:
  //  - read-only views (md preview for MDX, truncated <pre>) → DOM mouseup walk;
  //  - the CodeMirror editor → its onSelectText callback (line from the doc);
  //  - the WYSIWYG editor → the bubble menu's "Ask" button (commits directly);
  //  - the HTML preview iframe → mouseup inside its own document (below).
  const [selection, setSelection] = useState<{ x: number; y: number; text: string; line?: number; inHtml?: boolean } | null>(null);

  // The anchor is the POINTER at release: the pill hugs the cursor (below the
  // selection after a downward drag, above after an upward one) — the side is
  // decided by SelectionAskPill from this point.
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!onSelectCode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { setSelection(null); return; }
    const text = sel.toString().trim();
    if (!text || !contentRef.current) { setSelection(null); return; }
    const range = sel.getRangeAt(0);
    // Only selections INSIDE this file's body count — a stray page selection
    // elsewhere must not raise a pill anchored to this file.
    if (!contentRef.current.contains(range.commonAncestorContainer)) { setSelection(null); return; }

    // Resolve a line number by walking up to the nearest `data-line` row — the
    // rows buildLineNumberedHtml emits, so this resolves in the SOURCE view. The
    // markdown preview has no per-line anchors, so a quote from there degrades to
    // a file-only reference (buildSelectionPrefill omits `:line` when undefined),
    // which is still correct — just less precise.
    let line: number | undefined;
    let node: Node | null = range.startContainer;
    while (node && node !== contentRef.current) {
      if (node instanceof HTMLElement) {
        const ln = node.getAttribute('data-line');
        if (ln) { const n = Number(ln); if (!Number.isNaN(n)) { line = n; break; } }
      }
      node = node.parentNode;
    }

    setSelection({ x: e.clientX, y: e.clientY, text, line });
  }, [onSelectCode]);

  const commitSelection = useCallback(() => {
    if (!selection || !onSelectCode) return;
    onSelectCode(filePath, selection.line, selection.text);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    // An HTML-preview selection lives in the iframe's document — clear it there.
    if (selection.inHtml) {
      try { htmlFrameRef.current?.contentDocument?.getSelection()?.removeAllRanges(); } catch { /* cross-origin */ }
    }
  }, [selection, onSelectCode, filePath]);

  // WYSIWYG "Ask": the bubble menu already scopes to a real selection, so it
  // commits straight through — no pill hop. Line is unknowable in a rendered
  // doc; the prefill degrades to a file-level reference (still correct).
  const handleAskSelection = useCallback((text: string) => {
    onSelectCode?.(filePath, undefined, text);
  }, [onSelectCode, filePath]);

  // HTML preview: the rendered page lives in a same-origin IFRAME, so the
  // outer mouseup handler never sees selections made inside it. Listen inside
  // the iframe's own document and translate its selection rect to top-viewport
  // coords (iframe box offset). Line is unknowable in rendered HTML — the
  // prefill degrades to a file-level reference, same as the WYSIWYG path.
  const htmlFrameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlPreviewLive = !loading && !showSource && isHtml;
  useEffect(() => {
    if (!onSelectCode || !htmlPreviewLive) return;
    const frame = htmlFrameRef.current;
    if (!frame) return;
    let doc: Document | null = null;
    const onFrameMouseUp = (e: MouseEvent) => {
      if (!doc) return;
      const sel = doc.getSelection();
      const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : '';
      if (!text) { setSelection((prev) => (prev?.inHtml ? null : prev)); return; }
      // Anchor = the pointer at release, translated from iframe to top-viewport
      // coords — the pill hugs the cursor (side decided by SelectionAskPill).
      const box = frame.getBoundingClientRect();
      setSelection({ x: box.left + e.clientX, y: box.top + e.clientY, text, inHtml: true });
    };
    const attach = () => {
      // A cross-origin navigation inside the preview throws here — no pill then.
      try { doc = frame.contentDocument; } catch { doc = null; }
      doc?.addEventListener('mouseup', onFrameMouseUp);
    };
    // The document is replaced on every load (including the first, which may
    // not have happened yet) — (re)attach each time.
    frame.addEventListener('load', attach);
    if (frame.contentDocument?.readyState === 'complete') attach();
    return () => {
      frame.removeEventListener('load', attach);
      doc?.removeEventListener('mouseup', onFrameMouseUp);
    };
  }, [onSelectCode, htmlPreviewLive, filePath]);

  // Live selection rect for the pill, translated to top-viewport coords when
  // the selection lives inside the HTML preview iframe.
  const resolveSelectionRect = useCallback((): DOMRect | null => {
    if (!selection?.inHtml) return selectionClientRect();
    const frame = htmlFrameRef.current;
    let doc: Document | null = null;
    try { doc = frame?.contentDocument ?? null; } catch { return null; }
    if (!frame || !doc) return null;
    const rect = selectionClientRect(doc);
    if (!rect) return null;
    const box = frame.getBoundingClientRect();
    return new DOMRect(box.left + rect.left, box.top + rect.top, rect.width, rect.height);
  }, [selection?.inHtml]);

  // Drop a stale pill when the file changes.
  useEffect(() => { setSelection(null); }, [filePath]);

  const [pathCopied, setPathCopied] = useState(false);
  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    }).catch(() => {});
  }, [filePath]);

  const copyPathBtn = (
    <button
      type="button"
      className="fv-html-tab fv-copy-path-btn"
      onClick={handleCopyPath}
      title={`Copy path: ${filePath}`}
    >
      {pathCopied ? '✓ Copied' : 'Copy Path'}
    </button>
  );

  const downloadBtn = (
    <a
      className="fv-html-tab fv-download-btn"
      href={downloadFileUrl(filePath, host)}
      download
      title="Download file"
    >
      ⬇ Download
    </a>
  );

  /** Save / Discard cluster. The editor is always live for editable files, so
   *  these are always present there — Save disabled until something changed. */
  const editBtns = !canEdit || !editing ? null : (
    <>
      <button
        type="button"
        className="fv-html-tab fv-save-btn"
        onClick={() => { void handleSave(); }}
        disabled={saving || !dirty}
        title={dirty ? 'Save changes (⌘S)' : 'No changes to save'}
      >
        {saving ? 'Saving…' : savedFlash ? '✓ Saved' : 'Save'}
      </button>
      {dirty && (
        <button
          type="button"
          className="fv-html-tab fv-cancel-edit-btn"
          onClick={() => void handleDiscard()}
          title="Throw away unsaved changes and reload from disk"
        >
          Discard
        </button>
      )}
      {dirty && <span className="fv-dirty-dot" title="Unsaved changes">●</span>}
    </>
  );

  const markdownHtml = useMemo(() => {
    if (!isMarkdown || !data?.content) return '';
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : undefined;
    return renderMarkdownWithRefs(data.content, dir, host);
  }, [isMarkdown, data, host, filePath]);

  // ── "Open in Notes": OPT-IN jump to /notes for a vault note ────────────────
  // A file click used to divert here automatically; that was reverted (the app
  // shouldn't navigate away from a session because you clicked a .md). The button
  // only appears once the async vault check confirms this path IS a vault note.
  const navigate = useNavigate();
  const [notePath, setNotePath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNotePath(null);
    vaultRelativeNotePath(filePath, host)
      .then((rel) => { if (!cancelled) setNotePath(rel); })
      .catch(() => { /* not a note */ });
    return () => { cancelled = true; };
  }, [filePath, host]);

  const openInNotesBtn = notePath ? (
    <button
      type="button"
      className="fv-html-tab fv-notes-btn"
      onClick={() => navigate(`/notes?path=${encodeURIComponent(notePath)}`)}
      title="Open this note on the Notes page (tabs, backlinks, editing)"
    >
      Open in Notes
    </button>
  ) : null;

  // ── Desktop hand-off (macOS console only) ──────────────────────────────────
  const { canReveal, reveal, error: revealError, clearError: clearRevealError } = useRevealFile(host);
  const revealBtns = canReveal ? (
    <>
      <button
        type="button"
        className="fv-html-tab fv-reveal-btn"
        onClick={() => reveal(filePath, 'finder')}
        title="Reveal this file in Finder"
      >
        Finder
      </button>
      <button
        type="button"
        className="fv-html-tab fv-reveal-btn"
        onClick={() => reveal(filePath, 'app')}
        title="Open in the macOS default application for this file type"
      >
        Default app
      </button>
    </>
  ) : null;

  /** Toolbar tail every render mode shares. */
  const commonBtns = (
    <>
      {openInNotesBtn}
      {copyPathBtn}
      {downloadBtn}
      {revealBtns}
    </>
  );

  // Open the file in its own standalone browser TAB (zero-WS, one-shot fetch).
  // Hidden in fullscreen (fullscreen is the in-app expand) and when already popped out.
  const popoutBtn =
    !hidePopout && !fullscreen ? (
      <button
        type="button"
        className="fv-html-tab fv-popout-btn"
        onClick={() => openPopout('file', { path: filePath, host, line })}
        title="Open in new tab"
        aria-label="Open in new tab"
      >
        {ICON_NEW_TAB}
      </button>
    ) : null;

  return (
    <div
      className={`file-content-view${fullscreen ? ' fv-fullscreen' : ''}`}
      ref={contentRef}
      // Quote-to-ask for the READ-ONLY views (md preview of MDX, truncated
      // <pre>): DOM selection → pill. The editors report selections through
      // their own channels (CodeMirror onSelectText; WYSIWYG bubble-menu Ask),
      // so this handler is off while an editor owns the body.
      onMouseUp={onSelectCode && !editing ? handleMouseUp : undefined}
    >
      {loading && <div className="file-viewer-loading">Loading file...</div>}
      {reloading && <div className="fv-reloading-badge">Reloading…</div>}
      {!loading && data?.error && <div className="file-viewer-error">{data.error}</div>}
      {!loading && !raw && data?.binary && (
        <>
          <div className="fv-html-toolbar fv-toolbar-popout-only">{commonBtns}{popoutBtn}</div>
          <div className="file-viewer-error">
            Binary file ({formatSize(data.size)}) — cannot display. Use Download to save it.
          </div>
        </>
      )}
      {/* PDF: the BROWSER's own viewer (PDF.js in Chrome/Firefox) renders the raw
          bytes — zoom, search, print, page nav for free. We ship no PDF renderer. */}
      {!loading && raw === 'doc' && (
        <>
          <div className="fv-html-toolbar">
            {commonBtns}
            <button
              className="fv-html-tab fv-fullscreen-btn"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
            </button>
            {popoutBtn}
          </div>
          <iframe
            className="fv-doc-preview"
            src={rawFileContentUrl(filePath, host)}
            title={filePath}
          />
        </>
      )}
      {!loading && raw === 'image' && (
        <>
          <div className="fv-html-toolbar">
            {commonBtns}
            <button
              className="fv-html-tab fv-fullscreen-btn"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
            </button>
            {popoutBtn}
          </div>
          <div className="fv-image-preview">
            <img src={rawFileContentUrl(filePath, host)} alt={filePath} />
          </div>
        </>
      )}
      {!loading && media && (
        <>
          <div className="fv-html-toolbar">
            {commonBtns}
            <button
              type="button"
              className="fv-html-tab fv-skip-btn"
              onClick={() => skipBy(-3)}
              title="Back 3 seconds (←)"
              aria-label="Back 3 seconds"
            >
              ↺ 3s
            </button>
            <button
              type="button"
              className="fv-html-tab fv-skip-btn"
              onClick={() => skipBy(10)}
              title="Forward 10 seconds (→)"
              aria-label="Forward 10 seconds"
            >
              10s ↻
            </button>
            <select
              className="fv-html-tab fv-speed-select"
              value={playbackRate}
              onChange={(e) => {
                const rate = Number(e.target.value);
                setPlaybackRate(rate);
                if (mediaRef.current) mediaRef.current.playbackRate = rate;
              }}
              title="Playback speed"
              aria-label="Playback speed"
            >
              {PLAYBACK_RATES.map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
            <button
              className="fv-html-tab fv-fullscreen-btn"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
            </button>
            {popoutBtn}
          </div>
          <div className="fv-media-preview">
            {media === 'video' ? (
              <video
                controls
                preload="metadata"
                src={rawFileContentUrl(filePath, host)}
                ref={(el) => { mediaRef.current = el; if (el) el.playbackRate = playbackRate; }}
                // Some browsers reset playbackRate to 1 once metadata loads — re-apply.
                onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate; }}
              />
            ) : (
              <audio
                controls
                preload="metadata"
                src={rawFileContentUrl(filePath, host)}
                ref={(el) => { mediaRef.current = el; if (el) el.playbackRate = playbackRate; }}
                onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate; }}
              />
            )}
          </div>
        </>
      )}
      {!loading && isRenderable && (
        <div className="fv-html-toolbar">
          <button
            className={`fv-html-tab${!showSource ? ' active' : ''}`}
            // Both tabs are LIVE EDITORS of the same file (rendered doc vs raw
            // bytes), so switching carries the unsaved buffer across — the
            // draft captured here seeds the next editor. No confirm needed.
            onClick={() => switchTab(false)}
          >
            Preview
          </button>
          <button
            className={`fv-html-tab${showSource ? ' active' : ''}`}
            onClick={() => switchTab(true)}
          >
            Source
          </button>
          {editBtns}
          {commonBtns}
          <button
            className="fv-html-tab fv-fullscreen-btn"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
          </button>
          {popoutBtn}
        </div>
      )}
      {/* Non-renderable files (plain code) have no preview/source toolbar — give them
          a minimal one for Save + Download + pop-out. raw kinds/binary render their own. */}
      {!loading && !isRenderable && !raw && !data?.binary && !data?.error && (
        <div className="fv-html-toolbar fv-toolbar-popout-only">{editBtns}{commonBtns}{popoutBtn}</div>
      )}
      {/* Deliberately NOT .file-viewer-error: that class is the whole-pane empty
          state (height:100%, centered), which as a sibling of the editor grew to
          swallow the pane. A save error is a one-line BANNER above the editor. */}
      {saveError && (
        <div className="fv-save-error" role="alert" onClick={() => setSaveError(null)} title="Click to dismiss">
          {saveError}
        </div>
      )}
      {!loading && showPreview && isHtml && (
        <iframe
          ref={htmlFrameRef}
          className="fv-html-preview"
          // `src` (not `srcDoc`) so the page has its OWN document URL — in-page
          // anchors, relative links and scripts resolve against the file itself
          // instead of navigating the Walnut SPA. Files the user explicitly opened
          // are trusted; allow scripts/forms/popups so the page is interactive.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
          src={rawFileContentUrl(filePath, host)}
          title={filePath}
        />
      )}
      {/* Preview tab, files with no WYSIWYG surface: read-only markdown render
          (MDX, truncated markdown). Plain editable markdown never lands here —
          its Preview IS the WYSIWYG editor below. */}
      {!loading && showPreview && isMarkdown && (
        <div className="fv-md-preview markdown-body" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      )}
      {/* THE EDITORS — the default body for every editable file. Keyed on
          path + baseHash + seedNonce so a fresh READ (Refresh / external
          reload) or a Discard remounts onto new bytes — both editors are
          seed-once by design, which is what keeps the caret still while
          typing. A SAVE deliberately does NOT remount (markClean re-baselines
          in place; a remount yanked the caret to line 1 on ⌘S). A tab switch
          remounts (different component) but seeds from the carried draft.
          Preview tab → Notes WYSIWYG (same TipTap as /notes); Source tab and
          plain code → CodeMirror. */}
      {!loading && editing && data?.content != null && (
        editingWysiwyg ? (
          <FileMarkdownEditor
            key={`wys:${filePath}:${baseHash ?? ''}:${seedNonce}`}
            ref={editorRef}
            initialValue={draftRef.current ?? data.content}
            onDirtyChange={setEditorDirty}
            onSave={() => { void handleSave(); }}
            onAskSelection={onSelectCode ? handleAskSelection : undefined}
          />
        ) : (
          <FileSourceEditor
            key={`src:${filePath}:${baseHash ?? ''}:${seedNonce}`}
            ref={editorRef}
            initialValue={draftRef.current ?? data.content}
            path={filePath}
            onDirtyChange={setEditorDirty}
            onSave={() => { void handleSave(); }}
            initialLine={line}
            onSelectText={onSelectCode ? setSelection : undefined}
          />
        )
      )}
      {/* Read-only source (non-editable text: truncated reads etc.). */}
      {!loading && !editing && !showPreview && data?.content != null && data.content !== '' && (
        <pre className="file-viewer-code" dangerouslySetInnerHTML={{ __html: lineNumberedHtml }} />
      )}
      {!loading && !editing && data && !data.error && !data.binary && data.content === '' && (
        <div className="file-viewer-loading">Empty file</div>
      )}
      {!loading && data?.truncated && (
        <div className="file-viewer-truncated">
          Showing first {formatSize(512 * 1024)} of {formatSize(data.size)}
        </div>
      )}
      {revealError && (
        <div className="file-viewer-error fv-reveal-error" role="alert" onClick={clearRevealError} title="Click to dismiss">
          {revealError}
        </div>
      )}
      {selection && (
        <SelectionAskPill
          anchor={selection}
          onCommit={commitSelection}
          onDismiss={() => setSelection(null)}
          resolveRect={resolveSelectionRect}
          listenTo={selection.inHtml ? htmlFrameRef.current?.contentDocument : undefined}
        />
      )}
    </div>
  );
}
