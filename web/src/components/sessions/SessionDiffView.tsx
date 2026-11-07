import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type ReactNode, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import { useSelectionMatches } from '@/hooks/useSelectionMatches';
import { FileAskNotice } from '@/components/common/FileAskNotice';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { stableHtml } from '@/hooks/useStableHtml';
import { useDraft } from '@/hooks/useDraft';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { draftHash, draftKey } from '@/utils/drafts';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import {
  Diff, Hunk, Decoration, tokenize, markEdits, useSourceExpansion,
  getChangeKey, computeOldLineNumber, computeNewLineNumber, isDelete,
  type HunkData, type FileData, type ChangeData, type ChangeEventArgs, type EventMap,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { useSessionGitGlance, sessionGitStore } from '@/stores/session-git-store';
import { useChangedLiveRefresh, CHANGED_REFRESH_MIN_MS } from '@/hooks/useChangedLiveRefresh';
import { GitGlanceLineView, GitCheckedAgo } from './GitGlance';
import { fetchSessionChanges, fetchSessionFileChange, fetchFileChangeSummary, fetchChangesTriage, isWholeRepoBase, type SessionChangesResult, type SessionFileChange, type SessionDiffBase, type SessionDiffCompare, type SessionDiffScope, type FileChangeSummary, type GitCompareInfo } from '@/api/session-changes';
import { ApiError } from '@/api/client';
import { buildFileData, differsOnlyInWhitespace, unmarkWhitespaceEdits } from '@/components/sessions/diffPatch';
import { DiffComparePicker, forgetGitRefs, shortSha } from '@/components/sessions/DiffComparePicker';
import { changeSignature, compareKey, loadViewedMarks, saveViewedMarks, viewedState, type ViewedMarks, type ViewedState } from '@/components/sessions/diffViewed';
import { timeAgo } from '@/utils/time';
import { buildDiffTree, flattenFiles, allContainerIds, isMarkdownPath, type DiffTreeNode, type DiffTreeRepoNode } from '@/components/sessions/diffTree';
import { languageForPath, diffRefractor } from '@/components/sessions/diffHighlight';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { buildCommentMessage, buildReviewMessage } from '@/components/sessions/diffPrefill';
import { markdownBlocksWithLines, markdownCommentRange, type MarkdownBlock } from '@/components/sessions/diffMarkdownBlocks';
import { computeExpandGaps, oldSourceLineCount, UNFOLD_CHUNK, type ExpandGap } from '@/components/sessions/diffExpand';
import { segmentHunkForAuto, type DiffSegment } from '@/components/sessions/diffAutoSegment';
import { hiddenFunctionContext, splitSourceLines, type StickyDef } from '@/components/sessions/diffFuncContext';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SelectionAskPill } from '@/components/common/SelectionAskPill';
import { FILE_ASK_FAILURE_TEXT, FileThreadLayer, type FileAskResult, type FileThreadLayerHandle } from '@/components/common/FileThreadLayer';
import { useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import { DIFF_ASK_OFF_REASON, DIFF_CHROME_SKIP, diffPassageOf, type DiffPassage } from '@/utils/diff-passage';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import { FileContentView } from '@/components/common/FileContentView';
import { ReferencePanel } from '@/components/common/ReferencePanel';
import { CodeContextMenu, buildCodeContextTarget, type CodeContextTarget } from '@/components/common/CodeContextMenu';
import { fetchReferences, type ReferencesResponse } from '@/api/files';
import {
  DomSearchController, collectTextMatches,
  wordAtPoint, claimSearchOwner, onSearchOwnerLost, SYMBOL_RE,
} from '@/utils/dom-text-search';
import { ICON_REFRESH, ICON_WARNING, ICON_PANEL_LEFT, ICON_PANEL_LEFT_FILLED } from '@/components/common/Icons';
import { log } from '@/utils/log';
import { pointerOwnedElsewhere } from '@/utils/find-scope';
import { SessionCommitButton } from '@/components/sessions/SessionCommitDialog';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';

export type DiffViewType = 'split' | 'unified';
/** The toolbar layout mode: 'auto' picks per file — split only when some line
 *  changed IN PLACE (there's a left/right to compare), unified otherwise. */
export type DiffViewMode = DiffViewType | 'auto';

/** A file shown TEMPORARILY inside the Changed tab because a reference jump
 *  landed outside the change set. Read-only, visually grayed — it's context,
 *  not part of the review. */
interface GhostFile { file: string; line?: number; term?: string }

/** One stop in the in-tab jump history (⌘[ / ⌘] walk these). */
type DiffJumpStop =
  | { kind: 'change'; id: string; line?: number }
  | { kind: 'ghost'; ghost: GhostFile };

/** Line cells are found via react-diff-view's data-change-key — the ONLY line
 *  marker it emits (`N<oldLine>` context / `I<newLine>` insert / `D<oldLine>`
 *  delete; v3 removed data-line-number). N-keys carry the old-side number, so
 *  on files with insertions a context-line jump can land a few lines off —
 *  nearest-visible is the contract anyway (the exact line may be folded). */
function lineCellFor(main: HTMLElement, line: number): HTMLElement | null {
  return main.querySelector<HTMLElement>(`[data-change-key="I${line}"], [data-change-key="N${line}"]`);
}

/** Fallback when the exact target line sits inside a collapsed fold: land on
 *  the closest VISIBLE line so the jump still puts the target area on screen. */
function nearestLineCell(main: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const el of main.querySelectorAll<HTMLElement>('[data-change-key]')) {
    const m = /^[NID](\d+)$/.exec(el.getAttribute('data-change-key') ?? '');
    if (!m) continue;
    const d = Math.abs(Number(m[1]) - line);
    if (d < bestDist) { bestDist = d; best = el; }
  }
  return best;
}

/** Comparison-BASE options. Every mode is scoped to the repos THIS session
 *  edited — the base only changes the baseline `before`/`after` is read from,
 *  never which repo is shown (a session that edited nothing is empty in all).
 *
 *  Labels are deliberately plain-English ("what am I looking at?") instead of git
 *  jargon — with git-sync auto-committing every 30s, "vs last commit" vs "vs
 *  remote" can differ by hundreds of commits, and the old names gave no hint of
 *  that span. The CompareGraph schematic (shown on hover) visualizes the span.
 *
 *  'previous' (HEAD~1) is intentionally NOT offered: it only approximated "what
 *  this session did" when you'd committed exactly once, and "What this session
 *  changed" now answers that precisely regardless of commit count. The backend
 *  still accepts base=previous (tested + daemon-supported) — it's just not a
 *  user-facing choice anymore. */
const BASE_OPTIONS: ReadonlyArray<{ value: SessionDiffBase; label: string; hint: string }> = [
  { value: 'session', label: 'What this session changed', hint: "Everything THIS session edited — reconstructed from its own edit history, across any commits it made (no git baseline)" },
  { value: 'uncommitted', label: 'Uncommitted changes', hint: "Your working tree vs your last commit (git diff HEAD) — what you haven't committed yet" },
  { value: 'remote', label: 'Not yet pushed', hint: "Your working tree vs the remote branch (git diff @{upstream}) — everything not yet pushed, which may span many local commits" },
];

interface SessionDiffViewProps {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  /** Called when the user picks a line / selection to ask the agent about
   *  (prefills the chat input, doesn't send). */
  onSelectCode: (filePath: string, line: number | undefined, code: string) => void;
  /** Leave a comment on specific line(s): composes a located, code-quoted message
   *  and SENDS it to this session's main agent. When absent, falls back to
   *  onSelectCode (prefill only). Returns true if the send was accepted. */
  onComment?: (message: string) => boolean | void | Promise<boolean | void>;
  /** Chat segment of the full-width bar (the panel's chat toggle) — see
   *  SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
  /** Open a file in the Files tab at a line (reference-panel jumps). `term`
   *  is the symbol the jump was for — flashed at the landing line. */
  onOpenFile?: (path: string, line?: number, term?: string) => void;
  /** Leads the toolbar (the Changed tab's Files | Turns switch, SessionChangedTab). */
  toolbarLeadingSlot?: ReactNode;
}

/** An in-progress inline comment anchored to a line range within one file. */
interface CommentDraft {
  filePath: string;
  relPath: string;
  /** react-diff-view change key of the anchor line (where the widget renders). */
  anchorKey: string;
  /** Change keys of EVERY line in the selected range — kept so the range stays
   *  highlighted (via `selectedChanges`) while the composer is open, not just
   *  during the drag. */
  changeKeys: string[];
  /** Display location, e.g. "src/x.ts:L10" or "src/x.ts:L10-L14". */
  loc: string;
  /** The selected code lines (for quoting into the message). */
  code: string;
}

/** A RECORDED review comment (the "Add comment" path). Accumulates across files
 *  at the SessionDiffView level — surviving file switches — until the user
 *  submits the whole review in bulk or discards it. `id` is monotonic so removal
 *  is stable; `anchorKey`+`filePath` locate the inline card under its line. */
export interface PendingComment {
  id: number;
  filePath: string;
  anchorKey: string;
  /** Change keys of the commented line range — kept so the range stays
   *  highlighted in the diff after the comment is recorded (GitHub-style). */
  changeKeys: string[];
  loc: string;
  code: string;
  comment: string;
}

// Stable empty-hunks ref so useSourceExpansion's deps don't change identity when
// there's no parsed file (a new array each render would clear expansions / loop).
const EMPTY_HUNKS: HunkData[] = [];

/** Build a parsed FileData from a change. The crash-prone createPatch→parseDiff
 *  pipeline lives in diffPatch.ts (React-free, unit-tested); returns null on any
 *  failure so a single bad diff can never throw out of a useMemo and blank the panel. */
function buildFile(change: SessionFileChange, ignoreWhitespace: boolean): FileData | null {
  const file = buildFileData(change, { ignoreWhitespace });
  if (!file && change.before !== change.after && !(ignoreWhitespace && differsOnlyInWhitespace(change.before, change.after))) {
    log.warn('session-changes', 'buildFile produced no diff', { relPath: change.relPath });
  }
  return file;
}

/** Syntax + word-level token highlighting for a file's hunks. Combines Prism
 *  syntax colors (via refractor, when the file's language is known) with
 *  markEdits (intra-line add/del coloring). Highlighting is best-effort: any
 *  failure (or unknown language) falls back to plain markEdits-only tokens so a
 *  bad grammar can never throw out of the useMemo and blank the panel. */
/** Ignore whitespace, kept in THIS browser only (outside the ui-prefs mirror,
 *  which syncs open-walnut-*): a hidden-whitespace view left on elsewhere,
 *  days ago, must not silently hide changes in another review. */
const IGNORE_WS_KEY = 'walnut-diff-ignore-ws';

/** The server's answer when the asked branch or commit is in no repo of the session. */
const MISSING_REF_RE = /No repository this session works in has (branch|commit) /;

/** How often a shown git comparison re-reads the working tree (see the quiet
 *  refresh): often on this machine, sparingly over a remote host's link. */
const QUIET_REFRESH_LOCAL_MS = 3_000;
const QUIET_REFRESH_REMOTE_MS = 15_000;

/** Below this pane width Auto shows unified: two columns of code under ~360px each wrap every line. */
const AUTO_SPLIT_MIN_W = 720;

/** The two texts a diff compares, for a side-by-side view to show each side's own line. */
type DiffSides = { before: string; after: string };

