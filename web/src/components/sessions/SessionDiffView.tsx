import { memo, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import {
  Diff, Hunk, tokenize, markEdits,
  getChangeKey, computeOldLineNumber, computeNewLineNumber, isDelete,
  type HunkData, type FileData, type ChangeData, type ChangeEventArgs, type EventMap,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { fetchSessionChanges, type SessionChangesResult, type SessionFileChange, type SessionDiffBase, type SessionDiffScope } from '@/api/session-changes';
import { buildFileData } from '@/components/sessions/diffPatch';
import { buildDiffTree, flattenFiles, allContainerIds, isMarkdownPath, type DiffTreeNode, type DiffTreeRepoNode } from '@/components/sessions/diffTree';
import { languageForPath, diffRefractor } from '@/components/sessions/diffHighlight';
import { buildCommentMessage, buildReviewMessage } from '@/components/sessions/diffPrefill';
import { markdownBlocksWithLines, type MarkdownBlock } from '@/components/sessions/diffMarkdownBlocks';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ICON_REFRESH, ICON_WARNING } from '@/components/common/Icons';
import { log } from '@/utils/log';

export type DiffViewType = 'split' | 'unified';

/** Comparison-BASE options. Every mode is scoped to the repos THIS session
 *  edited — the base only changes the baseline `before`/`after` is read from,
 *  never which repo is shown (a session that edited nothing is empty in all). */
const BASE_OPTIONS: ReadonlyArray<{ value: SessionDiffBase; label: string; hint: string }> = [
  { value: 'session', label: 'Session changes', hint: "What THIS session edited, reconstructed from its own history (no git)" },
  { value: 'uncommitted', label: 'vs last commit', hint: "This session's files, compared against the last commit (git diff HEAD)" },
  { value: 'previous', label: 'vs previous commit', hint: "This session's files, compared against the commit before HEAD (git diff HEAD~1)" },
  { value: 'remote', label: 'vs remote (unpushed)', hint: "This session's files, compared against the pushed/remote branch (git diff @{upstream})" },
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
}

/** An in-progress inline comment anchored to a line range within one file. */
interface CommentDraft {
  filePath: string;
  relPath: string;
  /** react-diff-view change key of the anchor line (where the widget renders). */
  anchorKey: string;
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
  loc: string;
  code: string;
  comment: string;
}

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
  return { ch: 'M', cls: 'modified', title: 'Modified' };
}

