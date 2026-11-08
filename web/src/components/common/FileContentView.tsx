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
import { shownFolderName } from '@/utils/home-folder';
import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileAskNotice } from '@/components/common/FileAskNotice';
import { useSelectionMatches } from '@/hooks/useSelectionMatches';
import { stableHtml } from '@/hooks/useStableHtml';
import { useNavigate } from 'react-router-dom';
import {
  fetchFileContent, fetchFileContentConditional, rawFileContentUrl, downloadFileUrl, saveFileContent,
  FileSaveConflictError, FileReadError, isNetworkFetchError, isComingBackCode, isWalnutUnreachable, WALNUT_UNREACHABLE_CODE, type FileContentResponse,
} from '@/api/files';
import { visibleInterval } from '@/utils/page-visibility';
import {
  getCachedFileContent, setCachedFileContent, storable,
} from '@/cache/filecontent-idb';
import {
  fileDocKey, noteDocKey, subscribeDocSaved, wasSavedHere, type DocSavedSignal,
} from '@/stores/file-save-signal';
import { useEvent } from '@/hooks/useWebSocket';
import { useSessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { DocCommentsLayer, type DocCommentsHandle } from '@/components/common/DocCommentsLayer';
import { isSidecarPath } from '@/utils/doc-comments';
import { rawKind, isPlayable, isMarkdownExt } from '@/utils/file-kind';
import { formatSize } from '@/utils/format';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { loadFileScroll } from '@/utils/file-view-state';
import {
  saveFileDraft, loadFileDraft, deleteFileDraft, planDraftReplay, planStaleDraftRestore, stashFileDraftSync,
} from '@/utils/file-drafts';
import { highlightLines } from '@/utils/code-highlight';
import { computeContentHashClient } from '@/utils/content-hash';
import { vaultRelativeNotePath } from '@/utils/notes-link';
import { useRevealFile } from '@/hooks/useRevealFile';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useConfirm } from '@/hooks/useConfirm';
import { useLiveEdit, liveUnreachablePausedMessage, CONFIG_WRITE_DEBOUNCE_MS, type LiveEdit } from '@/hooks/useLiveEdit';
import { useEmbeddedImageFreshness, type EmbeddedImageFreshness } from '@/hooks/useEmbeddedImageFreshness';
import { FileHistoryPanel } from '@/components/common/FileHistoryPanel';
import { PdfPreview } from '@/components/common/PdfPreview';
import {
  ICON_NEW_TAB, ICON_NOTE, ICON_COPY, ICON_DOWNLOAD, ICON_FOLDER, ICON_OPEN_APP, ICON_EXPAND, ICON_COLLAPSE,
  ICON_SEARCH, ICON_HISTORY, ICON_MORE, ICON_CHECK, ICON_CLOSE, ICON_CODE, ICON_FILE, ICON_SKIP_BACK, ICON_SKIP_FORWARD,
} from '@/components/common/Icons';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { FileSourceEditor, type FileSourceEditorHandle } from '@/components/common/FileSourceEditor';
import { FileMarkdownEditor } from '@/components/common/FileMarkdownEditor';
import { SelectionAskPill, selectionClientRect } from '@/components/common/SelectionAskPill';
import {
  FILE_ASK_FAILURE_TEXT, FileThreadLayer, type FileAskResult, type FileThreadLayerHandle, type FileThreadSurface,
} from '@/components/common/FileThreadLayer';
import type { SessionPinnedQuote } from '@/types/session';
import { useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import { pointerOwnedElsewhere } from '@/utils/find-scope';
import {
  DomSearchController, collectTextMatches,
  wordAtPoint, claimSearchOwner, onSearchOwnerLost, SYMBOL_RE,
} from '@/utils/dom-text-search';
import { CodeContextMenu, buildCodeContextTarget, type CodeContextTarget } from '@/components/common/CodeContextMenu';
import { copyTextRobust } from '@/utils/clipboard';
import { usePreviewFrame } from '@/components/common/preview-frame';
import { openPopout } from '@/popout/openPopout';
import { log } from '@/utils/log';
import { useHidesHighlights } from '@/hooks/useHidesHighlights';
import '@/styles/live-edit.css';
import '@/styles/file-doc-bar.css';
import { fileCardOpenIn, selectionToolbarOpen } from '@/utils/file-card-escape';
import { keepReadingPlace } from '@/utils/reading-place';
import { lineSurfaceOf } from '@/utils/reading-line-dom';
import { useFileReadingPlace, type ReadingSeen } from '@/components/common/use-file-reading-place';
import { pressBelowText } from '@/utils/blank-press';

/** A ⌘S (or the banner's Try again) that never reached the server. */
const SAVE_RETRY_MESSAGE = "Can't reach Walnut right now. Your text is still in the editor: press Try again once Walnut is running.";

interface FileContentViewProps {
  path: string;
  line?: number;
  /** The keyword the jump landed on (reference panel) — flashed at `line` so
   *  the eye finds the term, not just the row. */
  lineTerm?: string;
  /** Last line of a range jump (`x.go:31-34`): `line`..`lineEnd` is highlighted. */
  lineEnd?: number;
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
  /**
   * A link inside the HTML preview pointed at ANOTHER file on this host. When
   * provided, the container opens that file the way a tree click would (its own
   * viewer, tree reveal, ‹ › history) instead of the frame navigating to it
   * with no way back. Absent → the frame navigates, and a "Back to <file>" strip
   * offers the way back.
   */
  onOpenPath?: (path: string) => void;
  /** The start of the document bar: where the file is. The explorer puts its
   *  ‹ › and the path here; absent → the file's folder and name. */
  barLeading?: ReactNode;
  /** The end of the document bar (the explorer's chat segment). */
  barTrailing?: ReactNode;
  /** Extra rows at the end of the ⋯ menu (the explorer's Refresh). */
  extraMenuItems?: ContextMenuItem[];
  /** Rows that lead the ⋯ menu once the bar has folded the lead's ‹ › into it
   *  to make room (the explorer's Back and Forward). */
  tightMenuItems?: ContextMenuItem[];
}

/** A path split for one line: the head (cut first), the file's own folder, the name. */
function splitPathRow(p: string): { head: string; folder: string; name: string } {
  const cut = p.lastIndexOf('/');
  const name = p.slice(cut + 1);
  const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
  const prev = dir.lastIndexOf('/', dir.length - 2);
  return { head: dir.slice(0, prev + 1), folder: dir.slice(prev + 1), name };
}

/**
 * The start of a path in ⋯'s first row, cut by whole folders: the folders nearest
 * the file stay, the ones that do not fit go, and a leading "…/" says some did.
 * Cutting the text instead split a folder name in the middle ("itor-fixture/").
 */
function PathHead({ head }: { head: string }) {
  const segs = useMemo(() => head.split('/').slice(0, -1).map((s) => `${s}/`), [head]);
  const boxRef = useRef<HTMLSpanElement>(null);
  // How many folders, nearest first, fit whole. Measured once the row is laid out
  // (the menu mounts fresh each time it opens, so once is enough).
  const [shown, setShown] = useState(segs.length);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const left = box.getBoundingClientRect().left - 0.5;
    const kids = Array.from(box.children) as HTMLElement[];
    let fit = 0;
    while (fit < kids.length && kids[fit]!.getBoundingClientRect().left >= left) fit++;
    if (fit < shown) setShown(fit);
  }, [shown]);
  if (segs.length === 0) return null;
  const nearest = segs.slice().reverse().slice(0, shown);
  return (
    <>
      {shown < segs.length && <span className="fv-more-path-cut" aria-hidden="true">…/</span>}
      {/* Nearest folder first in a right-to-left row; what overflows its left edge
          is measured above and left out. */}
      <span className="fv-more-path-dir" ref={boxRef}>
        {nearest.map((seg, i) => <span key={i}>{seg}</span>)}
      </span>
    </>
  );
}

/** Build line-numbered HTML from raw file content. Lines get Prism syntax
 *  coloring when the language is known (highlightLines); plain escape otherwise. */