function computeTokens(hunks: HunkData[], language: string | undefined, ignoreWhitespace = false, sides?: DiffSides): ReturnType<typeof tokenize> | undefined {
  // Hide whitespace turns lines that differ only in spaces into unchanged ones, which carry ONE
  // text (the new one). Side by side, each column must still show its own file's line: the old
  // column is tokenized from the old lines and the new column from the new ones.
  if (ignoreWhitespace && sides) {
    const oldLines = sides.before.split('\n');
    const newLines = sides.after.split('\n');
    const withNormals = (pick: (c: ChangeData & { oldLineNumber: number; newLineNumber: number }) => string | undefined): HunkData[] =>
      hunks.map((h) => ({ ...h, changes: h.changes.map((c) => (c.type === 'normal' ? { ...c, content: pick(c) ?? c.content } : c)) }));
    const oldSide = computeTokens(withNormals((c) => oldLines[c.oldLineNumber - 1]), language, true);
    const newSide = computeTokens(withNormals((c) => newLines[c.newLineNumber - 1]), language, true);
    if (oldSide && newSide) return { old: oldSide.old, new: newSide.new };
    return oldSide ?? newSide;
  }
  const enhancers = [markEdits(hunks, { type: 'block' }), ...(ignoreWhitespace ? [unmarkWhitespaceEdits] : [])];
  if (language) {
    try {
      return tokenize(hunks, { highlight: true, refractor: diffRefractor, language, enhancers });
    } catch (err) {
      log.warn('session-changes', 'syntax tokenize failed; falling back to plain', { language, error: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    return tokenize(hunks, { highlight: false, enhancers });
  } catch (err) {
    log.warn('session-changes', 'tokenize failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function useTokens(hunks: HunkData[] | undefined, relPath: string, ignoreWhitespace = false, sides?: DiffSides): ReturnType<typeof tokenize> | undefined {
  const language = useMemo(() => languageForPath(relPath), [relPath]);
  // Deferred OFF the first paint on purpose: tokenizing a whale diff takes
  // hundreds of ms, and doing it in a render-time useMemo blocked the first
  // frame of every newly opened file — a reference jump in the Changed tab
  // felt stuck while the Files tab (plain innerHTML) was instant. The table
  // paints uncolored, syntax colors land one tick later.
  const [tokState, setTokState] = useState<{ for: HunkData[]; tokens: ReturnType<typeof tokenize> | undefined } | null>(null);
  useEffect(() => {
    if (!hunks) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (!cancelled) setTokState({ for: hunks, tokens: computeTokens(hunks, language, ignoreWhitespace, sides) });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [hunks, language, ignoreWhitespace, sides]);
  // Tokens are positional per row — pairing stale tokens with NEW hunks (file
  // switch, expansion) would color the wrong lines. Render plain until the
  // recompute for THESE hunks lands.
  return hunks && tokState?.for === hunks ? tokState.tokens : undefined;
}

// ── File tree (left rail) ────────────────────────────────────────────────────

function isBinaryText(text: string): boolean {
  return text.indexOf('\0') !== -1;
}

function statusGlyph(status: SessionFileChange['status'], untracked?: boolean): { ch: string; cls: string; title: string } {
  if (untracked) return { ch: 'U', cls: 'untracked', title: 'Untracked: new, not added to git yet' };
  if (status === 'added') return { ch: 'A', cls: 'added', title: 'Added' };
  if (status === 'deleted') return { ch: 'D', cls: 'deleted', title: 'Deleted' };
  if (status === 'renamed') return { ch: 'R', cls: 'renamed', title: 'Renamed / moved' };
  return { ch: 'M', cls: 'modified', title: 'Modified' };
}

function TreeRow({
  node, depth, expanded, onToggle, selectedId, onSelectFile, critical, viewed, wsOnly,
}: {
  node: DiffTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelectFile: (change: SessionFileChange) => void;
  /** filePath → reason for the changeset's AI-triaged critical files (✦). */
  critical?: Map<string, string>;
  /** filePath → its Viewed state (absent = not viewed). */
  viewed?: Map<string, ViewedState>;
  /** Files whose every change is whitespace, while whitespace is hidden. */
  wsOnly?: Set<string>;
}) {
  const pad = { paddingLeft: 6 + depth * 14 };

  if (node.kind === 'file') {
    const g = statusGlyph(node.change.status, node.change.untracked);
    const isSel = selectedId === node.id;
    const vs = viewed?.get(node.change.filePath) ?? 'unviewed';
    const isWsOnly = wsOnly?.has(node.change.filePath) ?? false;
    const untracked = node.change.untracked ? ' (untracked: not added to git yet)' : '';
    const baseTitle = (node.change.status === 'renamed' && node.change.oldRelPath ? `${node.change.oldRelPath} → ${node.change.relPath}` : node.change.relPath)
      + untracked + (isWsOnly ? ' (only whitespace changed: hidden)' : '');
    return (
      <button
        className={`session-diff-tree-file${isSel ? ' is-selected' : ''}${vs === 'viewed' ? ' is-viewed' : ''}${isWsOnly ? ' is-ws-only' : ''}`}
        data-ws-only={isWsOnly ? 'true' : undefined}
        style={pad}
        title={vs === 'viewed' ? `${baseTitle} (viewed)` : vs === 'changed' ? `${baseTitle} (changed since you viewed it)` : baseTitle}
        onClick={() => onSelectFile(node.change)}
        data-viewed={vs}
      >
        <span className={`session-diff-tree-status status-${g.cls}`} title={g.title}>{g.ch}</span>
        <span className="session-diff-tree-name">{node.name}</span>
        {vs === 'viewed' && <span className="session-diff-tree-viewed" aria-label="viewed">{ICON_VIEWED_CHECK}</span>}
        {vs === 'changed' && <span className="session-diff-tree-changed" role="img" aria-label="changed since viewed" title="Changed since you viewed it" />}
        {critical?.has(node.change.filePath) && (
          <span className="session-diff-tree-critical" title={`AI: ${critical.get(node.change.filePath)}`}>✦</span>
        )}
        {node.change.status === 'renamed' && node.change.oldRelPath && (
          <span className="session-diff-tree-renamed-from" title={`moved from ${node.change.oldRelPath}`}>← {node.change.oldRelPath.split('/').pop()}</span>
        )}
        {node.change.partial && <span className="session-diff-tree-partial" title="Reconstructed best-effort (file changed on disk after the edit)">{ICON_WARNING}</span>}
      </button>
    );
  }

  // dir or repo
  const isOpen = expanded.has(node.id);
  const isRepo = node.kind === 'repo';
  return (
    <>
      <button
        className={`session-diff-tree-dir${isRepo ? ' is-repo' : ''}`}
        style={pad}
        onClick={() => onToggle(node.id)}
        title={isRepo ? `${node.label} (${node.repoKind})` : node.name}
      >
        <span className="session-diff-tree-caret">{isOpen ? '▾' : '▸'}</span>
        <span className="session-diff-tree-dir-name">{isRepo ? node.shortLabel : node.name}</span>
        {/* No pill for a submodule: the deep path in the tooltip already says so,
            and the pill only ate width the name needs in a narrow column. */}
        {isRepo && node.repoKind !== 'submodule' && (
          <span className={`session-diff-tree-repokind kind-${node.repoKind}`}>{node.repoKind}</span>
        )}
        <span className="session-diff-tree-count">{node.fileCount}</span>
      </button>
      {isOpen && node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          selectedId={selectedId}
          onSelectFile={onSelectFile}
          critical={critical}
          viewed={viewed}
          wsOnly={wsOnly}
        />
      ))}
    </>
  );
}

const ICON_WHITESPACE = (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden><path d="M2 8.5v2.5h10V8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const ICON_VIEWED_CHECK = (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><path d="M2.5 6.4 4.9 8.7 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

// ── Inline comment box (rendered under a line via react-diff-view `widgets`) ───

/**
 * The line-comment composer. Offers the TWO submit options the design calls for:
 *  - "Add comment" (primary): records the comment to the pending review batch —
 *    it stays on the line, gets a Copy button, and is sent with the rest on
 *    "Submit review". This is the GitHub PR-review default.
 *  - "Send now" (secondary): fires this one comment straight to the agent
 *    immediately (the old behavior), bypassing the batch.
 * ⌘/Ctrl+Enter = Add (the default); ⌘/Ctrl+Shift+Enter = Send now.
 */
function CommentBox({ loc, keepKey, onAdd, onSendNow, onCancel, onDirtyChange, lineChanged = false }: {
  loc: string;
  /** The commented lines read differently now (the session edited them while the box was open). */
  lineChanged?: boolean;
  /** Where the half-typed comment is kept (per session and line) until it is added, sent or cancelled. */
  keepKey: string;
  onAdd: (text: string) => void;
  onSendNow: (text: string) => void;
  onCancel: () => void;
  /** Reports whether the box holds unsaved text. The parent uses this to LOCK the
   *  composer: while it's dirty, clicking another line is ignored so a half-typed
   *  comment is never silently discarded — the user must Add / Send now / Cancel. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const draft = useDraft(keepKey);
  const { text, setText } = draft;
  const ref = useRef<HTMLTextAreaElement>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // Kept words reopen the box dirty, so the lock holds them as it holds fresh typing.
  useEffect(() => { if (draft.text.trim()) onDirtyChange?.(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Clear the dirty lock when this box goes away (Add / Send / Cancel / file switch).
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const update = (v: string) => { setText(v); onDirtyChange?.(v.trim().length > 0); };
  const add = () => { const t = text.trim(); if (t) { mic.current?.clear(); draft.clear(); onAdd(t); } };
  const sendNow = () => { const t = text.trim(); if (t) { mic.current?.clear(); draft.clear(); onSendNow(t); } };
  const cancel = () => { draft.clear(); onCancel(); };
  // Add and Send now pressed while the mic records wait for its last words.
  const addGate = useSendAfterDictation([mic], add);
  const sendNowGate = useSendAfterDictation([mic], sendNow);
  const wordsComing = addGate.micBusy || addGate.waiting || sendNowGate.waiting;
  return (
    <div className="session-diff-comment-box">
      <div className="session-diff-comment-loc">{loc}</div>
      {lineChanged && (
        <div className="session-diff-comment-changed" role="status" data-testid="session-diff-comment-changed">
          The code here changed since you started this comment
        </div>
      )}
      <textarea
        ref={ref}
        className="session-diff-comment-input"
        data-draft-key={draft.key ?? undefined}
        placeholder="Leave a comment… (⌘/Ctrl+Enter to add, +Shift to send now)"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (e.shiftKey) sendNowGate.send(); else addGate.send();
          // Esc closes the box and keeps its words (they come back on this line); Cancel drops them.
          } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          e.stopPropagation();
        }}
        rows={3}
      />
      <div className="session-diff-comment-actions">
        <BoxMic boxRef={ref} text={text} setText={update} handleRef={mic} />
        <button className="session-diff-comment-cancel" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>Cancel</button>
        <button className="session-diff-comment-sendnow" onMouseDown={(e) => e.preventDefault()} onClick={sendNowGate.send} disabled={!text.trim() && !wordsComing} {...dictationWaitProps(sendNowGate, 'Send this one comment to the agent right now')}>Send now</button>
        <button className="session-diff-comment-add" onMouseDown={(e) => e.preventDefault()} onClick={addGate.send} disabled={!text.trim() && !wordsComing} {...dictationWaitProps(addGate, 'Record this comment; submit the whole review at the end')}>Add comment</button>
      </div>
    </div>
  );
}

/** A recorded (pending) review comment, rendered read-only under its line with
 *  Copy (copies the composed `Re: …` message) and Remove. */
function PendingCommentCard({ loc, code, comment, onCopy, onRemove }: {
  loc: string;
  code: string;
  comment: string;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="session-diff-pending-card" data-pending-loc={loc}>
      <div className="session-diff-pending-head">
        <span className="session-diff-pending-loc" title={loc}>{loc}</span>
        <div className="session-diff-pending-actions">
          <button className="session-diff-pending-copy" onClick={copy} title="Copy this comment">
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="session-diff-pending-remove" onClick={onRemove} title="Remove this comment">✕</button>
        </div>
      </div>
      <div className="session-diff-pending-body">{comment}</div>
      {/* code kept for copy composition; not shown to avoid duplicating the diff line */}
      <span hidden>{code}</span>
    </div>
  );
}

// ── Expand-collapsed-context control (GitHub-style "unfold") ──────────────────

/** The unfold control rendered (via `Decoration`) in place of a collapsed block
 *  of unchanged lines — VS Code sticky-scroll style, two stacked rows:
 *
 *  1. STICKY ROW (only when a definition is actually hidden in this gap): the
 *     definition line pinned verbatim — ghost line number, original indentation,
 *     faded italic — per column in split view, stacked in unified when the two
 *     sides differ. Clicking it reveals the gap down to that definition. A
 *     definition that's visible on screen, or already pinned by an earlier bar,
 *     yields no sticky row (see hiddenFunctionContext) — so one long function
 *     never repeats its signature across consecutive bars.
 *  2. RAIL: a thin strip with the compact controls centered — ↓/↑ reveal one
 *     UNFOLD_CHUNK slice nearest the adjacent hunk, `↕ N` reveals everything.
 *     Directions that don't apply render disabled, not absent, so the buttons
 *     sit in the same place on every bar. */
function ExpandRow({ lines, split, funcOld, funcNew, onAll, onUp, onDown, onJumpOld, onJumpNew }: {
  lines: number;
  /** Split view pins old/new side by side; unified stacks them. */
  split: boolean;
  /** The hidden definition to pin, per diff side (null = nothing hidden). */
  funcOld?: StickyDef | null;
  funcNew?: StickyDef | null;
  onAll: () => void;
  onUp?: () => void;
  onDown?: () => void;
  /** Reveal the gap down to the pinned definition (per side). */
  onJumpOld?: () => void;
  onJumpNew?: () => void;
}) {
  const big = lines > UNFOLD_CHUNK;
  const pin = (def: StickyDef, onJump: (() => void) | undefined, side: 'old' | 'new') => (
    <button
      key={side}
      className="session-diff-sticky-cell"
      onClick={onJump}
      disabled={!onJump}
      title={onJump ? `Reveal down to line ${def.line}` : undefined}
    >
      <span className="session-diff-sticky-num">{def.line}</span>
      <span className="session-diff-sticky-code">{def.raw}</span>
    </button>
  );
  // Unified view: one column — when both sides pin the SAME text, one row is
  // enough (the reader can't tell sides apart there anyway).
  const unifiedDefs: Array<[StickyDef, (() => void) | undefined, 'old' | 'new']> =
    funcOld && funcNew && funcOld.raw === funcNew.raw
      ? [[funcOld, onJumpOld, 'old']]
      : ([[funcOld, onJumpOld, 'old'], [funcNew, onJumpNew, 'new']] as Array<[StickyDef | null | undefined, (() => void) | undefined, 'old' | 'new']>)
        .filter((d): d is [StickyDef, (() => void) | undefined, 'old' | 'new'] => !!d[0]);
  return (
    <div className="session-diff-expander">
      {split ? (funcOld || funcNew) && (
        <div className="session-diff-sticky is-split">
          <span className="session-diff-sticky-half">{funcOld && pin(funcOld, onJumpOld, 'old')}</span>
          <span className="session-diff-sticky-half">{funcNew && pin(funcNew, onJumpNew, 'new')}</span>
        </div>
      ) : unifiedDefs.length > 0 && (
        <div className="session-diff-sticky">
          {unifiedDefs.map(([def, onJump, side]) => pin(def, onJump, side))}
        </div>
      )}
      <div className="session-diff-expand-rail">
        {big && (
          <>
            <button className="session-diff-expand-btn is-dir" onClick={onDown} disabled={!onDown} title={`Show ${UNFOLD_CHUNK} lines below`}>↓ {UNFOLD_CHUNK}</button>
            <button className="session-diff-expand-btn is-dir" onClick={onUp} disabled={!onUp} title={`Show ${UNFOLD_CHUNK} lines above`}>↑ {UNFOLD_CHUNK}</button>
          </>
        )}
        <button className="session-diff-expand-btn is-all" onClick={onAll} title={`Show all ${lines} hidden line${lines === 1 ? '' : 's'}`}>
          ↕ {lines}
        </button>
      </div>
    </div>
  );
}

/** One auto-mode region: its own <Diff> table in the layout the region earned
 *  (split for an in-place replacement, unified for everything else — see
 *  diffAutoSegment.ts). Tokens are computed per segment; change objects are
 *  shared with the source hunks, so widgets/gutter events/selection keys all
 *  keep working, just spread across tables. */
function SegmentDiff({ seg, diffType, relPath, widgets, gutterEvents, selectedChanges, dragging, ignoreWhitespace }: {
  seg: DiffSegment;
  ignoreWhitespace: boolean;
  diffType: FileData['type'];
  relPath: string;
  widgets: Record<string, ReactNode> | undefined;
  gutterEvents: EventMap;
  selectedChanges: string[];
  dragging: boolean;
}) {
  const segHunks = useMemo(() => [seg.hunk], [seg.hunk]);
  const tokens = useTokens(segHunks, relPath, ignoreWhitespace);
  return (
    <Diff
      viewType={seg.viewType}
      diffType={diffType}
      hunks={segHunks}
      tokens={tokens}
      widgets={widgets}
      gutterEvents={gutterEvents}
      selectedChanges={selectedChanges}
      className={`session-diff-table session-diff-segment is-${seg.viewType} session-diff-commentable${dragging ? ' is-dragging' : ''}`}
    >
      {(hs) => hs.map((h) => <Hunk key={h.content} hunk={h} />)}
    </Diff>
  );
}

// ── Rendered markdown pane ────────────────────────────────────────────────────

/** The rendered HTML body of one markdown block, isolated behind React.memo
 *  keyed on the html string — see RenderedMarkdown's note on why this prevents
 *  the "selection collapses on re-render" bug. */
const MarkdownBlockBody = memo(function MarkdownBlockBody({ html }: { html: string }) {
  return <div className="markdown-body session-diff-rendered-block" dangerouslySetInnerHTML={stableHtml(html)} />;
});

/** One rendered markdown block with a DRAGGABLE source line number on its left
 *  (same comment affordance as the diff gutter): clicking the number opens the
 *  comment composer under this row; dragging DOWN the line-number column selects a
 *  contiguous range of blocks (GitHub-style multi-line comment), and any recorded
 *  comments for this line stack beneath it. `active` tints the row while it's part
 *  of the live drag / open composer's range, or it has recorded cards. The drag is
 *  driven by `index` (the block's position in renderedBlocks), mirroring how the
 *  diff gutter drags by flatChanges index. */
function RenderedMarkdownRow({ line, html, index, active, onLineDown, onLineEnter, onLineUp, children }: {
  line: number;
  html: string;
  /** Position in renderedBlocks — the unit a range drag selects over. */
  index: number;
  active: boolean;
  onLineDown: (index: number, e: ReactMouseEvent) => void;
  onLineEnter: (index: number) => void;
  onLineUp: () => void;
  /** Pending cards + open composer for this line, rendered under the block. */
  children?: ReactNode;
}) {
  return (
    <div className={`session-diff-rendered-row${active ? ' is-active' : ''}`}>
      <button
        className="session-diff-rendered-lineno"
        title={`Comment on line ${line} — or drag to select a range`}
        onMouseDown={(e) => onLineDown(index, e)}
        onMouseEnter={() => onLineEnter(index)}
        onMouseUp={onLineUp}
      >{line}</button>
      <div className="session-diff-rendered-main">
        <MarkdownBlockBody html={html} />
        {children}
      </div>
    </div>
  );
}

/** The rendered-markdown body: source content rendered as HTML with a left
 *  line-number gutter (each top-level block tagged with the source line it
 *  begins on). The line numbers are CLICKABLE — clicking one leaves a comment on
 *  that line, exactly like the diff view's gutter, so a markdown file is just as
 *  commentable in rendered mode as in diff mode.
 *
 *  WHY blocks + React.memo on the body: selecting text fires the parent's
 *  onMouseUp → setSelection → FileDiffPane re-renders. Inlining
 *  `dangerouslySetInnerHTML` would make React re-apply innerHTML on every such
 *  re-render (new object identity), tearing down and rebuilding all the text
 *  nodes and COLLAPSING the live selection ~3ms after mouseup. Memoizing the body
 *  on its html means a selection-only re-render is a no-op, so the live selection
 *  survives. */
const RenderedMarkdown = memo(function RenderedMarkdown({ blocks, dragging, renderRow }: {
  blocks: MarkdownBlock[];
  /** True while a line-number range drag is in progress (suppresses body text selection). */
  dragging: boolean;
  /** Render the comment composer + recorded cards for a given block. */
  renderRow: (block: MarkdownBlock, index: number) => ReactNode;
}) {
  return (
    <div className={`session-diff-rendered markdown-rendered-gutter${dragging ? ' is-dragging' : ''}`}>
      {blocks.map((b, i) => renderRow(b, i))}
    </div>
  );
});

// ── AI summary strip ──────────────────────────────────────────────────────────

/** Client-side memo of fetched summaries, module-level ON PURPOSE:
 *  FileDiffPane is keyed on filePath and remounts per file switch, so
 *  component state can't survive navigation. Capped (FIFO) — the server is
 *  content-hash cached anyway, so evictions only cost a fast re-fetch. */
const aiSummaryMemo = new Map<string, FileChangeSummary>();
const AI_SUMMARY_MEMO_CAP = 200;
/** Triage results (critical-file map) per changeset shape — the server caches
 *  too; this only avoids a refetch on remount. */
const triageMemo = new Map<string, Map<string, string>>();
/** Latched when the server answers 503 + {code:'ai_disabled'} (test env / AI
 *  globally off) — an environment fact, so page-lifetime by design; turning
 *  the ✦ toggle back on re-probes. Plain 503s (transient content-unavailable)
 *  must NOT latch. */
let aiSummaryUnavailable = false;

/** djb2 over the content. Lengths/op-counts alone miss same-length edits
 *  (x=1 → x=2), which would caption a diff the summary no longer describes.
 *  O(n), but only computed on file switch (memoized by the caller). */
function contentDigest(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

function summaryMemoKey(sessionId: string, change: SessionFileChange): string {
  return `${sessionId}:${change.filePath}:${change.status}:${contentDigest(change.before)}:${contentDigest(change.after)}`;
}

/** Isolated Marked instance — deliberately NOT the app's global singleton or
 *  markdownToRichHtml: the global gets retuned app-wide (image-path codespans
 *  become <img>, task-pill links), and summaries are MODEL output derived from
 *  arbitrary repo content (prompt-injectable). Tightest posture: plain gfm
 *  parse + a hard DOMPurify allowlist (no links, no images, no attributes). */
const summaryMarked = new Marked({ gfm: true, breaks: true });
const SUMMARY_SANITIZE = { ALLOWED_TAGS: ['p', 'br', 'code', 'em', 'strong'], ALLOWED_ATTR: [] as string[] };

function renderSummaryHtml(md: string): string {
  try {
    const raw = summaryMarked.parse(md);
    return DOMPurify.sanitize(typeof raw === 'string' ? raw : '', SUMMARY_SANITIZE);
  } catch {
    return DOMPurify.sanitize(md, SUMMARY_SANITIZE);
  }
}

/**
 * The ✦ strip above a file's diff: one short AI blurb — what this file's
 * change does and where it sits in the overall changeset. Generation is
 * server-side (cheap model, content-hash cached); this component only shows a
 * skeleton while it runs and hides itself quietly when summaries are off or
 * failing (a review tool must never block on decoration).
 */
function AiFileSummary({ sessionId, change }: { sessionId: string; change: SessionFileChange }) {
  const key = useMemo(() => summaryMemoKey(sessionId, change), [sessionId, change]);
  const [result, setResult] = useState<FileChangeSummary | null>(() => aiSummaryMemo.get(key) ?? null);
  const [state, setState] = useState<'loading' | 'done' | 'error' | 'hidden'>(
    () => (aiSummaryMemo.has(key) ? 'done' : aiSummaryUnavailable ? 'hidden' : 'loading'),
  );
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (aiSummaryMemo.has(key)) { setResult(aiSummaryMemo.get(key)!); setState('done'); return; }
    if (aiSummaryUnavailable) { setState('hidden'); return; }
    const ctrl = new AbortController();
    setState('loading');
    fetchFileChangeSummary(sessionId, change.filePath, { signal: ctrl.signal })
      .then((res) => {
        // Memo set BEFORE the abort bail on purpose: a fetch that lands after
        // the user switched away still warms the memo for their return.
        if (aiSummaryMemo.size >= AI_SUMMARY_MEMO_CAP) {
          const oldest = aiSummaryMemo.keys().next().value;
          if (oldest !== undefined) aiSummaryMemo.delete(oldest);
        }
        aiSummaryMemo.set(key, res);
        if (ctrl.signal.aborted) return;
        setResult(res);
        setState('done');
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError) {
          // Only the explicit ai_disabled marker means "off for good" — a bare
          // 503 is a transient content hiccup and must not kill the feature.
          const code = (err.body as { code?: string } | undefined)?.code;
          if (err.status === 503 && code === 'ai_disabled') {
            aiSummaryUnavailable = true;
            setState('hidden');
            return;
          }
          // 422 = this file is never summarizable (secrets/binary) → no strip,
          // no retry (retrying can't succeed). 404 = the session never touched
          // this file (git bases can list files outside the session changeset)
          // — equally unretryable, hide quietly.
          if (err.status === 422 || err.status === 404) {
            setState('hidden');
            return;
          }
        }
        log.info('session-changes', 'ai summary fetch failed', { sessionId, filePath: change.filePath, error: String(err) });
        setState('error');
      });
    return () => ctrl.abort();
  }, [sessionId, change.filePath, key, retryTick]);

  const html = useMemo(() => (result ? renderSummaryHtml(result.summary) : ''), [result]);

  if (state === 'hidden') return null;
  return (
    <div className={`session-diff-ai-summary is-${state}`}>
      <span className="session-diff-ai-icon" aria-hidden>✦</span>
      {state === 'loading' && (
        <span className="session-diff-ai-skeleton" role="status" aria-label="Generating AI summary" aria-busy>
          <span /><span /><span />
        </span>
      )}
      {state === 'done' && result && (
        <span
          className="session-diff-ai-text"
          title={result.cached ? `AI summary (cached) · ${result.model}` : `AI summary · ${result.model}`}
          dangerouslySetInnerHTML={stableHtml(html)}
        />
      )}
      {state === 'error' && (
        <span className="session-diff-ai-text is-error">
          AI summary unavailable ·{' '}
          <button type="button" className="session-diff-ai-retry" onClick={() => setRetryTick((t) => t + 1)}>Retry</button>
        </span>
      )}
    </div>
  );
}

// ── Single-file diff (center) ─────────────────────────────────────────────────

// memo is load-bearing: SessionDiffView re-renders on every small state change
// (jump history, search status, reference panel) and an unmemoized whale table
// re-reconciled for ~1s each time — measured as a 1s reference-jump stall. All
// props are stable identities (useMemo'd change/pending, useCallback'd handlers).
export const FileDiffPane = memo(function FileDiffPane({
  change, viewType, rendered, sessionCwd, sessionHost, pending, sessionId, aiSummaryOn,
  onAddComment, onSendNow, onCopyComment, onRemoveComment,
  ignoreWhitespace = false, onShowWhitespace, onShowUncommitted, viewedState, onToggleViewed, onNextUnviewed, onToggleRendered,
}: {
  change: SessionFileChange;
  viewType: DiffViewMode;
  rendered: boolean;
  /** Lines that differ only in whitespace read as unchanged (toolbar toggle). */
  ignoreWhitespace?: boolean;
  /** Turn ignoreWhitespace off (offered when a file changed ONLY in whitespace). */
  onShowWhitespace?: () => void;
  /** A Markdown file: switch between its diff and its rendered view (the header's Rendered toggle). */
  onToggleRendered?: () => void;
  /** Switch to the Uncommitted comparison (offered when a file's session edit could not be rebuilt). */
  onShowUncommitted?: () => void;
  /** The file's Viewed mark; absent = no Viewed control (the Turns view). */
  viewedState?: ViewedState;
  onToggleViewed?: (filePath: string) => void;
  /** Open the next file not yet viewed (offered once this one is). */
  onNextUnviewed?: (() => void) | null;
  sessionCwd?: string;
  sessionHost?: string;
  sessionId: string;
  /** The toolbar ✦ toggle — off = no strip AND no fetches. */
  aiSummaryOn: boolean;
  /** Recorded comments anchored in THIS file (subset of the review batch). */
  pending: PendingComment[];
  /** Record a comment to the pending review batch (the "Add comment" path). */
  onAddComment: (c: { filePath: string; anchorKey: string; changeKeys: string[]; loc: string; code: string; comment: string }) => void;
  /** Send a single comment to the agent immediately (the "Send now" path). */
  onSendNow: (message: string) => void;
  /** Copy a single recorded comment's composed text to the clipboard. */
  onCopyComment: (c: PendingComment) => void;
  /** Remove a recorded comment from the batch. */
  onRemoveComment: (id: number) => void;
}) {
  // A NUL byte means binary (an untracked image, an archive): never parsed into lines of garbage.
  const binary = useMemo(() => isBinaryText(change.before) || isBinaryText(change.after), [change.before, change.after]);
  const file = useMemo(() => (binary ? null : buildFile(change, ignoreWhitespace)), [binary, change, ignoreWhitespace]);
  // Expand collapsed context on demand: we already hold the full OLD source as
  // `change.before` (git HEAD/upstream content, or the reconstructed pre-session
  // file), so react-diff-view can splice the hidden surrounding lines back in.
  // `hunks` is the (possibly expanded) set actually rendered; `expandRange(start,
  // end)` reveals old-side lines [start,end). The hook auto-clears expansions when
  // `file.hunks` identity or the source changes — i.e. on every file switch.
  const [hunks, expandRange] = useSourceExpansion(file?.hunks ?? EMPTY_HUNKS, change.before ?? null);
  const sides = useMemo<DiffSides>(() => ({ before: change.before, after: change.after }), [change.before, change.after]);
  const tokens = useTokens(hunks, change.relPath, ignoreWhitespace, sides);

  // Auto-reveal tiny BETWEEN-hunk gaps: two hunks separated by ≤ UNFOLD_CHUNK
  // unchanged lines read better as one continuous block than as two sections
  // split by an expand bar. ALL small gaps go in ONE pass: ranges are absolute
  // old-side coordinates and useSourceExpansion applies them via a reducer, so
  // the batch costs one re-render (and one re-tokenize) — the old
  // one-gap-per-pass loop re-tokenized the whole file once per gap, which is a
  // big part of why opening a many-hunk file felt slow. The file's head/tail
  // gaps keep their bars: auto-showing dozens of leading imports would be
  // noise, not context.
  //
  // triedRef is the no-progress brake: if expandRange can't actually reveal a
  // range (truncated/partial `before` content) but still returns a fresh hunks
  // identity, retrying the same range forever would wedge the whole tab in a
  // render loop. Each range is attempted ONCE per file/source.
  const autoExpandTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => { autoExpandTriedRef.current.clear(); }, [change.filePath, change.before]);
  useEffect(() => {
    const gaps = computeExpandGaps(hunks, oldSourceLineCount(change.before));
    for (const g of gaps) {
      if (!(g.hunkIndex > 0 && g.hunkIndex < hunks.length && g.lines <= UNFOLD_CHUNK)) continue;
      const key = `${g.all[0]}:${g.all[1]}`;
      if (autoExpandTriedRef.current.has(key)) continue;
      autoExpandTriedRef.current.add(key);
      expandRange(g.all[0], g.all[1]);
    }
  }, [hunks, change.filePath, change.before, expandRange]);

  // Added files have no "before" — a split view would show an empty left pane.
  // Force unified so the whole new file reads as one continuous green column
  // (GitHub does the same for brand-new files). Deleted files are the mirror.
  const isWholeFile = change.status === 'added' || change.status === 'deleted';
  // Auto layout is PER REGION, not per file: replacements (a run with both
  // deletes and inserts) get side-by-side, everything else — context, pure
  // insertions/deletions — stays full-width unified. One in-place edit must
  // not flip a 700-line-insertion file into a blank left column.
  // A pane too narrow for two readable code columns (the chat beside it, a
  // small window) reads Auto as plain unified; Split stays the user's call.
  const paneRef = useRef<HTMLDivElement>(null);
  const [narrowPane, setNarrowPane] = useState(false);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setNarrowPane(el.clientWidth > 0 && el.clientWidth < AUTO_SPLIT_MIN_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const autoHybrid = viewType === 'auto' && !isWholeFile && !narrowPane;
  // The single-<Diff> layout used when a fixed mode is forced (or the file is
  // whole-file). In auto the hybrid path below renders instead.
  // Split in a pane too narrow for two code columns reads as unified (the header says so); a wider pane splits again.
  const splitTooNarrow = viewType === 'split' && narrowPane && !isWholeFile;
  const effectiveViewType: DiffViewType = isWholeFile || viewType === 'auto' || splitTooNarrow ? 'unified' : viewType;

  // The line the user clicked the gutter on → an open comment draft anchored there.
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  // Pill titles in the rendered-markdown view resolve from the entity-label
  // store — re-render when an observed title changes (memo boundary above).
  const labelsVersion = useEntityLabelsVersion();
  // True while the open composer holds unsaved text. A ref (not state) so typing
  // doesn't re-render the whole diff, and so the gutter handlers can read the
  // latest value synchronously. While dirty, opening a DIFFERENT draft is blocked
  // — the half-typed comment is never silently discarded (the reported bug).
  const draftDirtyRef = useRef(false);
  // Guard before opening/replacing a draft: if the current composer is dirty,
  // refuse to move (keep the box + its text). Returns false = caller should abort.
  const canOpenDraft = useCallback(() => !draftDirtyRef.current, []);
  // In-progress drag selection over the gutter: [anchorIdx, focusIdx] into the
  // flattened change list. null = not dragging. Lets the user drag L15→L20 and
  // comment on the whole range (GitHub-style), not just one line at a time.
  const [dragSel, setDragSel] = useState<{ anchor: number; focus: number } | null>(null);
  // Reset any open draft / drag when the selected file changes OR the view
  // toggles between diff and rendered (dragSel's index means different things in
  // each mode — flatChanges vs renderedBlocks — so a stale index must not carry over).
  // Also release the dirty lock so a switched-to file isn't stuck refusing clicks.
  useEffect(() => { setDraft(null); setDragSel(null); draftDirtyRef.current = false; }, [change.filePath, rendered]);

  // All changes flattened in render order, so a gutter event can be located by
  // index and a drag can select a contiguous [min,max] range across hunks. Built
  // from the EXPANDED hunks so a comment can anchor on a revealed context line too.
  const flatChanges = useMemo<ChangeData[]>(() => {
    const out: ChangeData[] = [];
    for (const h of hunks) for (const c of h.changes) out.push(c);
    return out;
  }, [hunks]);
  const keyToIdx = useMemo(() => {
    const m = new Map<string, number>();
    flatChanges.forEach((c, i) => m.set(getChangeKey(c), i));
    return m;
  }, [flatChanges]);
  // The open comment's lines, re-read after a live refresh: gone or reworded = changed.
  const draftLineChanged = useMemo(() => {
    if (!draft || draft.anchorKey.startsWith('md:')) return false;
    const now = draft.changeKeys.map((k) => {
      const i = keyToIdx.get(k);
      return i === undefined ? null : (flatChanges[i]!.content ?? '');
    });
    return now.some((t) => t === null) || now.join('\n') !== draft.code;
  }, [draft, keyToIdx, flatChanges]);
  // The line the open box hangs under was rewritten (a live refresh turned it into a
  // delete + insert): move the box to the same line number, else the nearest line
  // before it, so it never vanishes with its half-typed words.
  useEffect(() => {
    if (!draft || draft.anchorKey.startsWith('md:') || keyToIdx.has(draft.anchorKey) || flatChanges.length === 0) return;
    const n = Number(draft.anchorKey.slice(1));
    let next = ['I', 'N', 'D'].map((p) => `${p}${n}`).find((k) => keyToIdx.has(k));
    if (!next && Number.isFinite(n)) {
      const lineOf = (c: ChangeData) => (isDelete(c) ? computeOldLineNumber(c) : computeNewLineNumber(c));
      const before = flatChanges.filter((c) => lineOf(c) > 0 && lineOf(c) <= n).pop();
      next = getChangeKey(before ?? flatChanges[flatChanges.length - 1]!);
    }
    if (next) setDraft((d) => (d && d.anchorKey === draft.anchorKey ? { ...d, anchorKey: next! } : d));
  }, [draft, keyToIdx, flatChanges]);

  // Stat counts come from the ORIGINAL hunks (not the expanded ones) so revealing
  // context never inflates the +N/−N badges with normal lines.
  const { adds, dels } = useMemo(() => {
    let a = 0, d = 0;
    for (const h of file?.hunks ?? []) {
      for (const c of h.changes) {
        if (c.type === 'insert') a++;
        else if (c.type === 'delete') d++;
      }
    }
    return { adds: a, dels: d };
  }, [file]);

  // Rendered markdown view: show the AFTER content as rendered HTML blocks, each
  // tagged with its source line so the preview gets a line-number gutter.
  const renderedBlocks = useMemo(() => {
    if (!rendered) return null;
    return markdownBlocksWithLines(change.after || change.before || '', sessionCwd, sessionHost);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
  }, [rendered, change.after, change.before, sessionCwd, sessionHost, labelsVersion]);

  // Open a comment draft over a contiguous range [i..j] of RENDERED-MARKDOWN
  // blocks (indices into renderedBlocks). A single block (i===j) reads
  // `path:L15`; a multi-block range reads `path:L15-L20` and quotes every block's
  // source. Markdown has no diff changeKey, so each block is anchored by a
  // synthetic `md:L<line>` key — that's what the pending card / composer key off,
  // stable across re-renders. Anchored at the LAST block so the box renders just
  // below the selection (mirrors openDraftRange for the diff view).
  const openMarkdownDraftRange = useCallback((i: number, j: number) => {
    if (draftDirtyRef.current) return; // keep the half-typed comment; don't replace it
    if (!renderedBlocks) return;
    const range = markdownCommentRange(renderedBlocks, change.relPath, i, j);
    if (!range) return;
    setDraft({ filePath: change.filePath, relPath: change.relPath, ...range });
  }, [renderedBlocks, change.filePath, change.relPath]);

  // Human line number for one change (new-side, or old-side for deletions).
  const lineNoOf = useCallback((c: ChangeData) => (isDelete(c) ? computeOldLineNumber(c) : computeNewLineNumber(c)), []);

  // Open a comment draft over a contiguous range [i..j] of flatChanges. A single
  // line (i===j) reads `path:L15`; a range reads `path:L15-L20` and quotes every
  // line in between (GitHub-style multi-line comment). Anchored at the LAST line
  // so the box renders just below the selection.
  const openDraftRange = useCallback((i: number, j: number) => {
    if (draftDirtyRef.current) return; // keep the half-typed comment; don't replace it
    const lo = Math.min(i, j), hi = Math.max(i, j);
    const slice = flatChanges.slice(lo, hi + 1);
    if (slice.length === 0) return;
    const first = lineNoOf(slice[0]!);
    const last = lineNoOf(slice[slice.length - 1]!);
    const loc = first > 0
      ? (slice.length > 1 && last > 0 && last !== first ? `${change.relPath}:L${first}-L${last}` : `${change.relPath}:L${first}`)
      : change.relPath;
    setDraft({
      filePath: change.filePath,
      relPath: change.relPath,
      anchorKey: getChangeKey(slice[slice.length - 1]!),
      changeKeys: slice.map((c) => getChangeKey(c)),
      loc,
      code: slice.map((c) => c.content ?? '').join('\n'),
    });
  }, [flatChanges, lineNoOf, change.filePath, change.relPath]);

  // Gutter drag = range select (GitHub): mousedown starts, mouseenter extends
  // while held, mouseup opens the comment box over the whole range. A plain
  // click (no drag) collapses to a single line. We track via dragSel and only
  // open on mouseup so the box doesn't flicker mid-drag.
  const gutterEvents = useMemo<EventMap>(() => ({
    onMouseDown: (args: ChangeEventArgs, e) => {
      if (!args.change) return;
      if (draftDirtyRef.current) return; // an unsaved composer is open — don't start a new selection
      e.preventDefault(); // don't start a native text selection while range-dragging
      const idx = keyToIdx.get(getChangeKey(args.change));
      if (idx == null) return;
      setDraft(null);
      setDragSel({ anchor: idx, focus: idx });
    },
    onMouseEnter: (args: ChangeEventArgs) => {
      if (!args.change) return;
      const idx = keyToIdx.get(getChangeKey(args.change));
      if (idx == null) return;
      setDragSel((prev) => (prev ? { anchor: prev.anchor, focus: idx } : prev));
    },
    onMouseUp: (args: ChangeEventArgs) => {
      setDragSel((prev) => {
        if (prev) openDraftRange(prev.anchor, prev.focus);
        return null;
      });
    },
  }), [keyToIdx, openDraftRange]);
  // NOTE: clicking the CODE cell intentionally does NOT open a comment — only the
  // left line-number gutter does (gutterEvents above). This keeps the code text
  // freely selectable (double-click a word, drag to select) without a stray click
  // popping the composer. Commenting is a deliberate gutter action, GitHub-style.

  // Lines react-diff-view paints as selected = the union of three sources, so a
  // selection STAYS highlighted from the moment you drag, through the open
  // composer, and after it's recorded to the batch (GitHub keeps the commented
  // range tinted): (1) the live drag range, (2) the open draft's range, (3)
  // every recorded comment's range in THIS file.
  const selectedChanges = useMemo<string[]>(() => {
    const keys = new Set<string>();
    if (dragSel) {
      const lo = Math.min(dragSel.anchor, dragSel.focus), hi = Math.max(dragSel.anchor, dragSel.focus);
      for (const c of flatChanges.slice(lo, hi + 1)) keys.add(getChangeKey(c));
    }
    if (draft) for (const k of draft.changeKeys) keys.add(k);
    for (const c of pending) for (const k of c.changeKeys) keys.add(k);
    return [...keys];
  }, [dragSel, flatChanges, draft, pending]);

  // A drag can end outside the gutter (mouseup over the page) — finalize there
  // too. Dispatch to the right opener: markdown drags index into renderedBlocks,
  // diff drags into flatChanges.
  useEffect(() => {
    if (!dragSel) return;
    const open = rendered ? openMarkdownDraftRange : openDraftRange;
    const onUp = () => setDragSel((prev) => { if (prev) open(prev.anchor, prev.focus); return null; });
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [dragSel, rendered, openDraftRange, openMarkdownDraftRange]);

  // "Add comment" → record to the pending review batch (the default option).
  const addDraft = useCallback((commentText: string) => {
    if (!draft) return;
    draftDirtyRef.current = false; // recorded → composer no longer holds unsaved text
    onAddComment({ filePath: draft.filePath, anchorKey: draft.anchorKey, changeKeys: draft.changeKeys, loc: draft.loc, code: draft.code, comment: commentText });
    setDraft(null);
  }, [draft, onAddComment]);

  // "Send now" → fire this one comment to the agent immediately (the 2nd option).
  const sendDraftNow = useCallback((commentText: string) => {
    if (!draft) return;
    draftDirtyRef.current = false; // sent → composer no longer holds unsaved text
    onSendNow(buildCommentMessage(draft.loc, draft.code, commentText));
    setDraft(null);
  }, [draft, onSendNow]);

  // Cancel the open composer: drop its text AND clear the dirty lock so the next
  // line click works immediately (the only way, besides Add/Send, to release it).
  const cancelDraft = useCallback(() => {
    draftDirtyRef.current = false;
    setDraft(null);
  }, []);
  // Reported by CommentBox's textarea: keeps draftDirtyRef in sync with whether
  // the open composer holds unsaved text (the lock that blocks clicking away).
  const onDraftDirtyChange = useCallback((dirty: boolean) => { draftDirtyRef.current = dirty; }, []);

  // Widgets rendered under lines: every recorded comment's read-only card, plus
  // the open composer (if any). Multiple comments can share one anchor line, so
  // we group cards by anchorKey and the draft's box stacks under them.
  const widgets = useMemo(() => {
    const map: Record<string, ReactNode> = {};
    const byAnchor = new Map<string, PendingComment[]>();
    for (const c of pending) {
      if (!byAnchor.has(c.anchorKey)) byAnchor.set(c.anchorKey, []);
      byAnchor.get(c.anchorKey)!.push(c);
    }
    for (const [anchorKey, cards] of byAnchor) {
      const draftHere = draft?.anchorKey === anchorKey;
      map[anchorKey] = (
        <>
          {cards.map((c) => (
            <PendingCommentCard
              key={c.id}
              loc={c.loc}
              code={c.code}
              comment={c.comment}
              onCopy={() => onCopyComment(c)}
              onRemove={() => onRemoveComment(c.id)}
            />
          ))}
          {draftHere && (
            <CommentBox loc={draft!.loc} keepKey={draftKey('diff-comment', sessionId, draftHash(draft!.loc))} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} lineChanged={draftLineChanged} />
          )}
        </>
      );
    }
    // Draft anchored on a line that has no recorded comments yet.
    if (draft && !byAnchor.has(draft.anchorKey)) {
      map[draft.anchorKey] = (
        <CommentBox loc={draft.loc} keepKey={draftKey('diff-comment', sessionId, draftHash(draft.loc))} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} lineChanged={draftLineChanged} />
      );
    }
    return Object.keys(map).length ? map : undefined;
  }, [pending, draft, addDraft, sendDraftNow, cancelDraft, onDraftDirtyChange, onCopyComment, onRemoveComment, draftLineChanged]);

  // Recorded comments for the RENDERED-MARKDOWN view, grouped by their md anchor
  // key (`md:L<n>`) so each row can show its own cards + composer (the diff view
  // does the equivalent via react-diff-view `widgets`).
  const mdPendingByAnchor = useMemo(() => {
    const m = new Map<string, PendingComment[]>();
    for (const c of pending) {
      if (!c.anchorKey.startsWith('md:')) continue;
      if (!m.has(c.anchorKey)) m.set(c.anchorKey, []);
      m.get(c.anchorKey)!.push(c);
    }
    return m;
  }, [pending]);

  // Line-number drag on the RENDERED-MARKDOWN gutter = range select, mirroring
  // the diff gutter's gutterEvents: mousedown starts (dragSel indices now point
  // into renderedBlocks), mouseenter extends while held, mouseup opens the
  // composer over the whole range. A plain click (anchor===focus on mouseup)
  // collapses to one block. preventDefault stops a native text selection forming
  // while dragging the number column.
  const onMdLineDown = useCallback((index: number, e: ReactMouseEvent) => {
    if (draftDirtyRef.current) return; // an unsaved composer is open — don't start a new selection
    e.preventDefault();
    setDraft(null);
    setDragSel({ anchor: index, focus: index });
  }, []);
  const onMdLineEnter = useCallback((index: number) => {
    setDragSel((prev) => (prev ? { anchor: prev.anchor, focus: index } : prev));
  }, []);
  const onMdLineUp = useCallback(() => {
    setDragSel((prev) => {
      if (prev) openMarkdownDraftRange(prev.anchor, prev.focus);
      return null;
    });
  }, [openMarkdownDraftRange]);

  // While dragging in markdown mode, the set of block indices the live drag
  // covers — so every row in the range tints active (parallels selectedChanges
  // for the diff view). null when not dragging.
  const mdDragRange = useMemo(() => {
    if (!rendered || !dragSel) return null;
    return { lo: Math.min(dragSel.anchor, dragSel.focus), hi: Math.max(dragSel.anchor, dragSel.focus) };
  }, [rendered, dragSel]);

  // Render one rendered-markdown row: the block + (under it) its recorded cards
  // and the open composer if the draft is anchored here. Reuses the SAME
  // CommentBox / PendingCommentCard / batch as the diff view. The row is "active"
  // (tinted) when it's in the live drag range, its anchor holds the open draft,
  // or it has recorded cards.
  const renderMarkdownRow = useCallback((block: MarkdownBlock, index: number) => {
    const anchorKey = `md:L${block.line}`;
    const cards = mdPendingByAnchor.get(anchorKey) ?? [];
    const draftHere = draft?.anchorKey === anchorKey;
    const inDrag = mdDragRange != null && index >= mdDragRange.lo && index <= mdDragRange.hi;
    return (
      <RenderedMarkdownRow
        key={`${block.line}-${index}`}
        line={block.line}
        html={block.html}
        index={index}
        active={inDrag || draftHere || cards.length > 0}
        onLineDown={onMdLineDown}
        onLineEnter={onMdLineEnter}
        onLineUp={onMdLineUp}
      >
        {cards.map((c) => (
          <PendingCommentCard
            key={c.id}
            loc={c.loc}
            code={c.code}
            comment={c.comment}
            onCopy={() => onCopyComment(c)}
            onRemove={() => onRemoveComment(c.id)}
          />
        ))}
        {draftHere && (
          <CommentBox loc={draft!.loc} keepKey={draftKey('diff-comment', sessionId, draftHash(draft!.loc))} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} lineChanged={draftLineChanged} />
        )}
      </RenderedMarkdownRow>
    );
  }, [mdPendingByAnchor, draft, mdDragRange, onMdLineDown, onMdLineEnter, onMdLineUp, addDraft, sendDraftNow, cancelDraft, onDraftDirtyChange, onCopyComment, onRemoveComment]);

  // Number of lines in the OLD source (= the ceiling expansion can draw from).
  const oldLineCount = useMemo(() => oldSourceLineCount(change.before), [change.before]);
  // Both sides' lines, split once per file, for the expand bars' function
  // context — old and new can be inside DIFFERENT functions.
  const oldLines = useMemo(() => splitSourceLines(change.before), [change.before]);
  const newLines = useMemo(() => splitSourceLines(change.after), [change.after]);

  // Render the hunks with a GitHub-style "unfold" bar (Decoration) wherever the
  // diff hides a block of unchanged lines: above the first hunk, between hunks,
  // and after the last hunk. The [start,end) old-side ranges each button reveals
  // come from the pure, unit-tested computeExpandGaps; here we just map them to
  // Decoration rows + expandRange() calls. Keyed by hunkIndex so the leading/tail
  // unfold rows stay stable as expansions merge hunks. The gaps are computed against the
  // CURRENTLY-rendered (possibly already-expanded) hunks the render-prop hands us. */
  // One unfold bar's content — shared by the single-<Diff> Decoration path and
  // the hybrid standalone path (where bars live OUTSIDE any diff table).
  const gapRow = useCallback((g: ExpandGap, rendered: HunkData[], split: boolean): ReactElement => {
    // The definition to pin, per side: scan up from the next hunk's old/new
    // start (trailing gap: the first hidden line after the last hunk). Pinned
    // ONLY when the definition itself is hidden inside THIS gap — visible on
    // screen or pinned by an earlier bar → null (no repeats).
    const next = g.hunkIndex < rendered.length ? rendered[g.hunkIndex]! : null;
    const prev = g.hunkIndex > 0 ? rendered[g.hunkIndex - 1]! : null;
    const last = rendered[rendered.length - 1];
    const oldAt = next ? next.oldStart : g.all[0];
    const newLo = prev ? prev.newStart + prev.newLines : 1;
    const newAt = next ? next.newStart : (last ? last.newStart + last.newLines : 1);
    const funcOld = hiddenFunctionContext(oldLines, oldAt, g.all[0], g.all[1]);
    const funcNew = hiddenFunctionContext(newLines, newAt, newLo, next ? next.newStart : Number.MAX_SAFE_INTEGER);
    // Click-to-reveal: expandRange speaks OLD line numbers. The gap is an
    // unchanged region, so a new-side line maps exactly via the gap offset.
    const jumpOld = funcOld ? () => expandRange(funcOld.line, g.all[1]) : undefined;
    const jumpNew = funcNew ? () => expandRange(g.all[0] + (funcNew.line - newLo), g.all[1]) : undefined;
    return (
      <ExpandRow
        lines={g.lines}
        split={split}
        funcOld={funcOld}
        funcNew={funcNew}
        onAll={() => expandRange(g.all[0], g.all[1])}
        onDown={g.down ? () => expandRange(g.down![0], g.down![1]) : undefined}
        onUp={g.up ? () => expandRange(g.up![0], g.up![1]) : undefined}
        onJumpOld={jumpOld}
        onJumpNew={jumpNew}
      />
    );
  }, [expandRange, oldLines, newLines]);

  const renderHunks = useCallback((rendered: HunkData[]): ReactElement[] => {
    const gaps = computeExpandGaps(rendered, oldLineCount);
    const gapByIndex = new Map(gaps.map((g) => [g.hunkIndex, g]));
    const out: ReactElement[] = [];
    rendered.forEach((hunk, i) => {
      const g = gapByIndex.get(i);
      if (g) out.push(<Decoration key={`exp-${g.hunkIndex}`}>{gapRow(g, rendered, effectiveViewType === 'split')}</Decoration>);
      out.push(<Hunk key={hunk.content} hunk={hunk} />);
    });
    const tail = gapByIndex.get(rendered.length);
    if (tail) out.push(<Decoration key={`exp-${tail.hunkIndex}`}>{gapRow(tail, rendered, effectiveViewType === 'split')}</Decoration>);
    return out;
  }, [gapRow, oldLineCount, effectiveViewType]);

  // Auto-mode hybrid body: unfold bars render standalone between hunks, and
  // each hunk is sliced into per-region <Diff> segments (split only for
  // in-place replacements — see diffAutoSegment.ts).
  const hybridBody = useMemo(() => {
    if (!autoHybrid || !file) return null;
    const gaps = computeExpandGaps(hunks, oldLineCount);
    const gapByIndex = new Map(gaps.map((g) => [g.hunkIndex, g]));
    const out: ReactElement[] = [];
    hunks.forEach((hunk, i) => {
      const g = gapByIndex.get(i);
      if (g) out.push(<div key={`exp-${i}`} className="session-diff-expand-standalone">{gapRow(g, hunks, false)}</div>);
      for (const seg of segmentHunkForAuto(hunk)) {
        out.push(
          <SegmentDiff
            key={seg.hunk.content}
            seg={seg}
            diffType={file.type}
            relPath={change.relPath}
            widgets={widgets}
            gutterEvents={gutterEvents}
            selectedChanges={selectedChanges}
            dragging={!!dragSel}
            ignoreWhitespace={ignoreWhitespace}
          />,
        );
      }
    });
    const tail = gapByIndex.get(hunks.length);
    if (tail) out.push(<div key="exp-tail" className="session-diff-expand-standalone">{gapRow(tail, hunks, false)}</div>);
    return out;
  }, [autoHybrid, file, hunks, oldLineCount, gapRow, change.relPath, widgets, gutterEvents, selectedChanges, dragSel, ignoreWhitespace]);

  return (
    <div className="session-diff-filepane" data-file-path={change.filePath} ref={paneRef}>
      {/* Sticky wrapper keeps the header AND the ✦ strip pinned while the diff
          scrolls (a fixed pixel `top` on the strip breaks at other zoom/font
          sizes; the head's own sticky is inert inside this wrapper). */}
      <div className="session-diff-filepane-sticky">
      <div className="session-diff-filepane-head">
        {/* Cut from the left when it does not fit: the file name is what must stay. */}
        <span className="session-diff-filepane-path" dir="rtl" title={change.status === 'renamed' && change.oldRelPath ? `${change.filePath}\nMoved from ${change.oldRelPath}` : change.filePath}><bdi>{change.relPath}</bdi></span>
        {change.status === 'renamed' && change.oldRelPath && (
          <span className="session-diff-filepane-renamed" title={`Moved from ${change.oldRelPath}`}>{'← '}<code>{change.oldRelPath}</code></span>
        )}
        {change.untracked && (
          <span className="session-diff-ws-tag" title="A new file git does not track yet (not added)">untracked</span>
        )}
        {ignoreWhitespace && (
          <span className="session-diff-ws-tag" title="Whitespace changes are hidden (the toolbar's Hide whitespace)">whitespace hidden</span>
        )}
        {splitTooNarrow && (
          <span className="session-diff-ws-tag" title="Split needs a wider pane (hide the chat or widen the window): shown unified until then">unified: too narrow to split</span>
        )}
        <span className="session-diff-filepane-stat">
          {adds > 0 && <span className="session-diff-stat-add">+{adds}</span>}
          {dels > 0 && <span className="session-diff-stat-del">{'−'}{dels}</span>}
        </span>
        {/* Takes the free room, so the +/- numbers stay beside the name whatever follows. */}
        <span className="session-diff-filepane-spacer" aria-hidden />
        {(file || rendered) && <span className="session-diff-filepane-hint">
          {rendered
            ? 'Click a line number — or drag down the numbers to select a range — to comment'
            : 'Click a line — or drag the gutter to select a range — to comment'}
        </span>}
        {/* Per file, so the toolbar above never shifts between a Markdown file and another. */}
        {onToggleRendered && (
          <button
            type="button"
            className={`session-diff-rendered-toggle${rendered ? ' is-active' : ''}`}
            onClick={onToggleRendered}
            aria-pressed={rendered}
            title={rendered ? 'Showing the rendered markdown: click for the diff' : 'Show the markdown rendered'}
          >
            Rendered
          </button>
        )}
        {viewedState && (onToggleViewed || onNextUnviewed) && (
          <span className="session-diff-viewed-group">
            {viewedState === 'changed' && (
              <span className="session-diff-viewed-changed" title="You marked this file viewed, then it changed">Changed since viewed</span>
            )}
            {onNextUnviewed && (
              <button type="button" className="session-diff-next-unviewed" onClick={onNextUnviewed} title="Open the next file you have not viewed (N)" aria-label="Next unviewed">
                Next<span className="session-diff-next-unviewed-text"> unviewed</span> <span aria-hidden>{'↓'}</span>
              </button>
            )}
            {onToggleViewed && (
              <label className={`session-diff-viewed-toggle${viewedState === 'viewed' ? ' is-checked' : ''}`} title={viewedState === 'viewed' ? 'Viewed: the tree marks it until the file changes again (V)' : 'Mark this file as viewed (V)'}>
                <input
                  type="checkbox"
                  checked={viewedState === 'viewed'}
                  onChange={() => onToggleViewed(change.filePath)}
                />
                Viewed
              </label>
            )}
          </span>
        )}
      </div>
      {aiSummaryOn && <AiFileSummary sessionId={sessionId} change={change} />}
      </div>
      {rendered && renderedBlocks != null ? (
        <RenderedMarkdown blocks={renderedBlocks} dragging={mdDragRange != null} renderRow={renderMarkdownRow} />
      ) : file && hybridBody ? (
        <div className="session-diff-hybrid">{hybridBody}</div>
      ) : file ? (
        <Diff
          viewType={effectiveViewType}
          diffType={file.type}
          hunks={hunks}
          tokens={tokens}
          widgets={widgets}
          gutterEvents={gutterEvents}
          selectedChanges={selectedChanges}
          className={`session-diff-table session-diff-commentable${dragSel ? ' is-dragging' : ''}`}
        >
          {renderHunks}
        </Diff>
      ) : binary ? (
        <div className="session-diff-file-empty session-diff-binary">Binary file: no line diff to show.</div>
      ) : change.status === 'renamed' ? (
        <div className="session-diff-file-empty">File moved{change.oldRelPath ? ` from ${change.oldRelPath}` : ''} — content unchanged.</div>
      ) : ignoreWhitespace && differsOnlyInWhitespace(change.before, change.after) ? (
        <div className="session-diff-file-empty session-diff-ws-only">
          Only whitespace changed in this file.
          {onShowWhitespace && <button type="button" className="btn btn-sm" onClick={onShowWhitespace} title="Turns off the toolbar's Hide whitespace, for every file">Show whitespace (all files)</button>}
        </div>
      ) : change.partial && change.before === change.after ? (
        // The file changed on disk after the session's edit, so the edit could not be rebuilt from
        // the session's history: say so and offer git's view, never a bare "no diff".
        <div className="session-diff-file-empty session-diff-not-rebuilt">
          This file changed after the session edited it, so the session&apos;s edit could not be rebuilt here.
          {onShowUncommitted && <button type="button" className="btn btn-sm" onClick={onShowUncommitted}>Show it vs your last commit</button>}
        </div>
      ) : (
        <div className="session-diff-file-empty">No textual diff (binary, identical, or unreadable content).</div>
      )}
    </div>
  );
});

// ── Pending-review persistence ────────────────────────────────────────────────
// A drafted review (recorded comments not yet submitted) must survive leaving the
// Changed tab, closing the panel, and full reloads — it belongs to the session and
// only Discard/Submit clears it. So we mirror it to localStorage, keyed per session.
const REVIEW_STORAGE_PREFIX = 'open-walnut-diff-review:';

function loadPendingReview(sessionId: string): PendingComment[] {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_PREFIX + sessionId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Light validation so a corrupt/old record can never crash the panel.
    return parsed.filter((c): c is PendingComment =>
      !!c && typeof c.id === 'number' && typeof c.filePath === 'string'
      && typeof c.anchorKey === 'string' && Array.isArray(c.changeKeys)
      && typeof c.loc === 'string' && typeof c.code === 'string' && typeof c.comment === 'string');
  } catch { return []; }
}

function savePendingReview(sessionId: string, pending: PendingComment[]): void {
  try {
    if (pending.length === 0) localStorage.removeItem(REVIEW_STORAGE_PREFIX + sessionId);
    else localStorage.setItem(REVIEW_STORAGE_PREFIX + sessionId, JSON.stringify(pending));
  } catch { /* quota exceeded / storage disabled — non-fatal */ }
}

// ── Changed-tab view-state persistence ────────────────────────────────────────
// Re-entering the tab must land you where you left it (same contract as the
// Files tab's remembered selection): the compare base, scope, and the file you
// had open, keyed per session.
const DIFF_STATE_PREFIX = 'open-walnut-diff-state:';

interface DiffViewMemory { base?: SessionDiffBase; ref?: string; commit?: string; scope?: SessionDiffScope; selectedId?: string }

function loadDiffMemory(sessionId: string): DiffViewMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(DIFF_STATE_PREFIX + sessionId) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: DiffViewMemory = {};
    if (BASE_OPTIONS.some((o) => o.value === parsed.base) || parsed.base === 'branch') out.base = parsed.base;
    if (parsed.base === 'branch' && typeof parsed.ref === 'string' && parsed.ref) out.ref = parsed.ref;
    // A commit comparison needs its commit; without one the memory is the default view.
    if (parsed.base === 'commit' && typeof parsed.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(parsed.commit)) {
      out.base = 'commit';
      out.commit = parsed.commit;
    }
    // scope is no longer read: the 'all' scope was removed, and ignoring old
    // stored values also heals any memory that had the repo-wide trap saved.
    if (typeof parsed.selectedId === 'string') out.selectedId = parsed.selectedId;
    return out;
  } catch { return {}; }
}

