import { memo, useEffect, useMemo, useRef, useState, useCallback, type ReactNode, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Diff, Hunk, Decoration, tokenize, markEdits, useSourceExpansion,
  getChangeKey, computeOldLineNumber, computeNewLineNumber, isDelete,
  type HunkData, type FileData, type ChangeData, type ChangeEventArgs, type EventMap,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { fetchSessionChanges, fetchSessionFileChange, fetchFileChangeSummary, fetchChangesTriage, type SessionChangesResult, type SessionFileChange, type SessionDiffBase, type SessionDiffScope, type FileChangeSummary } from '@/api/session-changes';
import { ApiError } from '@/api/client';
import { buildFileData } from '@/components/sessions/diffPatch';
import { buildDiffTree, flattenFiles, allContainerIds, isMarkdownPath, type DiffTreeNode, type DiffTreeRepoNode } from '@/components/sessions/diffTree';
import { languageForPath, diffRefractor } from '@/components/sessions/diffHighlight';
import { buildCommentMessage, buildReviewMessage } from '@/components/sessions/diffPrefill';
import { markdownBlocksWithLines, markdownCommentRange, type MarkdownBlock } from '@/components/sessions/diffMarkdownBlocks';
import { computeExpandGaps, oldSourceLineCount, UNFOLD_CHUNK, type ExpandGap } from '@/components/sessions/diffExpand';
import { segmentHunkForAuto, type DiffSegment } from '@/components/sessions/diffAutoSegment';
import { hiddenFunctionContext, splitSourceLines, type StickyDef } from '@/components/sessions/diffFuncContext';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SelectionAskPill } from '@/components/common/SelectionAskPill';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import { FileContentView } from '@/components/common/FileContentView';
import { ReferencePanel } from '@/components/common/ReferencePanel';
import { CodeContextMenu, buildCodeContextTarget, type CodeContextTarget } from '@/components/common/CodeContextMenu';
import { fetchReferences, type ReferencesResponse } from '@/api/files';
import {
  DomSearchController, applyHighlights, clearHighlights, collectTextMatches,
  wordAtPoint, claimSearchOwner, onSearchOwnerLost, HL_SELMATCH, SYMBOL_RE,
} from '@/utils/dom-text-search';
import { ICON_REFRESH, ICON_WARNING, ICON_PANEL_LEFT, ICON_PANEL_LEFT_FILLED } from '@/components/common/Icons';
import { log } from '@/utils/log';

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
interface PendingComment {
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
function buildFile(change: SessionFileChange): FileData | null {
  const file = buildFileData(change);
  if (!file && change.before !== change.after) {
    log.warn('session-changes', 'buildFile produced no diff', { relPath: change.relPath });
  }
  return file;
}

/** Syntax + word-level token highlighting for a file's hunks. Combines Prism
 *  syntax colors (via refractor, when the file's language is known) with
 *  markEdits (intra-line add/del coloring). Highlighting is best-effort: any
 *  failure (or unknown language) falls back to plain markEdits-only tokens so a
 *  bad grammar can never throw out of the useMemo and blank the panel. */
function useTokens(hunks: HunkData[] | undefined, relPath: string): ReturnType<typeof tokenize> | undefined {
  const language = useMemo(() => languageForPath(relPath), [relPath]);
  return useMemo(() => {
    if (!hunks) return undefined;
    const enhancers = [markEdits(hunks, { type: 'block' })];
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
  }, [hunks, language]);
}

// ── File tree (left rail) ────────────────────────────────────────────────────

function statusGlyph(status: SessionFileChange['status']): { ch: string; cls: string; title: string } {
  if (status === 'added') return { ch: 'A', cls: 'added', title: 'Added' };
  if (status === 'deleted') return { ch: 'D', cls: 'deleted', title: 'Deleted' };
  if (status === 'renamed') return { ch: 'R', cls: 'renamed', title: 'Renamed / moved' };
  return { ch: 'M', cls: 'modified', title: 'Modified' };
}

function TreeRow({
  node, depth, expanded, onToggle, selectedId, onSelectFile, critical,
}: {
  node: DiffTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelectFile: (change: SessionFileChange) => void;
  /** filePath → reason for the changeset's AI-triaged critical files (✦). */
  critical?: Map<string, string>;
}) {
  const pad = { paddingLeft: 6 + depth * 14 };

  if (node.kind === 'file') {
    const g = statusGlyph(node.change.status);
    const isSel = selectedId === node.id;
    return (
      <button
        className={`session-diff-tree-file${isSel ? ' is-selected' : ''}`}
        style={pad}
        title={node.change.status === 'renamed' && node.change.oldRelPath ? `${node.change.oldRelPath} → ${node.change.relPath}` : node.change.relPath}
        onClick={() => onSelectFile(node.change)}
      >
        <span className={`session-diff-tree-status status-${g.cls}`} title={g.title}>{g.ch}</span>
        <span className="session-diff-tree-name">{node.name}</span>
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
        />
      ))}
    </>
  );
}

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
function CommentBox({ loc, onAdd, onSendNow, onCancel, onDirtyChange }: {
  loc: string;
  onAdd: (text: string) => void;
  onSendNow: (text: string) => void;
  onCancel: () => void;
  /** Reports whether the box holds unsaved text. The parent uses this to LOCK the
   *  composer: while it's dirty, clicking another line is ignored so a half-typed
   *  comment is never silently discarded — the user must Add / Send now / Cancel. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // Clear the dirty lock when this box goes away (Add / Send / Cancel / file switch).
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const update = (v: string) => { setText(v); onDirtyChange?.(v.trim().length > 0); };
  const add = () => { const t = text.trim(); if (t) onAdd(t); };
  const sendNow = () => { const t = text.trim(); if (t) onSendNow(t); };
  return (
    <div className="session-diff-comment-box">
      <div className="session-diff-comment-loc">{loc}</div>
      <textarea
        ref={ref}
        className="session-diff-comment-input"
        placeholder="Leave a comment… (⌘/Ctrl+Enter to add, +Shift to send now)"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (e.shiftKey) sendNow(); else add();
          } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          e.stopPropagation();
        }}
        rows={3}
      />
      <div className="session-diff-comment-actions">
        <button className="session-diff-comment-cancel" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>Cancel</button>
        <button className="session-diff-comment-sendnow" onMouseDown={(e) => e.preventDefault()} onClick={sendNow} disabled={!text.trim()} title="Send this one comment to the agent right now">Send now</button>
        <button className="session-diff-comment-add" onMouseDown={(e) => e.preventDefault()} onClick={add} disabled={!text.trim()} title="Record this comment; submit the whole review at the end">Add comment</button>
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
function SegmentDiff({ seg, diffType, relPath, widgets, gutterEvents, selectedChanges, dragging }: {
  seg: DiffSegment;
  diffType: FileData['type'];
  relPath: string;
  widgets: Record<string, ReactNode> | undefined;
  gutterEvents: EventMap;
  selectedChanges: string[];
  dragging: boolean;
}) {
  const segHunks = useMemo(() => [seg.hunk], [seg.hunk]);
  const tokens = useTokens(segHunks, relPath);
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
  return <div className="markdown-body session-diff-rendered-block" dangerouslySetInnerHTML={{ __html: html }} />;
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
          dangerouslySetInnerHTML={{ __html: html }}
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

function FileDiffPane({
  change, viewType, rendered, sessionCwd, sessionHost, pending, sessionId, aiSummaryOn,
  onAddComment, onSendNow, onCopyComment, onRemoveComment,
}: {
  change: SessionFileChange;
  viewType: DiffViewMode;
  rendered: boolean;
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
  const file = useMemo(() => buildFile(change), [change]);
  // Expand collapsed context on demand: we already hold the full OLD source as
  // `change.before` (git HEAD/upstream content, or the reconstructed pre-session
  // file), so react-diff-view can splice the hidden surrounding lines back in.
  // `hunks` is the (possibly expanded) set actually rendered; `expandRange(start,
  // end)` reveals old-side lines [start,end). The hook auto-clears expansions when
  // `file.hunks` identity or the source changes — i.e. on every file switch.
  const [hunks, expandRange] = useSourceExpansion(file?.hunks ?? EMPTY_HUNKS, change.before ?? null);
  const tokens = useTokens(hunks, change.relPath);

  // Auto-reveal tiny BETWEEN-hunk gaps: two hunks separated by ≤ UNFOLD_CHUNK
  // unchanged lines read better as one continuous block than as two sections
  // split by an expand bar. One gap per pass — expanding merges hunks, which
  // re-runs this effect until no small between-gap remains (bounded by the
  // number of hunks). The file's head/tail gaps keep their bars: auto-showing
  // dozens of leading imports would be noise, not context.
  //
  // triedRef is the no-progress brake: if expandRange can't actually reveal a
  // range (truncated/partial `before` content) but still returns a fresh hunks
  // identity, retrying the same range forever would wedge the whole tab in a
  // render loop. Each range is attempted ONCE per file/source.
  const autoExpandTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => { autoExpandTriedRef.current.clear(); }, [change.filePath, change.before]);
  useEffect(() => {
    const gaps = computeExpandGaps(hunks, oldSourceLineCount(change.before));
    const small = gaps.find((g) =>
      g.hunkIndex > 0 && g.hunkIndex < hunks.length && g.lines <= UNFOLD_CHUNK
      && !autoExpandTriedRef.current.has(`${g.all[0]}:${g.all[1]}`));
    if (small) {
      autoExpandTriedRef.current.add(`${small.all[0]}:${small.all[1]}`);
      expandRange(small.all[0], small.all[1]);
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
  const autoHybrid = viewType === 'auto' && !isWholeFile;
  // The single-<Diff> layout used when a fixed mode is forced (or the file is
  // whole-file). In auto the hybrid path below renders instead.
  const effectiveViewType: DiffViewType = isWholeFile || viewType === 'auto' ? 'unified' : viewType;

  // The line the user clicked the gutter on → an open comment draft anchored there.
  const [draft, setDraft] = useState<CommentDraft | null>(null);
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
  }, [rendered, change.after, change.before, sessionCwd, sessionHost]);

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
            <CommentBox loc={draft!.loc} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} />
          )}
        </>
      );
    }
    // Draft anchored on a line that has no recorded comments yet.
    if (draft && !byAnchor.has(draft.anchorKey)) {
      map[draft.anchorKey] = (
        <CommentBox loc={draft.loc} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} />
      );
    }
    return Object.keys(map).length ? map : undefined;
  }, [pending, draft, addDraft, sendDraftNow, cancelDraft, onDraftDirtyChange, onCopyComment, onRemoveComment]);

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
          <CommentBox loc={draft!.loc} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={cancelDraft} onDirtyChange={onDraftDirtyChange} />
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
          />,
        );
      }
    });
    const tail = gapByIndex.get(hunks.length);
    if (tail) out.push(<div key="exp-tail" className="session-diff-expand-standalone">{gapRow(tail, hunks, false)}</div>);
    return out;
  }, [autoHybrid, file, hunks, oldLineCount, gapRow, change.relPath, widgets, gutterEvents, selectedChanges, dragSel]);

  return (
    <div className="session-diff-filepane" data-file-path={change.filePath}>
      {/* Sticky wrapper keeps the header AND the ✦ strip pinned while the diff
          scrolls (a fixed pixel `top` on the strip breaks at other zoom/font
          sizes; the head's own sticky is inert inside this wrapper). */}
      <div className="session-diff-filepane-sticky">
      <div className="session-diff-filepane-head">
        <span className="session-diff-filepane-path" title={change.filePath}>{change.relPath}</span>
        {change.status === 'renamed' && change.oldRelPath && (
          <span className="session-diff-filepane-renamed" title={`moved from ${change.oldRelPath}`}>renamed from <code>{change.oldRelPath}</code></span>
        )}
        <span className="session-diff-filepane-stat">
          {adds > 0 && <span className="session-diff-stat-add">+{adds}</span>}
          {dels > 0 && <span className="session-diff-stat-del">{'−'}{dels}</span>}
        </span>
        <span className="session-diff-filepane-hint">
          {rendered
            ? 'Click a line number — or drag down the numbers to select a range — to comment'
            : 'Click a line — or drag the gutter to select a range — to comment'}
        </span>
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
      ) : change.status === 'renamed' ? (
        <div className="session-diff-file-empty">File moved{change.oldRelPath ? ` from ${change.oldRelPath}` : ''} — content unchanged.</div>
      ) : (
        <div className="session-diff-file-empty">No textual diff (binary, identical, or unreadable content).</div>
      )}
    </div>
  );
}

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

