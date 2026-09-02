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
 * same repo in the same second. Unsaved text is still never LOST: every
 * keystroke is mirrored into an IndexedDB draft (@/utils/file-drafts) and
 * replayed when the file is next read. Non-editable files (truncated/binary/raw
 * kinds) keep the read-only views.
 *  - QUOTE: selecting text raises an "Ask about this" pill that prefills the
 *    session chat with a located, code-quoted reference (same affordance and the
 *    same buildSelectionPrefill composer as the Changed tab). In the WYSIWYG
 *    editor the same action lives in the selection bubble menu ("Ask").
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchFileContentConditional, rawFileContentUrl, downloadFileUrl, saveFileContent,
  FileSaveConflictError, type FileContentResponse,
} from '@/api/files';
import {
  getCachedFileContent, setCachedFileContent, storable,
} from '@/cache/filecontent-idb';
import { rawKind, isPlayable, isMarkdownExt } from '@/utils/file-kind';
import { formatSize } from '@/utils/format';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { loadFileScroll, saveFileScroll } from '@/utils/file-view-state';
import {
  saveFileDraft, loadFileDraft, deleteFileDraft, planDraftReplay, planStaleDraftRestore,
} from '@/utils/file-drafts';
import { highlightLines } from '@/utils/code-highlight';
import { vaultRelativeNotePath } from '@/utils/notes-link';
import { useRevealFile } from '@/hooks/useRevealFile';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useConfirm } from '@/hooks/useConfirm';
import { useLiveEdit, type LiveEdit } from '@/hooks/useLiveEdit';
import { useEmbeddedImageFreshness, type EmbeddedImageFreshness } from '@/hooks/useEmbeddedImageFreshness';
import { FileHistoryPanel } from '@/components/common/FileHistoryPanel';
import { ICON_NEW_TAB } from '@/components/common/Icons';
import { FileSourceEditor, type FileSourceEditorHandle } from '@/components/common/FileSourceEditor';
import { FileMarkdownEditor } from '@/components/common/FileMarkdownEditor';
import { SelectionAskPill, selectionClientRect } from '@/components/common/SelectionAskPill';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import {
  DomSearchController, applyHighlights, clearHighlights, collectTextMatches,
  ensureHighlightStyles, wordAtPoint, claimSearchOwner, onSearchOwnerLost, HL_SELMATCH, SYMBOL_RE,
} from '@/utils/dom-text-search';
import { CodeContextMenu, buildCodeContextTarget, type CodeContextTarget } from '@/components/common/CodeContextMenu';
import { copyTextRobust } from '@/utils/clipboard';
import { openPopout } from '@/popout/openPopout';
import { log } from '@/utils/log';
import '@/styles/live-edit.css';