function saveDiffMemory(sessionId: string, mem: DiffViewMemory): void {
  try { localStorage.setItem(DIFF_STATE_PREFIX + sessionId, JSON.stringify(mem)); } catch { /* non-fatal */ }
}

/** A note the view still owes (a remembered branch that was gone), kept for
 *  this page until dismissed or another comparison is picked, so closing and
 *  reopening the panel still says why the comparison changed. sessionId → text. */
const pageNotices = new Map<string, string>();

function memoryCompare(mem: DiffViewMemory): SessionDiffCompare {
  const base = mem.base ?? 'session';
  if (base === 'branch') return mem.ref ? { base, ref: mem.ref } : { base };
  if (base === 'commit') return { base, commit: mem.commit };
  return { base };
}

/** The cache / identity key of a comparison (base + its ref or commit). */
function compareCacheKey(c: SessionDiffCompare): string {
  return compareKey(c);
}

/** One line naming what a branch or commit comparison resolved to. */
function CompareStrip({ info, compare }: { info: GitCompareInfo | undefined; compare: SessionDiffCompare }) {
  // The working-tree spans list only the session's files: said where the list is, not only in the picker.
  if (compare.base === 'uncommitted' || compare.base === 'remote') {
    return (
      <div className="session-diff-compare-strip" data-compare={compare.base}>
        <span className="sdc-strip-kind">Session files</span>
        <span>
          Only the files this session edited, as they differ from {compare.base === 'uncommitted' ? 'your last commit' : 'what is pushed (with no upstream, from where the branch left the default branch)'}.
          {' '}For every file on the branch, pick Branch vs the default branch in Compare.
        </span>
      </div>
    );
  }
  if (compare.base === 'branch') {
    const ref = info?.ref ?? compare.ref;
    return (
      <div className="session-diff-compare-strip" data-compare="branch">
        <span className="sdc-strip-kind">Branch</span>
        <span>
          Everything since this branch left <b>{ref ?? 'the default branch'}</b>
          {info?.baseSha && <> at <code title={info.baseSha}>{shortSha(info.baseSha)}</code></>}
          , uncommitted work included. Every file, not only this session's.
        </span>
      </div>
    );
  }
  const c = info?.commit;
  return (
    <div className="session-diff-compare-strip" data-compare="commit">
      <span className="sdc-strip-kind">Commit</span>
      {c ? (
        <span className="sdc-strip-commit">
          <code title={c.sha}>{shortSha(c.sha)}</code>
          <b className="sdc-strip-subject" title={c.subject}>{c.subject || '(no message)'}</b>
          <span className="sdc-strip-meta">
            {c.author}{c.time ? ` · ${timeAgo(new Date(c.time * 1000).toISOString())}` : ''}
            {' · '}{c.parent ? <>vs parent <code title={c.parent}>{shortSha(c.parent)}</code>{c.parents > 1 ? ' (first of a merge)' : ''}</> : 'first commit'}
          </span>
        </span>
      ) : (
        <span><code>{shortSha(compare.commit ?? '')}</code></span>
      )}
    </div>
  );
}