interface DiffViewMemory { base?: SessionDiffBase; scope?: SessionDiffScope; selectedId?: string }

function loadDiffMemory(sessionId: string): DiffViewMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(DIFF_STATE_PREFIX + sessionId) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: DiffViewMemory = {};
    if (BASE_OPTIONS.some((o) => o.value === parsed.base)) out.base = parsed.base;
    // scope is no longer read: the 'all' scope was removed, and ignoring old
    // stored values also heals any memory that had the repo-wide trap saved.
    if (typeof parsed.selectedId === 'string') out.selectedId = parsed.selectedId;
    return out;
  } catch { return {}; }
}

function saveDiffMemory(sessionId: string, mem: DiffViewMemory): void {
  try { localStorage.setItem(DIFF_STATE_PREFIX + sessionId, JSON.stringify(mem)); } catch { /* non-fatal */ }
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
  { id: 'uncommitted', anchorRow: 2, label: 'Uncommitted changes', meaning: 'Working tree vs your last commit' },
  { id: 'remote', anchorRow: 4, label: 'Not yet pushed', meaning: 'Working tree vs the remote — may span many local commits' },
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
      <div className="compare-graph-title">All three, compared</div>
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
            ? <>You’re viewing <b>Uncommitted changes</b> — everything in your working tree you haven’t committed yet.</>
            : <>You’re viewing <b>Not yet pushed</b> — may span many local commits (e.g. auto-saves).</>}
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
 *  mode's gutter and the recorded-comment cards. */