interface FileContentViewProps {
  path: string;
  line?: number;
  /** The keyword the jump landed on (reference panel) — flashed at `line` so
   *  the eye finds the term, not just the row. */
  lineTerm?: string;
  host?: string;
  /**
   * Session whose agent may be writing this file. Only Live Edit uses it: a
   * `session:tool-use`/`tool-result` pair naming this path is the signal to pull
   * the agent's bytes into the editor (merging them when the buffer is dirty)
   * instead of waiting for our own next write to 409. Absent (pop-out, "@"
   * mention preview) → the 409 path still covers every collision.
   */
  sessionId?: string;
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
  /**
   * Cmd/Ctrl+click on an identifier → reference search. When provided, the
   * container (SessionFileExplorer) owns the side panel and the jump; this
   * component only detects the gesture and reports the symbol.
   */
  onSymbolLookup?: (symbol: string, filePath: string, line?: number) => void;
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

/**
 * The office renderers are heavyweight (SheetJS alone ~1MB), so they live in
 * their own chunk that loads on the first office-file click.
 *
 * Deliberately NOT React.lazy + Suspense. A lazy import that REJECTS throws
 * during render, and the nearest boundary here is the session panel's — so a
 * chunk that a deploy replaced under an open tab turned "this docx can't
 * preview" into "Something went wrong loading this session" for the whole
 * panel (2026-08-23, reported from a live session; the same stale-chunk class
 * as the .go-syntax incident). Loading it as state keeps the failure LOCAL: the
 * pane shows a reload prompt, the session keeps working.
 */
type OfficePreviewComponent = typeof import('@/components/common/OfficePreview')['OfficePreview'];

/** Speed steps shared by the toolbar select and the </> keyboard shortcuts. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Keystroke → draft write settle window. Short enough that a click away from
 *  the panel almost always finds nothing pending, long enough that a typing
 *  burst is one write. */
const DRAFT_DEBOUNCE_MS = 400;


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
  path: filePath, line, lineTerm, host, sessionId, hidePopout, reloadToken = 0,
  onSelectCode, onSaved, onSymbolLookup,
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
  // Live Edit reads dirtiness from inside async continuations (a disk pull that
  // resolves mid-typing), so it gets a ref rather than this render's value.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // App-wide themed dialog (never window.confirm — see handleDiscard).
  const confirm = useConfirm();
  const draftRef = useRef<string | null>(null);
  // Bumped by Discard to force a remount back onto the on-disk bytes.
  const [seedNonce, setSeedNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // ── File history ───────────────────────────────────────────────────────────
  // The version timeline for THIS file (Walnut snapshots + git). Stays open across
  // file switches on purpose — the panel refetches for the new path — and
  // `versionsSeen` is bumped by every write we made or adopted, so the list picks
  // up the version just recorded without a remount.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionsSeen, setVersionsSeen] = useState(0);
  // Version folded into every embedded image URL (`&r=`). A byte-identical
  // <img src> is answered from the browser's per-document memory cache with no
  // request (WebKit never re-asks for a URL it already loaded), so a diagram the
  // agent regenerated kept its old pixels until the whole app was reloaded.
  // Seeded per MOUNT so re-opening a file is a new URL; moved forward whenever
  // the pane learns the bytes changed: a re-read that landed different content
  // (the remounted editor paints fresh URLs) and, most of the time, the quiet
  // in-place check below, which swaps a changed <img> and reports the version
  // it used so any later ProseMirror repaint emits that same fresh URL.
  const [imageEpoch, setImageEpoch] = useState(() => Date.now());
  const imageVersion = String(imageEpoch);
  // The in-place checker, reachable from the load effect (declared below, after
  // the refs it needs exist).
  const imageFreshnessRef = useRef<EmbeddedImageFreshness | null>(null);
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

  // ── Unsaved-draft persistence ──────────────────────────────────────────────
  // The dirty buffer used to live ONLY in React state, so leaving the Files
  // panel (or switching files) dropped it silently. Every keystroke now lands in
  // an IndexedDB side record (@/utils/file-drafts) that is replayed on the next
  // read. The file itself is still only ever written by an explicit Save.
  //
  // The pending record carries its OWN identity (host/path/baseHash) and the
  // text captured at keystroke time, because the flush can run after the
  // component has already re-rendered for the NEXT file: by then `editorRef`
  // points at the incoming file's editor, so reading getValue() at flush time
  // would persist (or worse, delete) the wrong file's draft.
  const pendingDraftRef = useRef<
    { host: string | undefined; path: string; text: string; baseHash: string; disk: string | null } | null
  >(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Draft found for a file whose bytes MOVED since it was written — kept out of
  // the editor until the user says which version wins (the banner below). Its own
  // baseHash rides along: restoring it re-arms the lock at THAT hash, which is
  // what turns a later Save into the conflict warning instead of a silent
  // overwrite of the newer file.
  const [staleDraft, setStaleDraft] = useState<{ text: string; baseHash: string } | null>(null);
  // Transient toolbar note after a matching-hash draft was seeded back.
  const [draftRestored, setDraftRestored] = useState(false);

  const cancelDraftTimer = useCallback(() => {
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
  }, []);

  /** Write (or clear) the pending draft now. Returns once storage has settled,
   *  so a read that follows a flush can't observe the pre-flush record. */
  const flushDraft = useCallback((): Promise<void> => {
    cancelDraftTimer();
    const p = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (!p) return Promise.resolve();
    // Typed back to exactly what's on disk ⇒ there is nothing unsaved to keep.
    if (p.disk != null && p.text === p.disk) return deleteFileDraft(p.host, p.path);
    return saveFileDraft(p.host, p.path, { text: p.text, baseHash: p.baseHash });
  }, [cancelDraftTimer]);

  /** Drop the pending draft AND the stored record — save/discard outcomes. */
  const dropDraft = useCallback((forPath: string, forHost: string | undefined) => {
    cancelDraftTimer();
    pendingDraftRef.current = null;
    void deleteFileDraft(forHost, forPath);
  }, [cancelDraftTimer]);

  // The disk bytes the buffer is compared against, as a ref: the capture below
  // runs from an editor callback and must not close over a stale `data`.
  const diskContentRef = useRef<string | null>(null);
  useEffect(() => { diskContentRef.current = data?.content ?? null; }, [data]);

  // ── Live Edit ──────────────────────────────────────────────────────────────
  // The bytes `lockHashRef` refers to — the merge BASE. Kept in step with the
  // lock: set on every read and on every successful write, and set to null when
  // the lock is re-armed at a hash whose bytes we don't have (a restored stale
  // draft), because a merge against a guessed base is data loss.
  const baseContentRef = useRef<string | null>(null);
  // True for the duration of a programmatic setValue. A merge/pull applies text
  // through the same editor callbacks a keystroke does, and without this the
  // pull would immediately auto-write back exactly what it just read.
  const applyingRef = useRef(false);
  // Assigned right after useLiveEdit below. handleDocChange is defined here
  // because it belongs to the draft writer (which predates live mode), so it
  // reaches the hook through a ref instead of forcing the whole component to be
  // reordered around it.
  const liveRef = useRef<LiveEdit | null>(null);

  // Which editor is mounted, as a ref: applyEditorText runs from async
  // continuations and needs to know how the apply will echo (see below).
  const wysiwygRef = useRef(false);

  /** Record the buffer as the pending draft (debounced write to IndexedDB). */
  const captureDraft = useCallback((text: string) => {
    pendingDraftRef.current = {
      host, path: filePath, text, baseHash: lockHashRef.current ?? '', disk: diskContentRef.current,
    };
    cancelDraftTimer();
    draftTimerRef.current = setTimeout(() => { draftTimerRef.current = null; void flushDraft(); }, DRAFT_DEBOUNCE_MS);
  }, [host, filePath, cancelDraftTimer, flushDraft]);

  /** Put text in the live editor without a remount and without arming a write. */
  const applyEditorText = useCallback((text: string) => {
    applyingRef.current = true;
    try {
      editorRef.current?.setValue(text);
    } finally {
      if (wysiwygRef.current) {
        // TipTap's setContent({emitUpdate:false}) emits nothing now, but a late
        // normalization transaction can still arrive — so the flag lives one
        // macrotask for that editor only.
        setTimeout(() => { applyingRef.current = false; }, 0);
      } else {
        // CodeMirror ran its update listener synchronously inside dispatch, so
        // the echo is over. Resetting NOW (not next macrotask) keeps a keystroke
        // that lands in the same tick — IME commit, paste — armed for the write.
        applyingRef.current = false;
      }
    }
    // The draft must follow the buffer whichever editor echoed: the WYSIWYG one
    // deliberately emits nothing for a programmatic apply, so without this a
    // merged buffer left the panel with the PRE-merge text as its saved draft.
    captureDraft(text);
  }, [captureDraft]);

  const handleDocChange = useCallback(() => {
    const text = editorRef.current?.getValue();
    if (text == null) return;
    captureDraft(text);
    // Only a USER edit arms the auto-write (see applyingRef). The draft capture
    // above still runs for a programmatic apply — the record then matches disk,
    // which is how the obsolete draft gets deleted.
    if (!applyingRef.current) liveRef.current?.noteUserEdit();
  }, [captureDraft]);

  // Unmount is the reported failure mode ("left the panel, came back, gone"), so
  // the last keystrokes are flushed rather than dropped with the timer.
  useEffect(() => () => { void flushDraft(); }, [flushDraft]);

  useEffect(() => {
    if (!draftRestored) return;
    const t = setTimeout(() => setDraftRestored(false), 4000);
    return () => clearTimeout(t);
  }, [draftRestored]);

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
  // `office` = the subset rendered by the lazy client-side office libs.
  const office = raw === 'word' || raw === 'sheet' || raw === 'slides' ? raw : null;

  // Office chunk, loaded as STATE so a failed fetch is a pane-local message
  // instead of a render throw that kills the session panel (see the type above).
  const [OfficeComp, setOfficeComp] = useState<OfficePreviewComponent | null>(null);
  const [officeChunkFailed, setOfficeChunkFailed] = useState(false);
  useEffect(() => {
    if (!office || OfficeComp) return;
    let cancelled = false;
    setOfficeChunkFailed(false);
    import('@/components/common/OfficePreview')
      .then((m) => { if (!cancelled) setOfficeComp(() => m.OfficePreview); })
      .catch((err) => {
        if (cancelled) return;
        setOfficeChunkFailed(true);
        // Same signal the app-wide recovery listens for: a chunk that vanished
        // means this tab is running a build the server no longer has.
        log.warn('office-preview', 'office chunk failed to load', {
          path: filePath, error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => { cancelled = true; };
  }, [office, OfficeComp, filePath]);

  // View state (source/preview toggle, fullscreen, speed) belongs to the FILE,
  // not to a reload — a Refresh must not kick you back out of Preview mode.
  // Source-vs-Preview is restored from the last visit to THIS file (same store as
  // the scroll offset) so reopening a file returns you to how you were reading it.
  useEffect(() => {
    setShowSource(loadFileScroll(host, filePath)?.source === true);
    setFullscreen(false);
    setPlaybackRate(1);
    // In-MEMORY draft/dirty state is per-FILE: switching files resets it. The
    // typed text itself is not lost — the cleanup below persists it first, and
    // the read of this file replays it (see the restore block).
    setEditorDirty(false);
    setDraftDirty(false);
    draftRef.current = null;
    // Belongs to the OUTGOING file's lock — the incoming read below sets it.
    baseContentRef.current = null;
    setSaveError(null);
    setStaleDraft(null);
    setDraftRestored(false);
    // Cleanup runs with the OUTGOING file's closure, and before the reset above
    // — so the last keystrokes of the file being left are written under their own
    // path, not the incoming one's.
    return () => { void flushDraft(); };
  }, [filePath, host, flushDraft]);

  // Distinguishes "first load of this file" (blank → spinner) from "Refresh of
  // the file already on screen" (keep content, badge it as reloading).
  const lastTokenRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isReload = lastTokenRef.current !== null && lastTokenRef.current !== reloadToken;
    lastTokenRef.current = reloadToken;
    // What the pane held before this read — a reload compares against it to
    // tell "new bytes" (remount) from "same bytes" (leave the editor alone).
    const lockBefore = lockHashRef.current;
    if (isReload) setReloading(true);
    else { setLoading(true); setData(null); }
    // Media/PDF/images render straight from the raw-bytes URL — no JSON content
    // fetch (which would whole-file-read a potentially huge binary on the remote
    // side, and text-decode bytes that aren't text).
    if (rawKind(filePath)) { setLoading(false); setReloading(false); return; }
    // Land the last keystrokes BEFORE the read that will look for them: a
    // Refresh with a pending write would otherwise restore the previous draft
    // and silently drop the newest characters.
    const flushed = flushDraft();

    /**
     * Everything the pane must become once a read's bytes are known.
     *
     * Runs TWICE for an open that had a cached copy: once `provisional` on the
     * cached bytes (so the pane paints immediately), then once authoritatively
     * when the server has confirmed or replaced them. `provisional` gates only
     * the decisions that DESTROY something — dropping the user's unsaved draft on
     * bytes nobody has confirmed yet would be data loss, and the confirmation is
     * one round trip away.
     */
    const apply = (
      d: FileContentResponse,
      draft: Awaited<ReturnType<typeof loadFileDraft>>,
      opts: { provisional: boolean },
    ) => {
      // ── Replay an unsaved draft ────────────────────────────────────────
      // Refresh no longer means "throw my typing away" (it did, and that was
      // the reported data loss). Discard is the only path that does. A draft
      // written against OLDER bytes is held back for the banner instead:
      // silently replaying over new bytes hides the other writer's work,
      // silently dropping the draft hides the user's.
      // ORDERING: draftRef must hold the seed BEFORE setBaseHash remounts the
      // editor, because the editor seeds from `draftRef.current ?? data.content`
      // at mount. Everything stays in this one continuation so React batches
      // the state changes into a single render.
      const plan = planDraftReplay(draft, { content: d.content, contentHash: d.contentHash });
      // A fresh read supersedes any pending conflict hash, and the lock follows
      // whatever the editor is seeded from. baseHash moves too, remounting any
      // open editor onto the new bytes.
      conflictHashRef.current = undefined;
      lockHashRef.current = plan.lockHash;
      // The lock follows the seed, and the merge base follows the LOCK — which
      // for a replayed draft is still the disk bytes (its baseHash matched), so
      // `d.content` is right in both branches.
      baseContentRef.current = d.content;
      draftRef.current = plan.seed;
      // Edited back to the original ⇒ nothing unsaved left to remember.
      if (plan.drop && !opts.provisional) void deleteFileDraft(host, filePath);
      // Passing the SAME payload object on the confirming pass is deliberate:
      // React bails out on an identical value, so a 304 costs no re-render.
      setData(d);
      setDraftDirty(plan.seed != null);
      setEditorDirty(false);
      setStaleDraft(plan.stale);
      setDraftRestored(plan.seed != null);
      setBaseHash(d.contentHash);
      setLoading(false);
      if (!opts.provisional) setReloading(false);
    };

    void (async () => {
      try {
        // The cached copy and the unsaved draft are both IndexedDB reads and both
        // needed before anything can be painted, so they go together. The draft
        // read still waits for the flush above — that flush is what puts the last
        // keystrokes INTO the record this is about to read.
        const [cached, draft] = await Promise.all([
          getCachedFileContent(host, filePath),
          (async () => { await flushed; return loadFileDraft(host, filePath); })(),
        ]);
        if (cancelled) return;

        // A copy we already have paints NOW, before the network is consulted.
        // Skipped on a Refresh: the pane is already showing content, so there is
        // no blank to fill, and re-seeding the editor from cache would be a
        // remount the user did not ask for.
        const cachedPayload: FileContentResponse | null = cached
          ? {
            content: cached.content,
            size: cached.size,
            truncated: false,
            binary: false,
            extension: cached.extension,
            contentHash: cached.contentHash,
          }
          : null;
        if (cachedPayload && !isReload) apply(cachedPayload, draft, { provisional: true });

        // `If-None-Match` is what turns "re-open an unchanged file" into a header
        // exchange: 304 means the bytes we just painted ARE the bytes on disk, so
        // nothing is transferred (for a remote file, nothing crosses the tunnel).
        // `track: 'baseline'` still records what this open found as the file's
        // "Opened" version — an edit is only undoable if the pre-edit state was
        // kept — and the server dedupes by hash, so re-opens add nothing.
        const res = await fetchFileContentConditional(filePath, host, {
          ...(cached ? { ifNoneMatch: cached.contentHash } : {}),
          track: 'baseline',
        });
        if (cancelled) return;

        if (res.notModified && cachedPayload) {
          // The cached bytes were right. Re-run with the same object so the draft
          // bookkeeping becomes authoritative without costing a render.
          apply(cachedPayload, draft, { provisional: false });
          if (isReload) void imageFreshnessRef.current?.checkNow();
          return;
        }

        // A 304 we have no bytes for is nobody's contract (a proxy, a stale tab
        // whose cache entry was evicted between the two steps). Ask again without
        // the validator rather than showing an error for a file that exists.
        const d = res.notModified
          ? (await fetchFileContentConditional(filePath, host, { track: 'baseline' })).payload
          : res.payload;
        if (cancelled) return;
        if (!d) throw new Error('Empty response from file-content');
        apply(d, draft, { provisional: false });
        if (storable(d)) void setCachedFileContent(host, filePath, d);
        if (isReload) {
          if (d.contentHash !== lockBefore) {
            // New bytes remount the editor; give the repaint fresh image URLs.
            setImageEpoch(Date.now());
          } else {
            // Same bytes, no remount, nothing repaints — so the pictures are
            // checked where they stand. This is what makes Refresh work for
            // "the diagram changed but the text did not" WITHOUT disturbing the
            // editor (caret, scroll, selection all stay).
            void imageFreshnessRef.current?.checkNow();
          }
        }
      } catch (err) {
        if (cancelled) return;
        setData({
          content: null, size: 0, truncated: false, binary: false,
          error: err instanceof Error ? err.message : String(err),
          extension: '',
        });
      } finally {
        if (!cancelled) { setLoading(false); setReloading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, host, reloadToken, flushDraft]);

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
  wysiwygRef.current = editingWysiwyg;
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

  /**
   * Everything that must become true once bytes are on disk. Shared by the
   * explicit Save and by Live Edit's auto-write — they differ only in what put
   * the bytes there, so a divergence here would mean one of the two paths
   * leaving a stale lock, a stale draft or a stuck dirty dot behind.
   */
  /**
   * Remember bytes we KNOW are on disk, so the next open of this file paints from
   * disk-truthful cache and its conditional read answers 304. Called from every
   * path that learns the file's current bytes: our own writes (explicit Save and
   * Live Edit alike) and another writer's bytes once we have read them. Without
   * this, every write would leave the cached copy stale and the next open would
   * flash the pre-write text before correcting itself.
   */
  const noteBytesOnDisk = useCallback((content: string, contentHash: string, size: number) => {
    const base = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    void setCachedFileContent(host, filePath, {
      content, size, contentHash, truncated: false, binary: false,
      extension: dot > 0 ? base.slice(dot + 1).toLowerCase() : '',
    });
  }, [filePath, host]);

  const applySaved = useCallback((
    text: string,
    res: { size: number; contentHash: string },
    opts: { live?: boolean } = {},
  ) => {
    // Advance the lock token WITHOUT remounting the editor (baseHash stays): a
    // remount reseeds the doc and yanks the caret/scroll to the top, which made
    // every ⌘S mid-document a jump-to-line-1. markClean re-baselines dirty
    // tracking in place instead.
    conflictHashRef.current = undefined;
    lockHashRef.current = res.contentHash;
    baseContentRef.current = text;
    // Before the early return below: whatever the buffer does next, `text` IS
    // what the server just accepted onto disk.
    noteBytesOnDisk(text, res.contentHash, res.size);
    setData((prev) => (prev ? { ...prev, content: text, size: res.size, contentHash: res.contentHash } : prev));
    setStaleDraft(null);
    setDraftRestored(false);
    // History refetches per version; a live burst is one coalesced version on the
    // server, so refetching (two git spawns) per typing pause would be noise.
    if (!opts.live) setVersionsSeen((n) => n + 1);
    // What is on disk is `text`. If the buffer has ALREADY moved on (a keystroke
    // landed while the write was in flight — routine in live mode, where every
    // pause is a write), the file is still dirty by exactly that much, and the
    // draft record holding the newer text is the only backup of it. markClean
    // here would re-baseline the editor onto the NEWER text (dirty dot off, Save
    // disabled, beforeunload guard off) and dropDraft would delete that backup —
    // the characters would then exist only in the buffer, invisibly unsaved.
    const buffer = editorRef.current?.getValue();
    if (buffer != null && buffer !== text) return;
    editorRef.current?.markClean();
    draftRef.current = null;
    // The bytes are on disk now, so the side record is obsolete. Cancelling the
    // pending capture matters as much as the delete: a timer that fired after
    // this would resurrect the draft for text that is no longer unsaved.
    dropDraft(filePath, host);
    setDraftDirty(false);
    setEditorDirty(false);
  }, [dropDraft, filePath, host, noteBytesOnDisk]);

  /** New disk bytes were read while the buffer stays dirty (a merge, or a
   *  collision we could not fold in). The pane's idea of "what is on disk" must
   *  follow, but the editor is NOT remounted — baseHash deliberately stays. */
  const applyDiskContent = useCallback((content: string, contentHash: string, size: number) => {
    diskContentRef.current = content;
    noteBytesOnDisk(content, contentHash, size);
    setData((prev) => (prev ? { ...prev, content, size, contentHash } : prev));
  }, [noteBytesOnDisk]);

  /** Another writer's bytes are now in the editor and nothing is unsaved. */
  const applyAdopted = useCallback((content: string, contentHash: string, size: number) => {
    applyDiskContent(content, contentHash, size);
    editorRef.current?.markClean();
    draftRef.current = null;
    dropDraft(filePath, host);
    setDraftDirty(false);
    setEditorDirty(false);
    setStaleDraft(null);
    setDraftRestored(false);
    // The pull that brought these bytes recorded them as an `agent` version.
    setVersionsSeen((n) => n + 1);
    // The same writer very likely regenerated the pictures the text refers to;
    // they are checked where they stand (no remount happened for the text).
    void imageFreshnessRef.current?.checkNow();
  }, [applyDiskContent, dropDraft, filePath, host]);

  /**
   * Put a version from the History panel into the editor as UNSAVED work. Same
   * remount-with-draft pattern as restoreStaleDraft: the editor re-seeds from the
   * chosen text and reports dirty, so Save is armed and Discard still means "back
   * to disk". The lock is NOT touched — it still names the bytes on disk, which is
   * exactly the base a later merge or conflict check needs. Nothing is written
   * here; the user saves when they are happy (or live mode does on the next edit).
   */
  const restoreHistoryVersion = useCallback((content: string, label: string) => {
    liveRef.current?.cancelPending();
    draftRef.current = content;
    setDraftDirty(true);
    setSaveError(null);
    setSeedNonce((n) => n + 1);
    // Persist it as a draft right away: a restore followed by leaving the panel
    // must come back, exactly like typing would.
    pendingDraftRef.current = {
      host, path: filePath, text: content, baseHash: lockHashRef.current ?? '', disk: diskContentRef.current,
    };
    void flushDraft();
    log.info('file-editor', 'restored a version into the editor', { path: filePath, host, version: label });
  }, [filePath, host, flushDraft]);

  // Embedded pictures follow the disk on their own — see the hook's header. Runs
  // for every rendered pane (WYSIWYG, read-only markdown, HTML preview), not just
  // editable ones: a picture you are only looking at goes stale the same way.
  const imageFreshness = useEmbeddedImageFreshness({
    rootRef: contentRef,
    enabled: !loading && !raw && data?.content != null,
    sessionId,
    fileKey: `${host ?? ''}\0${filePath}`,
    onChanged: (version) => setImageEpoch(version),
  });
  imageFreshnessRef.current = imageFreshness;

  const live = useLiveEdit({
    path: filePath,
    host,
    sessionId,
    canEdit,
    getText: () => editorRef.current?.getValue() ?? null,
    applyText: applyEditorText,
    lockHashRef,
    baseContentRef,
    isDirtyRef: dirtyRef,
    onWrote: (text, res) => {
      applySaved(text, res, { live: true });
      log.info('file-editor', 'live write saved', { path: filePath, host, size: res.size });
      onSaved?.(filePath);
    },
    onAdopted: applyAdopted,
    onDiskContent: applyDiskContent,
    onConflict: (message, overwriteHash) => {
      // Same contract as handleSave's 409 branch: the buffer is left alone and
      // the editor is NOT remounted (that would replace the user's unsaved work
      // with the pre-edit text). `overwriteHash` is only set when a write was
      // actually attempted, so the warn-once gate is never skipped.
      if (overwriteHash) conflictHashRef.current = overwriteHash;
      setSaveError(message);
    },
    onError: setSaveError,
  });
  liveRef.current = live;

  const handleSave = useCallback(async () => {
    const text = editorRef.current?.getValue();
    if (text == null) return;
    // An explicit Save IS the flush — a queued auto-write would otherwise fire
    // right behind it against a lock token this save has already spent.
    liveRef.current?.cancelPending();
    setSaving(true);
    setSaveError(null);
    try {
      // A pending conflict hash wins: pressing Save after a conflict IS the
      // user's "overwrite it with mine" decision, so send the hash the server
      // just told us is current rather than the stale seed hash (which would
      // 409 forever).
      const expectedHash = conflictHashRef.current ?? lockHashRef.current;
      const res = await saveFileContent(filePath, text, { host, expectedHash, writer: 'user' });
      applySaved(text, res);
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
  }, [filePath, host, onSaved, applySaved]);

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
    // Discard is the ONLY path that deliberately throws typed text away, so it
    // is also the only one that deletes the persisted copy.
    dropDraft(filePath, host);
    setDraftDirty(false);
    setEditorDirty(false);
    setSaveError(null);
    setStaleDraft(null);
    setDraftRestored(false);
    conflictHashRef.current = undefined;
    setSeedNonce((n) => n + 1);
  }, [confirm, dropDraft, filePath, host]);

  // Stale-draft banner, "Restore my changes": seed the editor from the draft and
  // remount — and RE-ARM the lock at the draft's own baseHash (planStaleDraftRestore).
  // Leaving the lock on the CURRENT disk hash made the next ⌘S a silent overwrite
  // of bytes the user has never seen: type, the session's agent rewrites the file,
  // Refresh, "Restore my changes", ⌘S — and the agent's work was gone with no 409
  // and no warning. Now that Save takes the existing conflict path, which spells
  // out the overwrite and needs a second press.
  const restoreStaleDraft = useCallback(() => {
    if (staleDraft == null) return;
    const { seed, lockHash } = planStaleDraftRestore(staleDraft);
    draftRef.current = seed;
    lockHashRef.current = lockHash;
    // The lock now points at bytes we no longer hold, so there is no trustworthy
    // merge BASE any more. Live Edit reads null as "don't merge, ask the human"
    // — merging against the wrong base is how the other writer's work vanishes.
    baseContentRef.current = null;
    conflictHashRef.current = undefined;
    setDraftDirty(true);
    setSeedNonce((n) => n + 1);
    setStaleDraft(null);
  }, [staleDraft]);

  const discardStaleDraft = useCallback(() => {
    dropDraft(filePath, host);
    setStaleDraft(null);
  }, [dropDraft, filePath, host]);

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
    // LEAVE FULLSCREEN: the fullscreen shell is a fixed inset:0 overlay at
    // z-index 10000, so it covers the composer the prefill just landed in. The
    // focus/caret were actually correct, but the user saw an unchanged file and
    // read it as "the button did nothing" (2026-08-13 report). Asking is a
    // move-to-the-chat action, so the reading overlay steps aside.
    setFullscreen(false);
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
    setFullscreen(false); // same reason as commitSelection: uncover the composer
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

  // ── HTML preview scroll memory ─────────────────────────────────────────────
  // The HTML preview scrolls inside its IFRAME's own document, so the parent-
  // document capture listener above never hears it and the chase can't reach its
  // scroller — HTML files were the one text kind that never remembered their
  // position. The frame is same-origin by construction (we serve the bytes), so
  // save/restore happen inside the frame itself. Restore re-runs on EVERY load
  // (unlike the md latch): each load is a fresh document parked at the top, so
  // re-applying the offset is a resume, not a mid-read yank. PDFs stay out —
  // the browser's PDF viewer document is a closed plugin, not scriptable.
  useEffect(() => {
    if (!htmlPreviewLive) return;
    const frame = htmlFrameRef.current;
    if (!frame) return;
    const key = `${host ?? 'local'} ${filePath}`;
    let win: Window | null = null;
    let raf = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let chaseTop: number | null = null;
    let lastSetTop = -1;
    let chaseDeadline = 0;

    const onFrameScroll = () => {
      if (!win) return;
      const top = win.scrollY;
      // A scroll that isn't the echo of our own set = the user took over.
      if (chaseTop != null && Math.abs(top - lastSetTop) > 1) chaseTop = null;
      lastSeenRef.current = { key, top };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const seen = lastSeenRef.current;
        if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top });
      }, 250);
    };

    // Chase across frames, same reason as the outer restore: the page may still
    // be laying out (scripts, images) so a one-shot set clamps against a
    // fraction of the final height and long pages "resume" near the top.
    const tick = () => {
      if (chaseTop != null && win) {
        const doc = win.document.scrollingElement ?? win.document.documentElement;
        if (doc) {
          const max = doc.scrollHeight - win.innerHeight;
          const top = Math.max(0, Math.min(chaseTop, max));
          if (Math.abs(win.scrollY - top) > 1) {
            lastSetTop = top;
            win.scrollTo(0, top);
            lastSeenRef.current = { key, top };
          }
          if (max >= chaseTop) chaseTop = null;
        }
      }
      if (chaseTop != null && Date.now() < chaseDeadline) raf = requestAnimationFrame(tick);
    };

    const attach = () => {
      // Cross-origin navigation inside the preview throws — no memory then.
      try { win = frame.contentWindow; } catch { win = null; return; }
      if (!win) return;
      win.removeEventListener('scroll', onFrameScroll); // load+readyState can both fire
      win.addEventListener('scroll', onFrameScroll, { passive: true });
      const saved = line ? null : loadFileScroll(host, filePath);
      if (saved && saved.top > 0) {
        chaseTop = saved.top;
        chaseDeadline = Date.now() + 5000;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      }
    };
    frame.addEventListener('load', attach);
    if (frame.contentDocument?.readyState === 'complete') attach();
    return () => {
      frame.removeEventListener('load', attach);
      try { win?.removeEventListener('scroll', onFrameScroll); } catch { /* frame gone */ }
      cancelAnimationFrame(raf);
      clearTimeout(saveTimer);
      // Flush the last LIVE value — the debounce would drop the final position
      // when the panel closes (and the detached frame reads 0 by then).
      const seen = lastSeenRef.current;
      if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top });
    };
  }, [htmlPreviewLive, filePath, host, line]);

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

  // ── In-file search (⌘F) ────────────────────────────────────────────────────
  // ONE search bar for every render mode. The CodeMirror surface searches via
  // the editor handle (decorations); every DOM surface (markdown preview,
  // WYSIWYG, read-only <pre>, HTML iframe) via DomSearchController, which
  // paints with the CSS Custom Highlight API — no DOM mutation, so refractor
  // spans and the live TipTap doc are never corrupted.
  const [searchOpen, setSearchOpen] = useState(false);
  // Identity for the single-owner arbitration of the global highlight registry.
  const searchTokenRef = useRef(`fv-${Math.random().toString(36).slice(2)}`);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchStatus, setSearchStatus] = useState({ count: 0, index: 0 });
  const domSearchRef = useRef<{ root: HTMLElement; ctrl: DomSearchController } | null>(null);