function TreeRow({
  node, depth, expanded, onToggle, selectedId, onSelectFile,
}: {
  node: DiffTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelectFile: (change: SessionFileChange) => void;
}) {
  const pad = { paddingLeft: 6 + depth * 14 };

  if (node.kind === 'file') {
    const g = statusGlyph(node.change.status);
    const isSel = selectedId === node.id;
    return (
      <button
        className={`session-diff-tree-file${isSel ? ' is-selected' : ''}`}
        style={pad}
        title={node.change.relPath}
        onClick={() => onSelectFile(node.change)}
      >
        <span className={`session-diff-tree-status status-${g.cls}`} title={g.title}>{g.ch}</span>
        <span className="session-diff-tree-name">{node.name}</span>
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
        <span className="session-diff-tree-dir-name">{isRepo ? node.label : node.name}</span>
        {isRepo && <span className={`session-diff-tree-repokind kind-${node.repoKind}`}>{node.repoKind === 'cwd' ? 'cwd' : node.repoKind}</span>}
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
function CommentBox({ loc, onAdd, onSendNow, onCancel }: {
  loc: string;
  onAdd: (text: string) => void;
  onSendNow: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
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
        onChange={(e) => setText(e.target.value)}
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

// ── Rendered markdown pane ────────────────────────────────────────────────────

/** One rendered markdown block (heading/paragraph/list/…) with a source
 *  line-number gutter to its left. Behind React.memo keyed on (line, html) so a
 *  selection-only re-render of the parent is a no-op here — see RenderedMarkdown. */
const RenderedMarkdownBlock = memo(function RenderedMarkdownBlock({ line, html }: MarkdownBlock) {
  return (
    <div className="session-diff-rendered-row">
      <span className="session-diff-rendered-lineno" aria-hidden>{line}</span>
      <div className="markdown-body session-diff-rendered-block" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

/** The rendered-markdown body: source content rendered as HTML with a left
 *  line-number gutter (each top-level block tagged with the source line it
 *  begins on — GitHub shows none, but this is a review view where locating a
 *  block in the file matters).
 *
 *  WHY blocks + React.memo: selecting text fires the parent's onMouseUp →
 *  setSelection → FileDiffPane re-renders. Inlining `dangerouslySetInnerHTML`
 *  would make React re-apply innerHTML on every such re-render (new object
 *  identity), tearing down and rebuilding all the text nodes and COLLAPSING the
 *  live selection ~3ms after mouseup — the "won't keep the selection" bug.
 *  Memoizing each block on its html means a selection-only re-render is a no-op,
 *  so the DOM (and the live selection) survives. */
const RenderedMarkdown = memo(function RenderedMarkdown({ blocks }: { blocks: MarkdownBlock[] }) {
  return (
    <div className="session-diff-rendered markdown-rendered-gutter">
      {blocks.map((b, i) => (
        <RenderedMarkdownBlock key={`${b.line}-${i}`} line={b.line} html={b.html} />
      ))}
    </div>
  );
});

// ── Single-file diff (center) ─────────────────────────────────────────────────

function FileDiffPane({
  change, viewType, rendered, sessionCwd, sessionHost, pending,
  onAddComment, onSendNow, onCopyComment, onRemoveComment,
}: {
  change: SessionFileChange;
  viewType: DiffViewType;
  rendered: boolean;
  sessionCwd?: string;
  sessionHost?: string;
  /** Recorded comments anchored in THIS file (subset of the review batch). */
  pending: PendingComment[];
  /** Record a comment to the pending review batch (the "Add comment" path). */
  onAddComment: (c: { filePath: string; anchorKey: string; loc: string; code: string; comment: string }) => void;
  /** Send a single comment to the agent immediately (the "Send now" path). */
  onSendNow: (message: string) => void;
  /** Copy a single recorded comment's composed text to the clipboard. */
  onCopyComment: (c: PendingComment) => void;
  /** Remove a recorded comment from the batch. */
  onRemoveComment: (id: number) => void;
}) {
  const file = useMemo(() => buildFile(change), [change]);
  const tokens = useTokens(file?.hunks, change.relPath);

  // Added files have no "before" — a split view would show an empty left pane.
  // Force unified so the whole new file reads as one continuous green column
  // (GitHub does the same for brand-new files). Deleted files are the mirror.
  const isWholeFile = change.status === 'added' || change.status === 'deleted';
  const effectiveViewType: DiffViewType = isWholeFile ? 'unified' : viewType;

  // The line the user clicked the gutter on → an open comment draft anchored there.
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  // Reset any open draft when the selected file changes.
  useEffect(() => { setDraft(null); }, [change.filePath]);

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

  // Open a comment draft anchored to the clicked line. `change` is a react-diff-view
  // ChangeData; we derive a human line number + the line's text for quoting.
  const openDraftAt = useCallback((c: ChangeData) => {
    const lineNo = isDelete(c) ? computeOldLineNumber(c) : computeNewLineNumber(c);
    const loc = lineNo > 0 ? `${change.relPath}:L${lineNo}` : change.relPath;
    setDraft({
      filePath: change.filePath,
      relPath: change.relPath,
      anchorKey: getChangeKey(c),
      loc,
      code: c.content ?? '',
    });
  }, [change.filePath, change.relPath]);

  // Gutter click (the line-number column) → open a comment box on that line.
  const gutterEvents = useMemo<EventMap>(() => ({
    onClick: (args: ChangeEventArgs) => { if (args.change) openDraftAt(args.change); },
  }), [openDraftAt]);
  // Clicking the code cell also opens a draft (bigger hit target, GitHub-like).
  const codeEvents = useMemo<EventMap>(() => ({
    onClick: (args: ChangeEventArgs) => {
      if (!args.change) return;
      // Don't hijack text selection: only open if the user didn't select text.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      openDraftAt(args.change);
    },
  }), [openDraftAt]);

  // "Add comment" → record to the pending review batch (the default option).
  const addDraft = useCallback((commentText: string) => {
    if (!draft) return;
    onAddComment({ filePath: draft.filePath, anchorKey: draft.anchorKey, loc: draft.loc, code: draft.code, comment: commentText });
    setDraft(null);
  }, [draft, onAddComment]);

  // "Send now" → fire this one comment to the agent immediately (the 2nd option).
  const sendDraftNow = useCallback((commentText: string) => {
    if (!draft) return;
    onSendNow(buildCommentMessage(draft.loc, draft.code, commentText));
    setDraft(null);
  }, [draft, onSendNow]);

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
            <CommentBox loc={draft!.loc} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={() => setDraft(null)} />
          )}
        </>
      );
    }
    // Draft anchored on a line that has no recorded comments yet.
    if (draft && !byAnchor.has(draft.anchorKey)) {
      map[draft.anchorKey] = (
        <CommentBox loc={draft.loc} onAdd={addDraft} onSendNow={sendDraftNow} onCancel={() => setDraft(null)} />
      );
    }
    return Object.keys(map).length ? map : undefined;
  }, [pending, draft, addDraft, sendDraftNow, onCopyComment, onRemoveComment]);

  return (
    <div className="session-diff-filepane" data-file-path={change.filePath}>
      <div className="session-diff-filepane-head">
        <span className="session-diff-filepane-path" title={change.filePath}>{change.relPath}</span>
        <span className="session-diff-filepane-stat">
          {adds > 0 && <span className="session-diff-stat-add">+{adds}</span>}
          {dels > 0 && <span className="session-diff-stat-del">{'−'}{dels}</span>}
        </span>
        {!rendered && <span className="session-diff-filepane-hint">Click a line to comment</span>}
      </div>
      {rendered && renderedBlocks != null ? (
        <RenderedMarkdown blocks={renderedBlocks} />
      ) : file ? (
        <Diff
          viewType={effectiveViewType}
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
          widgets={widgets}
          gutterEvents={gutterEvents}
          codeEvents={codeEvents}
          className="session-diff-table session-diff-commentable"
        >
          {(hunks: HunkData[]) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ) : (
        <div className="session-diff-file-empty">No textual diff (binary, identical, or unreadable content).</div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function SessionDiffView({ sessionId, sessionCwd, sessionHost, onSelectCode, onComment }: SessionDiffViewProps) {
  const [data, setData] = useState<SessionChangesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewType, setViewType] = useState<DiffViewType>(() => {
    try { return (localStorage.getItem('open-walnut-diff-view') as DiffViewType) || 'split'; } catch { return 'split'; }
  });
  const [rendered, setRendered] = useState(false);
  const [base, setBase] = useState<SessionDiffBase>('session');
  // Default to the files THIS session changed; 'all' widens to every change in
  // the repos it touched (never untouched repos). See computeSessionGitDiff.
  const [scope, setScope] = useState<SessionDiffScope>('session');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resizable tree rail (left of the diff). Stored as % of viewport.
  const tree = useResizablePanel('open-walnut-diff-tree-w', 22, 'left');

  // Floating "Ask about this" affordance, positioned at the current text selection.
  const [selection, setSelection] = useState<{ x: number; y: number; text: string; filePath: string; line?: number } | null>(null);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    fetchSessionChanges(sessionId, { refresh, base, scope, signal: ctrl.signal })
      .then((res) => setData(res))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        log.warn('session-changes', 'fetch failed', { sessionId, base, scope, error: msg });
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [sessionId, base, scope]);

  useEffect(() => {
    const cancel = load(false);
    return cancel;
  }, [load]);

  useEffect(() => {
    try { localStorage.setItem('open-walnut-diff-view', viewType); } catch { /* ignore */ }
  }, [viewType]);

  const tree2 = useMemo<DiffTreeRepoNode[]>(() => buildDiffTree(data?.groups ?? []), [data]);
  const files = useMemo(() => flattenFiles(tree2), [tree2]);

  // On data change: expand all containers + select the first file.
  useEffect(() => {
    if (!tree2.length) { setSelectedId(null); return; }
    setExpanded(new Set(allContainerIds(tree2)));
    setSelectedId((prev) => (prev && files.some((f) => f.id === prev)) ? prev : (files[0]?.id ?? null));
  }, [tree2, files]);

  const selectedChange = useMemo(
    () => files.find((f) => f.id === selectedId)?.change ?? null,
    [files, selectedId],
  );

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

  const selectFile = useCallback((change: SessionFileChange) => {
    setSelectedId(change.filePath);
  }, []);

  // Keyboard: ↑/↓ to move between files in the flattened order.
  const stepFile = useCallback((dir: 1 | -1) => {
    if (!files.length) return;
    const idx = files.findIndex((f) => f.id === selectedId);
    const nextIdx = idx < 0 ? 0 : Math.min(files.length - 1, Math.max(0, idx + dir));
    setSelectedId(files[nextIdx]!.id);
  }, [files, selectedId]);

  // Detect a text selection inside the diff → show the floating "Ask" pill.
  const handleMouseUp = useCallback(() => {
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

    let line: number | undefined;
    let lineNode: Node | null = range.startContainer;
    while (lineNode && lineNode !== containerRef.current) {
      if (lineNode instanceof HTMLElement) {
        const ln = lineNode.getAttribute('data-line-number');
        if (ln) { const n = Number(ln); if (!Number.isNaN(n)) { line = n; break; } }
      }
      lineNode = lineNode.parentNode;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ x: rect.left + rect.width / 2, y: rect.top, text, filePath, line });
  }, [selectedChange]);

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
  const [pending, setPending] = useState<PendingComment[]>([]);
  const nextId = useRef(1);
  // Reset the batch when the session changes (a review belongs to one session).
  useEffect(() => { setPending([]); }, [sessionId]);

  // Send one composed message to the agent (shared by "Send now" + "Submit review").
  // Falls back to prefilling the chat input when the parent didn't wire onComment.
  const sendMessage = useCallback((message: string) => {
    if (onComment) { void onComment(message); return; }
    onSelectCode('', undefined, message);
  }, [onComment, onSelectCode]);

  const addComment = useCallback((c: { filePath: string; anchorKey: string; loc: string; code: string; comment: string }) => {
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

  if (loading && !data) {
    return <div className="session-diff-view session-diff-loading"><LoadingSpinner /></div>;
  }

  if (error) {
    return (
      <div className="session-diff-view session-diff-error">
        <div className="session-diff-error-box">
          {ICON_WARNING} <span>Couldn't load changes: {error}</span>
          <button className="btn btn-sm" onClick={() => load(true)}>Retry</button>
        </div>
      </div>
    );
  }

  const empty = !data || data.fileCount === 0;

  return (
    <div className="session-diff-view" ref={containerRef} onMouseUp={handleMouseUp}>
      <div className="session-diff-toolbar">
        <button
          className="session-diff-tree-toggle"
          onClick={() => setTreeCollapsed((c) => !c)}
          title={treeCollapsed ? 'Show file tree' : 'Hide file tree'}
        >
          {treeCollapsed ? '☰' : '⟨'}
        </button>
        <span className="session-diff-toolbar-title">
          {empty ? 'No file changes' : `${data!.fileCount} file${data!.fileCount === 1 ? '' : 's'} changed`}
        </span>
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
        {base !== 'session' && (
          <div className="session-diff-scope-toggle" role="group" aria-label="File scope" title="Only the files this session edited, or every change in the repos it touched">
            <button
              className={`session-diff-scope-btn${scope === 'session' ? ' is-active' : ''}`}
              onClick={() => setScope('session')}
            >This session</button>
            <button
              className={`session-diff-scope-btn${scope === 'all' ? ' is-active' : ''}`}
              onClick={() => setScope('all')}
            >All in repo</button>
          </div>
        )}
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
          <button className="session-diff-refresh" onClick={() => load(true)} title="Re-scan changes">
            {ICON_REFRESH}
          </button>
        </div>
      </div>

      {empty ? (
        <div className="session-diff-empty">
          {base === 'session' ? (
            <>
              <p>This session hasn't edited any files yet.</p>
              <p className="text-muted">Edits, writes, and subagent changes will appear here as a diff.</p>
            </>
          ) : scope === 'session' ? (
            <>
              <p>Nothing this session changed differs for this comparison.</p>
              <p className="text-muted">None of the files this session edited differ from "{BASE_OPTIONS.find((o) => o.value === base)?.label}". Switch to "All in repo" to see other changes in the same repo.</p>
            </>
          ) : (
            <>
              <p>No changes in this session's repos for this comparison.</p>
              <p className="text-muted">{BASE_OPTIONS.find((o) => o.value === base)?.hint}</p>
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
                  />
                ))}
              </div>
              <div
                className="session-diff-tree-resize"
                onMouseDown={tree.handleResizeStart}
                title="Drag to resize"
              />
            </>
          )}
          <div className="session-diff-main">
            {selectedChange ? (
              <FileDiffPane
                key={selectedChange.filePath}
                change={selectedChange}
                viewType={viewType}
                rendered={rendered}
                sessionCwd={sessionCwd}
                sessionHost={sessionHost}
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
        <button
          className="session-diff-ask-pill"
          style={{ left: selection.x, top: selection.y }}
          // preventDefault keeps the text selection; stopPropagation on mouseup is
          // CRITICAL — otherwise the mouseup bubbles to the container's handleMouseUp,
          // which recomputes the now-collapsing selection and unmounts THIS pill
          // before click fires (so commitSelection never runs).
          onMouseDown={(e) => { e.preventDefault(); }}
          onMouseUp={(e) => { e.stopPropagation(); }}
          onClick={commitSelection}
        >
          Ask about this
        </button>
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