function buildLineNumberedHtml(content: string, path: string, highlightLine?: number, highlightEnd?: number): string {
  const lines = content.split('\n');
  const colored = highlightLines(content, path);
  const rows = lines.map((lineText, i) => {
    const lineNum = i + 1;
    const isHighlighted = highlightLine !== undefined && (lineNum === highlightLine
      || (highlightEnd !== undefined && lineNum > highlightLine && lineNum <= highlightEnd));
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
/**
 * The document bar's steps, roomiest first (see barStep in FileContentView): its
 * tier (full: words; compact: icons; tight: one Preview / Source switch, no save
 * word) and how many tools are folded into ⋯, one at a time, rarest first:
 * 1 History, 2 ‹ › (⌘[ ⌘] still work), 3 Find (⌘F still works), 4 Preview / Source,
 * 5 the host's own buttons at the bar's end that carry data-bar-foldable (Terminal).
 */
const BAR_STEPS = [
  { fit: 'full', fold: 0 },
  { fit: 'compact', fold: 0 },
  { fit: 'compact', fold: 1 },
  { fit: 'compact', fold: 2 },
  { fit: 'compact', fold: 3 },
  { fit: 'tight', fold: 3 },
  { fit: 'tight', fold: 4 },
  { fit: 'tight', fold: 5 },
] as const;
/** The step the bar's width alone gives: full, compact or tight. */
const barStepForWidth = (w: number) => (w >= 560 ? 0 : w >= 440 ? 1 : 5);

/** Keystroke → draft write settle window. Short enough that a click away from
 *  the panel almost always finds nothing pending, long enough that a typing
 *  burst is one write. */
const DRAFT_DEBOUNCE_MS = 400;
/** "Still loading" answers joined in a row (each ~60s at the server) before the last one shows as it is. */
const MAX_FILE_LOADING_JOINS = 10;
/** How often a file whose host is not answering now ("Reconnecting to ...") is asked again. */
const FILE_RECONNECT_RETRY_MS = 5_000;


export function FileContentView({
  path: filePath, line, lineTerm, lineEnd, host, sessionId, hidePopout, reloadToken = 0,
  onSelectCode, onSaved, onSymbolLookup, onOpenPath, barLeading, barTrailing, extraMenuItems, tightMenuItems,
}: FileContentViewProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loading, setLoading] = useState(true);
  /**
   * Identity of THIS mount. Several views of one file can be on screen at once
   * (two session Files panes, a pane plus the "@" mention preview, the /notes
   * editor plus the pane rooted at the vault), so every write we make is stamped
   * with this and every doc-saved signal carrying it is our own echo. Comparing
   * on content hash alone would be wrong: two views can hold byte-identical
   * buffers, and then nobody would react.
   */
  const viewIdRef = useRef(`fv-${Math.random().toString(36).slice(2)}`);
  /**
   * Re-read this file because something OTHER than the container asked for it: a
   * sibling view saved it, or the server said the note/memory doc behind it
   * moved, and this pane has no editor to fold the bytes into. Added to
   * `reloadToken` (both only ever increase) so one read path serves both.
   */
  const [selfReload, setSelfReload] = useState(0);
  const readToken = reloadToken + selfReload;
  // The next read is this view asking again while the file's host reconnects:
  // no "Reloading…" badge, the sentence on screen already says what is going on.
  const quietReadRef = useRef(false);
  // A read is under way: the reconnect clock never stacks a second one on it.
  const readingRef = useRef(false);
  // Re-fetch of the file already on screen (Refresh): keep the old content
  // visible instead of flashing to blank, and show a small "Reloading…" badge.
  const [reloading, setReloading] = useState(false);
  // A remote file still arriving (slow link that answers): the host's label while
  // this view joins the server's read again (MAX_FILE_LOADING_JOINS).
  const [loadingFrom, setLoadingFrom] = useState<string | null>(null);
  // For HTML/Markdown files, default to the rendered preview; toggle to source on demand.
  const [showSource, setShowSource] = useState(false);
  const sourceModeRef = useRef({ key: `${host ?? 'local'} ${filePath}`, source: false });
  // Fullscreen the preview (md/html) — CSS-fixed overlay, no remount.
  const [fullscreen, setFullscreen] = useState(false);
  // Full screen hides the sheet under this one (fullscreen-tab.css) by visibility: its
  // chat's marks must not paint on this document in WebKit.
  useHidesHighlights(fullscreen);
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
  // The disk bytes the carried draft is a modification of: the other half of the
  // pair an editor keeps as getValue/getBase. Set with draftRef whenever it seeds
  // an editor, moved by our own write landing and by a merge, and never by a
  // read on its own (the 2026-09-08 rule: text and base come from one owner).
  const draftBaseRef = useRef<string | null>(null);
  // Bumped by Discard to force a remount back onto the on-disk bytes.
  const [seedNonce, setSeedNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // What the save banner offers besides its words: the conflict choice (keep mine /
  // use the version on disk) after a ⌘S that 409'd, or Try again after one that
  // never arrived. Live Edit's own pauses are read from `live.suspendedReason`.
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveRetry, setSaveRetry] = useState(false);
  useEffect(() => {
    if (saveError == null) { setSaveConflict(false); setSaveRetry(false); }
  }, [saveError]);
  // ── File history ───────────────────────────────────────────────────────────
  // The version timeline for THIS file (Walnut snapshots + git). Stays open across
  // file switches on purpose — the panel refetches for the new path — and
  // `versionsSeen` is bumped by every write we made or adopted, so the list picks
  // up the version just recorded without a remount.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionsSeen, setVersionsSeen] = useState(0);
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;
  const liveVersionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An open History comparison follows the editor's text a beat after typing stops.
  const [bufferToken, setBufferToken] = useState(0);
  const bufferTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (bufferTokenTimerRef.current) clearTimeout(bufferTokenTimerRef.current); }, []);
  useEffect(() => () => { if (liveVersionTimerRef.current) clearTimeout(liveVersionTimerRef.current); }, []);
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
  // The buffer and its base, whichever surface holds them: the editor when one is
  // mounted, otherwise (an HTML or MDX preview, which renders and does not edit)
  // the carried draft. Saving reads these, so a write, a Try again or a landed
  // write never mistakes "no editor on screen" for "nothing unsaved".
  const bufferText = (): string | null => {
    if (editorRef.current) return editorRef.current.getValue();
    return dirtyRef.current ? draftRef.current : null;
  };
  const bufferBase = (): string | null => {
    if (editorRef.current) return editorRef.current.getBase();
    return dirtyRef.current && draftRef.current != null ? draftBaseRef.current : null;
  };

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
  /**
   * Which BUFFER the lock above belongs to. Bumped by every path that installs a
   * different buffer (a read applying disk bytes, a merge, an adopted write, a
   * restored draft, our own save), and read by anything that armed a write
   * earlier — a token from generation N+1 must never be sent with text from
   * generation N.
   *
   * The 2026-09-05 incident: the pane read a remote design doc, advancing the lock
   * to the bytes it had just read, while an older copy still sat in the buffer.
   * The auto-write took the text from one and the token from the other, so the
   * server's optimistic lock — which re-reads and re-hashes the real file — had no
   * way to tell it apart from a legitimate save, and a stale 28 KB copy replaced a
   * 40 KB file four times. Nothing else in this file may assume the lock and the
   * buffer are in step; this counter is what makes a divergence detectable.
   */
  const bufferGenRef = useRef(0);
  /**
   * Call whenever the buffer's bytes (or the lock describing them) are replaced.
   *
   * `source` names the path that did it, and is logged: this is the OTHER HALF of
   * the write log. A write line alone cannot say why its token was newer than its
   * text; paired with these lines (same path, seconds apart) the sequence reads
   * straight off the log as read → lock advance → write decision. The 2026-09-05
   * incident took a day of archaeology for want of exactly this line.
   */
  const noteBufferInstalled = useCallback((source: string, nextLockHash?: string | null) => {
    bufferGenRef.current += 1;
    log.info('file-editor', 'buffer installed', {
      path: filePath, host, source, gen: bufferGenRef.current,
      // Before/after, because the whole bug was the two drifting apart. A caller
      // that sets the lock itself right after this call passes the new value in;
      // otherwise the lock is not moving and both read the same.
      lockBefore: lockHashRef.current,
      lockAfter: nextLockHash === undefined ? lockHashRef.current : nextLockHash,
    });
  }, [filePath, host]);
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

  /** Put text in the live editor without a remount and without arming a write.
   *  `base` = the disk bytes that text is a modification of; omitted means the
   *  text IS the disk bytes (an adopt). See FileSourceEditorHandle.getBase. */
  const applyEditorText = useCallback((text: string, base?: string) => {
    // A different buffer from here on: any write armed against the previous one
    // must not go out under the lock this apply belongs to.
    noteBufferInstalled('apply-editor-text');
    applyingRef.current = true;
    try {
      if (editorRef.current) editorRef.current.setValue(text, base);
      else { draftRef.current = text; draftBaseRef.current = base ?? text; }
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

  // Text put in the editor by Walnut rather than typed (a restored version, a
  // replayed draft) is unsaved but arms no write by itself: only a user edit
  // does. Without this the chip said Saving… with nothing on its way, and with
  // no Save button nothing would ever write it. Armed by the restore, fired once
  // the remounted editor can hand over its text (it may still be loading).
  const armOnMountRef = useRef(false);
  useEffect(() => {
    if (!armOnMountRef.current) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (!armOnMountRef.current) return;
      if (bufferText() == null) {
        if (++tries < 50) t = setTimeout(fire, 100);
        return;
      }
      armOnMountRef.current = false;
      liveRef.current?.noteUserEdit();
    };
    fire();
    return () => { if (t) clearTimeout(t); };
  });

  const handleDocChange = useCallback(() => {
    const text = editorRef.current?.getValue();
    if (text == null) return;
    captureDraft(text);
    if (historyOpenRef.current) {
      if (bufferTokenTimerRef.current) clearTimeout(bufferTokenTimerRef.current);
      bufferTokenTimerRef.current = setTimeout(() => setBufferToken((n) => n + 1), 400);
    }
    // Only a USER edit arms the auto-write (see applyingRef). The draft capture
    // above still runs for a programmatic apply — the record then matches disk,
    // which is how the obsolete draft gets deleted.
    if (!applyingRef.current) liveRef.current?.noteUserEdit();
  }, [captureDraft]);

  // Unmount is the reported failure mode ("left the panel, came back, gone"), so
  // the last keystrokes are flushed rather than dropped with the timer.
  useEffect(() => () => { void flushDraft(); }, [flushDraft]);

  // Leaving the page (reload, closed window, the Mac app quitting): an IndexedDB
  // write started now may never land, so the pending draft is stashed
  // synchronously as well (stashFileDraftSync). Typed-then-reloaded text came back
  // only when the reload waited out the draft timer (2026-11-07 review).
  useEffect(() => {
    const stash = () => {
      const p = pendingDraftRef.current;
      if (!p || (p.disk != null && p.text === p.disk)) return;
      stashFileDraftSync(p.host, p.path, { text: p.text, baseHash: p.baseHash });
      void flushDraft();
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') stash(); };
    window.addEventListener('pagehide', stash);
    window.addEventListener('beforeunload', stash);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', stash);
      window.removeEventListener('beforeunload', stash);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [flushDraft]);

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
    const source = loadFileScroll(host, filePath)?.source === true;
    sourceModeRef.current = { key: `${host ?? 'local'} ${filePath}`, source };
    setShowSource(source);
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
    const isReload = lastTokenRef.current !== null && lastTokenRef.current !== readToken;
    lastTokenRef.current = readToken;
    const quiet = quietReadRef.current;
    quietReadRef.current = false;
    // What the pane held before this read — a reload compares against it to
    // tell "new bytes" (remount) from "same bytes" (leave the editor alone).
    const lockBefore = lockHashRef.current;
    if (isReload) { if (!quiet) setReloading(true); }
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
      // The lock is about to describe DIFFERENT bytes than whatever is in the
      // editor right now, so anything armed against the old buffer is void.
      noteBufferInstalled(draft ? 'read+draft-replay' : 'read', plan.lockHash);
      lockHashRef.current = plan.lockHash;
      // The lock follows the seed, and the merge base follows the LOCK — which
      // for a replayed draft is still the disk bytes (its baseHash matched), so
      // `d.content` is right in both branches.
      baseContentRef.current = d.content;
      draftRef.current = plan.seed;
      draftBaseRef.current = d.content;
      // Edited back to the original ⇒ nothing unsaved left to remember.
      if (plan.drop && !opts.provisional) void deleteFileDraft(host, filePath);
      // Passing the SAME payload object on the confirming pass is deliberate:
      // React bails out on an identical value, so a 304 costs no re-render.
      setData(d);
      setDraftDirty(plan.seed != null);
      setEditorDirty(false);
      setStaleDraft(plan.stale);
      setDraftRestored(plan.seed != null);
      // A replayed draft is unsaved work on the bytes now on disk: saving is
      // always live, so it goes out like the keystrokes that made it would have.
      if (plan.seed != null && !opts.provisional) armOnMountRef.current = true;
      setBaseHash(d.contentHash);
      setLoading(false);
      if (!opts.provisional) setReloading(false);
    };

    readingRef.current = true;
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
        // With an unsaved draft in hand the cached copy is NOT painted, and the
        // draft is not shown to planDraftReplay yet. That decision ("is this draft
        // based on what is on disk, or is it stale?") is only answerable against
        // bytes the server has confirmed: judged against a cached copy, a draft
        // typed against THAT copy looks current and gets replayed into the editor,
        // which is a stale buffer sitting in an editor armed to write. Waiting one
        // round trip costs a blank moment; getting it wrong costs the file.
        if (cachedPayload && !isReload && !draft) apply(cachedPayload, null, { provisional: true });

        // `If-None-Match` is what turns "re-open an unchanged file" into a header
        // exchange: 304 means the bytes we just painted ARE the bytes on disk, so
        // nothing is transferred (for a remote file, nothing crosses the tunnel).
        // `track: 'baseline'` still records what this open found as the file's
        // "Opened" version — an edit is only undoable if the pre-edit state was
        // kept — and the server dedupes by hash, so re-opens add nothing.
        let res = await fetchFileContentConditional(filePath, host, {
          ...(cached ? { ifNoneMatch: cached.contentHash } : {}),
          track: 'baseline',
        });
        // "Still loading": the server's read goes on, and asking again joins it,
        // so the bytes land the moment they are in, never a sentence to retry by hand.
        for (let joins = 0; !cancelled && res.payload?.loading && joins < MAX_FILE_LOADING_JOINS; joins++) {
          setLoadingFrom(res.payload.loading.from);
          res = await fetchFileContentConditional(filePath, host, { track: 'baseline' });
        }
        if (!cancelled) setLoadingFrom(null);
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
          // Walnut was not answering: asked again on the clock below, like a host that reconnects.
          ...(isWalnutUnreachable(err) ? { code: WALNUT_UNREACHABLE_CODE }
            // Walnut's own refusal keeps its code: a host coming back is asked again the same way.
            : err instanceof FileReadError && err.code ? { code: err.code } : {}),
        });
      } finally {
        if (!cancelled) { setLoading(false); setReloading(false); readingRef.current = false; }
      }
    })();
    return () => { cancelled = true; readingRef.current = false; };
  }, [filePath, host, readToken, flushDraft]);

  // The file's host is not answering now: ask again until it is back, so a file
  // opened while it reconnected shows once it answers, with no click (gate
  // review, 2026-10-07: it kept "Reconnecting to Cloud" until it was clicked).
  const hostWaiting = !loading && isComingBackCode(data?.code) && data?.content == null;
  // Walnut is back (the socket reconnected): a read that failed while it was gone is asked again now.
  const failedRead = !loading && !!data?.error && data.content == null;
  const failedReadRef = useRef(failedRead);
  failedReadRef.current = failedRead;
  useEvent('_ws:reconnected', () => {
    if (!failedReadRef.current || readingRef.current) return;
    quietReadRef.current = true;
    setSelfReload((n) => n + 1);
  });
  useEffect(() => {
    if (!hostWaiting) return;
    const retryMs = (window as unknown as { __filesRetryMs?: number }).__filesRetryMs || FILE_RECONNECT_RETRY_MS;
    return visibleInterval(() => {
      if (readingRef.current) return;
      quietReadRef.current = true;
      setSelfReload((n) => n + 1);
    }, retryMs);
  }, [hostWaiting, filePath, host]);

  // Scroll to highlighted line after content renders
  useEffect(() => {
    if (!line || !contentRef.current) return;
    const el = contentRef.current.querySelector(`[data-line="${line}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [line, data]);

  // ── The reading place (use-file-reading-place.ts) ──────────────────────────
  // Noted as the source line at the top of the view on every scroll, carried across a
  // Preview/Source switch, and brought back on every reopen of this file (panel toggle,
  // session switch, reload). A deep link to a line (`line`) wins over the remembered place.
  const lastSeenRef = useRef<ReadingSeen | null>(null);
  const showSourceRef = useRef(showSource);
  showSourceRef.current = showSource;
  const { noteSwitch } = useFileReadingPlace({
    rootRef: contentRef, host, filePath, line, seenRef: lastSeenRef,
    // Raw kinds (media/PDF/image) have no text body: their place belongs to the native control.
    active: !!data?.content && !raw,
    contentNonce: data,
    textOf: () => draftRef.current ?? dataRef.current?.content ?? '',
    sourceChosen: () => {
      const m = sourceModeRef.current;
      return m.key === `${host ?? 'local'} ${filePath}` ? m.source : showSourceRef.current;
    },
  });

  // ── Keep the reading place across width changes (utils/reading-place.ts) ──
  // The window, a panel divider or the sheet changing width rewraps every line above
  // the reader; the same scrollTop then shows another part of the file (2026-11-10:
  // Section 62 became Section 74). CodeMirror keeps its own place, and a frame is its page's.
  useEffect(() => {
    const view = contentRef.current;
    if (!view) return;
    return keepReadingPlace(view, () => {
      // The surfaces the line keeper knows (utils/reading-line-dom.ts), CodeMirror left to itself.
      const s = lineSurfaceOf(view);
      return s && s.kind !== 'cm' ? { scroller: s.scroller, body: s.body } : null;
    });
  }, [filePath]);

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
      if (e.key !== 'Escape') return;
      // One layer per Escape: an open menu closes first (its own handler), the
      // full screen on the next press.
      if (document.querySelector('.wn-context-menu, .app-modal-overlay')) return;
      if (historyOpenRef.current) return; // History's own handler takes this press
      // A selection toolbar, then a card over the file (Ask here, a comment), close first
      // (utils/file-card-escape.ts).
      if (e.defaultPrevented || selectionToolbarOpen() || fileCardOpenIn(contentRef.current)) return;
      e.stopPropagation();
      setFullscreen(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [fullscreen]);

  // Escape closes History and only History: claimed in the capture phase so the
  // Files panel (and full screen) see a consumed key and stay open. One layer per
  // press, same as above: a menu or a confirm closes first.
  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (document.querySelector('.wn-context-menu, .app-modal-overlay')) return;
      // The find bar closes itself on Escape first, and so does a selection toolbar.
      if (e.target instanceof Element && e.target.closest('.fv-search-bar')) return;
      if (selectionToolbarOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      setHistoryOpen(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [historyOpen]);

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
  // Read from an async continuation (a sibling view's save handler), so a ref.
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  // Editors ARE the default view for editable files. Preview tab: WYSIWYG for
  // plain markdown, read-only render for HTML (iframe) and MDX. Source tab /
  // non-renderable text: CodeMirror. Non-editable files keep the read views.
  const editingWysiwyg = canEdit && canWysiwyg && !showSource;
  wysiwygRef.current = editingWysiwyg;
  const editingSource = canEdit && (showSource || !isRenderable);
  const editing = editingWysiwyg || editingSource;
  const showPreview = isRenderable && !showSource && !editingWysiwyg;
  // A press in the blank space under an editor's text (a short file leaves room in the view)
  // puts the caret at the end, as a text box does; the editors hear presses on their text
  // only (2026-11-10 review: nothing took focus, and the next "F" opened the page's filter).
  // Inside the source editor's own box FileSourceEditor does the same.
  useEffect(() => {
    const view = contentRef.current;
    if (!view || !editing) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (e.button !== 0 || e.defaultPrevented || !(t instanceof Element)) return;
      const host = view.querySelector<HTMLElement>(':scope > .fv-source-editor, :scope > .fv-wysiwyg-editor');
      if (!host) return;
      const text = host.querySelector('.ProseMirror') ?? host;
      // A control in the margin (a button, a link, a field) is not blank space.
      const blank = t === view || (t !== text && host.contains(t) && !text.contains(t)
        && !t.closest('.editor-mic-dock, .notes-bubble-menu, .cm-editor, button, a, input, textarea, select, label, [role=button]'));
      if (!blank || !pressBelowText(e.clientY, e.clientX, text.getBoundingClientRect().bottom, null)) return;
      e.preventDefault();
      editorRef.current?.focusEnd?.();
    };
    view.addEventListener('mousedown', onDown);
    return () => view.removeEventListener('mousedown', onDown);
  }, [editing]);
  /** Which text surface is on show, for the question layer (marks, Ask here). */
  const threadSurface: FileThreadSurface = loading ? 'none'
    : showPreview && isHtml ? 'html'
      : editingWysiwyg ? 'wysiwyg'
        : editingSource ? 'source'
          : showPreview && isMarkdown ? 'preview'
            : data?.content ? 'pre' : 'none';

  // Prism-highlighted rows for the read-only <pre> fallback ONLY (non-editable
  // text, e.g. truncated reads). Editable files render an editor instead — and
  // CodeMirror highlights itself — so skip the (quadratic-ish) work for them.
  const lineNumberedHtml = useMemo(() => {
    if (!data?.content || editing) return '';
    return buildLineNumberedHtml(data.content, filePath, line, lineEnd);
  }, [data, filePath, line, lineEnd, editing]);

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
  // Bumped whenever new bytes are on disk (our write, another writer's adopted):
  // the HTML preview loads the file by URL, so it must be told to load again.
  const [diskVersion, setDiskVersion] = useState(0);
  const noteBytesOnDisk = useCallback((content: string, contentHash: string, size: number) => {
    setDiskVersion((n) => n + 1);
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
    noteBufferInstalled(opts.live ? 'our-live-write' : 'our-save', res.contentHash);
    lockHashRef.current = res.contentHash;
    baseContentRef.current = text;
    // Before the early return below: whatever the buffer does next, `text` IS
    // what the server just accepted onto disk.
    noteBytesOnDisk(text, res.contentHash, res.size);
    setData((prev) => (prev ? { ...prev, content: text, size: res.size, contentHash: res.contentHash } : prev));
    setStaleDraft(null);
    setDraftRestored(false);
    // History refetches per version; a live burst is one coalesced version on the
    // server, so refetching (two git spawns) per typing pause would be noise. An
    // OPEN panel still has to show it: one refetch once the burst has settled.
    if (!opts.live) setVersionsSeen((n) => n + 1);
    else if (historyOpenRef.current) {
      if (liveVersionTimerRef.current) clearTimeout(liveVersionTimerRef.current);
      liveVersionTimerRef.current = setTimeout(() => setVersionsSeen((n) => n + 1), 1500);
    }
    // What is on disk is `text`. If the buffer has ALREADY moved on (a keystroke
    // landed while the write was in flight — routine in live mode, where every
    // pause is a write), the file is still dirty by exactly that much, and the
    // draft record holding the newer text is the only backup of it. markClean
    // here would re-baseline the editor onto the NEWER text (dirty dot off, Save
    // disabled, beforeunload guard off) and dropDraft would delete that backup —
    // the characters would then exist only in the buffer, invisibly unsaved.
    const buffer = bufferText();
    if (buffer != null && buffer !== text) {
      // Dirty tracking stays where it is (see above), but "what is on disk" moved,
      // so the editor's BASE has to move even though "clean" does not. Skipping
      // this leaves the base one generation behind disk, and since an automatic
      // write derives its token from the base, every following typing pause 409s
      // by construction and runs a pointless merge cycle (found in review,
      // 2026-09-08). Ordering matters: this must run BEFORE the return.
      if (editorRef.current) editorRef.current.setBase(text);
      else draftBaseRef.current = text;
      // Re-record the newer words on top of the bytes now on disk, so a reload
      // replays them as a draft of THIS version (not a stale one of the last).
      diskContentRef.current = text;
      captureDraft(buffer);
      // At once, not after the draft debounce: a reload in that window would
      // find only the record of the last version and call the words stale.
      void flushDraft();
      return;
    }
    editorRef.current?.markClean(text);
    draftRef.current = null;
    // The bytes are on disk now, so the side record is obsolete. Cancelling the
    // pending capture matters as much as the delete: a timer that fired after
    // this would resurrect the draft for text that is no longer unsaved.
    dropDraft(filePath, host);
    setDraftDirty(false);
    setEditorDirty(false);
  }, [captureDraft, dropDraft, filePath, flushDraft, host, noteBytesOnDisk]);

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
    editorRef.current?.markClean(content);
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
    // A version picked from History is a deliberate write: a pause for a refused
    // or unreachable write is retried by it. A real conflict stays paused: the
    // other writer's change still waits on Keep mine / Use disk.
    if (liveRef.current?.suspendedReason && liveRef.current.suspendedReason !== 'conflict') liveRef.current.resume();
    armOnMountRef.current = true;
    draftRef.current = content;
    draftBaseRef.current = baseContentRef.current;
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

  // Config-like files are often watched and loaded the moment they change, so a
  // half-typed one must not land: JSON and YAML are parsed first (the YAML
  // parser is loaded only for a YAML file).
  const isYaml = /\.ya?ml$/i.test(filePath);
  const yamlRef = useRef<{ parseAllDocuments: (s: string) => unknown } | null>(null);
  useEffect(() => {
    if (!isYaml || yamlRef.current) return;
    let gone = false;
    void import('yaml').then((m) => { if (!gone) yamlRef.current = m; }).catch(() => { /* no parser: no hold */ });
    return () => { gone = true; };
  }, [isYaml]);
  const validateForLiveWrite = useCallback((text: string, path: string, base: string | null): string | null => {
    const check = (t: string): string | null => {
      try {
        if (/\.json$/i.test(path)) JSON.parse(t.replace(/^\uFEFF/, ''));
        else if (/\.ya?ml$/i.test(path) && yamlRef.current) {
          const docs = yamlRef.current.parseAllDocuments(t);
          const list = Array.isArray(docs) ? (docs as Array<{ errors: Array<{ message: string }> }>) : [];
          const bad = list.flatMap((d) => d.errors)[0];
          if (bad) return bad.message.split('\n')[0];
        }
        return null;
      } catch (err) {
        return err instanceof Error ? err.message.split('\n')[0] : String(err);
      }
    };
    const invalid = check(text);
    // Only a file that parsed before is held: one that never did (JSON with
    // comments, a tsconfig, YAML the parser is stricter about) saves as before.
    return invalid && (base == null || check(base) == null) ? invalid : null;
  }, []);
  const live = useLiveEdit({
    path: filePath,
    host,
    origin: viewIdRef.current,
    sessionId,
    canEdit,
    isVisible: () => !document.hidden && !!contentRef.current?.getClientRects().length,
    getText: bufferText,
    // The bytes the EDITOR says its text is based on. Deliberately not
    // `baseContentRef`: that one moves when a read lands, which is a render before
    // the editor is reseeded, and writing under a base the editor never held is
    // the 2026-09-08 data loss. With no editor mounted (an HTML/MDX preview) it
    // is the carried draft's own base, recorded with it; null when nothing is
    // unsaved, which stops an automatic write rather than guessing.
    getBaseText: bufferBase,
    validate: validateForLiveWrite,
    debounceMs: /\.(ya?ml|json|jsonc|toml|ini|conf|cfg|env)$/i.test(filePath) || /\/\.env(\.[^/]*)?$/.test(filePath) ? CONFIG_WRITE_DEBOUNCE_MS : undefined,
    applyText: applyEditorText,
    lockHashRef,
    bufferGenRef,
    baseContentRef,
    isDirtyRef: dirtyRef,
    onWrote: (text, res) => {
      applySaved(text, res, { live: true });
      // A write that landed ends whatever the banner was about (a pause the
      // user resumed, a conflict the merge resolved): leaving it up would report
      // a problem the disk no longer has.
      setSaveError(null);
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

  /**
   * Write the buffer now. ⌘S, and the save banner's buttons: saving is otherwise
   * automatic (Live Edit), so there is no Save button. `overwrite` is the banner's
   * "Keep my version": the user has read that the file changed under them and chose
   * theirs, so a 409 is answered by writing again against the hash the server just
   * named, once. Resolves true when the bytes landed.
   */
  const handleSave = useCallback(async (opts?: { overwrite?: boolean }): Promise<boolean> => {
    const text = bufferText();
    if (text == null) return false;
    // An explicit Save IS the flush — a queued auto-write would otherwise fire
    // right behind it against a lock token this save has already spent.
    liveRef.current?.cancelPending();
    setSaving(true);
    setSaveError(null);
    setSaveConflict(false);
    setSaveRetry(false);
    try {
      // A pending conflict hash wins: pressing Save after a conflict IS the
      // user's "overwrite it with mine" decision, so send the hash the server
      // just told us is current rather than the stale seed hash (which would
      // 409 forever).
      //
      // Otherwise the token comes from the EDITOR'S OWN BASE, hashed here, for the
      // same reason the automatic write does (see useLiveEdit's PendingWrite.
      // baseText). `lockHashRef` is advanced the moment a READ lands, while the
      // editor is reseeded a render later, so quoting it lets a ⌘S pressed inside
      // that window replace the file with text from before the read — the 2026-09-08
      // mechanism with a human hand on it. Hashing the editor's base cannot do
      // that: if the editor is behind, the save 409s and the user gets the
      // conflict dialog, which is the whole point of the dialog.
      const editorBase = bufferBase();
      const expectedHash = conflictHashRef.current
        ?? (editorBase != null ? computeContentHashClient(editorBase) : lockHashRef.current);
      let res;
      try {
        res = await saveFileContent(filePath, text, {
          host, expectedHash, writer: 'user', origin: viewIdRef.current,
        });
      } catch (first) {
        if (!(opts?.overwrite && first instanceof FileSaveConflictError)) throw first;
        res = await saveFileContent(filePath, text, {
          host, expectedHash: first.currentHash, writer: 'user', origin: viewIdRef.current,
        });
      }
      applySaved(text, res);
      log.info('file-editor', 'file saved', { path: filePath, host, size: res.size });
      onSaved?.(filePath);
      // A save that landed settles whatever paused live saving for this file (a
      // second ⌘S over a conflict, a Try again): saving is live again from here.
      liveRef.current?.resume();
      return true;
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
        setSaveError('This file changed on disk since you opened it. Keep your version to replace it, or use the version on disk.');
        setSaveConflict(true);
        log.warn('file-editor', 'save conflict', { path: filePath, host });
      } else if (isNetworkFetchError(err)) {
        // The request never arrived (server restarting, tunnel down). The
        // browser's own words for this ("Failed to fetch", "Load failed") name
        // no cause and no way out, so say what happened and what to do.
        setSaveError(SAVE_RETRY_MESSAGE);
        setSaveRetry(true);
        log.warn('file-editor', 'save did not reach the server', {
          path: filePath, host, error: err instanceof Error ? err.message : String(err),
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
        setSaveRetry(true);
        log.error('file-editor', 'save failed', { path: filePath, host, error: msg });
      }
      return false;
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
  const handleDiscard = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current;
    const ok = await confirm({
      title: 'Use the version on disk?',
      message: 'Your changes to this file that are not saved will be thrown away.',
      confirmLabel: 'Use the version on disk',
      danger: true,
    });
    if (!ok || editorRef.current !== editor) return false;
    // The version on disk NOW, read fresh: the copy from when the file was opened
    // may be older than the write that caused this choice.
    let disk: FileContentResponse;
    try {
      disk = await fetchFileContent(filePath, host);
    } catch (err) {
      setSaveError(`Couldn't read the version on disk (${err instanceof Error ? err.message : String(err)}). Your text is still in the editor: try again.`);
      return false;
    }
    if (editorRef.current !== editor || disk.content == null) return false;
    liveRef.current?.cancelPending();
    setData(disk);
    setBaseHash(disk.contentHash);
    noteBufferInstalled('discard', disk.contentHash);
    baseContentRef.current = disk.content;
    lockHashRef.current = disk.contentHash;
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
    return true;
  }, [confirm, dropDraft, filePath, host, noteBufferInstalled]);

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
    noteBufferInstalled('stale-draft-restore', lockHash);
    draftRef.current = seed;
    // No base we still hold (see below): like the editor it seeds, the draft is
    // its own base, so no automatic write can match the disk.
    draftBaseRef.current = seed;
    lockHashRef.current = lockHash;
    // The lock now points at bytes we no longer hold, so there is no trustworthy
    // merge BASE any more. Live Edit reads null as "don't merge, ask the human"
    // — merging against the wrong base is how the other writer's work vanishes.
    baseContentRef.current = null;
    conflictHashRef.current = undefined;
    setDraftDirty(true);
    // Nothing is written on its own: the draft was made on bytes that are no
    // longer on disk, and with no base to merge against a write would either
    // replace the other writer's work or (merging against the draft itself)
    // quietly throw the draft away. The file waits on the person's choice.
    liveRef.current?.pause('conflict');
    setSaveError('These are your changes to an older version of this file, and the file has changed since. Keep your version to replace what is on disk now, or use the version on disk.');
    setSeedNonce((n) => n + 1);
    setStaleDraft(null);
  }, [staleDraft, noteBufferInstalled]);

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
        draftBaseRef.current = editorRef.current.getBase();
        setDraftDirty(true);
      }
      setEditorDirty(false);
    }
    const key = `${host ?? 'local'} ${filePath}`;
    sourceModeRef.current = { key, source: toSource };
    // The outgoing view's line goes with the reader (after the draft is carried: it is the
    // text the incoming view shows).
    noteSwitch(toSource);
    setShowSource(toSource);
  }, [dirty, filePath, host, noteSwitch]);

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
  // The selection as the pill rose for it (its Comment): by the pill's click the
  // editor may have dropped the DOM selection (CodeMirror does), so it is kept from then.
  const pillRangeRef = useRef<Range | null>(null);
  // ...and as the quote its Ask here asks about, taken at the same moment: by the
  // click the DOM those words were in may have been re-rendered (a range into it
  // then points at nothing), while a quote is text, found again in the new DOM.
  // (The HTML preview's selection is the page's, as its bridge last reported it.)
  const pillQuoteRef = useRef<SessionPinnedQuote | null>(null);
  const threadLayerRef = useRef<FileThreadLayerHandle>(null);
  const keepPillQuote = useCallback((range: Range | null, inFrame: boolean) => {
    const layer = threadLayerRef.current;
    pillQuoteRef.current = !layer ? null
      : inFrame ? layer.quoteOf({ inFrame: true })
        : range && !range.collapsed ? layer.quoteOf({ inFrame: false, range }) : null;
  }, []);
  // The HTML preview's "clear the page's selection" (set below, once its frame hook exists).
  const clearFrameSelectionRef = useRef<(() => void) | null>(null);

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

    pillRangeRef.current = range.cloneRange();
    keepPillQuote(range, false);
    setSelection({ x: e.clientX, y: e.clientY, text, line });
  }, [onSelectCode, keepPillQuote]);

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
    // An HTML-preview selection lives in the page: it clears it itself (preview-frame.ts).
    if (selection.inHtml) clearFrameSelectionRef.current?.();
  }, [selection, onSelectCode, filePath]);

  // WYSIWYG "Ask": the bubble menu already scopes to a real selection, so it
  // commits straight through — no pill hop. Line is unknowable in a rendered
  // doc; the prefill degrades to a file-level reference (still correct).
  const handleAskSelection = useCallback((text: string) => {
    onSelectCode?.(filePath, undefined, text);
    setFullscreen(false); // same reason as commitSelection: uncover the composer
  }, [onSelectCode, filePath]);

  // "Ask here": the selection becomes a QUESTION about this passage of the file,
  // answered in a comment card beside it (FileThreadLayer; the card is the
  // session timeline's). Offered only inside a session panel (a threads api that
  // can record anchors); the file stays on screen, so fullscreen stays too.
  const threadsApi = useSessionThreadsApi();
  const canAskHere = threadsApi.canAsk && !!sessionId;
  // An Ask here that opened no card says why, in the view, for a few seconds.
  // (An object per failure: the same words twice restart the timer.)
  const [askNotice, setAskNotice] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (!askNotice) return;
    const t = window.setTimeout(() => setAskNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [askNotice]);
  useEffect(() => { setAskNotice(null); }, [filePath]);
  const askLanded = useCallback((res: FileAskResult, via: string) => {
    if (res.ok) { setAskNotice(null); return; }
    log.warn('threads', 'ask here opened no card', { path: filePath, via, reason: res.reason });
    setAskNotice({ text: FILE_ASK_FAILURE_TEXT[res.reason] });
  }, [filePath]);
  const askHereFromSelection = useCallback(() => {
    // The selection as the pill rose for it (as Comment does): by the pill's click
    // the live DOM selection is gone (CodeMirror drops it; so did WebKit in the
    // read-only views), and reading only that made `Ask here` in the Source tab,
    // code files and the read-only views do nothing at all (2026-11-06). First the
    // quote taken then (text survives a re-render of the view), else the range.
    const layer = threadLayerRef.current;
    const quote = pillQuoteRef.current;
    const kept = pillRangeRef.current;
    const inFrame = !!selection?.inHtml;
    const line = selection?.line ? { line: selection.line } : {};
    const res: FileAskResult = !layer ? { ok: false, reason: 'no-layer' }
      : quote ? layer.askPassage({ quote, inFrame, ...line })
        : layer.askSelection({ inFrame, ...line, ...(kept && !kept.collapsed ? { range: kept } : {}) });
    askLanded(res, quote ? 'pill-quote' : 'pill-range');
    pillQuoteRef.current = null;
    setSelection(null);
  }, [selection, askLanded]);
  const askHereFromBubble = useCallback((range: Range) => {
    const layer = threadLayerRef.current;
    askLanded(layer ? layer.askSelection({ inFrame: false, range }) : { ok: false, reason: 'no-layer' }, 'bubble');
  }, [askLanded]);

  // "Comment": a Google Docs style comment kept in the doc's sidecar file, its card
  // in place under its words (DocCommentsLayer); it also waits above the
  // composer for the next message. Every view of a doc shows its comments, the HTML
  // preview's same-origin frame included; never on a sidecar itself.
  const commentsApi = useSessionCommentsApi();
  const canDocComment = commentsApi.canComment && !!sessionId && !isSidecarPath(filePath) && threadSurface !== 'none';
  const docCommentsRef = useRef<DocCommentsHandle>(null);
  const commentFromBubble = useCallback((range: Range, text: string) => {
    docCommentsRef.current?.commentOn({ range, text });
  }, []);
  const keepPillRange = useCallback(() => {
    const sel = window.getSelection();
    pillRangeRef.current = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }, []);
  // The source editor's selection as document offsets, kept the same way.
  const pillOffsetsRef = useRef<{ from: number; to: number } | null>(null);
  const onSourceSelect = useCallback((sel: Parameters<typeof setSelection>[0]) => {
    if (sel) { keepPillRange(); keepPillQuote(pillRangeRef.current, false); } else pillQuoteRef.current = null;
    pillOffsetsRef.current = sel ? editorRef.current?.selectionOffsets?.() ?? null : null;
    setSelection(sel);
  }, [keepPillRange, keepPillQuote]);
  const commentFromSelection = useCallback(() => {
    const range = pillRangeRef.current;
    docCommentsRef.current?.commentOn({
      ...(range ? { range } : {}), ...(selection?.text ? { text: selection.text } : {}), offsets: pillOffsetsRef.current,
      ...(selection?.inHtml ? { inFrame: true } : {}),
    });
    setSelection(null);
  }, [selection]);
  const docTextNow = useCallback(() => editorRef.current?.getValue() ?? data?.content ?? null, [data?.content]);

  // HTML preview: the page runs sandboxed in an origin of its own, so the console
  // cannot reach into its document; its selection, text, scroll position, link clicks,
  // marks, find and Esc go through the bridge Walnut puts into it (preview-frame.ts).
  // Line is unknowable in rendered HTML: the prefill degrades to a file-level
  // reference, as the WYSIWYG path does.
  const htmlFrameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlPreviewLive = !loading && !showSource && isHtml;
  const onFrameSelection = useCallback((sel: { x: number; y: number; text: string } | null) => {
    if (!sel) { setSelection((prev) => (prev?.inHtml ? null : prev)); return; }
    pillRangeRef.current = null; // the range lives in the page; a comment keeps its words
    keepPillQuote(null, true);
    setSelection({ ...sel, inHtml: true });
  }, [keepPillQuote]);
  // ⌘F inside the page and its find results (the search bar is set up below).
  const frameFindRef = useRef<{ open: () => void; result: (r: { count: number; index: number }) => void } | null>(null);
  const preview = usePreviewFrame({
    // The URL version a "Back to" strip returns to: the file as it is now.
    frameRef: htmlFrameRef, live: htmlPreviewLive, filePath, host, line, reloadToken: reloadToken + diskVersion, lastSeenRef, sourceModeRef,
    onSelection: onSelectCode ? onFrameSelection : undefined, onOpenPath,
    onFindKey: () => frameFindRef.current?.open(),
    onFindResult: (r) => frameFindRef.current?.result(r),
  });
  const { strayed, setStrayed, returnToFile, selectionRect: frameSelectionRect } = preview;
  clearFrameSelectionRef.current = preview.clearSelection;
  // The preview's URL version. Frozen while the reader has followed a link away
  // from the file: a write to the file must not pull them back on its own.
  const previewRevRef = useRef(0);
  if (!strayed) previewRevRef.current = reloadToken + diskVersion;

  // Live selection rect for the pill, translated to top-viewport coords when
  // the selection lives inside the HTML preview iframe.
  const resolveSelectionRect = useCallback((): DOMRect | null => {
    if (!selection?.inHtml) return selectionClientRect();
    return frameSelectionRect();
  }, [selection?.inHtml, frameSelectionRect]);

  // Drop a stale pill when the file changes.
  useEffect(() => { setSelection(null); }, [filePath]);

  // ── In-file search (⌘F) ────────────────────────────────────────────────────
  // ONE search bar for every render mode. The CodeMirror surface searches via
  // the editor handle (decorations); every DOM surface (markdown preview,
  // WYSIWYG, read-only <pre>) via DomSearchController, which paints with the CSS
  // Custom Highlight API — no DOM mutation, so refractor spans and the live
  // TipTap doc are never corrupted. The HTML preview's page finds and paints
  // itself (its bridge, the same rules), answering with its count.
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
    if (!loading && !showSource && isHtml) return null; // the page's own (findInPage)
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

  const pageChannel = preview.channel;
  /** The HTML preview finds in its page: the answer comes back as a message (frameFindRef). */
  const findInPage = htmlPreviewLive;
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchStatus({ count: 0, index: 0 });
    editorRef.current?.searchClose?.();
    domSearchRef.current?.ctrl.close();
    domSearchRef.current = null;
    pageChannel.send({ type: 'find-close' });
  }, [pageChannel]);

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
  frameFindRef.current = { open: openSearch, result: setSearchStatus };

  // Re-run the search when the query/case/surface changes. Debounced: the DOM
  // pass re-walks every text node, which a fast typist shouldn't pay per key.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      if (editingSource) {
        setSearchStatus(editorRef.current?.searchUpdate?.(searchQuery, searchCase) ?? { count: 0, index: 0 });
      } else if (findInPage) {
        pageChannel.send({ type: 'find', query: searchQuery.slice(0, 1000), caseSensitive: searchCase });
      } else {
        const ctrl = domSearchCtrl();
        setSearchStatus(ctrl ? ctrl.update(searchQuery, searchCase) : { count: 0, index: 0 });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, searchCase, editingSource, domSearchCtrl, data, findInPage, pageChannel]);

  const handleSearchNav = useCallback((dir: 1 | -1) => {
    if (editingSource) {
      setSearchStatus(editorRef.current?.searchNav?.(dir) ?? { count: 0, index: 0 });
    } else if (findInPage) {
      pageChannel.send({ type: 'find-nav', dir });
    } else {
      const ctrl = domSearchCtrl();
      setSearchStatus(ctrl ? ctrl.nav(dir) : { count: 0, index: 0 });
    }
  }, [editingSource, domSearchCtrl, findInPage, pageChannel]);

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
        // The reader was last in a chat or another column: the page find owns it.
        if (!el.closest('.file-viewer-overlay') && !fullscreen && pointerOwnedElsewhere(el)) return;
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
  useSelectionMatches(
    () => contentRef.current?.querySelector<HTMLElement>('.fv-wysiwyg-editor, .fv-md-preview, .file-viewer-code') ?? null,
    (body, text) => collectTextMatches(body, text, true, 2000),
    [filePath, showSource],
  );

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
    editorRef.current?.scrollToLine?.(line, lineTerm, lineEnd);
  }, [line, lineTerm, lineEnd, editingSource, data, baseHash]);

  const [pathCopied, setPathCopied] = useState(false);
  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    }).catch(() => {});
  }, [filePath]);

  const labelsVersion = useEntityLabelsVersion();
  const markdownHtml = useMemo(() => {
    if (!isMarkdown || !data?.content) return '';
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : undefined;
    return renderMarkdownWithRefs(data.content, dir, host, { imageVersion, taskIds: 'off' });
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

  // ── The same file, open in another view of this page ───────────────────────
  // Every view of a file used to hold a private copy and its own write path, so
  // a save in one was invisible in the others until they happened to re-read —
  // and the first thing the other one's own next save learned was a 409 against
  // the user's own change. Two channels now reach us, both keyed on the DOCUMENT
  // rather than on the surface:
  //  - the browser-local doc-saved signal (stores/file-save-signal.ts), which is
  //    synchronous and carries the bytes, so a clean sibling converges without a
  //    request and without waiting for the server;
  //  - the server's `notes:updated`, for the one writer that does not share this
  //    module state: the /notes editor saving through the notes API. (It also
  //    publishes locally, which is why the echo check below is not redundant —
  //    it is what keeps us from re-reading bytes we already hold.)
  const adoptOtherWriter = useCallback((sig?: DocSavedSignal) => {
    // Dirty buffer, or bytes we were not handed: Live Edit's pull is the only
    // path that can fold another writer's work into unsaved typing (three-way
    // merge, and an honest conflict when it overlaps). A pane with no editor
    // (truncated/binary read) has nothing to merge — it just re-reads.
    if (dirtyRef.current || sig?.content == null) {
      if (canEditRef.current) liveRef.current?.pullNow('other-view');
      else setSelfReload((n) => n + 1);
      return;
    }
    // Clean, and the writer handed us the exact bytes: converge in this tick.
    // ORDER: seed the editor first, then applySaved-style bookkeeping — the
    // second half drops the draft record the first half re-armed.
    noteBufferInstalled('adopt-other-writer', sig.contentHash);
    lockHashRef.current = sig.contentHash;
    baseContentRef.current = sig.content;
    applyEditorText(sig.content);
    applyAdopted(sig.content, sig.contentHash, sig.size ?? new TextEncoder().encode(sig.content).length);
  }, [applyAdopted, applyEditorText]);

  useEffect(() => {
    const onSaved = (sig: DocSavedSignal) => {
      if (sig.origin === viewIdRef.current) return; // our own write
      if (sig.contentHash === lockHashRef.current) return; // already these bytes
      log.info('file-editor', 'another view saved this file', {
        path: filePath, host, dirty: dirtyRef.current,
      });
      adoptOtherWriter(sig);
    };
    const unsubs = [subscribeDocSaved(fileDocKey(host, filePath), onSaved)];
    // A vault note is ALSO addressable by its vault path, which is the key the
    // /notes editor and the home Notes panel publish under.
    if (notePath) unsubs.push(subscribeDocSaved(noteDocKey(notePath), onSaved));
    return () => { for (const u of unsubs) u(); };
  }, [filePath, host, notePath, adoptOtherWriter]);

  useEvent('notes:updated', (data: unknown) => {
    if (!notePath) return;
    const d = data as { source?: unknown; contentHash?: unknown };
    if (typeof d?.source !== 'string' || typeof d.contentHash !== 'string') return;
    if (d.source !== `notes/${notePath.replace(/\.md$/, '')}`) return;
    if (d.contentHash === lockHashRef.current) return; // our own save, already applied
    // A save made anywhere in THIS browser already arrived through the local
    // signal, bytes included; re-reading for its echo would be pure cost.
    if (wasSavedHere(noteDocKey(notePath), d.contentHash)) return;
    log.info('file-editor', 'the note behind this file changed on disk', { path: filePath });
    adoptOtherWriter();
  });

  // ── Desktop hand-off (macOS console only) ──────────────────────────────────
  const { canReveal, reveal, error: revealError, clearError: clearRevealError } = useRevealFile(host);
  // Finder and the default app open on the Mac, not on a phone holding the page.
  // (The pointer, not the width: a narrow Mac window still reveals in Finder.)
  const coarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  // ── The document bar ("Document first", 2026-11-06) ────────────────────────
  // One quiet line above the file instead of a row of a dozen buttons: where the
  // file is (the container's lead, or its own name), the save state, the view
  // switch, Find and History as icons, and every rarer action behind ⋯. It is the
  // same line for every kind of file, so nothing appears and disappears in a
  // different place per file type. Saving is always live, so there is no Save
  // button, no Discard and no Live switch: the state reads Saving… / Saved, and a
  // file that could not be saved says why in the banner below, with its choices.
  const canFullscreen = isRenderable || raw === 'doc' || raw === 'image' || !!office || !!media;
  const canFind = !raw && !data?.binary && !data?.error;
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  // How much fits: the bar never wraps and never pushes a control off its end.
  // The width picks a tier (full over ~560px, compact over ~440px, else tight),
  // and the file's name has the last word: while the name is cut, the bar takes
  // the next step of BAR_STEPS, folding one more tool into ⋯, and it steps back
  // only once it is clearly wider than where the name was cut. Measured, not
  // guessed from the window, because the pane's width depends on the tree and
  // the chat beside it. Evan, 2026-11-09: fewer header buttons, the rest in the
  // dropdown, and the tools stay out while there is room.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barStep, setBarStep] = useState(0);
  const stepRef = useRef(barStep);
  const measureFitRef = useRef<((fresh?: boolean) => void) | null>(null);
  // Each step the name forced: the step it left, and the width it was cut at.
  const fitCutsRef = useRef<{ step: number; w: number }[]>([]);
  stepRef.current = barStep;
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const last = BAR_STEPS.length - 1;
    const measure = (fresh?: boolean) => {
      if (fresh) fitCutsRef.current = [];
      const w = el.getBoundingClientRect().width;
      const cuts = fitCutsRef.current = fitCutsRef.current.filter((c) => w < c.w + 48);
      let step = Math.max(barStepForWidth(w), ...cuts.map((c) => c.step + 1));
      if (step < last && stepRef.current === step) {
        const name = el.querySelector<HTMLElement>('.sfe-crumb.is-last .sfe-crumb-text, .fv-doc-crumb-file');
        if (name && name.scrollWidth > name.clientWidth + 1) { cuts.push({ step, w }); step += 1; }
      }
      step = Math.min(step, last);
      if (step !== stepRef.current) { stepRef.current = step; setBarStep(step); }
    };
    measureFitRef.current = measure;
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    const lead = el.querySelector('.fv-doc-bar-lead');
    if (lead) ro.observe(lead);
    return () => { ro.disconnect(); measureFitRef.current = null; };
  }, []);
  // A step frees room only once it is drawn: look at the name again then, so a
  // name still cut takes the next step without waiting for a resize.
  useLayoutEffect(() => { measureFitRef.current?.(); }, [barStep]);
  // Entering or leaving full screen changes the bar's width in one frame:
  // measure then, not when a later resize happens to come.
  useLayoutEffect(() => { measureFitRef.current?.(true); }, [fullscreen]);
  // Another file is another name: measure it afresh, from the full bar.
  useLayoutEffect(() => {
    if (!measureFitRef.current) return;
    // Now, not in the frame below: the old name's steps would draw this one low.
    fitCutsRef.current = [];
    stepRef.current = 0;
    setBarStep(0);
    const id = requestAnimationFrame(() => measureFitRef.current?.(true));
    return () => cancelAnimationFrame(id);
  }, [filePath]);
  const { fit: barFit, fold: barFold } = BAR_STEPS[barStep];
  const tight = barFit === 'tight';
  const openMore = () => {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) setMoreAt((cur) => (cur ? null : { x: r.right, y: r.bottom }));
  };
  const pathRow = splitPathRow(filePath);
  // The host's buttons folded at the last step, read when ⋯ opens (they are the host's, not ours).
  const foldedTrail = barFold >= 5 && moreAt
    ? [...(barRef.current?.querySelectorAll<HTMLButtonElement>('[data-bar-foldable]') ?? [])]
    : [];
  const moreItems: ContextMenuItem[] = [
    // Where the file is, in full: the bar shows only its last folders.
    {
      key: 'where', info: true, title: filePath,
      // The start of the path gives way; the file's own folder and its name never.
      label: (
        <span className="fv-more-path" title={filePath}>
          {/* Cut from its start, whole folders at a time (PathHead). */}
          {pathRow.head && <PathHead head={pathRow.head} />}
          {pathRow.folder && <span className="fv-more-path-folder">{pathRow.folder}</span>}
          <span className="fv-more-path-name">{pathRow.name}</span>
        </span>
      ),
    },
    // (No divider: the title block draws its own rule above the first action.)
    ...(barFold >= 2 && tightMenuItems?.length ? [...tightMenuItems, { divider: true }] : []),
    ...(foldedTrail.length ? [...foldedTrail.map((btn, i) => ({
      key: `trail-${i}`, label: btn.getAttribute('aria-label') || btn.textContent || '',
      toggle: true, checked: btn.getAttribute('aria-pressed') === 'true',
      onSelect: () => btn.click(),
    })), { divider: true }] : []),
    ...(barFold >= 4 && isRenderable ? [{
      key: 'view', label: showSource ? 'Show preview' : 'Show source', icon: showSource ? ICON_FILE : ICON_CODE,
      onSelect: () => switchTab(!showSource),
    }, { divider: true }] : []),
    ...(tight && media ? [
      { key: 'back3', label: 'Back 3 seconds', icon: ICON_SKIP_BACK, keepOpen: true, onSelect: () => skipBy(-3) },
      { key: 'fwd10', label: 'Forward 10 seconds', icon: ICON_SKIP_FORWARD, keepOpen: true, onSelect: () => skipBy(10) },
      ...PLAYBACK_RATES.map((r) => ({
        key: `rate-${r}`, label: `Speed ${r}×`, checked: playbackRate === r, keepOpen: true,
        onSelect: () => { setPlaybackRate(r); if (mediaRef.current) mediaRef.current.playbackRate = r; },
      })),
      { divider: true },
    ] : []),
    ...(barFold >= 3 && canFind ? [{
      key: 'find', label: 'Find in file', icon: ICON_SEARCH, onSelect: () => (searchOpen ? closeSearch() : openSearch()),
    }] : []),
    ...(barFold >= 1 && canEdit && editing ? [{
      key: 'history', label: 'History', icon: ICON_HISTORY, onSelect: () => setHistoryOpen((o) => !o),
    }] : []),
    ...((barFold >= 3 && canFind) || (barFold >= 1 && canEdit && editing) ? [{ divider: true }] : []),
    ...(notePath ? [{
      key: 'notes', label: 'Open in Notes', icon: ICON_NOTE,
      title: 'Open this note on the Notes page (tabs, backlinks, editing)',
      onSelect: () => navigate(`/notes?path=${encodeURIComponent(notePath)}`),
    }] : []),
    ...(!hidePopout && !fullscreen ? [{
      key: 'tab', label: 'Open in new tab', icon: ICON_NEW_TAB,
      onSelect: () => openPopout('file', { path: filePath, host, line }),
    }] : []),
    ...(canFullscreen ? [{
      key: 'fullscreen', label: fullscreen ? 'Exit fullscreen' : 'Fullscreen',
      icon: fullscreen ? ICON_COLLAPSE : ICON_EXPAND,
      onSelect: () => setFullscreen((f) => !f),
    }] : []),
    { divider: true },
    { key: 'copy-path', label: 'Copy path', icon: ICON_COPY, title: filePath, onSelect: handleCopyPath },
    {
      key: 'download', label: 'Download', icon: ICON_DOWNLOAD,
      onSelect: () => { window.location.href = downloadFileUrl(filePath, host); },
    },
    ...(canReveal && !coarsePointer ? [
      { key: 'finder', label: 'Reveal in Finder', icon: ICON_FOLDER, onSelect: () => reveal(filePath, 'finder') },
      {
        key: 'app', label: 'Open in default app', icon: ICON_OPEN_APP,
        title: 'Open in the macOS default application for this file type',
        onSelect: () => reveal(filePath, 'app'),
      },
    ] : []),
    ...(extraMenuItems?.length ? [{ divider: true }, ...extraMenuItems] : []),
  ];

  const fileName = filePath.split('/').pop() || filePath;
  // The host's home reads `~`, never its id or user name (utils/home-folder.ts).
  const parentDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const parentName = parentDir ? shownFolderName(parentDir, host) : '';
  const defaultLead = (
    <span className="fv-doc-crumbs" title={filePath}>
      {parentName && <span className="fv-doc-crumb-dir">{parentName}</span>}
      {parentName && <span className="fv-doc-crumb-sep" aria-hidden="true">/</span>}
      <span className="fv-doc-crumb-file">{fileName}</span>
    </span>
  );

  // Saving is live, so the state is mostly "Saved". It reads "Saving…" from the
  // first keystroke until the write lands, and "Not saved" while a pause or a
  // failed write holds the text back (the banner then says why).
  const saveHeld = live.suspended || saveConflict || saveRetry;
  const saveState: 'saved' | 'saving' | 'held' | 'waiting' =
    saveHeld ? 'held'
      : live.unreachable || (live.heldInvalid && dirty) ? 'waiting'
        : saving || live.writing || dirty ? 'saving'
          : 'saved';
  // The state belongs to the file, not to the surface on show: an HTML or MDX
  // preview of an editable file says Saved / Saving / Not saved too.
  const saveStateEl = !canEdit ? null : (
    <span
      className="fv-save-state"
      data-state={saveState}
      data-testid="fv-save-state"
      role="status"
      title={saveState === 'saved' ? 'Every change is saved to disk as you type'
        : saveState === 'saving' ? 'Saving your changes to disk'
          : saveState === 'waiting' ? (live.heldInvalid
            ? `Saves once the file is valid again: ${live.heldInvalid}`
            : 'Waiting to reach the file to save your changes')
            : 'Your changes are not saved yet: see the note below'}
    >
      {/* `fv-dirty-dot` marks text typed but not on disk yet: the page-wide
          unsaved-work check (utils/unsaved-work.ts) looks for it before a
          reload or an update. */}
      {saveState === 'saved' && !dirty ? <span className="fv-save-state-mark" aria-hidden="true">{ICON_CHECK}</span>
        : saveState === 'held'
          ? <span className={`fv-save-state-dot${dirty ? ' fv-dirty-dot' : ''}`} aria-hidden="true" />
          // Waiting writes nothing (text to become valid, the file to be
          // reachable): a still ring, not the spinner of a write on its way.
          : saveState === 'waiting'
            ? <span className={`fv-save-state-ring${dirty ? ' fv-dirty-dot' : ''}`} aria-hidden="true" />
            : <span className={`fv-save-state-spin${dirty ? ' fv-dirty-dot' : ''}`} aria-hidden="true" />}
      <span className="fv-save-state-word">
        {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'waiting' ? (live.heldInvalid ? 'Saving when valid' : 'Waiting to save') : 'Not saved'}
      </span>
    </span>
  );

  const docBar = (extra?: ReactNode) => (
    <div className="fv-html-toolbar fv-doc-bar" data-testid="fv-doc-bar" data-fit={barFit} data-fold={barFold} ref={barRef}>
      <div className="fv-doc-bar-lead">{barLeading ?? defaultLead}</div>
      <div className="fv-doc-bar-tools">
        {draftRestored && (
          <span
            className="fv-draft-note"
            role="status"
            title="Your unsaved changes were restored from this browser's draft store."
          >
            Draft restored
          </span>
        )}
        {/* Live Edit receipt: something arrived from another writer and was folded
            in. Transient (4s) and one line: it reports, it doesn't ask. */}
        {live.receipt && <span className="fv-draft-note fv-live-receipt" role="status">{live.receipt}</span>}
        {pathCopied && <span className="fv-draft-note" role="status">Path copied</span>}
        {saveStateEl}
        {isRenderable && tight && barFold < 4 && (
          /* No room for two words: one switch to the other view. */
          <button
            type="button"
            className="fv-doc-icon fv-mode-switch"
            onClick={() => switchTab(!showSource)}
            aria-label={showSource ? 'Show preview' : 'Show source'}
            title={showSource ? 'Show preview' : 'Show source'}
          >
            {showSource ? ICON_FILE : ICON_CODE}
          </button>
        )}
        {isRenderable && !tight && (
          <span className="fv-mode-toggle" role="group" aria-label="View">
            {/* Both tabs are LIVE EDITORS of the same file (rendered doc vs raw
                bytes), so switching carries the unsaved buffer across: the
                draft captured here seeds the next editor. No confirm needed. */}
            <button
              type="button"
              className={`fv-html-tab fv-mode-tab${!showSource ? ' active' : ''}`}
              aria-pressed={!showSource}
              aria-label={barFit === 'compact' ? 'Preview' : undefined}
              title={barFit === 'compact' ? 'Preview' : undefined}
              onClick={() => switchTab(false)}
            >
              {barFit === 'compact' ? ICON_FILE : 'Preview'}
            </button>
            <button
              type="button"
              className={`fv-html-tab fv-mode-tab${showSource ? ' active' : ''}`}
              aria-pressed={showSource}
              aria-label={barFit === 'compact' ? 'Source' : undefined}
              title={barFit === 'compact' ? 'Source' : undefined}
              onClick={() => switchTab(true)}
            >
              {barFit === 'compact' ? ICON_CODE : 'Source'}
            </button>
          </span>
        )}
        {extra}
        {canFind && barFold < 3 && (
          <button
            type="button"
            className={`fv-doc-icon fv-find-btn${searchOpen ? ' active' : ''}`}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            aria-pressed={searchOpen}
            aria-label="Find in file"
            title="Find in file (⌘F)"
          >
            {ICON_SEARCH}
          </button>
        )}
        {canEdit && editing && barFold < 1 && (
          /* Versions of THIS file. Sits with the edit state because restoring one
             is an edit (it lands in the buffer and is saved like typing). */
          <button
            type="button"
            className={`fv-doc-icon fv-history-btn${historyOpen ? ' active' : ''}`}
            onClick={() => setHistoryOpen((o) => !o)}
            aria-pressed={historyOpen}
            aria-label="History"
            title="Versions of this file: Walnut's snapshots of your opens and saves, plus git commits"
          >
            {ICON_HISTORY}
          </button>
        )}
        <button
          type="button"
          ref={moreBtnRef}
          className={`fv-doc-icon fv-more-btn${moreAt ? ' active' : ''}`}
          onClick={openMore}
          aria-haspopup="menu"
          aria-expanded={!!moreAt}
          aria-label="More file actions"
          title="More: open elsewhere, copy path, download"
        >
          {ICON_MORE}
        </button>
        {fullscreen && (
          <button
            type="button"
            className="fv-doc-icon fv-fullscreen-btn"
            onClick={() => setFullscreen(false)}
            aria-label="Exit fullscreen"
            title="Exit fullscreen (Esc)"
          >
            {ICON_COLLAPSE}
          </button>
        )}
      </div>
      {barTrailing}
      {moreAt && (
        <ContextMenu
          point={moreAt}
          align="right"
          items={moreItems}
          onClose={() => setMoreAt(null)}
          ariaLabel="File actions"
          testId="fv-more-menu"
          className="fv-more-menu"
          returnFocus={moreBtnRef.current}
        />
      )}
    </div>
  );

  const mediaControls = !media ? null : (
    <>
      <button
        type="button"
        className="fv-html-tab fv-skip-btn"
        onClick={() => skipBy(-3)}
        title="Back 3 seconds (←)"
        aria-label="Back 3 seconds"
      >
        {ICON_SKIP_BACK}<span>3s</span>
      </button>
      <button
        type="button"
        className="fv-html-tab fv-skip-btn"
        onClick={() => skipBy(10)}
        title="Forward 10 seconds (→)"
        aria-label="Forward 10 seconds"
      >
        <span>10s</span>{ICON_SKIP_FORWARD}
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
    </>
  );

  // Why the file is not saving, and the way out. Shown while a pause holds the
  // file even if the words were dismissed: the state chip says "Not saved" and
  // this is where it points.
  // A way out that worked hands the keyboard back to the text: the button it was
  // pressed on is gone, and the next keystroke belongs in the editor.
  // (After a frame: "use the disk version" remounts the editor first.)
  const backToText = () => { requestAnimationFrame(() => requestAnimationFrame(() => editorRef.current?.focus())); };
  const keepMine = async () => { if (await handleSave({ overwrite: true })) { live.resume(); backToText(); } };
  const useDisk = async () => { if (await handleDiscard()) { live.resume(); backToText(); } };
  const retrySave = async () => { if (await handleSave()) { live.resume(); backToText(); } };
  const conflictOpen = saveConflict || live.suspendedReason === 'conflict';
  const retryOpen = !conflictOpen && (saveRetry || live.suspendedReason === 'unreachable' || live.suspendedReason === 'refused');
  const reloadOpen = !conflictOpen && !retryOpen && live.suspendedReason === 'reload';
  const bannerText = saveError
    ?? (live.suspendedReason === 'conflict'
      ? 'This file changed somewhere else while you were editing, so saving is paused for it. Keep your version to replace it, or use the version on disk.'
      : live.suspendedReason === 'unreachable' ? liveUnreachablePausedMessage(live.unreachableHost ?? undefined)
      : live.suspendedReason === 'refused' ? 'Walnut could not save this file, so saving is paused for it. Your text is still in the editor: press Try again.'
      : live.suspendedReason === 'reload' ? 'This tab is running an older version of Walnut, so it can no longer save automatically. Reload the page to save again; your text is kept.'
      : null);

  return (
    <>
    {/* The sheet's backdrop, as every full screen has: a click on it leaves. In a
        portal because the view's own box is the sheet. */}
    {fullscreen && createPortal(
      <div className="open-walnut-fullscreen-backdrop fv-fullscreen-backdrop" onClick={() => setFullscreen(false)} />,
      document.body,
    )}
    <div
      className={`file-content-view${fullscreen ? ' fv-fullscreen' : ''}${media === 'video' ? ' fv-video-view' : ''}`}
      ref={contentRef}
      // Quote-to-ask for the READ-ONLY views (md preview of MDX, truncated
      // <pre>): DOM selection → pill. The editors report selections through
      // their own channels (CodeMirror onSelectText; WYSIWYG bubble-menu Ask),
      // so this handler is off while an editor owns the body.
      onMouseUp={onSelectCode && !editing ? handleMouseUp : undefined}
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
      {docBar(tight ? null : mediaControls)}
      {loading && <div className="file-viewer-loading">{loadingFrom ? `Still loading from ${loadingFrom}…` : 'Loading file...'}</div>}
      {reloading && <div className="fv-reloading-badge">{loadingFrom ? `Still loading from ${loadingFrom}…` : 'Reloading…'}</div>}
      {!loading && !reloading && loadingFrom && <div className="fv-reloading-badge">Still loading from {loadingFrom}…</div>}
      {!loading && data?.error && <div className="file-viewer-error">{data.error}</div>}
      {!loading && !raw && data?.binary && (
        <div className="file-viewer-error">
          Binary file ({formatSize(data.size)}) cannot be shown here. Download it from the ⋯ menu.
        </div>
      )}
      {!loading && raw === 'doc' && (
        <>
          <PdfPreview key={`${host ?? ''}:${filePath}`} path={filePath} host={host} reloadToken={reloadToken} />
        </>
      )}
      {!loading && raw === 'image' && (
        <>
          <div className="fv-image-preview">
            <img src={rawFileContentUrl(filePath, host, reloadToken)} alt={filePath} />
          </div>
        </>
      )}
      {/* Office documents (docx/xlsx/pptx…): read-only client-side render by
          lazy-loaded open-source libs, fed from the same raw-bytes URL. */}
      {!loading && office && (
        <>
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
      {/* Deliberately NOT .file-viewer-error: that class is the whole-pane empty
          state (height:100%, centered), which as a sibling of the editor grew to
          swallow the pane. A save error is a one-line BANNER above the editor. */}
      {/* Live mode's last write never reached the server and is being retried.
          A STATUS, not an error: live mode is still on, nothing is lost (the text
          is in the editor and in the draft store), nothing needs deciding. It is
          a strip and not a toolbar note because the toolbar is a non-wrapping
          row that a ~600px pane fills completely, where a shrinkable note is
          zero pixels wide (measured under Playwright at 1200x800 with the chat
          open). The 2026-09-24 incident was this state shown as a red "Failed to
          fetch" with live mode silently paused underneath: the strip exists so
          "not saving right now" is never invisible. Hidden behind a real error
          banner, which already says what to do. */}
      {live.unreachable && !saveError && (
        <div className="fv-offline-banner" role="status">
          Can't reach {live.unreachableHost ?? 'Walnut'} right now. Your edits are kept in the editor and will be saved on their own once it is back.
        </div>
      )}
      {bannerText && (
        <div className={`fv-save-error${conflictOpen || retryOpen || reloadOpen ? ' fv-save-held' : ''}`} role="alert">
          <span className="fv-save-error-text">{bannerText}</span>
          {conflictOpen && (
            <span className="fv-save-error-actions">
              <button type="button" className="fv-html-tab fv-keep-mine-btn" onClick={() => { void keepMine(); }} disabled={saving}>
                Keep my version
              </button>
              <button type="button" className="fv-html-tab fv-use-disk-btn" onClick={() => { void useDisk(); }} disabled={saving}>
                Use the version on disk
              </button>
            </span>
          )}
          {retryOpen && (
            <span className="fv-save-error-actions">
              <button type="button" className="fv-html-tab fv-retry-save-btn" onClick={() => { void retrySave(); }} disabled={saving}>
                {saving ? 'Saving…' : 'Try again'}
              </button>
            </span>
          )}
          {reloadOpen && (
            <span className="fv-save-error-actions">
              <button
                type="button"
                className="fv-html-tab fv-retry-save-btn fv-reload-btn"
                // The draft store already holds the text (every edit is captured),
                // so the reloaded tab replays it and saves it on its own.
                onClick={() => { void flushDraft().finally(() => window.location.reload()); }}
              >
                Reload the page
              </button>
            </span>
          )}
          {!conflictOpen && !retryOpen && !reloadOpen && saveError && (
            <button
              type="button"
              className="fv-save-error-dismiss"
              onClick={() => setSaveError(null)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              {ICON_CLOSE}
            </button>
          )}
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
            title="Put your unsaved text back in the editor. The copy on disk is newer, so you will be asked before it replaces that version."
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
      {!loading && showPreview && isHtml && strayed && (
        <div className="fv-draft-banner fv-strayed-banner" role="status">
          <button type="button" className="fv-html-tab" onClick={returnToFile}>
            ← Back to {filePath.split('/').pop() || filePath}
          </button>
          {strayed.path && onOpenPath && (
            <button
              type="button"
              className="fv-html-tab"
              onClick={() => { const p = strayed.path!; setStrayed(null); onOpenPath(p); }}
              title={strayed.path}
            >
              Open {strayed.path.split('/').pop() || strayed.path} here
            </button>
          )}
          <span className="fv-strayed-where" title={strayed.path}>
            {strayed.path ? `Preview moved to ${strayed.path}` : 'Preview moved to another page'}
          </span>
        </div>
      )}
      {!loading && showPreview && isHtml && (
        <iframe
          ref={htmlFrameRef}
          className="fv-html-preview"
          // `src` (not `srcDoc`) so the page has its OWN document URL — in-page
          // anchors, relative links and scripts resolve against the file itself
          // instead of navigating the Walnut SPA. Interactive (scripts, forms,
          // popups), but NEVER allow-same-origin: on Walnut's origin a page's script
          // reads the Passwords unlock and the device token (the server's CSP
          // sandbox, src/web/untrusted-doc.ts, says the same).
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          // reloadToken rides the URL: same-src iframes are never re-navigated,
          // which made Refresh a silent no-op on the rendered HTML preview. So
          // does the disk version: a save shows in the page it saved.
          src={rawFileContentUrl(filePath, host, previewRevRef.current)}
          title={filePath}
        />
      )}
      {/* Preview tab, files with no WYSIWYG surface: read-only markdown render
          (MDX, truncated markdown). Plain editable markdown never lands here —
          its Preview IS the WYSIWYG editor below. */}
      {!loading && showPreview && isMarkdown && (
        <div className="fv-md-preview markdown-body" dangerouslySetInnerHTML={stableHtml(markdownHtml)} />
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
            // The DISK bytes behind that seed. Equal to it for a clean open; the
            // disk bytes a replayed draft sits on top of; and deliberately
            // ABSENT after a stale-draft restore, where the base is bytes we no
            // longer hold — the editor then reports its own text as its base, so
            // an automatic write cannot match disk and is refused instead of
            // silently replacing someone else's newer file.
            baseValue={(draftRef.current != null ? draftBaseRef.current : baseContentRef.current) ?? undefined}
            path={filePath}
            host={host}
            imageVersion={imageVersion}
            onDirtyChange={setEditorDirty}
            onDocChange={handleDocChange}
            onSave={() => { void handleSave(); }}
            onAskSelection={onSelectCode ? handleAskSelection : undefined}
            onAskHere={canAskHere ? askHereFromBubble : undefined}
            onComment={canDocComment ? commentFromBubble : undefined}
          />
        ) : (
          <FileSourceEditor
            key={`src:${filePath}:${baseHash ?? ''}:${seedNonce}`}
            ref={editorRef}
            initialValue={draftRef.current ?? data.content}
            baseValue={(draftRef.current != null ? draftBaseRef.current : baseContentRef.current) ?? undefined}
            path={filePath}
            onDirtyChange={setEditorDirty}
            onDocChange={handleDocChange}
            onSave={() => { void handleSave(); }}
            initialLine={line}
            initialEndLine={lineEnd}
            initialFlashTerm={lineTerm}
            onSelectText={onSelectCode ? onSourceSelect : undefined}
            onSymbolClick={onSymbolLookup ? handleCmSymbolClick : undefined}
          />
        )
      )}
      {/* Read-only source (non-editable text: truncated reads etc.). */}
      {!loading && !editing && !showPreview && data?.content != null && data.content !== '' && (
        <pre className="file-viewer-code" dangerouslySetInnerHTML={stableHtml(lineNumberedHtml)} />
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
            currentText={() => bufferText() ?? data?.content ?? ''}
            onRestore={restoreHistoryVersion}
            onClose={() => setHistoryOpen(false)}
            refreshToken={versionsSeen}
            bufferToken={bufferToken}
          />
        </div>
      )}
      {canAskHere && !loading && data && !data.error && !data.binary && !raw && (
        <FileThreadLayer
          ref={threadLayerRef}
          filePath={filePath}
          sessionId={sessionId!}
          rootRef={contentRef}
          channel={htmlPreviewLive ? preview.channel : null}
          surface={threadSurface}
          surfaceNonce={`${filePath}:${baseHash ?? ''}:${seedNonce}:${reloadToken}:${threadSurface}:${data.content?.length ?? 0}`}
        />
      )}
      {canDocComment && !loading && data && !data.error && !data.binary && !raw && (
        <DocCommentsLayer
          ref={docCommentsRef}
          filePath={filePath}
          host={host}
          sessionId={sessionId!}
          rootRef={contentRef}
          surfaceNonce={`${filePath}:${baseHash ?? ''}:${seedNonce}:${reloadToken}:${threadSurface}:${data.content?.length ?? 0}`}
          surface={threadSurface}
          channel={htmlPreviewLive ? preview.channel : null}
          editor={editorRef}
          getDocText={docTextNow}
        />
      )}
      {askNotice && <FileAskNotice text={askNotice.text} />}
      {selection && (
        <SelectionAskPill
          anchor={selection}
          onCommit={commitSelection}
          onAskHere={canAskHere ? askHereFromSelection : undefined}
          onComment={canDocComment ? commentFromSelection : undefined}
          onDismiss={() => setSelection(null)}
          resolveRect={resolveSelectionRect}
          listenTo={selection.inHtml ? preview.scrollEvents : undefined}
          // Inside the file view's own box: never past the sheet's edge or over the file tree.
          boundsOf={() => contentRef.current}
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
    </>
  );
}