const DIFF_SEARCH_SKIP = '.diff-gutter, .diff-widget, .session-diff-expander, .session-diff-filepane-head, .session-diff-ai-summary, .session-diff-rendered-lineno, .session-diff-pending-card';

// Last result per session|base, module-level so it SURVIVES the tab switch
// (the panel unmounts this view). Re-entering paints the previous list
// instantly and refreshes behind it — without this, every visit started at
// `data=null` → a full spinner, and git bases re-ran their whole (possibly
// remote, 10-30s) diff while the user stared at it. LRU-capped: git-base
// results carry before/after content and a monorepo entry can be MBs.
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

export function SessionDiffView({ sessionId, sessionCwd, sessionHost, onSelectCode, onComment, barRightSlot, onOpenFile }: SessionDiffViewProps) {
  const [data, setData] = useState<SessionChangesResult | null>(() => {
    const mem = loadDiffMemory(sessionId);
    return lastChangesCache.get(`${sessionId}|${mem.base ?? 'session'}|session`) ?? null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Layout mode. 'auto' (the default) shows each file the way it reads best:
  // unified when one side would be empty anyway, split only when lines changed
  // in place. New storage key on purpose — the old 'open-walnut-diff-view' key
  // has 'split' saved everywhere, which would silently defeat the auto default.
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
  // Base/selected file are remembered per session — coming back to the
  // Changed tab restores the exact view you left (loadDiffMemory above).
  const [base, setBase] = useState<SessionDiffBase>(() => loadDiffMemory(sessionId).base ?? 'session');
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
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resizable tree rail (left of the diff). Stored as % of viewport.
  const tree = useResizablePanel('open-walnut-diff-tree-w', 22, 'left');

  // Floating "Ask about this" affordance, positioned at the current text selection.
  const [selection, setSelection] = useState<{ x: number; y: number; text: string; filePath: string; line?: number } | null>(null);

  // Session-base lists ship LIGHT (no before/after) + SWR (cached list paints
  // instantly, recompute runs behind) — per-file diffs load lazily below. Git
  // bases keep the original full blocking fetch (their diff comes from git).
  const isSessionBase = base === 'session';
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
  const baseKey = `${base}|${scope}`;
  const cacheKey = `${sessionId}|${baseKey}`;
  const prevBaseKey = useRef(baseKey);
  useEffect(() => {
    if (prevBaseKey.current === baseKey) return;
    prevBaseKey.current = baseKey;
    setData(lastChangesCache.get(cacheKey) ?? null);
    fileContentRef.current.clear();
  }, [baseKey, cacheKey]);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    const light = isSessionBase;
    // Converge by POLLING the SWR endpoint (cheap: cache/stat only) until the
    // background recompute lands (stale flag clears). The previous approach — a
    // blocking light fetch queued behind the recompute — sat on one HTTP
    // request for the whale's full 50-80s cold parse and DIED at the client's
    // 60s timeout, leaving the tab stuck on a stale list.
    const POLL_MS = 3000;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollUntilFresh = (attempt: number): void => {
      if (ctrl.signal.aborted) return;
      setRefreshingBg(true);
      pollTimer = setTimeout(() => {
        fetchSessionChanges(sessionId, { base, scope, light: true, swr: true, signal: ctrl.signal })
          .then((res) => {
            if (ctrl.signal.aborted) return;
            if (res.stale) {
              // Still recomputing — keep the currently-shown list, poll again
              // (cap ~5min so an abandoned tab doesn't poll forever).
              if (attempt < 100) pollUntilFresh(attempt + 1);
              else setRefreshingBg(false);
              return;
            }
            rememberChanges(cacheKey, res);
            setData(res);
            fileContentRef.current.clear();
            setContentVersion((v) => v + 1);
            setRefreshingBg(false);
          })
          .catch(() => { if (!ctrl.signal.aborted) setRefreshingBg(false); });
      }, POLL_MS);
    };
    fetchSessionChanges(sessionId, { refresh, base, scope, light, swr: light && !refresh, signal: ctrl.signal })
      .then((res) => {
        // Cache stale results too — a stale list is exactly what a re-entry
        // wants to paint first; the background poll upgrades it in place.
        rememberChanges(cacheKey, res);
        setData(res);
        if (refresh) {
          fileContentRef.current.clear();
          setContentVersion((v) => v + 1);
        }
        if (res.stale && light) pollUntilFresh(0);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        log.warn('session-changes', 'fetch failed', { sessionId, base, scope, error: msg });
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => { ctrl.abort(); if (pollTimer) clearTimeout(pollTimer); };
  }, [sessionId, base, scope, isSessionBase, cacheKey]);

  useEffect(() => {
    const cancel = load(false);
    return cancel;
  }, [load]);

  useEffect(() => {
    try { localStorage.setItem('open-walnut-diff-view-mode', viewType); } catch { /* ignore */ }
  }, [viewType]);

  // If this component instance is reused for ANOTHER session (no remount),
  // reload that session's remembered view instead of leaking this one's.
  const memSessionRef = useRef(sessionId);
  useEffect(() => {
    if (memSessionRef.current === sessionId) return;
    memSessionRef.current = sessionId;
    const mem = loadDiffMemory(sessionId);
    setBase(mem.base ?? 'session');
    // Seed the NEW session's cached list (or clear) — without this the old
    // session's files linger under the new session while its fetch runs.
    setData(lastChangesCache.get(`${sessionId}|${mem.base ?? 'session'}|session`) ?? null);
    fileContentRef.current.clear();
    setSelectedId(null);
    pendingRestoreRef.current = mem.selectedId ?? null;
  }, [sessionId]);

  // Persist the remembered view. While selectedId is still null (initial data
  // load) keep the STORED selection instead of overwriting it — otherwise a
  // slow fetch wipes it before the restore effect can validate it against the
  // arriving file list.
  useEffect(() => {
    saveDiffMemory(sessionId, {
      base,
      selectedId: selectedId ?? loadDiffMemory(sessionId).selectedId,
    });
  }, [sessionId, base, selectedId]);

  const tree2 = useMemo<DiffTreeRepoNode[]>(() => buildDiffTree(data?.groups ?? []), [data]);
  const files = useMemo(() => flattenFiles(tree2), [tree2]);

  // On data change: expand all containers + select the remembered file if it's
  // still in the list, else the first file.
  useEffect(() => {
    if (!tree2.length) { setSelectedId(null); return; }
    setExpanded(new Set(allContainerIds(tree2)));
    setSelectedId((prev) => {
      const want = prev ?? pendingRestoreRef.current;
      pendingRestoreRef.current = null;
      return (want && files.some((f) => f.id === want)) ? want : (files[0]?.id ?? null);
    });
  }, [tree2, files]);

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
  const ensureFileContent = useCallback((filePath: string) => {
    if (fileContentRef.current.has(filePath) || fileFetchesRef.current.has(filePath)) return;
    fileFetchesRef.current.add(filePath);
    fetchSessionFileChange(sessionId, filePath)
      .then((res) => {
        fileContentRef.current.set(filePath, res.file);
        setContentVersion((v) => v + 1);
      })
      .catch((err) => {
        log.warn('session-changes', 'file diff fetch failed', {
          sessionId, filePath, error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { fileFetchesRef.current.delete(filePath); });
  }, [sessionId]);

  useEffect(() => {
    if (!isSessionBase || !selectedChangeRaw) return;
    ensureFileContent(selectedChangeRaw.filePath);
    // Prefetch neighbours (±2 in tree order) so ↑/↓ stepping feels instant.
    const idx = files.findIndex((f) => f.id === selectedId);
    for (const off of [1, -1, 2, -2]) {
      const n = files[idx + off];
      if (n) ensureFileContent(n.change.filePath);
    }
  }, [isSessionBase, selectedChangeRaw, files, selectedId, ensureFileContent]);

  // The change record FileDiffPane renders: light row hydrated with fetched
  // content. contentVersion re-runs this when a lazy fetch lands.
  const selectedChange = useMemo(() => {
    void contentVersion;
    if (!selectedChangeRaw) return null;
    if (!isSessionBase) return selectedChangeRaw;
    const full = fileContentRef.current.get(selectedChangeRaw.filePath);
    return full ? { ...selectedChangeRaw, before: full.before, after: full.after, partial: full.partial } : null;
  }, [selectedChangeRaw, isSessionBase, contentVersion]);
  const selectedContentLoading = isSessionBase && !!selectedChangeRaw && !selectedChange;

  // Reset Rendered when the selected file isn't markdown.
  const selectedIsMd = selectedChange ? isMarkdownPath(selectedChange.relPath) : false;
  useEffect(() => { if (!selectedIsMd && rendered) setRendered(false); }, [selectedIsMd, rendered]);

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
      if (++tries < 20) window.setTimeout(attempt, 150);
    };
    window.setTimeout(attempt, 50);
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

  // ── Select → highlight every exact match (same paint as the Files viewer) ──
  // paintedRef: only clear the (document-global) highlight WE painted — another
  // viewer instance may own the name right now.
  const selMatchPaintedRef = useRef(false);
  const refreshDiffSelectionMatches = useCallback(() => {
    const root = containerRef.current?.querySelector<HTMLElement>('.session-diff-main');
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString() : '';
    const t = text.trim();
    if (!root || !t || t.length < 3 || t.length > 200 || t.includes('\n')
      || !sel || !sel.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      if (selMatchPaintedRef.current) {
        clearHighlights(window, HL_SELMATCH);
        selMatchPaintedRef.current = false;
      }
      return;
    }
    applyHighlights(window, HL_SELMATCH, collectTextMatches(root, t, true, 2000, DIFF_SEARCH_SKIP));
    selMatchPaintedRef.current = true;
  }, []);
  // The paint must track the SELECTION, not our mouse-ups: clearing the
  // selection by clicking in the chat pane (or selecting text in another
  // component) never fires a mouse-up here, which left the old highlight
  // stuck on screen. selectionchange fires for all of those; debounce it so
  // drag-selection doesn't re-scan a whale diff every frame.
  useEffect(() => {
    let timer = 0;
    const onSelChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refreshDiffSelectionMatches, 120);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      document.removeEventListener('selectionchange', onSelChange);
      window.clearTimeout(timer);
    };
  }, [refreshDiffSelectionMatches]);
  useEffect(() => () => { if (selMatchPaintedRef.current) clearHighlights(window, HL_SELMATCH); }, []);
  // File switch replaces the pane DOM — drop paint that points into the old tree.
  useEffect(() => {
    if (selMatchPaintedRef.current) {
      clearHighlights(window, HL_SELMATCH);
      selMatchPaintedRef.current = false;
    }
  }, [selectedId]);

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

  // Esc closes the panel (capture, mirroring the Files tab).
  useEffect(() => {
    if (!refState) return;
    const onKey = (e: KeyboardEvent) => {
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

    setSelection({ x: e.clientX, y: e.clientY, text, filePath, line });
  }, [selectedChange, refreshDiffSelectionMatches, lineFromNode]);

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
          {data ? (empty ? 'No file changes' : `${data.fileCount} file${data.fileCount === 1 ? '' : 's'} changed`) : (loading ? 'Loading…' : 'Changes')}
          {(refreshingBg || (loading && !!data)) && <span className="session-diff-refreshing" title="List served from cache — re-scanning in the background">↻</span>}
        </span>
        <div className="session-diff-base-wrap">
          <label className="session-diff-base-select" title="Choose what the diff compares against">
            <span className="session-diff-base-label">Compare:</span>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value as SessionDiffBase)}
            >
              {BASE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>
              ))}
            </select>
          </label>
          {/* Hover affordance → the vertical schematic explaining all three spans. */}
          <CompareHelp base={base} />
        </div>
        <div className="session-diff-toolbar-actions">
          {selectedIsMd && (
            <button
              className={`session-diff-rendered-toggle${rendered ? ' is-active' : ''}`}
              onClick={() => setRendered((r) => !r)}
              title="Toggle rendered markdown / diff"
            >
              {rendered ? 'Diff' : 'Rendered'}
            </button>
          )}
          <div
            className="session-diff-viewtoggle"
            role="group"
            aria-label="Diff layout"
            title={selectedWholeFile ? 'New/deleted files always show the whole file' : undefined}
          >
            <button
              className={`session-diff-viewtoggle-btn${viewType === 'auto' && !selectedWholeFile ? ' is-active' : ''}`}
              onClick={() => setViewType('auto')}
              disabled={rendered || selectedWholeFile}
              title="Unified normally; split only where lines changed in place"
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
          <button className="session-diff-refresh" onClick={() => load(true)} title="Re-scan changes">
            {ICON_REFRESH}
          </button>
        </div>
        {barRightSlot}
      </div>
  );

  if (loading && !data) {
    return (
      <div className="session-diff-view" ref={containerRef}>
        {toolbar}
        <div className="session-diff-loading"><LoadingSpinner /></div>
      </div>
    );
  }

  // A failed refresh must not blank a list we already have (cached view stays
  // useful); the full error pane is for having NOTHING to show.
  if (error && !data) {
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

      {empty ? (
        <div className="session-diff-empty">
          {base === 'session' ? (
            <>
              <p>This session hasn't edited any files yet.</p>
              <p className="text-muted">Edits, writes, and subagent changes will appear here as a diff.</p>
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
                viewType={viewType}
                rendered={rendered}
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
              />
            ) : (
              <div className="session-diff-file-empty">Select a file from the tree.</div>
            )}
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