// ── Compare schematic ─────────────────────────────────────────────────────────
// A VERTICAL git-graph that shows ALL THREE compare modes side by side so you can
// see, at a glance, how their spans differ — because the labels alone can't convey
// that (with git-sync auto-committing every 30s) "Uncommitted" and "Not yet pushed"
// can be hundreds of commits apart. It's a SCHEMATIC, not real history: a fixed
// trunk of nodes
//   ◉ working tree (now) · ◆ this session · ● last commit · ⋮ unpushed · ○ remote
// with THREE coloured rails drawn next to it — each running from "now" down to that
// mode's anchor, so their relative lengths make the difference obvious. The
// currently-selected mode's rail + legend row are emphasised; the others stay
// visible (dimmed) for comparison.

// Trunk nodes, top→bottom. `row` is the 0-based vertical slot (each ROW_H tall).
const COMPARE_TRUNK: ReadonlyArray<{ node: 'now' | 'session' | 'commit' | 'ellipsis' | 'remote'; label: string; glyph: string; row: number }> = [
  { node: 'now', label: 'Working tree (now)', glyph: '◉', row: 0 },
  { node: 'session', label: 'This session’s edits', glyph: '◆', row: 1 },
  { node: 'commit', label: 'Last commit', glyph: '●', row: 2 },
  { node: 'ellipsis', label: 'unpushed commits…', glyph: '⋮', row: 3 },
  { node: 'remote', label: 'Remote (origin)', glyph: '○', row: 4 },
];

// The three rails. `anchorRow` = the trunk row each span reaches (from row 0,
// "now", down to its anchor). Rendered as absolutely-positioned bar elements in a column
// to the RIGHT of the labels, so they can never overlap the text.
const COMPARE_SPANS: ReadonlyArray<{ id: SessionDiffBase; anchorRow: number; label: string; meaning: string }> = [
  { id: 'session', anchorRow: 1, label: 'What this session changed', meaning: 'This session’s own edits, across any commits it made (rebuilt from history)' },
  { id: 'uncommitted', anchorRow: 2, label: 'Uncommitted changes', meaning: 'Those files, working tree vs your last commit' },
  { id: 'remote', anchorRow: 4, label: 'Not yet pushed', meaning: 'Those files vs what is pushed: may span many local commits (never pushed: since the branch left the default branch)' },
];