  /** The DOM body that hosts text in the CURRENT render mode (null for CM). */
  const resolveDomSearchTarget = useCallback((): { root: HTMLElement; win: Window; scrollWindow: boolean } | null => {
    const rootEl = contentRef.current;
    if (!rootEl) return null;
    if (!loading && !showSource && isHtml) {
      const frame = htmlFrameRef.current;
      let doc: Document | null = null;
      try { doc = frame?.contentDocument ?? null; } catch { doc = null; }
      const win = frame?.contentWindow;
      if (doc?.body && win) {
        ensureHighlightStyles(doc);
        return { root: doc.body, win, scrollWindow: true };
      }
      return null;
    }
    const body = rootEl.querySelector<HTMLElement>('.fv-wysiwyg-editor, .fv-md-preview, .file-viewer-code');
    return body ? { root: body, win: window, scrollWindow: false } : null;
  }, [loading, showSource, isHtml]);

  const domSearchCtrl = useCallback((): DomSearchController | null => {
    const target = resolveDomSearchTarget();
    if (!target) return null;
    if (domSearchRef.current?.root !== target.root) {
      domSearchRef.current?.ctrl.close();
      domSearchRef.current = { root: target.root, ctrl: new DomSearchController(target.root, target.win, target.scrollWindow) };
    }
    return domSearchRef.current.ctrl;
  }, [resolveDomSearchTarget]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchStatus({ count: 0, index: 0 });
    editorRef.current?.searchClose?.();
    domSearchRef.current?.ctrl.close();
    domSearchRef.current = null;
  }, []);

  /** Open the bar and claim the highlight registry (closing any other one). */
  const openSearch = useCallback(() => {
    claimSearchOwner(searchTokenRef.current);
    setSearchOpen(true);
  }, []);

  // Another viewer claimed the registry — close our bar rather than sit there
  // showing a count for highlights that are no longer painted. Subscribed
  // UNCONDITIONALLY: when one ⌘F reaches two surfaces, both claim before
  // either's searchOpen commits — an open-gated listener would miss the loss
  // and leave two bars fighting over the one highlight registry.
  useEffect(() => onSearchOwnerLost(searchTokenRef.current, closeSearch), [closeSearch]);

  // Re-run the search when the query/case/surface changes. Debounced: the DOM
  // pass re-walks every text node, which a fast typist shouldn't pay per key.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      if (editingSource) {
        setSearchStatus(editorRef.current?.searchUpdate?.(searchQuery, searchCase) ?? { count: 0, index: 0 });
      } else {
        const ctrl = domSearchCtrl();
        setSearchStatus(ctrl ? ctrl.update(searchQuery, searchCase) : { count: 0, index: 0 });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, searchCase, editingSource, domSearchCtrl, data]);

  const handleSearchNav = useCallback((dir: 1 | -1) => {
    if (editingSource) {
      setSearchStatus(editorRef.current?.searchNav?.(dir) ?? { count: 0, index: 0 });
    } else {
      const ctrl = domSearchCtrl();
      setSearchStatus(ctrl ? ctrl.nav(dir) : { count: 0, index: 0 });
    }
  }, [editingSource, domSearchCtrl]);

  // Search state belongs to the FILE — switching files drops it.
  useEffect(() => () => { closeSearch(); }, [filePath, closeSearch]);

  // ⌘F opens the bar. Capture phase so it beats CodeMirror and the browser's
  // native find. Guards: skip inputs outside this view; when several viewers
  // are mounted (session panel + overlay), only the focused/overlay one reacts.
  useEffect(() => {
    if (raw || data?.binary) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      const el = contentRef.current;
      if (!el) return;
      const t = e.target as HTMLElement | null;
      const inside = t ? el.contains(t) : false;
      if (!inside) {
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (document.querySelectorAll('.file-content-view').length > 1
          && !el.contains(document.activeElement)
          && !el.closest('.file-viewer-overlay') && !fullscreen) return;
      }
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [raw, data?.binary, fullscreen]);

  // ── Select → highlight every exact match ───────────────────────────────────
  // DOM surfaces only: CodeMirror already does this via highlightSelectionMatches.
  // Painted with the Highlight API under the browser's own selection paint.
  const refreshSelectionMatches = useCallback(() => {
    const rootEl = contentRef.current;
    if (!rootEl) return;
    const body = rootEl.querySelector<HTMLElement>('.fv-wysiwyg-editor, .fv-md-preview, .file-viewer-code');
    if (!body) return;
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString() : '';
    const t = text.trim();
    if (!t || t.length < 3 || t.length > 200 || t.includes('\n')
      || !sel || !body.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      clearHighlights(window, HL_SELMATCH);
      return;
    }
    applyHighlights(window, HL_SELMATCH, collectTextMatches(body, t, true, 2000));
  }, []);
  useEffect(() => () => { clearHighlights(window, HL_SELMATCH); }, [filePath]);

  // ── Cmd/Ctrl+click → reference lookup (DOM surfaces) ───────────────────────
  // CodeMirror detects its own (virtualized DOM — see FileSourceEditor); this
  // covers the read-only <pre>, markdown preview, and WYSIWYG surfaces.
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    // metaKey only on Apple platforms: there ctrl+click IS the context-menu
    // gesture — accepting it would fire a lookup AND open the menu in one click.
    const lookupKey = /Mac|iP/.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey;
    if (!onSymbolLookup || !lookupKey || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.fv-source-editor')) return; // CM owns its clicks
    // Cheap containment check FIRST: caretPositionFromPoint hit-tests the whole
    // document, so a portalled overlay over the click would otherwise resolve a
    // word that isn't ours (and preventDefault would eat the user's real click).
    if (!contentRef.current?.contains(t)) return;
    const hit = wordAtPoint(document, e.clientX, e.clientY);
    if (!hit || !contentRef.current?.contains(hit.node)) return;
    // Resolve a line where per-line anchors exist (read-only source rows).
    let lineNum: number | undefined;
    let node: Node | null = hit.node;
    while (node && node !== contentRef.current) {
      if (node instanceof HTMLElement) {
        const ln = node.getAttribute('data-line');
        if (ln) { const n = Number(ln); if (!Number.isNaN(n)) { lineNum = n; break; } }
      }
      node = node.parentNode;
    }
    e.preventDefault();
    onSymbolLookup(hit.word, filePath, lineNum);
  }, [onSymbolLookup, filePath]);

  // Shared by CodeMirror's cmd+click AND the context menu's "Find references"
  // (same action, optional line from the menu path).
  const handleCmSymbolClick = useCallback((symbol: string, lineNum?: number) => {
    onSymbolLookup?.(symbol, filePath, lineNum);
  }, [onSymbolLookup, filePath]);

  // ── Right-click → code context menu ─────────────────────────────────────────
  // Replaces the browser menu ONLY when we have something to offer (a selection
  // or an identifier under the pointer) — otherwise the native menu opens.
  const [ctxTarget, setCtxTarget] = useState<CodeContextTarget | null>(null);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const rootEl = contentRef.current;
    if (!rootEl) return;
    const t = e.target as HTMLElement;
    // Editors' own chrome + form fields keep their native menus.
    if (t.closest('input, textarea, .fv-html-toolbar, .fv-search-bar')) return;
    const target = buildCodeContextTarget(e, rootEl, wordAtPoint, SYMBOL_RE, (node) => {
      let n: Node | null = node;
      while (n && n !== rootEl) {
        if (n instanceof HTMLElement) {
          const ln = n.getAttribute('data-line');
          if (ln) { const v = Number(ln); if (!Number.isNaN(v)) return v; }
        }
        n = n.parentNode;
      }
      return undefined;
    });
    if (!target) return;
    e.preventDefault();
    setCtxTarget(target);
  }, []);
  // File switch invalidates the menu's captured context.
  useEffect(() => { setCtxTarget(null); }, [filePath]);
  const copySelection = useCallback((text: string) => {
    // copyTextRobust: plain-HTTP LAN access has no navigator.clipboard —
    // the execCommand fallback is what makes Copy work there.
    void copyTextRobust(text);
  }, []);
  const askFromMenu = useCallback((text: string, lineNum?: number) => {
    onSelectCode?.(filePath, lineNum, text);
  }, [onSelectCode, filePath]);
  const findInFileFromMenu = useCallback((q: string) => {
    openSearch();
    setSearchQuery(q);
  }, [openSearch]);

  // Reference-jump within the SAME open file: the editor doesn't remount when
  // only `line` changes (key is path+hash), so scroll it imperatively — and
  // flash the landed-on term so the eye finds the keyword, not just the row.
  // baseHash is a dep on purpose: a cross-file jump mounts the editor once for
  // the fetch, then REMOUNTS it when the read lands (the key includes the
  // hash) — a flash applied to the first instance dies with it. Re-running
  // after the final remount is what makes the landing flash actually visible.
  useEffect(() => {
    if (!line || !editingSource) return;
    editorRef.current?.scrollToLine?.(line, lineTerm);
  }, [line, lineTerm, editingSource, data, baseHash]);

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

  /** Live Edit toggle. A pill with a dot rather than a labelled checkbox: it sits
   *  in a dense toolbar, and the dot is what makes its state readable at a
   *  glance. Preference is global; a conflict pauses it per FILE, which is why
   *  the paused title says "click to resume" instead of "turn on". */
  const liveToggle = !canEdit || !editing ? null : (
    <button
      type="button"
      className={`fv-html-tab fv-live-toggle${live.on ? ' active' : ''}${live.suspended ? ' fv-live-suspended' : ''}`}
      onClick={live.toggle}
      aria-pressed={live.on}
      title={live.suspended
        ? 'Live edit paused for this file after a conflict — click to resume'
        : live.on
          ? 'Live edit is ON — your changes are written to disk shortly after you stop typing. Click to turn it off.'
          : 'Live edit is off — changes are written only when you press Save. Click to write as you type.'}
    >
      <span className="fv-live-dot" aria-hidden="true">●</span>
      Live
    </button>
  );

  /** Versions of THIS file. Sits with the edit controls because restoring one is
   *  an edit (it lands in the buffer unsaved), not a navigation. */
  const historyBtn = !canEdit || !editing ? null : (
    <button
      type="button"
      className={`fv-html-tab fv-history-btn${historyOpen ? ' active' : ''}`}
      onClick={() => setHistoryOpen((o) => !o)}
      aria-pressed={historyOpen}
      title="Versions of this file — Walnut's snapshots of your opens and saves, plus git commits"
    >
      History
    </button>
  );

  /** Save / Discard cluster. The editor is always live for editable files, so
   *  these are always present there — Save disabled until something changed. */
  const editBtns = !canEdit || !editing ? null : (
    <>
      {liveToggle}
      {historyBtn}
      <button
        type="button"
        className="fv-html-tab fv-save-btn"
        onClick={() => { void handleSave(); }}
        disabled={saving || !dirty}
        title={dirty ? 'Save changes (⌘S)' : 'No changes to save'}
      >
        {/* An auto-write borrows this slot: the user should see that a write is
            happening in the place they already look for save state. */}
        {saving || live.writing ? 'Saving…' : savedFlash ? '✓ Saved' : 'Save'}
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
      {draftRestored && (
        <span
          className="fv-draft-note"
          role="status"
          title="Your unsaved changes were restored from this browser's draft store. They are still unsaved."
        >
          Draft restored
        </span>
      )}
      {/* Live Edit receipt: something arrived from another writer and was folded
          in. Transient (4s) and one line — it reports, it doesn't ask. */}
      {live.receipt && (
        <span className="fv-draft-note fv-live-receipt" role="status">{live.receipt}</span>
      )}
    </>
  );

  const labelsVersion = useEntityLabelsVersion();
  const markdownHtml = useMemo(() => {
    if (!isMarkdown || !data?.content) return '';
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : undefined;
    return renderMarkdownWithRefs(data.content, dir, host, { imageVersion });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
  }, [isMarkdown, data, host, filePath, labelsVersion, imageVersion]);

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

  /** Find button — same affordance as ⌘F, for mouse-first users. */
  const findBtn = !raw && !data?.binary && !data?.error ? (
    <button
      type="button"
      className={`fv-html-tab fv-find-btn${searchOpen ? ' active' : ''}`}
      onClick={() => (searchOpen ? closeSearch() : openSearch())}
      title="Find in file (⌘F)"
    >
      Find
    </button>
  ) : null;

  /** Toolbar tail every render mode shares. */
  const commonBtns = (
    <>
      {findBtn}
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
      // so this handler is off while an editor owns the body. Selection-match
      // highlighting listens on every DOM surface (CM paints its own).
      onMouseUp={(e) => {
        refreshSelectionMatches();
        if (onSelectCode && !editing) handleMouseUp(e);
      }}
      // Cmd/Ctrl+click identifier → references (DOM surfaces; CM self-detects).
      onMouseDown={onSymbolLookup ? handleContainerMouseDown : undefined}
      // Focus leaving an EDITOR lands a pending Live Edit write now instead of
      // waiting out the debounce. React's onBlur is focusout, so it hears the
      // editors' inner contenteditable; the closest() check keeps a hop between
      // toolbar buttons from counting as leaving the buffer.
      onBlur={(e) => {
        const from = e.target as HTMLElement | null;
        if (from?.closest?.('.fv-source-editor, .fv-wysiwyg-editor')) live.flushNow();
      }}
      // Right-click → our code menu (Copy / Ask / Find references / Find in file).
      // raw/binary keep the browser menu on purpose: images and PDFs need
      // "Save image as…" / the PDF viewer's own items, which ours can't offer.
      onContextMenu={!raw && !data?.binary ? handleContextMenu : undefined}
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
            src={rawFileContentUrl(filePath, host, reloadToken)}
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
            <img src={rawFileContentUrl(filePath, host, reloadToken)} alt={filePath} />
          </div>
        </>
      )}
      {/* Office documents (docx/xlsx/pptx…): read-only client-side render by
          lazy-loaded open-source libs, fed from the same raw-bytes URL. */}
      {!loading && office && (
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
          {officeChunkFailed ? (
            <div className="fv-office-preview" data-testid="office-chunk-error">
              <div className="file-viewer-error">
                The document preview couldn’t load because this page is running an
                older version of the app (a deploy replaced it).
                {' '}
                <button type="button" className="fv-html-tab" onClick={() => window.location.reload()}>
                  Reload the page
                </button>
                {' '}
                or use Download to open the file locally.
              </div>
            </div>
          ) : OfficeComp ? (
            <OfficeComp path={filePath} host={host} kind={office} reloadToken={reloadToken} />
          ) : (
            <div className="file-viewer-loading">Loading preview…</div>
          )}
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
                src={rawFileContentUrl(filePath, host, reloadToken)}
                ref={(el) => { mediaRef.current = el; if (el) el.playbackRate = playbackRate; }}
                // Some browsers reset playbackRate to 1 once metadata loads — re-apply.
                onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate; }}
              />
            ) : (
              <audio
                controls
                preload="metadata"
                src={rawFileContentUrl(filePath, host, reloadToken)}
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
      {/* A draft written against OLDER bytes. Non-transient on purpose: both the
          user's text and whatever landed on disk are real work, so this waits
          for a decision instead of picking a winner. */}
      {staleDraft != null && (
        <div className="fv-draft-banner" role="status">
          <span>You have unsaved changes to this file from an older version of it on disk.</span>
          <button
            type="button"
            className="fv-html-tab"
            onClick={restoreStaleDraft}
            title="Put your unsaved text back in the editor. The copy on disk is newer, so Save will warn you before it replaces that version."
          >
            Restore my changes
          </button>
          <button type="button" className="fv-html-tab" onClick={discardStaleDraft}>
            Discard draft
          </button>
        </div>
      )}
      {searchOpen && (
        <FileSearchBar
          query={searchQuery}
          caseSensitive={searchCase}
          count={searchStatus.count}
          index={searchStatus.index}
          onQueryChange={setSearchQuery}
          onToggleCase={() => setSearchCase((c) => !c)}
          onNav={handleSearchNav}
          onClose={closeSearch}
        />
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
          // reloadToken rides the URL: same-src iframes are never re-navigated,
          // which made Refresh a silent no-op on the rendered HTML preview.
          src={rawFileContentUrl(filePath, host, reloadToken)}
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
            path={filePath}
            host={host}
            imageVersion={imageVersion}
            onDirtyChange={setEditorDirty}
            onDocChange={handleDocChange}
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
            onDocChange={handleDocChange}
            onSave={() => { void handleSave(); }}
            initialLine={line}
            initialFlashTerm={lineTerm}
            onSelectText={onSelectCode ? setSelection : undefined}
            onSymbolClick={onSymbolLookup ? handleCmSymbolClick : undefined}
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
      {/* History flyout: overlays part of the pane (bottom drawer; side panel in
          fullscreen) rather than joining the flex column, so the editor keeps its
          size and scroll position while versions are compared. ✕ or the toolbar button closes it. */}
      {historyOpen && canEdit && editing && !loading && (
        <div className="fv-history-flyout" data-testid="file-history-flyout">
          <FileHistoryPanel
            path={filePath}
            host={host}
            currentText={() => editorRef.current?.getValue() ?? data?.content ?? ''}
            onRestore={restoreHistoryVersion}
            onClose={() => setHistoryOpen(false)}
            refreshToken={versionsSeen}
          />
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
      {ctxTarget && (
        <CodeContextMenu
          target={ctxTarget}
          onClose={() => setCtxTarget(null)}
          onCopy={copySelection}
          onAsk={onSelectCode ? askFromMenu : undefined}
          onFindReferences={onSymbolLookup ? handleCmSymbolClick : undefined}
          onFindInFile={findInFileFromMenu}
        />
      )}
    </div>
  );
}