const CMP_ROW_H = 26;   // px height of one trunk row
const CMP_RAIL_W = 6;   // px width of a rail bar
const CMP_RAIL_GAP = 5; // px gap between parallel rails

/** The vertical schematic showing all three spans at once. `base` = the
 *  currently-selected mode → emphasise its rail + legend row. Pure presentational.
 *  Layout: a left "trunk + labels" stack (flow layout, no overlap possible) and a
 *  right rail strip with absolutely-positioned bar elements whose pixel heights are
 *  computed from row counts — so the three spans' relative lengths are obvious and
 *  the rails are physically separated from the label text. */
function CompareGraph({ base }: { base: SessionDiffBase }) {
  const stackH = COMPARE_TRUNK.length * CMP_ROW_H;
  const railStripW = COMPARE_SPANS.length * CMP_RAIL_W + (COMPARE_SPANS.length - 1) * CMP_RAIL_GAP;
  return (
    <div className="compare-graph" role="img" aria-label="How the three compare modes overlap">
      <div className="compare-graph-title">This session’s files, three ways</div>
      <div className="compare-graph-body" style={{ height: stackH }}>
        {/* LEFT: trunk line + node glyph + label, one flow row each (no overlap). */}
        <div className="compare-graph-trunk">
          <span className="compare-graph-trunkline" aria-hidden style={{ top: CMP_ROW_H / 2, bottom: CMP_ROW_H / 2 }} />
          {COMPARE_TRUNK.map((n) => (
            <div key={n.node} className="compare-graph-traw" style={{ height: CMP_ROW_H }}>
              <span className={`compare-graph-node node-${n.node}`} aria-hidden>{n.glyph}</span>
              <span className={`compare-graph-nodelabel node-${n.node}`}>{n.label}</span>
            </div>
          ))}
        </div>
        {/* RIGHT: rail strip — three parallel rails, each from row 0 to its anchor. */}
        <div className="compare-graph-rails" style={{ width: railStripW }}>
          {COMPARE_SPANS.map((s, i) => (
            <span
              key={s.id}
              className={`compare-graph-rail rail-${s.id}${base === s.id ? ' is-active' : ''}`}
              style={{
                left: i * (CMP_RAIL_W + CMP_RAIL_GAP),
                top: CMP_ROW_H / 2,
                height: s.anchorRow * CMP_ROW_H,
                width: CMP_RAIL_W,
              }}
              title={`${s.label} — ${s.meaning}`}
            />
          ))}
        </div>
      </div>
      {/* colour legend: maps each rail → mode name + one-line meaning; active row bold */}
      <ul className="compare-graph-legend">
        {COMPARE_SPANS.map((s) => (
          <li key={`leg-${s.id}`} className={`rail-${s.id}${base === s.id ? ' is-active' : ''}`}>
            <span className="compare-graph-swatch" aria-hidden />
            <span className="compare-graph-legtext">
              <b>{s.label}</b>
              <span className="compare-graph-legmeaning">{s.meaning}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="compare-graph-note">
        {base === 'session'
          ? <>You’re viewing <b>What this session changed</b>. <span className="compare-graph-warn">⚠ If another process changed the same lines after an edit, that file is rebuilt best-effort and flagged.</span></>
          : base === 'uncommitted'
            ? <>You’re viewing <b>Uncommitted changes</b> of the files this session edited.</>
            : base === 'remote'
              ? <>You’re viewing <b>Not yet pushed</b> for the files this session edited: may span many local commits (e.g. auto-saves).</>
              : base === 'previous'
                ? <>You’re viewing <b>Last commit and uncommitted</b> for the files this session edited.</>
                : <>You’re viewing a <b>{base === 'branch' ? 'branch' : 'single commit'}</b>: every file it changes, not only this session’s. The strip under the toolbar names what it is compared with.</>}
      </div>
      <div className="compare-graph-note">
        <b>Branch vs …</b> shows every file the branch changes since it left that branch (as a pull request would). <b>Commit …</b> shows one commit against its parent. Both are in the Compare list.
      </div>
    </div>
  );
}

/** The (?) chip + its hover/focus popover. The popover is rendered FIXED (escaping
 *  the diff column's `overflow:hidden`, which was clipping an absolutely-positioned
 *  child) and positioned from the chip's live rect, clamped to the viewport. */
function CompareHelp({ base }: { base: SessionDiffBase }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const POP_W = 340;

  const place = useCallback(() => {
    const r = chipRef.current?.getBoundingClientRect();
    if (!r) return;
    // Prefer left-aligned under the chip; clamp so the panel stays fully on-screen.
    const left = Math.min(Math.max(8, r.left), window.innerWidth - POP_W - 8);
    setPos({ left, top: r.bottom + 8 });
  }, []);

  const show = useCallback(() => { place(); setOpen(true); }, [place]);
  const hide = useCallback(() => setOpen(false), []);

  return (
    <span
      ref={chipRef}
      className="session-diff-base-help"
      tabIndex={0}
      aria-label="Explain the comparison modes"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // Esc closes the explanation only (the panel's own Esc must not see it).
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hide(); } }}
    >?
      {open && pos && (
        <span
          className="session-diff-base-popover is-fixed"
          role="tooltip"
          style={{ left: pos.left, top: pos.top, width: POP_W }}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <CompareGraph base={base} />
        </span>
      )}
    </span>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

/** Text under these selectors is diff CHROME, not file content — excluded from
 *  in-file search and selection-match highlighting, and the SAME list gates the
 *  cmd+click / right-click handlers (an action offered on chrome text is
 *  guaranteed to fail, because search can never find it). Add new chrome
 *  classes HERE, not at the call sites. The last two are the rendered-markdown
 *  mode's gutter and the recorded-comment cards. One list with the question
 *  layer's index (diff-passage.ts), so Ask here and search agree on what text is. */
const DIFF_SEARCH_SKIP = DIFF_CHROME_SKIP;

// Last result per session|base, module-level so it SURVIVES the tab switch
// (the panel unmounts this view). Re-entering paints the previous list
// instantly and refreshes behind it — without this, every visit started at
// `data=null` → a full spinner, and git bases re-ran their whole (possibly
// remote, 10-30s) diff while the user stared at it. LRU-capped: git-base
// results carry before/after content and a monorepo entry can be MBs.
/** What a soft re-read compares: the list, without the SWR markers. */
function listShape(r: SessionChangesResult): string {
  return JSON.stringify([r.fileCount, r.anyPartial, r.groups]);
}
/** One file's light row: a new op, status, rename or content signature (a git list's `sig`) means its content changed. */
function fileShape(f: SessionFileChange): string {
  return `${f.status}|${f.ops}|${f.partial}|${f.oldRelPath ?? ''}|${f.before.length}|${f.after.length}|${f.sig ?? ''}`;
}

/** How often an open Changed tab re-reads its session's repos. */
const GIT_POLL_MS = 15_000;

const lastChangesCache = new Map<string, SessionChangesResult>();
const LAST_CHANGES_CACHE_MAX = 24;
function rememberChanges(key: string, res: SessionChangesResult): void {
  lastChangesCache.delete(key);
  lastChangesCache.set(key, res);
  if (lastChangesCache.size > LAST_CHANGES_CACHE_MAX) {
    const oldest = lastChangesCache.keys().next().value;
    if (oldest !== undefined) lastChangesCache.delete(oldest);
  }
}

export function SessionDiffView({ sessionId, sessionCwd, sessionHost, onSelectCode, onComment, barRightSlot, onOpenFile, toolbarLeadingSlot }: SessionDiffViewProps) {
  const [data, setData] = useState<SessionChangesResult | null>(() => {
    const mem = loadDiffMemory(sessionId);
    return lastChangesCache.get(`${sessionId}|${compareCacheKey(memoryCompare(mem))}|session`) ?? null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Layout mode. 'auto' (the default) shows each file the way it reads best:
  // unified when one side would be empty anyway, split only when lines changed
  // in place. New storage key on purpose — the old 'open-walnut-diff-view' key
  // has 'split' saved everywhere, which would silently defeat the auto default.
  const phoneDiff = usePhoneLayout();
  const [viewType, setViewType] = useState<DiffViewMode>(() => {
    try {
      const v = localStorage.getItem('open-walnut-diff-view-mode');
      return v === 'split' || v === 'unified' || v === 'auto' ? v : 'auto';
    } catch { return 'auto'; }
  });
  // ✦ AI summaries: on by default. Off = zero fetches. NOT merely per-browser:
  // the 'open-walnut-' prefix rides ui-prefs-sync, so the choice follows the
  // user across devices.
  const [aiSummaryOn, setAiSummaryOn] = useState<boolean>(() => {
    try { return localStorage.getItem('open-walnut-diff-ai-summary') !== '0'; } catch { return true; }
  });
  const toggleAiSummary = useCallback(() => {
    setAiSummaryOn((prev) => {
      try { localStorage.setItem('open-walnut-diff-ai-summary', prev ? '0' : '1'); } catch { /* ignore */ }
      // Turning ON re-probes a latched "AI disabled" — the environment may
      // have been fixed since (config change, env var cleared).
      if (!prev) aiSummaryUnavailable = false;
      return !prev;
    });
  }, []);
  const [rendered, setRendered] = useState(false);
  // Ignore whitespace: lines that differ only in spaces, tabs or line endings
  // read as unchanged. Off by default; the 'open-walnut-' prefix rides
  // ui-prefs-sync, so the choice follows the user across devices.
  const [ignoreWhitespace, setIgnoreWhitespace] = useState<boolean>(() => {
    try { return localStorage.getItem(IGNORE_WS_KEY) === '1'; } catch { return false; }
  });
  const toggleIgnoreWhitespace = useCallback(() => {
    setIgnoreWhitespace((prev) => {
      try { localStorage.setItem(IGNORE_WS_KEY, prev ? '0' : '1'); } catch { /* ignore */ }
      return !prev;
    });
  }, []);
  const showWhitespace = useCallback(() => {
    try { localStorage.setItem(IGNORE_WS_KEY, '0'); } catch { /* ignore */ }
    setIgnoreWhitespace(false);
  }, []);
  // The comparison + selected file are remembered per session — coming back to
  // the Changed tab restores the exact view you left (loadDiffMemory above).
  const [compare, setCompare] = useState<SessionDiffCompare>(() => memoryCompare(loadDiffMemory(sessionId)));
  // A one-line note above the diff (a remembered branch that is gone).
  const [notice, setNoticeState] = useState<string | null>(() => pageNotices.get(sessionId) ?? null);
  const setNotice = useCallback((text: string | null) => {
    if (text) pageNotices.set(sessionId, text);
    else pageNotices.delete(sessionId);
    setNoticeState(text);
  }, [sessionId]);
  const pickCompare = useCallback((c: SessionDiffCompare) => { setNotice(null); setCompare(c); }, [setNotice]);
  const showUncommitted = useCallback(() => pickCompare({ base: 'uncommitted' }), [pickCompare]);
  const base = compare.base;
  const setBase = useCallback((b: SessionDiffBase) => setCompare({ base: b }), []);
  // Always the files THIS session changed. The old 'all' scope ("All in repo":
  // every change in the repos the session touched, other sessions' included)
  // confused more than it helped and its repo-wide git diff timed out on huge
  // remote monorepos — the toggle is gone. The API still accepts scope=all.
  const scope: SessionDiffScope = 'session';
  const [selectedId, setSelectedId] = useState<string | null>(() => loadDiffMemory(sessionId).selectedId ?? null);
  // The remembered file to restore once data arrives. Held in a ref because the
  // on-data effect below runs with an EMPTY tree first (data still loading) and
  // nulls selectedId — the ref survives that so the restore still happens.
  const pendingRestoreRef = useRef<string | null>(loadDiffMemory(sessionId).selectedId ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The file tree hidden or shown stays as it was left, in every diff (utils/view-memory.ts).
  const [treeCollapsed, setTreeCollapsed] = usePageView('diff', 'treeCollapsed', false, isBoolean);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resizable tree rail (left of the diff). Stored as % of viewport.
  const tree = useResizablePanel('open-walnut-diff-tree-w', 22, 'left');

  // Floating "Ask about this" affordance, positioned at the current text selection.
  // `ask`: the selection as a passage of the current file (the pill's Ask here),
  // or why it is not one; absent where no question can be asked (no session panel).
  const [selection, setSelection] = useState<{ x: number; y: number; text: string; filePath: string; line?: number; ask?: DiffPassage | { ok: false; reason: 'deleted' } } | null>(null);
  // Ask here on a selection: the same question layer as the Files tab, over the
  // file's diff (FileThreadLayer, surface `diff`), so the card opens beside the
  // passage and the question is the same `file:` record either tab shows.
  const threadsApi = useSessionThreadsApi();
  const canAskHere = threadsApi.canAsk;
  const diffWrapRef = useRef<HTMLDivElement>(null);
  const noFrameRef = useRef<HTMLIFrameElement>(null);
  const diffLayerRef = useRef<FileThreadLayerHandle>(null);

  // Session-base lists ship LIGHT (no before/after) + SWR (cached list paints
  // instantly, recompute runs behind) — per-file diffs load lazily below. The
  // branch and commit bases ship light too (names only, a branch can hold
  // hundreds of files), without SWR; the other git bases keep the original
  // full blocking fetch (their diff comes from git).
  const isSessionBase = base === 'session';
  const wholeRepo = isWholeRepoBase(base);
  const isLazy = isSessionBase || wholeRepo;
  // Per-file diff cache (session base). Ref-backed so ensureFileContent stays
  // referentially stable; version bump triggers re-render on arrival.
  const fileContentRef = useRef(new Map<string, SessionFileChange>());
  const fileFetchesRef = useRef(new Set<string>());
  const [contentVersion, setContentVersion] = useState(0);
  const [refreshingBg, setRefreshingBg] = useState(false);

  // Changing the comparison (base/scope) invalidates the shown data OUTRIGHT:
  // keeping the old list while the new fetch runs (10-30s for remote git bases)
  // rendered a light session-base row under a git base — empty content, bogus
  // "No textual diff", stale file count. Reseed from the new base's cached
  // result when we have one (instant), else clear to the spinner.
  const baseKey = `${compareCacheKey(compare)}|${scope}`;
  const cacheKey = `${sessionId}|${baseKey}`;
  // The comparison the shown `data` belongs to: set together with every
  // setData, so one render never pairs a new comparison with the old list.
  const [dataKey, setDataKey] = useState(cacheKey);
  const dataKeyRef = useCommittedRef(dataKey);
  // The shown list belongs to the comparison just left (the new one is loading).
  const switching = !!data && dataKey !== cacheKey;
  const prevBaseKey = useRef(baseKey);
  useEffect(() => {
    if (prevBaseKey.current === baseKey) return;
    prevBaseKey.current = baseKey;
    const cached = lastChangesCache.get(cacheKey);
    // No answer for the new comparison yet: the old list stays on screen,
    // dimmed and inert (dataKey still names it, so nothing loads for it), and
    // the toolbar and tree do not jump. Its file pane shows a spinner.
    if (cached) {
      setData(cached);
      setDataKey(cacheKey);
    }
    fileContentRef.current.clear();
    staleContentRef.current.clear();
    setContentVersion((v) => v + 1);
  }, [baseKey, cacheKey]);

  // The list on screen, for a soft (automatic) re-read to compare against.
  const dataRef = useRef(data);
  dataRef.current = data;
  // A soft re-read keeps what still holds: the old content of a file that
  // changed stays on screen (staleContentRef) until its new content lands, and
  // files that did not change keep theirs. So the open file, its scroll, an
  // open comment box and the folded folders all survive the session's edits.
  const staleContentRef = useRef(new Map<string, SessionFileChange>());
  /** Loads still running: the timed re-read never cancels one (a big session's parse outlasts its pace). */
  const loadsRunningRef = useRef(0);
  /** A Re-scan (a full re-read) is running: a live re-read waits for it rather than cancelling it. */
  const rescanRunningRef = useRef(false);
  // `all` (a Re-scan): every file's content is read again, the old one shown until it lands.
  // `key`: the comparison `res` answers. A list for another comparison keeps nothing.
  const applyList = useCallback((res: SessionChangesResult, key: string, soft: boolean, all = false): boolean => {
    const prev = dataRef.current;
    const sameView = !!prev && dataKeyRef.current === key;
    if (soft && !all && sameView && listShape(prev) === listShape(res)) return false;
    // Any new list for the list on screen keeps what still holds, soft or not: the tab's
    // own first read can land after the user opened a file and started a comment there
    // (clearing every file's content unmounted the pane, and the comment with it).
    if (sameView && prev.sessionId === res.sessionId) {
      // A branch whose merge-base moved (the default branch was fetched, the branch rebased):
      // every file's `before` is read from another commit, so every file is read again.
      const basesOf = (r: SessionChangesResult) => r.groups.map((g) => g.compare?.baseSha ?? '').join(',');
      const every = all || basesOf(prev) !== basesOf(res);
      const before = new Map<string, string>();
      for (const g of prev.groups) for (const f of g.files) before.set(f.filePath, fileShape(f));
      for (const g of res.groups) for (const f of g.files) {
        if (!every && before.get(f.filePath) === fileShape(f)) continue;
        const had = fileContentRef.current.get(f.filePath);
        if (had) staleContentRef.current.set(f.filePath, had);
        fileContentRef.current.delete(f.filePath);
      }
    } else {
      fileContentRef.current.clear();
      staleContentRef.current.clear();
    }
    setData(res);
    setDataKey(key);
    setContentVersion((v) => v + 1);
    return true;
  }, [dataKeyRef]);

  const load = useCallback((refresh = false, soft = false, all = false) => {
    // Running until its list (or the last poll for it) lands, fails or is cancelled.
    loadsRunningRef.current++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      loadsRunningRef.current--;
      if (all) rescanRunningRef.current = false;
    };
    if (all) rescanRunningRef.current = true;
    if (!soft) setLoading(true);
    // A Re-scan in place: the list stays (and the comment being written with it), the ↻ shows.
    if (all) setRefreshingBg(true);
    // A soft re-read keeps an error on screen until it has something better (no "no changes" flash).
    if (!soft) setError(null);
    const ctrl = new AbortController();
    const light = isLazy;
    const swrOk = isSessionBase;
    // Converge by POLLING the SWR endpoint (cheap: cache/stat only) until the
    // background recompute lands (stale flag clears). The previous approach — a
    // blocking light fetch queued behind the recompute — sat on one HTTP
    // request for the whale's full 50-80s cold parse and DIED at the client's
    // 60s timeout, leaving the tab stuck on a stale list.
    // The first polls come quickly (a small session's recompute takes well under a second,
    // and the git strip above already moved), then every 3 s.
    const pollDelay = (attempt: number): number => [500, 1000, 2000][attempt] ?? 3000;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // The ↻ is for a read the user asked for (opening the tab, Re-scan); an automatic re-read is quiet.
    const showsSpinner = !soft || all;
    let spinning = all;
    const pollUntilFresh = (attempt: number): void => {
      if (ctrl.signal.aborted) { settle(); return; }
      if (showsSpinner) { spinning = true; setRefreshingBg(true); }
      pollTimer = setTimeout(() => {
        fetchSessionChanges(sessionId, { base, ref: compare.ref, commit: compare.commit, scope, light: true, swr: true, signal: ctrl.signal })
          .then((res) => {
            if (ctrl.signal.aborted) return;
            if (res.stale) {
              // Still recomputing — keep the currently-shown list, poll again
              // (cap ~5min so an abandoned tab doesn't poll forever).
              if (attempt < 100) pollUntilFresh(attempt + 1);
              else { if (spinning) setRefreshingBg(false); settle(); }
              return;
            }
            rememberChanges(cacheKey, res);
            applyList(res, cacheKey, soft, all);
            if (spinning) setRefreshingBg(false);
            settle();
          })
          .catch(() => { if (!ctrl.signal.aborted && spinning) setRefreshingBg(false); settle(); });
      }, pollDelay(attempt));
    };
    fetchSessionChanges(sessionId, { refresh, base, ref: compare.ref, commit: compare.commit, scope, light, swr: swrOk && !refresh, signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        // Cache stale results too — a stale list is exactly what a re-entry
        // wants to paint first; the background poll upgrades it in place.
        rememberChanges(cacheKey, res);
        setError(null);
        if (all && !(res.stale && swrOk)) setRefreshingBg(false);
        // A quiet re-read that found a change moves the git strip with it (its own pace is slower).
        if (soft) { if (applyList(res, cacheKey, true, all)) void sessionGitStore.refresh(sessionId); }
        else {
          setData(res);
          setDataKey(cacheKey);
          if (refresh) {
            fileContentRef.current.clear();
            staleContentRef.current.clear();
            setContentVersion((v) => v + 1);
          }
        }
        if (res.stale && swrOk) pollUntilFresh(0);
        else settle();
      })
      .catch((err) => {
        settle();
        if (ctrl.signal.aborted) return;
        if (all) setRefreshingBg(false);
        const msg = err instanceof Error ? err.message : String(err);
        // A remembered branch or commit that no longer exists: back to the
        // default comparison, saying why, instead of an error page every visit.
        if (((base === 'branch' && compare.ref) || base === 'commit') && MISSING_REF_RE.test(msg)) {
          const what = base === 'branch' ? `Branch ${compare.ref}` : `Commit ${(compare.commit ?? '').slice(0, 7)}`;
          setNotice(`${what} is no longer in this repository, so the view went back to ${base === 'branch' ? 'Branch vs the default branch' : 'What this session changed'}.`);
          setCompare(base === 'branch' ? { base: 'branch' } : { base: 'session' });
          return;
        }
        setError(msg);
        log.warn('session-changes', 'fetch failed', { sessionId, base, scope, error: msg });
      })
      .finally(() => { if (!ctrl.signal.aborted && !soft) setLoading(false); });
    return () => {
      const running = !settled;
      ctrl.abort();
      if (pollTimer) clearTimeout(pollTimer);
      settle();
      // A read cut short takes its ↻ with it (its own then/poll never runs to clear it).
      if (running && spinning) setRefreshingBg(false);
    };
  }, [sessionId, base, compare.ref, compare.commit, scope, isSessionBase, isLazy, cacheKey, applyList, setNotice]);

  useEffect(() => {
    const cancel = load(false);
    return cancel;
  }, [load]);

  // Live: the open tab follows the session's edits (useChangedLiveRefresh) and
  // its git strip re-reads the repos on open and with every re-read.
  const gitGlance = useSessionGitGlance(sessionId);
  // While the tab is open and shown, its repos are re-read every GIT_POLL_MS:
  // an edit by anyone (the session, an editor, a formatter) moves them, and the
  // server's `session:git-status` for that change re-reads the list below.
  // The list is re-read at the same pace (soft: it changes nothing on screen unless the
  // session's record moved, which the server checks with one stat): a file the session
  // rewrote with the same counts changes no git number, so no git event says so.
  const liveCancelRef = useRef<(() => void) | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const isSessionBaseRef = useRef(isSessionBase);
  isSessionBaseRef.current = isSessionBase;
  useEffect(() => {
    void sessionGitStore.refresh(sessionId);
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void sessionGitStore.refresh(sessionId);
      // The list too, for the session base only (one stat on the server); a git base is a
      // full diff, and keeps the slower live refresh below.
      if (!isSessionBaseRef.current || loadsRunningRef.current > 0) return;
      liveCancelRef.current = loadRef.current(false, true);
    }, GIT_POLL_MS);
    return () => clearInterval(t);
  }, [sessionId]);
  useEffect(() => () => { liveCancelRef.current?.(); liveCancelRef.current = null; }, [load]);
  // The chip counts what this tab lists while it is open (the session base is the chip's count).
  // (Only this session's list: on a switch the old list is still in `data` for one render.)
  const listedCount = isSessionBase && data && data.sessionId === sessionId ? data.fileCount : null;
  const tabToken = useRef({}).current;
  useEffect(() => { sessionGitStore.setTabCount(sessionId, tabToken, listedCount); }, [sessionId, tabToken, listedCount]);
  useEffect(() => () => { sessionGitStore.setTabCount(sessionId, tabToken, null); }, [sessionId, tabToken]);
  useChangedLiveRefresh(sessionId, () => {
    // A Re-scan running reads everything anyway: let it finish.
    if (rescanRunningRef.current) { void sessionGitStore.refresh(sessionId); return; }
    liveCancelRef.current?.();
    liveCancelRef.current = load(false, true);
    void sessionGitStore.refresh(sessionId);
  }, { minIntervalMs: isSessionBase ? CHANGED_REFRESH_MIN_MS : 30_000 });
  // The git comparisons follow the working tree on their own: a quiet re-read
  // (soft, so nothing on screen moves unless the answer differs; then only the
  // files whose row differs reload) when the window comes back and every
  // QUIET_REFRESH_*_MS while it is shown. A commit never changes; the session
  // base keeps the pace above.
  useEffect(() => {
    if (base === 'session' || base === 'commit') return;
    const quiet = () => {
      if (document.visibilityState !== 'visible' || loadsRunningRef.current > 0) return;
      liveCancelRef.current = loadRef.current(true, true);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') quiet(); };
    window.addEventListener('focus', quiet);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(quiet, sessionHost ? QUIET_REFRESH_REMOTE_MS : QUIET_REFRESH_LOCAL_MS);
    return () => {
      window.removeEventListener('focus', quiet);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [sessionHost, base, load]);

  useEffect(() => {
  try { localStorage.setItem('open-walnut-diff-view-mode', viewType); } catch { /* ignore */ }
}, [viewType]);

  // If this component instance is reused for ANOTHER session (no remount),
  // reload that session's remembered view instead of leaking this one's.
  const memSessionRef = useRef(sessionId);
  useEffect(() => {
    if (memSessionRef.current === sessionId) return;
    memSessionRef.current = sessionId;
    setNoticeState(pageNotices.get(sessionId) ?? null);
    const mem = loadDiffMemory(sessionId);
    const memCompare = memoryCompare(mem);
    setCompare(memCompare);
    // Seed the NEW session's cached list (or clear) — without this the old
    // session's files linger under the new session while its fetch runs.
    setData(lastChangesCache.get(`${sessionId}|${compareCacheKey(memCompare)}|session`) ?? null);
    setDataKey(`${sessionId}|${compareCacheKey(memCompare)}|session`);
    fileContentRef.current.clear();
    staleContentRef.current.clear();
    setSelectedId(null);
    pendingRestoreRef.current = mem.selectedId ?? null;
  }, [sessionId]);

  // Persist the remembered view. While selectedId is still null (initial data
  // load) keep the STORED selection instead of overwriting it — otherwise a
  // slow fetch wipes it before the restore effect can validate it against the
  // arriving file list.
  useEffect(() => {
    const stored = loadDiffMemory(sessionId);
    // A branch or commit is kept like any comparison; one that is gone later falls back with a note.
    saveDiffMemory(sessionId, {
      base: compare.base,
      ...(compare.ref ? { ref: compare.ref } : {}),
      ...(compare.base === 'commit' && compare.commit ? { commit: compare.commit } : {}),
      selectedId: selectedId ?? stored.selectedId,
    });
  }, [sessionId, base, compare, selectedId]);

  // Every folder id the tree has shown for this session and comparison.
  const knownContainersRef = useRef(new Set<string>());
  useEffect(() => { knownContainersRef.current = new Set(); }, [sessionId, base, scope]);
  const tree2 = useMemo<DiffTreeRepoNode[]>(() => buildDiffTree(data?.groups ?? []), [data]);
  const files = useMemo(() => flattenFiles(tree2), [tree2]);

  // ── Viewed marks (diffViewed.ts): per session and comparison, per file ──
  // A branch comparison is keyed by the commit it resolved to: "Branch vs main"
  // and "Branch vs origin/main" from the same fork point share their marks.
  const resolvedBaseSha = dataKey === cacheKey && compare.base === 'branch' ? data?.groups.find((g) => g.compare)?.compare?.baseSha : undefined;
  const viewKey = resolvedBaseSha ? `branch@${resolvedBaseSha}` : compareKey(compare);
  const viewStoreKey = `${sessionId}\n${viewKey}`;
  const [viewedStore, setViewedStore] = useState<{ key: string; marks: ViewedMarks }>(() => ({ key: viewStoreKey, marks: loadViewedMarks(sessionId, viewKey) }));
  // Another comparison or session: its stored marks, read once per key.
  const viewedMarks = useMemo(
    () => (viewedStore.key === viewStoreKey ? viewedStore.marks : loadViewedMarks(sessionId, viewKey)),
    [viewedStore, viewStoreKey, sessionId, viewKey],
  );
  const viewedMap = useMemo(() => {
    const m = new Map<string, ViewedState>();
    for (const f of files) m.set(f.change.filePath, viewedState(viewedMarks, f.change.filePath, changeSignature(f.change, isLazy)));
    return m;
  }, [files, viewedMarks, isLazy]);
  // Hide whitespace: the files whose every change is whitespace (the git
  // list says so for names-only rows; otherwise from the loaded content).
  const wsOnlySet = useMemo(() => {
    const set = new Set<string>();
    if (!ignoreWhitespace) return set;
    void contentVersion;
    for (const f of files) {
      const c = f.change;
      if (c.status !== 'modified') continue;
      if (c.wsOnly) { set.add(c.filePath); continue; }
      const full = isLazy ? fileContentRef.current.get(c.filePath) : c;
      if (full && full.before !== full.after && differsOnlyInWhitespace(full.before, full.after)) set.add(c.filePath);
    }
    return set;
  }, [ignoreWhitespace, files, isLazy, contentVersion]);
  // One count everywhere: every listed file, whitespace-only ones included (Hide whitespace
  // changes how a diff reads, not what is listed); the title only notes how many those are.
  const { viewedCount, changedCount } = useMemo(() => {
    let viewed = 0;
    let changed = 0;
    for (const v of viewedMap.values()) { if (v === 'viewed') viewed++; else if (v === 'changed') changed++; }
    return { viewedCount: viewed, changedCount: changed };
  }, [viewedMap]);
  const reviewable = files.length;
  const shownCount = data?.fileCount ?? 0;
  const toggleViewed = useCallback((filePath: string) => {
    const change = files.find((f) => f.change.filePath === filePath)?.change;
    if (!change) return;
    const next: ViewedMarks = { ...viewedMarks };
    if (viewedMap.get(filePath) === 'viewed') delete next[filePath];
    else next[filePath] = changeSignature(change, isLazy) ?? '';
    saveViewedMarks(sessionId, viewKey, next);
    setViewedStore({ key: viewStoreKey, marks: next });
  }, [files, viewedMarks, viewedMap, isLazy, sessionId, viewKey, viewStoreKey]);

  // On data change: expand all containers + select the remembered file if it's
  // still in the list, else the first file.
  useEffect(() => {
    // An empty tree while the first answer loads must not drop the selection.
    if (!tree2.length) { if (data) setSelectedId(null); return; }
    // Folders open as they appear; one the user folded stays folded on a re-read.
    const all = allContainerIds(tree2);
    const fresh = all.filter((id) => !knownContainersRef.current.has(id));
    for (const id of fresh) knownContainersRef.current.add(id);
    if (fresh.length) setExpanded((prev) => new Set([...prev, ...fresh]));
    setSelectedId((prev) => {
      const want = prev ?? pendingRestoreRef.current;
      pendingRestoreRef.current = null;
      return (want && files.some((f) => f.id === want)) ? want : (files[0]?.id ?? null);
    });
  }, [tree2, files, data]);

  // AI triage: one hidden side question marks the changeset's critical files
  // (✦ in the tree) and pre-seeds their summaries server-side. Keyed by the
  // changeset SHAPE (paths + statuses) so it refreshes when files join/leave,
  // not on every keystroke of ongoing edits.
  const [criticalMap, setCriticalMap] = useState<Map<string, string>>(() => new Map());
  const triageKey = useMemo(() => {
    // Runs under every base (git bases too — the server derives the real
    // session changeset itself; the displayed file list is only a memo key).
    if (!files.length) return '';
    const shape = files.map((f) => `${f.change.status}\t${f.change.filePath}`).sort().join('\n');
    return `${sessionId}:${contentDigest(shape)}`;
  }, [sessionId, files]);
  useEffect(() => {
    if (!triageKey || !aiSummaryOn || aiSummaryUnavailable) { setCriticalMap(new Map()); return; }
    const memoHit = triageMemo.get(triageKey);
    if (memoHit) { setCriticalMap(memoHit); return; }
    const ctrl = new AbortController();
    fetchChangesTriage(sessionId, { signal: ctrl.signal })
      .then((res) => {
        const map = new Map(res.critical.map((e) => [e.filePath, e.reason || e.summary || 'critical']));
        triageMemo.set(triageKey, map);
        if (!ctrl.signal.aborted) setCriticalMap(map);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        // Same latch contract as the strip: only the explicit marker disables.
        const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
        if (err instanceof ApiError && err.status === 503 && code === 'ai_disabled') {
          aiSummaryUnavailable = true;
        }
        // Quiet degrade: an unstared tree is not an error state.
        log.info('session-changes', 'changes triage unavailable', { sessionId, error: String(err) });
      });
    return () => ctrl.abort();
  }, [triageKey, aiSummaryOn, sessionId]);

  const selectedChangeRaw = useMemo(
    () => files.find((f) => f.id === selectedId)?.change ?? null,
    [files, selectedId],
  );

  // Lazy per-file content (session base): a light list row has before===after===''.
  // Fetch the full record on demand; renames/deletes with empty content are
  // legitimate, so "needs fetch" = light list + not yet cached, not "empty".
  // The comparison a per-file fetch belongs to: an answer for a comparison the
  // user already left must not land in the new one's cache.
  const contentGenRef = useRef(cacheKey);
  contentGenRef.current = cacheKey;
  const groupRootOf = useCallback((filePath: string) => data?.groups.find((g) => g.files.some((f) => f.filePath === filePath))?.repoRoot, [data]);
  const ensureFileContent = useCallback((filePath: string) => {
    const gen = cacheKey;
    const fetchKey = `${gen}\n${filePath}`;
    if (fileContentRef.current.has(filePath) || fileFetchesRef.current.has(fetchKey)) return;
    fileFetchesRef.current.add(fetchKey);
    fetchSessionFileChange(sessionId, filePath, wholeRepo ? { compare, repoRoot: groupRootOf(filePath) } : undefined)
      .then((res) => {
        if (contentGenRef.current !== gen) return;
        fileContentRef.current.set(filePath, res.file);
        staleContentRef.current.delete(filePath);
        setContentVersion((v) => v + 1);
      })
      .catch((err) => {
        log.warn('session-changes', 'file diff fetch failed', {
          sessionId, filePath, error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { fileFetchesRef.current.delete(fetchKey); });
  }, [sessionId, cacheKey, wholeRepo, compare, groupRootOf]);

  useEffect(() => {
    if (!isLazy || !selectedChangeRaw) return;
    // The render right after a comparison switch still holds the old list:
    // its files are not part of the new comparison (a git base answers 404).
    if (data && dataKey !== cacheKey) return;
    ensureFileContent(selectedChangeRaw.filePath);
    // Prefetch neighbours (±2 in tree order) so ↑/↓ stepping feels instant,
    // once the open file is in: they must not queue ahead of it on the host.
    void contentVersion;
    if (!fileContentRef.current.has(selectedChangeRaw.filePath)) return;
    const idx = files.findIndex((f) => f.id === selectedId);
    for (const off of [1, -1, 2, -2]) {
      const n = files[idx + off];
      if (n) ensureFileContent(n.change.filePath);
    }
  }, [isLazy, selectedChangeRaw, files, selectedId, ensureFileContent, data, dataKey, cacheKey, contentVersion]);

  // The change record FileDiffPane renders: light row hydrated with fetched
  // content. contentVersion re-runs this when a lazy fetch lands.
  const selectedChange = useMemo(() => {
    void contentVersion;
    if (!selectedChangeRaw) return null;
    if (!isLazy) return selectedChangeRaw;
    const full = fileContentRef.current.get(selectedChangeRaw.filePath) ?? staleContentRef.current.get(selectedChangeRaw.filePath);
    return full ? { ...selectedChangeRaw, before: full.before, after: full.after, partial: full.partial } : null;
  }, [selectedChangeRaw, isLazy, contentVersion]);
  const selectedContentLoading = isLazy && !!selectedChangeRaw && !selectedChange;

  // Reset Rendered when the selected file isn't markdown.
  // Only when there is Markdown to render: not a deleted file, not a move with nothing changed.
  const selectedIsMd = selectedChange ? isMarkdownPath(selectedChange.relPath) && selectedChange.status !== 'deleted'
    && !(selectedChange.status === 'renamed' && selectedChange.before === selectedChange.after) : false;
  useEffect(() => { if (!selectedIsMd && rendered) setRendered(false); }, [selectedIsMd, rendered]);
  const toggleRendered = useCallback(() => setRendered((r) => !r), []);

  // Added/deleted files render whole-page (unified) regardless of the toggle —
  // disable the Split/Unified buttons so it's clear why Split has no effect.
  const selectedWholeFile = selectedChange ? (selectedChange.status === 'added' || selectedChange.status === 'deleted') : false;

  const toggleDir = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Temporary "context file" shown in place of the diff (reference jump landed
  // outside the change set). Declared before selectFile so a tree click can
  // dismiss it.
  const [ghost, setGhost] = useState<GhostFile | null>(null);
  const closeGhost = useCallback(() => setGhost(null), []);

  const selectFile = useCallback((change: SessionFileChange) => {
    setGhost(null); // a tree click leaves any temporary context file
    setSelectedId(change.filePath);
  }, []);

  // Keyboard: ↑/↓ to move between files in the flattened order.
  const stepFile = useCallback((dir: 1 | -1) => {
    if (!files.length) return;
    const idx = files.findIndex((f) => f.id === selectedId);
    const nextIdx = idx < 0 ? 0 : Math.min(files.length - 1, Math.max(0, idx + dir));
    setGhost(null);
    setSelectedId(files[nextIdx]!.id);
  }, [files, selectedId]);

  // The next file (in tree order, wrapping) not marked viewed; null when all are.
  const nextUnviewedId = useMemo(() => {
    if (!files.length) return null;
    const idx = files.findIndex((f) => f.id === selectedId);
    for (let k = 1; k <= files.length; k++) {
      const f = files[(Math.max(idx, 0) + k) % files.length]!;
      if (f.id !== selectedId && viewedMap.get(f.change.filePath) !== 'viewed') return f.id;
    }
    return null;
  }, [files, selectedId, viewedMap]);
  const openNextUnviewed = useCallback(() => {
    if (!nextUnviewedId) return;
    setGhost(null);
    setSelectedId(nextUnviewedId);
  }, [nextUnviewedId]);

  // V marks the open file viewed (or not), N opens the next unviewed one: only while
  // the keys go to this view or to nothing in particular, never into a text box.
  const selectedPathRef = useCommittedRef(selectedChangeRaw?.filePath ?? null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k !== 'v' && k !== 'n') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const el = containerRef.current;
      if (!el || el.offsetParent === null) return;
      if (t && t !== document.body && !el.contains(t)) return;
      if (window.getSelection()?.toString()) return;
      if (k === 'v') {
        const path = selectedPathRef.current;
        if (!path) return;
        e.preventDefault();
        toggleViewed(path);
      } else {
        e.preventDefault();
        openNextUnviewed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleViewed, openNextUnviewed, selectedPathRef]);

  // ── In-tab reference jumps + browser-style back/forward (⌘[ / ⌘]) ─────────
  // A reference row NEVER leaves the Changed tab: a file that's part of this
  // change opens as its own diff (scrolled to the line); anything else opens
  // as a grayed read-only context view in the same pane. Keeps the reviewer's
  // train of thought in one place — no tab switching mid-review.
  const diffScrollSeqRef = useRef(0);
  const scrollDiffToLine = useCallback((line: number | undefined) => {
    if (!line) return;
    const seq = ++diffScrollSeqRef.current;
    let tries = 0;
    const attempt = () => {
      if (diffScrollSeqRef.current !== seq) return; // superseded by a newer jump
      const main = containerRef.current?.querySelector<HTMLElement>('.session-diff-main');
      if (main) {
        const cell = lineCellFor(main, line) ?? nearestLineCell(main, line);
        if (cell) {
          cell.scrollIntoView({ block: 'center' });
          const row = cell.closest('tr');
          if (row) {
            row.classList.add('session-diff-jump-flash');
            window.setTimeout(() => row.classList.remove('session-diff-jump-flash'), 1600);
          }
          return;
        }
      }
      // Diff content is lazy-fetched — retry until the pane renders (max ~3s).
      if (++tries < 30) window.setTimeout(attempt, 100);
    };
    // First probe next tick: a same-file jump has the cell already in the DOM.
    window.setTimeout(attempt, 0);
  }, []);

  const jumpHistRef = useRef<{ stops: DiffJumpStop[]; index: number }>({ stops: [], index: -1 });
  const [, setJumpHistVer] = useState(0); // refreshes the Back/Forward disabled state

  const applyJumpStop = useCallback((stop: DiffJumpStop) => {
    if (stop.kind === 'change') {
      setGhost(null);
      setSelectedId(stop.id);
      scrollDiffToLine(stop.line);
    } else {
      setGhost(stop.ghost);
    }
  }, [scrollDiffToLine]);

  const pushJumpStop = useCallback((stop: DiffJumpStop) => {
    const h = jumpHistRef.current;
    const stops = h.stops.slice(0, h.index + 1); // a new jump truncates the forward tail
    if (!stops.length) {
      // Seed with where we ARE so the very first ⌘[ returns to the departure file.
      if (ghost) stops.push({ kind: 'ghost', ghost });
      else if (selectedId) stops.push({ kind: 'change', id: selectedId });
    }
    stops.push(stop);
    jumpHistRef.current = { stops, index: stops.length - 1 };
    setJumpHistVer((v) => v + 1);
    applyJumpStop(stop);
  }, [applyJumpStop, ghost, selectedId]);

  const navigateJump = useCallback((delta: -1 | 1) => {
    const h = jumpHistRef.current;
    const idx = h.index + delta;
    const stop = h.stops[idx];
    if (!stop) return;
    jumpHistRef.current = { stops: h.stops, index: idx };
    setJumpHistVer((v) => v + 1);
    applyJumpStop(stop);
  }, [applyJumpStop]);

  const canJumpBack = jumpHistRef.current.index > 0;
  const canJumpForward = jumpHistRef.current.index >= 0
    && jumpHistRef.current.index < jumpHistRef.current.stops.length - 1;

  const openDiffReference = useCallback((file: string, line: number, term?: string) => {
    const inChange = files.some((f) => f.change.filePath === file);
    pushJumpStop(inChange
      ? { kind: 'change', id: file, line }
      : { kind: 'ghost', ghost: { file, line, term } });
  }, [files, pushJumpStop]);

  // ⌘[ / ⌘] — same keys as the Files tab. Tabs mount exclusively, but keep the
  // visibility guard anyway (pop-outs, future layouts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== '[' && e.key !== ']') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const el = containerRef.current;
      if (!el || el.offsetParent === null) return;
      e.preventDefault();
      navigateJump(e.key === '[' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigateJump]);

  // ── In-file search (⌘F) over the rendered diff ─────────────────────────────
  // Same engine as the Files viewer (dom-text-search): the diff is refractor-
  // colored DOM, so highlights ride the CSS Custom Highlight API and never
  // touch the table. DIFF_SEARCH_SKIP keeps gutters/unfold bars/widgets out —
  // searching "42" must not light every 42nd line number.
  const searchTokenRef = useRef(`sdv-${Math.random().toString(36).slice(2)}`);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchStatus, setSearchStatus] = useState({ count: 0, index: 0 });
  // Remounts the bar so its input refocuses+selects when "Find in file" prefills
  // an ALREADY-open bar (FileSearchBar only autofocuses on mount).
  const [searchEpoch, setSearchEpoch] = useState(0);
  const domSearchRef = useRef<{ root: HTMLElement; ctrl: DomSearchController } | null>(null);

  // Identity bail-out: the controller returns a fresh {count,index} on every
  // update; passing it straight to setState would re-render (and re-reconcile
  // the whole diff table) on every mutation burst even when nothing changed.
  const setSearchStatusIfChanged = useCallback((next: { count: number; index: number }) => {
    setSearchStatus((prev) => (prev.count === next.count && prev.index === next.index ? prev : next));
  }, []);

  const diffSearchCtrl = useCallback((): DomSearchController | null => {
    const root = containerRef.current?.querySelector<HTMLElement>('.session-diff-main') ?? null;
    if (!root) return null;
    if (domSearchRef.current?.root !== root) {
      domSearchRef.current?.ctrl.close();
      domSearchRef.current = { root, ctrl: new DomSearchController(root, window, false, DIFF_SEARCH_SKIP) };
    }
    return domSearchRef.current.ctrl;
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchStatus({ count: 0, index: 0 });
    domSearchRef.current?.ctrl.close();
    domSearchRef.current = null;
  }, []);
  // Unmount teardown: without this, leaving the tab with the bar open keeps up
  // to 5000 live Ranges registered in the document-global CSS.highlights,
  // pinning the detached diff table in memory (and every DOM mutation anywhere
  // pays O(ranges) while they live). Direct ctrl.close(), not closeSearch —
  // no setState during unmount.
  useEffect(() => () => { domSearchRef.current?.ctrl.close(); domSearchRef.current = null; }, []);

  /** Open the bar and claim the document-global highlight registry. */
  const openSearch = useCallback((prefill?: string) => {
    claimSearchOwner(searchTokenRef.current);
    if (prefill !== undefined) {
      setSearchQuery(prefill);
      setSearchEpoch((v) => v + 1);
    }
    setSearchOpen(true);
  }, []);

  // Another viewer claimed the registry — close rather than show stale counts.
  // Subscribed UNCONDITIONALLY (not gated on searchOpen): when one keydown
  // reaches two surfaces, both claim before either's searchOpen state commits,
  // so an open-gated listener would miss the loss and leave two bars fighting
  // over the one registry. Last claimer wins; the earlier one closes here.
  useEffect(() => onSearchOwnerLost(searchTokenRef.current, closeSearch), [closeSearch]);

  // Recompute on query/case + anything that redraws the diff DOM (file switch,
  // lazy content arrival, layout toggles). Debounced — the pass re-walks every
  // text node under the scroller.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      const ctrl = diffSearchCtrl();
      setSearchStatusIfChanged(ctrl ? ctrl.update(searchQuery, searchCase) : { count: 0, index: 0 });
    }, 120);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, searchCase, selectedId, contentVersion, viewType, rendered, data, diffSearchCtrl, setSearchStatusIfChanged]);

  // Hunk EXPANSION redraws the table with no state visible at this level —
  // observe the scroller so newly revealed lines get painted too. Loop-safe on
  // TWO conditions, both load-bearing: (1) the Highlight API paints without
  // mutating the DOM; (2) the match-count text this rerun updates renders in
  // FileSearchBar, which sits OUTSIDE the observed .session-diff-main root —
  // moving the count inside the scroller would close a permanent 250ms
  // observe→setState→characterData→observe loop. The recompute closure rides a
  // ref so a keystroke doesn't tear the observer down mid-burst; the 250ms here
  // (vs 120ms for typing) absorbs multi-node redraw bursts.
  const searchRecomputeRef = useRef<() => void>(() => {});
  searchRecomputeRef.current = () => {
    const ctrl = diffSearchCtrl();
    if (ctrl) setSearchStatusIfChanged(ctrl.update(searchQuery, searchCase));
  };
  useEffect(() => {
    if (!searchOpen) return;
    const root = containerRef.current?.querySelector('.session-diff-main');
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const obs = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => searchRecomputeRef.current(), 250);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); if (timer) clearTimeout(timer); };
    // data/selectedId: the scroller's CONTENT node can appear after the bar
    // opened (spinner/empty state first) — reattach when it does.
  }, [searchOpen, data, selectedId, diffSearchCtrl]);

  const handleSearchNav = useCallback((dir: 1 | -1) => {
    const ctrl = diffSearchCtrl();
    setSearchStatus(ctrl ? ctrl.nav(dir) : { count: 0, index: 0 });
  }, [diffSearchCtrl]);

  // ⌘F opens the bar. Capture phase beats the browser's native find. The
  // offsetParent probe answers "is THIS view on screen" — several session
  // columns can mount their own SessionDiffView at once, and only the visible
  // ones may react (trap: offsetParent is also null inside position:fixed
  // subtrees — if this panel ever goes fixed, ⌘F dies silently here). When the
  // key lands outside the diff, defer to a Files viewer only when it could
  // legitimately own the key: one inside THIS panel (the ghost context file)
  // or a document-level overlay — NOT a Files tab open in some other column.
  const hasSearchableDiff = !!data && data.fileCount > 0; // `empty` is declared below (render section)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      const el = containerRef.current;
      if (!el || el.offsetParent === null || !hasSearchableDiff) return;
      const t = e.target as HTMLElement | null;
      const inside = t ? el.contains(t) : false;
      if (!inside) {
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (pointerOwnedElsewhere(el)) return;
        const panel = el.closest('.session-panel');
        for (const v of Array.from(document.querySelectorAll('.file-content-view'))) {
          if (v.closest('.file-viewer-overlay') || panel?.contains(v)) return;
        }
      } else if (t?.closest('.file-content-view')) {
        // Key target is the ghost context file INSIDE the diff — its own
        // FileContentView ⌘F handler owns that search.
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [openSearch, hasSearchableDiff]);

  // 嵌套的文件预览自行管理选区，只扫描真正的 diff。
  const refreshDiffSelectionMatches = useSelectionMatches(
    () => containerRef.current?.querySelector<HTMLElement>('.session-diff-filepane') ?? null,
    (root, text) => collectTextMatches(root, text, true, 2000, DIFF_SEARCH_SKIP),
    [selectedId, ghost?.file],
  );

  // ── Cmd/Ctrl+click identifier → reference search (right-docked panel) ──────
  const [refState, setRefState] = useState<{
    symbol: string; fromFile: string; loading: boolean;
    result: ReferencesResponse | null; error: string | null;
  } | null>(null);
  const refSeqRef = useRef(0);

  const lookupReferences = useCallback((symbol: string, fromFile: string) => {
    const seq = ++refSeqRef.current;
    log.info('session-diff', 'reference lookup', { sessionId, symbol, fromFile });
    setRefState({ symbol, fromFile, loading: true, result: null, error: null });
    fetchReferences(fromFile, symbol, sessionHost)
      .then((res) => {
        if (refSeqRef.current === seq) setRefState({ symbol, fromFile, loading: false, result: res, error: null });
      })
      .catch((err) => {
        if (refSeqRef.current === seq) {
          setRefState({ symbol, fromFile, loading: false, result: null, error: err instanceof Error ? err.message : String(err) });
        }
      });
  }, [sessionHost, sessionId]);

  const closeReferences = useCallback(() => {
    refSeqRef.current++; // supersede any in-flight fetch
    setRefState(null);
  }, []);

  // The moment reference results land, prefetch the in-change files they point
  // at — by the time a row is clicked its diff content is already local, so
  // the jump doesn't pay a fetch round-trip on top of the render.
  useEffect(() => {
    const matches = refState?.result?.matches;
    if (!matches || !isSessionBase) return;
    const inChange = new Set(files.map((f) => f.change.filePath));
    const seen = new Set<string>();
    for (const m of matches) {
      if (seen.size >= 8) break; // cap the speculative fetches
      if (!inChange.has(m.file) || seen.has(m.file)) continue;
      seen.add(m.file);
      ensureFileContent(m.file);
    }
  }, [refState, files, isSessionBase, ensureFileContent]);

  // Esc closes the panel (capture, mirroring the Files tab).
  useEffect(() => {
    if (!refState) return;
    const onKey = (e: KeyboardEvent) => {
      // The compare picker's own Esc closes only the picker.
      if ((e.target as Element | null)?.closest?.('.session-diff-compare-pop')) return;
      if (e.key === 'Escape') { e.stopPropagation(); closeReferences(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [refState, closeReferences]);

  /** Nearest enclosing data-file-path for a DOM node (filepane roots carry it). */
  const filePathFromNode = useCallback((node: Node | null): string | undefined => {
    let n: Node | null = node;
    while (n && n !== containerRef.current) {
      if (n instanceof HTMLElement) {
        const fp = n.getAttribute('data-file-path');
        if (fp) return fp;
      }
      n = n.parentNode;
    }
    return undefined;
  }, []);
  // Line for a node inside the diff table, via react-diff-view's data-change-key
  // (`N<oldLine>` context / `I<newLine>` insert / `D<oldLine>` delete — the lib
  // does NOT emit data-line-number; v3 removed it). N-keys carry the OLD-side
  // number, so a context row's line can drift from the new-side file by the
  // insertions above it — fine for a human-facing "file:L<n>" hint.
  const lineFromNode = useCallback((node: Node | null): number | undefined => {
    let n: Node | null = node;
    while (n && n !== containerRef.current) {
      if (n instanceof HTMLElement) {
        const key = n.getAttribute('data-change-key');
        const m = key ? /^[NID](\d+)$/.exec(key) : null;
        if (m) return Number(m[1]);
      }
      n = n.parentNode;
    }
    return undefined;
  }, []);

  // metaKey on Apple platforms ONLY: there ctrl+click IS the context-menu
  // gesture — accepting ctrlKey would fire a repo-wide grep AND open the menu
  // on one physical click.
  const isSymbolLookupGesture = useCallback((e: ReactMouseEvent): boolean => {
    const apple = /Mac|iP/.test(navigator.platform);
    return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey;
  }, []);

  const handleDiffMouseDown = useCallback((e: ReactMouseEvent) => {
    if (!isSymbolLookupGesture(e) || e.button !== 0) return;
    const main = containerRef.current?.querySelector<HTMLElement>('.session-diff-main');
    const t = e.target as HTMLElement;
    if (!main || !main.contains(t)) return;
    // Ghost context files embed a FileContentView with its OWN cmd+click.
    if (t.closest(`${DIFF_SEARCH_SKIP}, .session-diff-ghost, button, a, input, textarea, select`)) return;
    const hit = wordAtPoint(document, e.clientX, e.clientY);
    if (!hit || !main.contains(hit.node)) return;
    const fromFile = filePathFromNode(hit.node) ?? selectedChange?.filePath;
    if (!fromFile) return;
    e.preventDefault(); // keep the caret still — this is a lookup, not a click
    lookupReferences(hit.word, fromFile);
  }, [isSymbolLookupGesture, filePathFromNode, lookupReferences, selectedChange]);

  // ── Right-click → code context menu (diff area only) ───────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ target: CodeContextTarget; filePath: string } | null>(null);
  const handleDiffContextMenu = useCallback((e: ReactMouseEvent) => {
    const main = containerRef.current?.querySelector<HTMLElement>('.session-diff-main');
    const t = e.target as HTMLElement;
    if (!main || !main.contains(t)) return; // tree/toolbar keep the native menu
    // Chrome text (gutters, unfold bars, AI blurbs…) is excluded from the
    // search index, so every menu action on it would fail — keep those native.
    // Ghost context files run their own FileContentView menu.
    if (t.closest(`${DIFF_SEARCH_SKIP}, input, textarea, .session-diff-ghost`)) return;
    const target = buildCodeContextTarget(e, main, wordAtPoint, SYMBOL_RE, lineFromNode);
    if (!target) return; // nothing to offer → native menu
    const filePath = filePathFromNode(t) ?? selectedChange?.filePath;
    if (!filePath) return;
    e.preventDefault();
    setSelection(null); // the Ask pill and the menu must not stack at the cursor
    setCtxMenu({ target, filePath });
  }, [lineFromNode, filePathFromNode, selectedChange]);
  // A different file under the cursor than when the menu opened = stale menu.
  useEffect(() => { setCtxMenu(null); }, [selectedId]);

  // Detect a text selection inside the diff → show the floating "Ask" pill.
  // The anchor is the POINTER at release (not the selection rect), so the pill
  // appears next to the cursor — below after a downward drag, above after an
  // upward one (SelectionAskPill decides the side from this point).
  const handleMouseUp = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return; // right-click must not raise the Ask pill under the menu
    // The question layer's own rows and card are not the diff.
    if ((e.target as Element | null)?.closest?.('.fv-thread-layer')) return;
    refreshDiffSelectionMatches();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { setSelection(null); return; }
    const text = sel.toString().trim();
    if (!text || !containerRef.current) { setSelection(null); return; }
    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) { setSelection(null); return; }

    let node: Node | null = range.commonAncestorContainer;
    let fileEl: HTMLElement | null = null;
    while (node && node !== containerRef.current) {
      if (node instanceof HTMLElement && node.classList.contains('session-diff-filepane')) { fileEl = node; break; }
      node = node.parentNode;
    }
    const filePath = fileEl?.getAttribute('data-file-path') ?? (selectedChange?.filePath ?? '');
    const line = lineFromNode(range.startContainer);

    // Read at mouseup, not at the pill's click: by then WebKit has dropped the
    // selection (the Files tab's Ask here did nothing for that, 2026-11-06).
    let ask: DiffPassage | { ok: false; reason: 'deleted' } | undefined;
    if (canAskHere && fileEl && selectedChange && selectedChange.filePath === filePath) {
      // The rendered markdown view draws the whole new file and nothing removed.
      const renderedView = !!fileEl.querySelector('.session-diff-rendered');
      ask = selectedChange.status === 'deleted'
        ? { ok: false, reason: 'deleted' }
        : diffPassageOf(fileEl, range, renderedView ? null : selectedChange.after);
    }
    setSelection({ x: e.clientX, y: e.clientY, text, filePath, line, ...(ask ? { ask } : {}) });
  }, [selectedChange, refreshDiffSelectionMatches, lineFromNode, canAskHere]);

  // An Ask here that opened no card says why, over the diff, for a few seconds.
  const [askNotice, setAskNotice] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (!askNotice) return;
    const t = window.setTimeout(() => setAskNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [askNotice]);
  const askHereSelection = useCallback(() => {
    const ask = selection?.ask;
    if (!ask?.ok) return;
    const layer = diffLayerRef.current;
    const res: FileAskResult = layer
      ? layer.askPassage({ quote: ask.quote, ...(ask.line ? { line: ask.line } : {}) })
      : { ok: false, reason: 'no-layer' };
    if (!res.ok) {
      log.warn('threads', 'ask here on a diff selection opened no card', { sessionId, path: selection?.filePath ?? '', reason: res.reason });
      setAskNotice({ text: FILE_ASK_FAILURE_TEXT[res.reason] });
    } else setAskNotice(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, sessionId]);

  const commitSelection = useCallback(() => {
    if (!selection) return;
    const short = displayPath(selection.filePath, data);
    onSelectCode(short, selection.line, selection.text);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, onSelectCode, data]);

  // ── Pending review batch (the GitHub PR-review model) ──────────────────────
  // Recorded comments accumulate HERE (not in FileDiffPane) so they survive file
  // switches — the user can comment across many files, then submit the whole
  // review in bulk. "Send now" bypasses this and fires one comment immediately.
  const [pending, setPending] = useState<PendingComment[]>(() => loadPendingReview(sessionId));
  // nextId must clear any persisted ids so a restored batch keeps stable, unique keys.
  const nextId = useRef(1);
  useEffect(() => {
    const restored = loadPendingReview(sessionId);
    setPending(restored);
    nextId.current = restored.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  }, [sessionId]);
  // Mirror every change of the batch to localStorage so it survives leaving the
  // Changed tab / closing the panel / a reload — only Discard or Submit clears it.
  useEffect(() => { savePendingReview(sessionId, pending); }, [sessionId, pending]);

  // Send one composed message to the agent (shared by "Send now" + "Submit review").
  // Falls back to prefilling the chat input when the parent didn't wire onComment.
  const sendMessage = useCallback((message: string) => {
    if (onComment) { void onComment(message); return; }
    onSelectCode('', undefined, message);
  }, [onComment, onSelectCode]);

  const addComment = useCallback((c: { filePath: string; anchorKey: string; changeKeys: string[]; loc: string; code: string; comment: string }) => {
    setPending((prev) => [...prev, { id: nextId.current++, ...c }]);
  }, []);
  const removeComment = useCallback((id: number) => {
    setPending((prev) => prev.filter((c) => c.id !== id));
  }, []);
  const copyComment = useCallback((c: PendingComment) => {
    void copyText(buildCommentMessage(c.loc, c.code, c.comment));
  }, []);
  const copyAll = useCallback(() => {
    void copyText(buildReviewMessage(pending));
  }, [pending]);
  const submitReview = useCallback(() => {
    if (pending.length === 0) return;
    sendMessage(buildReviewMessage(pending));
    setPending([]);
  }, [pending, sendMessage]);
  const discardReview = useCallback(() => setPending([]), []);

  // Comments anchored in the currently-open file (FileDiffPane renders these inline).
  const pendingForFile = useMemo(
    () => (selectedChange ? pending.filter((c) => c.filePath === selectedChange.filePath) : []),
    [pending, selectedChange],
  );

  const empty = !data || data.fileCount === 0;

  // The toolbar renders in EVERY state — loading and error included. A git
  // base on a huge remote repo can take 30s and then 502 (daemon git.diff
  // timeout); if the spinner/error replaced the toolbar, the Compare picker
  // would be unreachable and — with base/scope persisted per session — every
  // re-entry would replay the same doomed fetch with no way out.
  const toolbar = (
      <div className="session-diff-toolbar">
        {toolbarLeadingSlot}
        {/* VS Code-style layout toggle — same control as the Files tab. */}
        <button
          type="button"
          className="sfe-btn sfe-tree-toggle"
          onClick={() => setTreeCollapsed((c) => !c)}
          title={treeCollapsed ? 'Show file tree' : 'Hide file tree'}
          aria-label={treeCollapsed ? 'Show file tree' : 'Hide file tree'}
          aria-expanded={!treeCollapsed}
        >
          {treeCollapsed ? ICON_PANEL_LEFT : ICON_PANEL_LEFT_FILLED}
        </button>
        <div className="sfe-nav-group">
          <button
            type="button"
            className="sfe-btn sfe-nav-btn"
            onClick={() => navigateJump(-1)}
            disabled={!canJumpBack}
            title={canJumpBack ? 'Back (⌘[)' : 'Back (no earlier jump)'}
            aria-label="Back to the previous jump target"
          >‹</button>
          <button
            type="button"
            className="sfe-btn sfe-nav-btn"
            onClick={() => navigateJump(1)}
            disabled={!canJumpForward}
            title={canJumpForward ? 'Forward (⌘])' : 'Forward (no later jump)'}
            aria-label="Forward to the next jump target"
          >›</button>
        </div>
        <span className="session-diff-toolbar-title">
          {data && !switching
            ? (empty ? 'No file changes' : <>{shownCount} file{shownCount === 1 ? '' : 's'}<span className="session-diff-title-long"> changed</span></>)
            : error ? "Couldn't load changes" : (loading || switching ? 'Loading…' : 'Changes')}
          {!switching && wsOnlySet.size > 0 && (
            <span className="session-diff-ws-count" title="Files whose every change is whitespace (Hide whitespace shows them as unchanged)">{wsOnlySet.size} whitespace only</span>
          )}
          {!empty && !switching && reviewable > 0 && (
            <span
              className={`session-diff-viewed-count${viewedCount === reviewable ? ' is-done' : ''}`}
              title="Files you marked viewed that have not changed since (tick Viewed in a file's header). Kept in this browser, per comparison."
            >
              {viewedCount === reviewable ? `✓ ${viewedCount} of ${reviewable} viewed` : `${viewedCount} of ${reviewable} viewed`}
            </span>
          )}
          {!empty && !switching && changedCount > 0 && (
            <span className="session-diff-changed-count" title="Files you marked viewed that changed since: their marks wait for another look">{changedCount} changed since viewed</span>
          )}
          {/* Its room is kept while idle, so the controls after it never shift when it shows. */}
          {(() => {
            const on = refreshingBg || (loading && !!data && !switching);
            return <span className={`session-diff-refreshing${on ? '' : ' is-idle'}`} aria-hidden={on ? undefined : true} title={on ? 'List served from cache — re-scanning in the background' : undefined}>↻</span>;
          })()}
        </span>
        <div className="session-diff-base-wrap">
          <DiffComparePicker
            sessionId={sessionId}
            compare={compare}
            resolved={data?.groups.find((g) => g.compare)?.compare}
            onChange={pickCompare}
          />
          {/* Hover affordance → the vertical schematic explaining the three
              working-tree spans, and what a branch or commit comparison shows. */}
          <CompareHelp base={base} />
        </div>
        <div className="session-diff-toolbar-actions">
          <button
            type="button"
            className={`session-diff-ws-toggle${ignoreWhitespace ? ' is-active' : ''}`}
            onClick={toggleIgnoreWhitespace}
            aria-pressed={ignoreWhitespace}
            aria-label="Hide whitespace changes"
            disabled={rendered}
            title={ignoreWhitespace ? 'Whitespace changes hidden: lines that differ only in spaces, tabs or line endings read as unchanged. Click to show them.' : 'Hide whitespace changes (lines that differ only in spaces, tabs or line endings)'}
          >{ignoreWhitespace ? ICON_VIEWED_CHECK : ICON_WHITESPACE}<span>Hide whitespace</span></button>
          <div
            className="session-diff-viewtoggle"
            role="group"
            aria-label="Diff layout"
            title={rendered ? 'The rendered Markdown view has no diff layout' : selectedWholeFile ? 'New and deleted files always show the whole file' : undefined}
          >
            <button
              className={`session-diff-viewtoggle-btn${viewType === 'auto' && !selectedWholeFile ? ' is-active' : ''}`}
              onClick={() => setViewType('auto')}
              disabled={rendered || selectedWholeFile}
              title="Unified normally; split only where lines changed in place, when the pane is wide enough"
            >Auto</button>
            <button
              className={`session-diff-viewtoggle-btn${viewType === 'split' && !selectedWholeFile ? ' is-active' : ''}`}
              onClick={() => setViewType('split')}
              disabled={rendered || selectedWholeFile}
            >Split</button>
            <button
              className={`session-diff-viewtoggle-btn${(viewType === 'unified' || selectedWholeFile) ? ' is-active' : ''}`}
              onClick={() => setViewType('unified')}
              disabled={rendered || selectedWholeFile}
            >Unified</button>
          </div>
          {/* Hidden when there's nothing to search — the toolbar also renders in
              the loading/error/empty states, where an open bar can't render. */}
          {!empty && (
            <button
              className={`fv-html-tab${searchOpen ? ' active' : ''}`}
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
              title="Find in diff (⌘F)"
              aria-pressed={searchOpen}
            >Find</button>
          )}
          <button
            className={`session-diff-ai-toggle${aiSummaryOn ? ' is-active' : ''}`}
            onClick={toggleAiSummary}
            title={aiSummaryOn ? 'AI summaries on — click to hide' : 'AI summaries off — click to show a short AI blurb per file'}
            aria-pressed={aiSummaryOn}
          >✦ AI</button>
          {/* Commits the session's working-tree edits: not offered while a past commit is shown. */}
          {/* Kept in place on a one-commit view (disabled there), so the toolbar never shifts. */}
          <SessionCommitButton sessionId={sessionId} disabled={base === 'commit' || !data || empty} onCommitted={() => load(true)} />
          <button className="session-diff-refresh" onClick={() => { forgetGitRefs(sessionId); liveCancelRef.current?.(); liveCancelRef.current = load(true, true, true); }} title="Re-scan changes">
            {ICON_REFRESH}
          </button>
        </div>
        {barRightSlot && <span className="session-diff-toolbar-right">{barRightSlot}</span>}
        {/* Below one row of everything: ends the title row, so the comparison and the actions share the second. */}
        <span className="session-diff-toolbar-break" aria-hidden />
      </div>
  );

  // The session's repos now: branch, uncommitted files, +/- lines, unpushed commits.
  // Known before the list is (a separate, cheaper read), so it shows while the list loads.
  const gitStrip = gitGlance && gitGlance.repos.length > 0 && (
    <div className="session-diff-gitstrip" data-testid="session-diff-gitstrip">
      <GitGlanceLineView glance={gitGlance} words="long" />
      <GitCheckedAgo at={gitGlance.checkedAt} />
    </div>
  );

  if (loading && !data) {
    return (
      <div className="session-diff-view" ref={containerRef}>
        {toolbar}
        {gitStrip}
        <div className="session-diff-loading"><LoadingSpinner /></div>
      </div>
    );
  }

  // A failed refresh must not blank a list we already have (cached view stays
  // useful); the full error pane is for having NOTHING to show.
  if (error && (!data || switching)) {
    return (
      <div className="session-diff-view session-diff-error" ref={containerRef}>
        {toolbar}
        <div className="session-diff-error-box">
          {ICON_WARNING} <span>Couldn't load changes: {error}</span>
          <button className="btn btn-sm" onClick={() => load(true)}>Retry</button>
          {/* Git bases run on the (possibly remote) repo and can time out on
              huge monorepos — offer the always-works comparison as a way out. */}
          {base !== 'session' && (
            <button className="btn btn-sm" onClick={() => setBase('session')}>
              View this session's changes instead
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="session-diff-view"
      ref={containerRef}
      onMouseUp={handleMouseUp}
      onMouseDown={handleDiffMouseDown}
      onContextMenu={handleDiffContextMenu}
    >
      {toolbar}

      {gitStrip}

      {(wholeRepo || base === 'uncommitted' || base === 'remote') && <CompareStrip info={switching ? undefined : data?.groups.find((g) => g.compare)?.compare} compare={compare} />}

      {notice && (
        <div className="session-diff-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {/* Refresh failed but the cached list is still on screen — say so in a
          slim strip instead of blanking the view. */}
      {error && (
        <div className="session-diff-error-strip">
          {ICON_WARNING} <span>Refresh failed: {error}</span>
          <button className="btn btn-sm" onClick={() => load(true)}>Retry</button>
        </div>
      )}

      {searchOpen && !empty && (
        <FileSearchBar
          key={searchEpoch}
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

      {switching ? (
        <div className="session-diff-loading"><LoadingSpinner /></div>
      ) : empty ? (
        <div className="session-diff-empty">
          {base === 'session' ? (
            <>
              <p>This session hasn't edited any files yet.</p>
              <p className="text-muted">Edits, writes, and subagent changes will appear here as a diff.</p>
            </>
          ) : wholeRepo && !data?.groups.some((g) => g.compare) ? (
            <>
              <p>No git repository here.</p>
              <p className="text-muted">This session's folder is not in a git repository, so there is no branch or commit to compare with.</p>
            </>
          ) : base === 'branch' ? (
            <>
              <p>This branch has no changes.</p>
              <p className="text-muted">Nothing differs from where it left {data?.groups.find((g) => g.compare)?.compare?.ref ?? compare.ref ?? 'the default branch'}, uncommitted work included.</p>
            </>
          ) : base === 'commit' ? (
            <>
              <p>This commit changed no files.</p>
              <p className="text-muted">It matches its parent (an empty commit, or a merge that took its first parent's files).</p>
            </>
          ) : (
            <>
              <p>Nothing this session changed differs for this comparison.</p>
              <p className="text-muted">None of the files this session edited differ from "{BASE_OPTIONS.find((o) => o.value === base)?.label}".</p>
            </>
          )}
        </div>
      ) : (
        <div className="session-diff-body">
          {!treeCollapsed && (
            <>
              <div className="session-diff-tree" ref={tree.panelRef} style={{ width: tree.width }}>
                {data!.anyPartial && (
                  <div className="session-diff-partial-note" title="Some files changed on disk after the session edited them — those diffs are reconstructed best-effort.">
                    {ICON_WARNING} some diffs reconstructed
                  </div>
                )}
                {tree2.map((repo) => (
                  <TreeRow
                    key={repo.id}
                    node={repo}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggleDir}
                    selectedId={selectedId}
                    onSelectFile={selectFile}
                    critical={aiSummaryOn ? criticalMap : undefined}
                    viewed={viewedMap}
                    wsOnly={wsOnlySet}
                  />
                ))}
                {ghost && (
                  <div className="session-diff-tree-ghost" title={ghost.file}>
                    <span className="session-diff-tree-ghost-name">{basename(ghost.file)}</span>
                    <span className="session-diff-tree-ghost-tag">context</span>
                    <button
                      className="session-diff-tree-ghost-close"
                      onClick={closeGhost}
                      title="Close context file"
                      aria-label="Close context file"
                    >×</button>
                  </div>
                )}
              </div>
              <div
                className="session-diff-tree-resize"
                {...tree.handleProps}
                title="Drag to resize"
              />
            </>
          )}
          {/* A box that does not scroll around the one that does: the question
              layer over it stays put while the diff scrolls (FileThreadLayer). */}
          <div className="session-diff-main-wrap" ref={diffWrapRef}>
          <div className="session-diff-main">
            {ghost ? (
              <div className="session-diff-ghost">
                <div className="session-diff-ghost-banner">
                  <span className="session-diff-ghost-tag">context</span>
                  <span className="session-diff-ghost-path" title={ghost.file}>{ghost.file}</span>
                  <span className="session-diff-ghost-note">not part of this change — read-only</span>
                  {onOpenFile && (
                    <button
                      className="btn btn-sm"
                      onClick={() => { onOpenFile(ghost.file, ghost.line, ghost.term); }}
                      title="Open this file in the Files tab"
                    >Open in Files</button>
                  )}
                  <button className="btn btn-sm" onClick={closeGhost} title="Back to the diff (⌘[)">Back to diff</button>
                </div>
                <div className="session-diff-ghost-body">
                  <FileContentView
                    key={ghost.file}
                    path={ghost.file}
                    line={ghost.line}
                    lineTerm={ghost.term}
                    host={sessionHost}
                    hidePopout
                    // ⌘-click inside the context file keeps working, still in-tab.
                    onSymbolLookup={(symbol, filePath) => { lookupReferences(symbol, filePath); }}
                  />
                </div>
              </div>
            ) : selectedContentLoading ? (
              <div className="session-diff-file-empty"><LoadingSpinner /></div>
            ) : selectedChange ? (
              <FileDiffPane
                key={selectedChange.filePath}
                change={selectedChange}
                // A phone has no room for two columns: always one (C78).
                viewType={phoneDiff ? 'unified' : viewType}
                rendered={rendered}
                onToggleRendered={selectedIsMd ? toggleRendered : undefined}
                sessionCwd={sessionCwd}
                sessionHost={sessionHost}
                sessionId={sessionId}
                // Summaries always describe the SESSION's change to this file
                // (that's what the server reads) — shown under git bases too as
                // context; files the session never touched 404 → strip hides.
                aiSummaryOn={aiSummaryOn}
                pending={pendingForFile}
                onAddComment={addComment}
                onSendNow={sendMessage}
                onCopyComment={copyComment}
                onRemoveComment={removeComment}
                ignoreWhitespace={ignoreWhitespace}
                onShowWhitespace={showWhitespace}
                onShowUncommitted={base === 'session' ? showUncommitted : undefined}
                viewedState={viewedMap.get(selectedChange.filePath) ?? 'unviewed'}
                onToggleViewed={toggleViewed}
                onNextUnviewed={nextUnviewedId ? openNextUnviewed : null}
              />
            ) : (
              <div className="session-diff-file-empty">Select a file from the tree.</div>
            )}
          </div>
          {canAskHere && !ghost && !selectedContentLoading && selectedChange && selectedChange.status !== 'deleted' && (
            <FileThreadLayer
              ref={diffLayerRef}
              filePath={selectedChange.filePath}
              sessionId={sessionId}
              rootRef={diffWrapRef}
              frameRef={noFrameRef}
              surface="diff"
              surfaceNonce={`${selectedChange.filePath}:${phoneDiff ? 'unified' : viewType}:${rendered}:${selectedChange.after.length}`}
            />
          )}
          {askNotice && <FileAskNotice text={askNotice.text} />}
          </div>
          {refState && (
            <ReferencePanel
              result={refState.result}
              symbol={refState.symbol}
              currentFile={refState.fromFile}
              loading={refState.loading}
              error={refState.error}
              // A row jump stays IN the Changed tab: a changed file opens as
              // its diff at that line; anything else shows as a grayed
              // read-only context file in the same pane (⌘[ comes back).
              onOpen={(file, line) => { openDiffReference(file, line, refState.symbol); }}
              onClose={closeReferences}
            />
          )}
        </div>
      )}

      {pending.length > 0 && (
        <ReviewBar
          count={pending.length}
          onCopyAll={copyAll}
          onSubmit={submitReview}
          onDiscard={discardReview}
        />
      )}

      {selection && (
        <SelectionAskPill
          anchor={selection}
          onCommit={commitSelection}
          onAskHere={selection.ask?.ok ? askHereSelection : undefined}
          askHereOff={selection.ask && !selection.ask.ok ? DIFF_ASK_OFF_REASON[selection.ask.reason] : undefined}
          onDismiss={() => setSelection(null)}
        />
      )}

      {ctxMenu && (
        <CodeContextMenu
          target={ctxMenu.target}
          onClose={() => setCtxMenu(null)}
          onCopy={(text) => { void copyText(text); }}
          // Path asymmetry is load-bearing: Ask gets displayPath (short, display
          // only) while Find references gets the RAW absolute path —
          // /api/files/references needs it to resolve the repo root.
          onAsk={(text, line) => { onSelectCode(displayPath(ctxMenu.filePath, data), line, text); }}
          onFindReferences={(symbol) => { lookupReferences(symbol, ctxMenu.filePath); }}
          onFindInFile={(q) => { openSearch(q); }}
        />
      )}

      {/* Hidden keyboard nav target — ↑/↓ steps files when the diff has focus */}
      <div
        tabIndex={-1}
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); stepFile(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); stepFile(-1); }
        }}
      />
    </div>
  );
}

/** Copy to clipboard with a textarea fallback for non-secure contexts. */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (err) {
    log.warn('session-changes', 'clipboard copy failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Sticky footer summarizing the pending review: count + Copy all + Submit +
 *  Discard. The two send options are "Send now" (per-comment, in the box) and
 *  "Submit review" (the whole batch, here). */
function ReviewBar({ count, onCopyAll, onSubmit, onDiscard }: {
  count: number;
  onCopyAll: () => void;
  onSubmit: () => void;
  onDiscard: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    onCopyAll();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="session-diff-reviewbar" role="region" aria-label="Pending review">
      <span className="session-diff-reviewbar-count">{count} comment{count === 1 ? '' : 's'} pending</span>
      <div className="session-diff-reviewbar-actions">
        <button className="session-diff-reviewbar-discard" onClick={onDiscard} title="Discard all pending comments">Discard</button>
        <button className="session-diff-reviewbar-copy" onClick={copy} title="Copy all pending comments to the clipboard">
          {copied ? 'Copied' : 'Copy all'}
        </button>
        <button className="session-diff-reviewbar-submit" onClick={onSubmit} title="Send all pending comments to the agent as one review">
          Submit review ({count})
        </button>
      </div>
    </div>
  );
}

/** Map an absolute file path back to the repo-relative path the panel shows. */
function displayPath(absPath: string, data: SessionChangesResult | null): string {
  if (!data) return basename(absPath);
  for (const g of data.groups) {
    for (const f of g.files) {
      if (f.filePath === absPath) return f.relPath;
    }
  }
  return basename(absPath);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
