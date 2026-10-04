import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore, memo, type ReactNode } from 'react';
import { scrollDebugEnabled } from '@/utils/scroll-debug';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { useEvent } from '@/hooks/useWebSocket';
import { useLightbox } from '@/hooks/useLightbox';
import { BackgroundTasksChip, BackgroundTasksPanelHost, type KnownAgent } from './BackgroundTasksPanel';
import { setLiveLanes, setToolSource } from '@/stores/background-panel-store';
import { EMPTY_TOOL_SOURCE } from '@/stream/command-view';
import { SessionMessage, StableMarkdownBody, ToolRunShell, StreamRunMembers, streamRunSummary, isToolOnlyMessage, isThinkingOnlyMessage, isTextPlusMergeableTools, mergeThinkingOnly, trailingThinkingOnlyStart, MergedHistoryToolRun, SystemGroupRun, systemGroupMemberFromHistory, type SystemGroupMember, type StreamRunMember } from './SessionMessage';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { StreamingBlockView, WorkingIndicator, countStreamChars } from './StreamingBlockView';
import { StreamingLane, streamAgentSettled, knownAgentFromStream } from './LaneTimeline';
import { dedupeOptimisticMessages } from './optimistic-dedup';
import { typedUserText } from './injected-banner';
import { computeRenderWindow, type RenderWindowAnchor } from './render-window';
import { parseHistoryUnavailable, visibleHistoryUnavailable } from './history-unavailable';
import { shouldRefetchForTurnPrompt, turnPromptMissing, PROMPT_REFETCH_RETRY_DELAYS_MS } from './turn-prompt-refetch';
import { computeRenderFilter, allBlocksAbsorbed, buildHistoryEvidence } from '@/stream/render-filter';
import { getFinishedAgentIds, subscribeFinishedAgentIds } from '@/cache/finished-agents-store';
import { groupStreamingBlocks, collectLanes, isLaneChild, isRunMemberBlock, trailingThinkingStart, type GroupedStreamItem } from '@/stream/group-blocks';
import { TeamCard } from './TeamCard';
import { SessionPinnedToc, type TocEntry } from './SessionPinnedToc';
import { ThreadMap } from './ThreadMap';
import { placePins } from './outline-order';
import { QuotePinSelectionBar, type QuotePinTarget } from './QuotePinSelectionBar';
import { QuotePinPopover } from './QuotePinPopover';
import { useSessionPinsApi } from '@/contexts/SessionPinsContext';
import { EMPTY_DERIVED, useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import {
  ROOT_THREAD_KEY, buildThreadTree, fileOfParent, hueForAnchor, threadKeyOf,
  withPendingUserRows, type ThreadFilePlace, type ThreadRowInfo, type ThreadTreeMessage,
} from '@/utils/thread-tree';
import { createPortal } from 'react-dom';
import { ThreadStackFrame, ThreadMarkTipLayer } from './ThreadStackFrame';
import { ThreadQuoteHead } from './ThreadQuoteHead';
import { ThreadAskedFromList } from './ThreadAskedFromList';
import { ThreadStackHeader } from './ThreadStackHeader';
import { ThreadTurnLabel } from './ThreadTurnLabel';
import { ThreadCommentCard } from './ThreadCommentCard';
import { ThreadStackMenu } from './ThreadStackMenu';
import { useThreadCardPlace } from '@/hooks/useThreadCardPlace';
import { allPassageMarks, cardTurnsOf, questionBodyOf } from '@/utils/thread-card';
import { headsBySeq, keysBySeq, questionNumbers, tagKeyOfBlocks, withTagAnchors } from '@/utils/question-tag';
import { ThreadResolvedStrip } from './ThreadResolvedStrip';
import { useThreadToast } from './ThreadPanelToast';
import { useThreadLanding } from '@/hooks/useThreadLanding';
import { useThreadMarks } from '@/hooks/useThreadMarks';
import { useThreadMapLayout } from '@/hooks/useThreadMapLayout';
import { counts as threadCounts } from '@/utils/thread-meta-counts';
import type { TreeRow } from '@/utils/thread-tree-rows';
import { pageRowsBefore, pageWindowLimit } from '@/utils/thread-page-window';
import { deriveThreadLiveStates, displayTitleOf, metaOf, viewStatusOf } from '@/utils/thread-meta';
import {
  MAIN_TITLE, askedFromGroups, blockPageKey, composerDraftKey, deliveryEntries, readComposerDraft, deriveThreadStats, markSpecsFor, newTurnBook,
  recordTurnSegments, sliverBars, trackTurn, type AskedFromRow, type MarkSpec, type StreamTurnSegment, type TurnBook,
} from '@/utils/thread-stack-state';
import { pinKeyOf, pinLabelFor } from '@/hooks/useSessionPins';
import { useQuotePinPaint } from '@/hooks/useQuotePinPaint';
import { flashRange } from '@/utils/pin-highlights';
import { WorkflowProgress } from './WorkflowProgress';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Lightbox } from '../common/Lightbox';
import type {
  SessionEngine, SessionHistoryMessage, SessionPinnedQuote, SessionThreadAnchor,
} from '@/types/session';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineCaps } from '@/utils/engine-capabilities';
import type { ImageAttachment } from '@/api/chat';
import { useSelectionScrollGuard, useSelectionFrozenWith, useSelectionAnchoredScroll } from '@/utils/selection-guard';
import { runWhenVisible } from '@/utils/page-visibility';
import { log } from '@/utils/log';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SESSION CHAT — SINGLE TIMELINE (non-destructive absorption)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ## Two data sources displayed together
 *
 * 1. **Persisted history** (`messages`): Fetched from `/api/sessions/:id/history`.
 *    Server reads the Claude Code JSONL output file and parses it into messages.
 *    This is the source of truth after a turn completes.
 *
 * 2. **Streaming blocks** (`blocks` from useSessionStream): what the user watched
 *    generate live. APPEND-ONLY — turn boundaries never delete blocks.
 *
 * 3. **Optimistic messages** (`optimisticMessages`): Client-side state managed by
 *    `useSessionSend`. Shown immediately when the user sends a message, before
 *    the JSONL contains it.
 *
 * ## The absorption model (replaces destructive reconciliation)
 *
 * A streaming block renders only while the persisted history has NOT absorbed it.
 * Every render, `computeRenderFilter` (stream/render-filter.ts) proves which
 * blocks already have a persisted twin (msgId/toolUseId id-first; content
 * multiset within the turn watermark window; finished-background-lane proof)
 * and those are hidden. History arriving late means a block briefly renders
 * TWICE (next to its twin) and collapses when evidence lands — it can never
 * vanish. This is idempotent and order-insensitive, which kills the old
 * machinery this file used to need: awaitingRefresh, pendingBatchTotal/Ids,
 * the 5s fallback timer, clearCompletedAndShift, prevMsgLen freezing,
 * blockIndexMap anchor shifting. (consumedQueueIds survives — it is the
 * optimistic-BUBBLE sticky-consumption set, a different mechanism.)
 *
 * Once ALL blocks are hidden and no turn is live, `resetIfAbsorbed` physically
 * drops the array (pure memory reclamation — zero visual difference).
 *
 * ## Turn watermark
 *
 * Content matching (for id-less blocks and optimistic-bubble text fallback)
 * only trusts messages[watermark..] — the history length when the current turn
 * started streaming (isStreaming false→true). Identical short texts recur
 * across turns; the watermark prevents claiming an old twin for a new block.
 * On shrink (/compact rewrote history) the slice clamps to empty and content
 * matching pauses; id matching is scope-safe and unaffected.
 *
 * ## Optimistic message status lifecycle
 *
 *   pending → received → delivered → (absorbed: hidden by dedup filter, then
 *   removed by handleBatchCompleted / onBatchCompleted GC)
 *
 * User messages appear in JSONL via Pattern A (FIFO enqueue→dequeue + user
 * line), Pattern B (enqueue only, synthesized), or Pattern C (--resume spawn) —
 * see src/core/session-history.ts. The echo-claim binding (walnutMessageId)
 * gives id-exact dedup; text-window matching is the fallback
 * (optimistic-dedup.ts, scanning messages[watermark..]).
 *
 * ## Unified timeline (buildTimeline)
 *
 * Optimistic messages interleave with streaming blocks via blockIndexMap — a
 * Map<queueId, blocks.length at send>. Blocks being append-only makes these
 * anchors STABLE (no shifting on partial deletion, which no longer exists).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export interface OptimisticMessage extends SessionHistoryMessage {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  images?: ImageAttachment[];
  /** The uuid the CLI was told to persist this user line under (the stream-json
   *  `uuid` contract), stamped at send time. It is the id the thread anchor was
   *  recorded against, so the bubble belongs to its thread before any history
   *  fetch — see thread-tree's `rowIdOf`. Dedup does not read it. */
  userUuid?: string;
  /** Error message when status is 'failed' */
  failedError?: string;
  /** Server PARKED this row (dead-letter): the failure is permanent, so nothing
   *  will retry it automatically again. Rendered as a 'failed' bubble with its
   *  own label + a Discard that actually deletes the durable row. */
  parked?: boolean;
  /** Server-side text ACTUALLY enqueued to the CLI, when it differs from `text`.
   *  `text` is what the user typed (and what we render); with attachments the
   *  server prepends image refs before enqueueing, so the persisted echo carries
   *  the augmented form. Dedup must compare against THIS, not `text`, or an
   *  image message's bubble never matches its persisted twin and stays pinned at
   *  the bottom forever (inc-1785091339102). Set from the send RPC response. */
  dedupText?: string;
  /** The session's launch prompt (the server's, or this tab's own seed). It heads
   *  the conversation, above every persisted row, until the first typed user row
   *  history shows absorbs it (optimistic-dedup.ts). */
  launch?: boolean;
}

/** Renders base64 image thumbnails for optimistic messages */
function OptimisticImagePreviews({ images }: { images?: ImageAttachment[] }) {
  if (!images || images.length === 0) return null;
  // Right-aligned: these thumbnails belong to the user's own (right-bubble) message.
  return (
    <div className="chat-image-previews" style={{ padding: '0 0 8px', justifyContent: 'flex-end' }}>
      {images.map((img, i) => {
        const src = `data:${img.mediaType};base64,${img.data}`;
        return (
          <div key={i} className="chat-image-preview">
            <img src={src} alt={img.name || 'attached image'} data-lightbox-src={src} />
          </div>
        );
      })}
    </div>
  );
}

interface SessionChatHistoryProps {
  sessionId: string;
  /** Coding agent backing this session. Legacy records without one are Claude Code. */
  engine?: SessionEngine;
  phase?: string;
  /** Initial prompt text to display at the top of the timeline (first user message). */
  initialPrompt?: string;
  /** Session working directory — used to resolve relative image paths in tool results */
  sessionCwd?: string;
  /** SSH host alias — used for remote file access */
  sessionHost?: string;
  optimisticMessages?: OptimisticMessage[];
  onMessagesDelivered?: (count: number, messageIds?: string[]) => void;
  onBatchCompleted?: (count: number, messageIds?: string[]) => void;
  onBatchFailed?: (messageIds: string[], error: string) => void;
  onEditQueued?: (queueId: string, newText: string) => void;
  onDeleteQueued?: (queueId: string) => void;
  onAgentQueued?: (msg: { queueId: string; text: string; enqueuedAt?: string }) => void;
  onRetryFailed?: (queueId: string) => void;
  onDismissFailed?: (queueId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
  /** Bubbles the hook's isStreaming up so parents don't need to mount their
   *  own useSessionStream (which would double RPCs + defensive-clear paths). */
  onStreamingChange?: (isStreaming: boolean) => void;
  /**
   * Bump to jump the timeline to the bottom, exactly like clicking the ↓ arrow.
   * Unconditional by design — the caller is acting ON the user's behalf (they
   * clicked "Ask about this", so the composer is where they now are), which is
   * why this ignores isAtBottom and the selection guard that the automatic
   * follow-bottom paths respect. 0/undefined = no-op (initial mount).
   */
  scrollToBottomNonce?: number;
  /**
   * The user asked about something (a passage, or a thread picked in the outline):
   * reveal the composer and focus it. The panel owns both, so the timeline only
   * says WHEN — same shape as the "Ask about this" prefill path, minus the text
   * (the quote rides the composer chip and is composed at send time).
   *
   * `keepTimelinePosition` — this focus came WITH a jump somewhere in the
   * transcript (an outline row), so the panel must not also pull the timeline down
   * to the composer. Omitted = do pull it down, which is right for the selection
   * pill: the passage is already on screen and the user is about to type.
   */
  onRequestComposerFocus?: (opts?: { keepTimelinePosition?: boolean }) => void;
}

// Grouping semantics (task groups / consumed subagent lanes / hidden-parent
// asymmetry) live in the pure module so the chat lab can replay production
// traces through the exact projection the timeline renders.

/** True when a streaming block merges into a muted "Ran N commands ›" run:
 *  a COMPLETED generic tool_call, or the main-lane thinking between two of them
 *  (isRunMemberBlock). A still-calling tool stays a full card so the user
 *  watches it live; it collapses into the run when done. Special blocks
 *  (Task/Agent anchors, plan cards, plan writes, ghosts) never merge. */
function isMergeableStreamItem(
  item: TimelineItem,
  consumed: Set<number>,
  groupedByIndex: Map<number, GroupedStreamItem>,
): item is TimelineItem & { kind: 'block'; block: StreamRunMember } {
  if (item.kind !== 'block') return false;
  if (groupedByIndex.has(item.index) || consumed.has(item.index)) return false;
  return isRunMemberBlock(item.block);
}

/** Inline edit component for queued messages */
function EditableQueuedMessage({ message, onSave, onCancel }: {
  message: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(message);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  return (
    <div className="session-msg-edit">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(value.trim() || message); }
          if (e.key === 'Escape') onCancel();
        }}
        className="session-msg-edit-textarea"
        rows={2}
        {...NO_AUTOFILL_PROPS}
      />
      <div className="session-msg-edit-actions">
        <button onClick={() => onSave(value.trim() || message)} className="btn btn-sm btn-primary">Save</button>
        <button onClick={onCancel} className="btn btn-sm">Cancel</button>
      </div>
    </div>
  );
}

// ── Timeline types ──

type TimelineItem =
  | { kind: 'block'; block: StreamingBlock; index: number }
  | { kind: 'user'; msg: OptimisticMessage }
  | { kind: 'indicator'; type: 'resuming' | 'working' };

type HistoryPart = { kind: 'msg'; m: SessionHistoryMessage; globalIndex: number; suppressTools?: boolean }
  | { kind: 'run'; members: { m: SessionHistoryMessage; globalIndex: number }[];
      /** Pre-mapped member messages — a STABLE array ref so the memoized
       *  MergedHistoryToolRun can skip re-render on streaming frames (mapping
       *  in JSX would mint a fresh array every 150ms flush). */
      memberMsgs: SessionHistoryMessage[];
      /** First member is a tools-only clone of the preceding msg part (same
       *  globalIndex) — skip the fork-divider check for it. */
      seeded?: boolean }
  | { kind: 'system-run'; members: { m: SessionHistoryMessage; globalIndex: number }[];
      /** Pre-mapped stable array for the memoized SystemGroupRun (same reason). */
      systemMembers: SystemGroupMember[] };

function isTransparentStreamItem(item: TimelineItem): boolean {
  if (item.kind !== 'block') return false;
  const block = item.block;
  if (isLaneChild(block)) return true;
  if ((block.type === 'text' || block.type === 'thinking') && !block.content.trim()) {
    return true;
  }
  // StreamingBlockView suppresses exactly this stale placeholder shape. Keep it
  // transparent here too so a DOM-null block cannot split adjacent tool runs.
  return block.type === 'tool_call'
    && block.status === 'calling'
    && (!block.input || Object.keys(block.input).length === 0)
    && !block.result;
}

/**
 * Interleave streaming blocks and active optimistic messages by blockIndex.
 * Each user message was sent at a specific blocks.length — it renders at that
 * position. `hidden` = blocks absorbed by persisted history (render filter):
 * they keep their INDEX (anchors stay stable) but emit no timeline item.
 */
function buildTimeline(
  blocks: StreamingBlock[],
  activeOptimistic: OptimisticMessage[],
  blockIndexMap: Map<string, number>,
  isStreaming: boolean,
  isResuming: boolean,
  hidden?: Set<number>,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let visibleCount = 0;

  // Group user messages by their blockIndex
  const usersByIndex = new Map<number, OptimisticMessage[]>();
  for (const msg of activeOptimistic) {
    const idx = blockIndexMap.get(msg.queueId) ?? blocks.length;
    const arr = usersByIndex.get(idx);
    if (arr) arr.push(msg);
    else usersByIndex.set(idx, [msg]);
  }

  // Interleave: for each block position, insert user messages at that position, then the block
  for (let i = 0; i < blocks.length; i++) {
    const usersHere = usersByIndex.get(i);
    if (usersHere) {
      for (const msg of usersHere) {
        items.push({ kind: 'user', msg });
      }
    }
    if (hidden?.has(i)) continue; // absorbed by history — its twin renders above
    visibleCount++;
    items.push({ kind: 'block', block: blocks[i], index: i });
  }

  // Trailing user messages (blockIndex >= blocks.length — sent after all current blocks)
  const trailingIndices = [...usersByIndex.keys()].filter(k => k >= blocks.length).sort((a, b) => a - b);
  for (const idx of trailingIndices) {
    for (const msg of usersByIndex.get(idx)!) {
      items.push({ kind: 'user', msg });
    }
  }

  // Working indicator: pinned at the TAIL of the live region for the whole
  // turn (Claude-app style) — it replaced the old "Streaming" badge as the
  // turn-is-live signal. Resuming keeps the old empty-only behavior (a
  // resumed session with visible blocks isn't producing anything yet).
  if (isStreaming) {
    items.push({ kind: 'indicator', type: 'working' });
  } else if (isResuming && visibleCount === 0) {
    items.push({ kind: 'indicator', type: 'resuming' });
  }

  return items;
}

// ── Auto-scroll constant ──
const NEAR_BOTTOM_PX = 80;  // px from bottom to consider "at bottom"
/** How long after real input inside the transcript its growth still counts as the
 *  reader's own doing (see the follower below). A click's layout lands within a
 *  frame or two, so this only has to cover a gesture, not a thought. */
const FOLLOW_INPUT_QUIET_MS = 700;

/** Serial for quote-pin highlight slices. Two timelines can show the SAME session
 *  (a column plus the fullscreen overlay), so the session id alone is not a
 *  unique key into the shared highlight registry. */
let nextQuotePanelSeq = 0;

// Divergence-tripwire settle window: the unmatched set must survive this long
// unchanged (no new turn, no history fetch in flight) before evidence ships.
// Sized above the observed post-turn delta round-trip (~1.2s on SSH sessions,
// inc-1786496042099) so a normal turn-end never reports; a real divergence is
// persistent and merely reports a few seconds later. Tests can shrink it via
// window.__tripwireSettleMs.
const TRIPWIRE_SETTLE_MS = (typeof window !== 'undefined'
  && (window as unknown as { __tripwireSettleMs?: number }).__tripwireSettleMs) || 8_000;

/** Width of a threaded row's clickable gutter strip: the 3px bar plus the 8px
 *  padding beside it (`.session-msg--threaded` in globals.css, whose `::before`
 *  paints the pointer cursor over exactly this run). */
const THREAD_BAR_HIT_PX = 11;

/** Stable empty mark list for a page (or view) without question marks. */
const NO_MARKS: MarkSpec[] = [];

export const SessionChatHistory = memo(function SessionChatHistory({ sessionId, engine, phase, initialPrompt, sessionCwd, sessionHost, optimisticMessages, onMessagesDelivered, onBatchCompleted, onBatchFailed, onEditQueued, onDeleteQueued, onAgentQueued, onRetryFailed, onDismissFailed, onTaskClick, onSessionClick, onFileOpen, onStreamingChange, scrollToBottomNonce, onRequestComposerFocus }: SessionChatHistoryProps) {
  // Dev-only render counter per session: lets a browser test prove a hot
  // interaction (the pointer over a question mark) never re-renders this tree.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const w = window as unknown as { __walnutHistoryRenders?: Record<string, number> };
    const counts = (w.__walnutHistoryRenders ??= {});
    counts[sessionId] = (counts[sessionId] ?? 0) + 1;
  }
  // Slow-commit detector: renderT0 is per-render-pass (closure), the layout
  // effect runs after THAT pass commits — the delta is the synchronous
  // render+commit cost of this whole conversation subtree. This is the
  // heaviest tree in the app (markdown, syntax highlight, tool cards), so
  // when a page-load main-thread block happens, this line says whether the
  // conversation render was the culprit and how big the input was.
  const renderT0 = performance.now();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const commitMs = Math.round(performance.now() - renderT0);
    if (commitMs > 300) {
      console.warn('[perf] SessionChatHistory slow commit', {
        sessionId, commitMs,
        url: window.location.pathname,
      });
    }
  });
  const [historyVersion, setHistoryVersion] = useState(0);
  // Who the assistant bubbles are attributed to — the engine's own label from
  // the catalog, so a newly registered engine names itself in the transcript.
  const engineCatalog = useEngineCatalog();
  const assistantLabel = engineCaps(engine, engineCatalog).displayName;
  // Turn watermark: history length when the CURRENT turn started streaming.
  // Content matching (id-less blocks + bubble text fallback) only trusts
  // messages[watermark..] — identical short texts recur across turns, and the
  // watermark stops a new block from claiming an old twin. Advances ONLY at
  // turn start (isStreaming false→true) — never on message growth, so a
  // finished turn's delta stays inside the window until the next turn begins.
  const turnWatermark = useRef(0);
  const watermarkInitialized = useRef(false);
  // queueIds already matched to a persisted twin — never re-render their bubble
  // (see "Sticky consumption" at the dedup call site). Reset on session switch.
  const consumedQueueIds = useRef<Set<string>>(new Set());
  // Consumed queueIds already reported to the owner (useSessionSend GC).
  const notifiedConsumedIds = useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  // The pinned Initial Prompt renders through the same markdown path as every
  // other user bubble, so its task pills and file links need the same delegate.
  const handleInitialPromptClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost, sessionId);

  // ── Message truncation — render only the tail to keep DOM count low ──
  const INITIAL_RENDER_LIMIT = 30;
  const LOAD_MORE_BATCH = 500;
  const [truncationOffset, setTruncationOffset] = useState(0);
  // "Show earlier" scroll anchor: distance-to-bottom captured at click time,
  // restored after the expanded batch renders. The container has
  // overflow-anchor:none, so without this the browser keeps scrollTop
  // numerically fixed and the newly inserted messages shove the user's
  // reading position out of view. Bottom distance is invariant to any
  // content inserted above the viewport.
  const pendingBottomDistance = useRef<number | null>(null);
  // Monotonic render-window start: once computed, only ratchets DOWN (older)
  // so already-rendered rows never unmount from the top (see visibleStart).
  // null = fresh session view. Index into messages[], re-derived from its
  // CONTENT anchor on every pass — see render-window.ts for why an index alone
  // cannot survive this array.
  const renderWindowStart = useRef<number | null>(null);
  const renderWindowAnchor = useRef<RenderWindowAnchor | null>(null);
  const { lightboxSrc, openLightbox, closeLightbox } = useLightbox();

  // ── Outline (pinned messages) ──
  // Pins live on the session record; the panel provides them through context so
  // the memoized message rows can host the pin button without prop drilling.
  const pinsApi = useSessionPinsApi();
  // ── Conversation threads ──
  // The anchors live on the session record (the panel owns them); the ROWS they
  // point at live in this component's history hook. So the tree is derived here
  // and published back up, and everything else (rail, gutter, chip, composer)
  // reads that one structure.
  const threadsApi = useSessionThreadsApi();
  // This mounted timeline's slice of the document-global highlight registry — the
  // home page shows up to three sessions side by side, and they must be able to
  // paint their own pins without deleting each other's (see pin-highlights.ts).
  const quotePanelKey = useMemo(() => `${sessionId}:${nextQuotePanelSeq++}`, [sessionId]);
  /** scrollTop the last outline jump left from — armed for one "Back". */
  const jumpReturnTop = useRef<number | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  /** A jump whose target row is outside the loaded tail: parked here while the
   *  full history loads, finished by the effect next to jumpToPlace. */
  const pendingJump = useRef<{ msgId: string; quote?: SessionPinnedQuote; via: string; armBack?: boolean } | null>(null);

  // ── blockIndexMap: assigns each optimistic message a fixed position in the streaming timeline ──
  // Key: queueId, Value: blocks.length at creation time. Set once, never updated.
  const blockIndexMap = useRef(new Map<string, number>());

  // Event delegation: open lightbox when clicking images with data-lightbox-src
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const lightboxImg = target.closest('img[data-lightbox-src]') as HTMLImageElement | null;
    if (lightboxImg) {
      const src = lightboxImg.getAttribute('data-lightbox-src');
      if (src) {
        e.preventDefault();
        openLightbox(src);
      }
    }
  }, [openLightbox]);

  const { messages, loading, phase2Pending, error, stale, forkBoundaryIndex, olderHidden, olderWindowed, loadFullHistory } = useSessionHistory(sessionId, historyVersion);
  const historyUnavailableRaw = parseHistoryUnavailable(error);
  const { blocks, isStreaming, completedLen, resetIfAbsorbed } = useSessionStream(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ── Turn watermark maintenance ──
  // First history load seeds the watermark at the full length (content
  // matching starts trusting only what arrives AFTER this point — safe
  // direction: an unmatched stale block lingers as a brief duplicate rather
  // than a new block being claimed by an old twin). Each turn start
  // (isStreaming false→true) advances it to the current length.
  useLayoutEffect(() => {
    if (!watermarkInitialized.current && messages.length > 0) {
      watermarkInitialized.current = true;
      turnWatermark.current = messages.length;
    }
  }, [messages]);
  // Front-insertion guard (lazy "Load N earlier" backfill): when older rows are
  // inserted BEFORE the current head, every index shifts by the growth — shift
  // the watermark too. Without this the content window suddenly spans thousands
  // of OLD rows and a pending bubble can be falsely absorbed by an ancient twin
  // (the disappearing-message class the watermark exists to prevent). A rewrite
  // where the old head simply vanished (/compact, whale window slide) finds no
  // match and shifts nothing — too-big watermarks already degrade safely.
  const prevFirstMsgId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const first = messages[0]?.msgId;
    const prev = prevFirstMsgId.current;
    if (prev && first !== prev) {
      const k = messages.findIndex((m) => m.msgId === prev);
      if (k > 0) {
        turnWatermark.current = Math.min(messages.length, turnWatermark.current + k);
      }
      // The render window is an index too, but it is NOT shifted here: an
      // effect runs after the frame it should have corrected is already on
      // screen (that one stale frame is the whole first-open flicker), and it
      // only knows about insertions — not head drops or window swaps. It
      // re-derives from its content anchor during render instead
      // (computeRenderWindow), which covers all four cases.
    }
    prevFirstMsgId.current = first;
  }, [messages]);
  // Turn-start prompt refetch state (see the effect below the isStreaming edge).
  const promptRefetchFired = useRef(false);
  const promptRefetchTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const optimisticCountRef = useRef(optimisticMessages?.length ?? 0);
  optimisticCountRef.current = optimisticMessages?.length ?? 0;
  const isStreamingRefForPrompt = useRef(isStreaming);
  isStreamingRefForPrompt.current = isStreaming;
  const clearPromptRefetchRetries = useCallback(() => {
    for (const t of promptRefetchTimers.current) clearTimeout(t);
    promptRefetchTimers.current = [];
  }, []);
  const prevIsStreaming = useRef(false);
  useLayoutEffect(() => {
    if (isStreaming && !prevIsStreaming.current) {
      turnWatermark.current = messagesRef.current.length;
      watermarkInitialized.current = true;
    }
    // Streaming ENDED — refetch history unconditionally.
    //
    // Absorption is evidence-based: a bubble is only hidden once persisted history
    // proves it landed. That makes the ARRIVAL of history the one thing absorption
    // cannot do without — and until now the only trigger was
    // `session:batch-completed` (plus session:error / _ws:reconnected). That event
    // is not reliable: the 60s activeProcessing safety timeout force-clears the
    // in-flight entry and emits NOTHING at all, and results withheld behind
    // background work or suppressed as replays emit nothing either. On those paths
    // no refetch ever fired, so the bubble stayed pinned no matter how good the
    // matching is — and turns over 60s are exactly the reported pattern (measured:
    // 66.2% of turns exceed the window; orphan rate 24% under 30s → 84% at ≥900s).
    // isStreaming true→false is derived from the stream itself, so it survives
    // every one of those server-signal losses.
    // Cheap and idempotent: the fetch is a `?since=` delta (usually a few rows),
    // it coalesces with the batch-completed bump via the same historyVersion state,
    // and a redundant refetch can only ADD evidence — it can never remove a bubble.
    if (!isStreaming && prevIsStreaming.current) {
      setHistoryVersion((v) => v + 1);
      // Turn over: re-arm the turn-start prompt refetch for the next turn and
      // drop its pending retries (the refetch above already covers them).
      promptRefetchFired.current = false;
      clearPromptRefetchRetries();
    }
    prevIsStreaming.current = isStreaming;
  }, [isStreaming]);

  // ── Turn-START refetch: a running turn whose prompt is not on screen ──
  // The launch prompt reaches the CLI transcript ~3 s after spawn, AFTER the
  // panel's opening fetches, and no refetch fires until the turn ends — so a
  // fresh session's first message was invisible for the whole first turn. The
  // CLI appends the user line before calling the model, so the turn's first
  // model-output block proves the line is on disk; refetch on that edge when
  // nothing (persisted row or optimistic bubble) stands for the prompt yet.
  // System blocks don't count — they stream before the line lands. Details and
  // the predicate: turn-prompt-refetch.ts.
  useEffect(() => {
    if (!shouldRefetchForTurnPrompt({
      blocks, completedLen, messages,
      watermark: turnWatermark.current,
      optimisticCount: optimisticMessages?.length ?? 0,
      alreadyFiredThisTurn: promptRefetchFired.current,
    })) return;
    promptRefetchFired.current = true;
    log.info('session-history', 'turn prompt missing at first model output — refetching history', {
      sessionId, messages: messages.length, blocks: blocks.length, completedLen,
    });
    setHistoryVersion((v) => v + 1);
    // Bounded safety net: if the refetch still shows no prompt (remote stat
    // lag), try again; a finished turn hands over to the turn-end refetch.
    clearPromptRefetchRetries();
    for (const delay of PROMPT_REFETCH_RETRY_DELAYS_MS) {
      promptRefetchTimers.current.push(setTimeout(() => {
        if (!isStreamingRefForPrompt.current) return;
        if (!turnPromptMissing(messagesRef.current, turnWatermark.current, optimisticCountRef.current)) return;
        log.info('session-history', `turn prompt still missing after ${delay}ms — refetching again`, { sessionId });
        setHistoryVersion((v) => v + 1);
      }, delay));
    }
  }, [blocks, completedLen, messages, optimisticMessages, sessionId, clearPromptRefetchRetries]);
  useEffect(() => () => clearPromptRefetchRetries(), [clearPromptRefetchRetries]);

  // ── Non-destructive absorption (the single-timeline core) ──
  // Which streaming blocks has persisted history already absorbed? Those are
  // HIDDEN at render time — never deleted at event time. Late history = brief
  // double-render that collapses when evidence lands; never a vanish.
  // Evidence walks the FULL history — memoized by messages ref so whale
  // sessions (5000+ msgs) don't re-walk on every streaming frame.
  const historyEvidence = useMemo(() => buildHistoryEvidence(messages), [messages]);
  // Server-transported orphan finished-agent ids (nested agents whose tool_use
  // row never reaches the canonical JSONL — inc-1786496042099). Store-backed:
  // the proving notification lines are hidden from chat, so a delta can grow
  // this set with an EMPTY message slice — only the store subscription
  // re-renders us then. Stable ref until it grows, so the filter memo is safe.
  const finishedAgentIds = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeFinishedAgentIds(sessionId, cb), [sessionId]),
    () => getFinishedAgentIds(sessionId),
  );
  // NOTE: turnWatermark.current is a ref read — invisible to the deps array,
  // so a watermark write alone never recomputes this memo. That is sound only
  // because every watermark write is triggered by a dep edge (messages /
  // isStreaming, via useLayoutEffect): the write lands after that render, and
  // the very next dep change (first delta appends a block within a frame)
  // re-runs the memo with the fresh value — worst case one frame of the old
  // watermark, which only widens the content window (duplicate-safe, never
  // vanish). If you ever write the watermark on an independent trigger, this
  // memo will keep serving a stale filter until some dep happens to change.
  const { hidden: liveHiddenBlocks, unmatched: unmatchedBlocks } = useMemo(
    () => computeRenderFilter({ blocks, messages, watermark: turnWatermark.current, isStreaming, completedLen, historyEvidence, finishedAgentIds }),
    [blocks, messages, isStreaming, completedLen, historyEvidence, finishedAgentIds],
  );
  // Freeze the hidden set while a selection lives in the container: absorption
  // hides a streaming block and mounts its persisted twin — brand-new DOM — so
  // applying it mid-selection destroys the nodes the selection is anchored to
  // (the "select while generating, copy after it finishes" flow). Deferring
  // the swap until the selection clears is safe by design: the failure mode of
  // a stale filter is a brief DOUBLE-render next to the twin, never a vanish.
  const hiddenBlocks = useSelectionFrozenWith(containerRef, liveHiddenBlocks);

  // Divergence tripwire: a FINISHED block with no history twin is kept visible
  // (safe), but persistent misses mean archive & stream disagree — surface it.
  // Deduped per count so a stable divergence logs once, not every render.
  //
  // QUIESCENCE GATE (inc-1786496042099 false positive): the tripwire used to
  // fire the instant isStreaming flipped false — 41ms after session:result and
  // 1.2s BEFORE the post-turn delta returned, so the entire final turn read as
  // "no history twin" and shipped a 460-block bogus evidence payload that then
  // drove a mis-diagnosis. Real quiescence = no turn streaming AND no history
  // fetch in flight (loading/phase2Pending) AND the unmatched set survives a
  // settle delay unchanged — the delay covers the gap before the version-bump
  // fetch even starts and any revise round between fetches. A genuine
  // divergence is persistent by definition, so delaying the report loses nothing.
  const lastUnmatchedLogged = useRef(0);
  useEffect(() => {
    if (isStreaming || loading || phase2Pending) return;
    if (unmatchedBlocks.length === 0) { lastUnmatchedLogged.current = 0; return; }
    if (unmatchedBlocks.length === lastUnmatchedLogged.current) return;
    const timer = setTimeout(() => {
      lastUnmatchedLogged.current = unmatchedBlocks.length;
      log.warn('stream', `render-filter: ${unmatchedBlocks.length} completed block(s) had no delta twin — kept, not deleted`, {
        sessionId, unmatched: unmatchedBlocks.slice(0, 5),
      });
      // Ship the UNTRUNCATED evidence to POST /api/client-evidence — the
      // console-log forwarder caps args at 1000 chars, which reduced a
      // 200-entry flight trace to ~12 entries and 78 unmatched blocks to 5
      // (inc-1786165723472's forensics gap). The endpoint persists the payload
      // verbatim AND opens a deduped incident, so divergences become queryable
      // data points instead of grep targets. Fire-and-forget; the log.warn
      // above stays as the greppable breadcrumb.
      void import('@/stream/flight-recorder').then(({ flightTrace }) => {
        const trace = flightTrace(sessionId);
        void fetch('/api/client-evidence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            kind: 'render-filter-no-twin',
            summary: `${unmatchedBlocks.length} completed block(s) had no history twin at quiescence`,
            flightTrace: trace,
            unmatched: unmatchedBlocks,
            blocksSummary: blocks.map((b, i) => ({
              i,
              type: b.type,
              name: b.type === 'tool_call' ? b.name : undefined,
              msgId: (b as { msgId?: string }).msgId,
              toolUseId: b.type === 'tool_call' ? b.toolUseId : undefined,
              parent: (b as { parentToolUseId?: string }).parentToolUseId,
              len: b.type === 'text' || b.type === 'thinking' ? b.content.length : undefined,
              hidden: hiddenBlocks.has(i),
            })),
            messagesSummary: messages.slice(-40).map(m => ({
              role: m.role,
              msgId: m.msgId,
              textLen: m.text?.length,
              tools: m.tools?.map(t => ({ id: t.toolUseId, name: t.name, bg: t.bgTaskFinished })),
            })),
          }),
        }).catch(() => {});
      }).catch(() => {});
    }, TRIPWIRE_SETTLE_MS);
    // Any dep change within the window (delta landed → unmatched recomputed,
    // new turn started, fetch began) cancels the pending report — evidence is
    // only shipped for a divergence that outlived the settle window.
    return () => clearTimeout(timer);
  }, [unmatchedBlocks, isStreaming, loading, phase2Pending, sessionId]);

  // Memory reclamation: once EVERY block is absorbed and no turn is live,
  // physically drop the array (zero visual difference — all were hidden).
  // Bubble anchors clamp to 0 so pre-reset sends stay ABOVE the next turn's
  // blocks (they were sent before that content existed).
  useEffect(() => {
    if (allBlocksAbsorbed(blocks, hiddenBlocks, isStreaming)) {
      if (resetIfAbsorbed(hiddenBlocks.size)) {
        for (const k of blockIndexMap.current.keys()) blockIndexMap.current.set(k, 0);
      }
    }
  }, [blocks, hiddenBlocks, isStreaming, resetIfAbsorbed]);

  // Propagate the single useSessionStream instance's isStreaming to parents
  // (e.g. SessionPanel) so they can drive the ChatInput's send/interrupt state
  // without mounting their own hook — the dual-mount pattern doubled RPCs and
  // produced races between two defensive-clear paths.
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // ── Team detection from history messages ──
  // Scan messages for TeamCreate + Agent tools to detect ALL teams in this session.
  // IMPORTANT: The Agent tool's teamName is the source of truth — TeamCreate's input.team_name
  // may differ because Claude Code can internally rename/regenerate the team name.
  const teams = useMemo(() => {
    const teamsByName = new Map<string, { teamName: string; agentStatuses: Map<string, 'calling' | 'done' | 'error'> }>();
    for (const m of messages) {
      if (!m.tools) continue;
      for (const tool of m.tools) {
        if (tool.name === 'Agent' && tool.teamName) {
          const realTeamName = tool.teamName;
          if (!teamsByName.has(realTeamName)) {
            teamsByName.set(realTeamName, { teamName: realTeamName, agentStatuses: new Map() });
          }
          const team = teamsByName.get(realTeamName)!;
          const agentName = tool.teamAgentName || (typeof tool.input?.name === 'string' ? tool.input.name : '');
          if (agentName) {
            team.agentStatuses.set(agentName, tool.result ? 'done' : 'calling');
          }
        }
      }
    }
    return [...teamsByName.values()];
  }, [messages]);

  // Active team tab: null = "Main" (lead conversation), string = team name
  const [activeTeamTab, setActiveTeamTab] = useState<string | null>(null);

  // When switching from a team tab back to Lead, the main conversation container
  // transitions from display:none → visible. ResizeObserver does NOT fire for this
  // transition (per spec), so scroll position is stale. Force a scroll to bottom.
  const prevTeamTab = useRef<string | null>(null);
  useEffect(() => {
    if (prevTeamTab.current !== null && activeTeamTab === null && isAtBottom.current) {
      // Switched from team → lead: container just became visible, scrollTop may be 0
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (el && isAtBottom.current) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
    prevTeamTab.current = activeTeamTab;
  }, [activeTeamTab]);

// ── Message delivery lifecycle ──
  // 1. User sends → optimistic msg added (status: 'pending', grey)
  // 2. Server delivers to CLI (FIFO/resume) → 'session:messages-delivered' → status: 'delivered' (normal)
  // 3. Turn completes → 'session:batch-completed' → removed (id-first), refresh history

  // Messages delivered to CLI: transition from grey (pending) to normal (delivered).
  useEvent('session:messages-delivered', (data) => {
    const d = data as { sessionId?: string; count?: number; messageIds?: string[] };
    if (d.sessionId === sessionId) {
      onMessagesDelivered?.(d.count ?? 1, d.messageIds);
    }
  });

  // Turn completed: refresh history. Bubble removal is NOT triggered here —
  // removing at event time would blank the user's message for the seconds the
  // refetch takes (the vanish direction). Instead the render-time dedup hides
  // a bubble in the SAME render that shows its persisted twin (zero flash),
  // and the GC effect below then notifies useSessionSend to drop it by id.
  // No ordering machinery: block absorption is a render-time filter too, so
  // nothing here sequences against the refetch — the old awaitingRefresh flag,
  // batch accumulators and 5s fallback timer are gone with the destructive model.
  // Do NOT reintroduce anything that assumes event order here: batch-completed
  // reliably arrives BEFORE session:result (the server bus fans out
  // synchronously in subscription order and the result re-emit awaits task
  // enrichment — a structural ~20-50ms inversion, not a race you can fix).
  useEvent('session:batch-completed', (data) => {
    const d = data as { sessionId?: string; count?: number; messageIds?: string[] };
    if (d.sessionId === sessionId) {
      log.info('stream', `batch-completed count=${d.count ?? 1} ids=${d.messageIds?.length ?? 0} blocks=${blocks.length} isStreaming=${isStreaming}`, { sessionId });
      setHistoryVersion((v) => v + 1);
    }
  });

  // Batch delivery failed (e.g. SSH/daemon down): mark the matching optimistic
  // messages 'failed' so they keep their text + show Retry. Crucially we do NOT
  // refresh history here — the messages were never delivered, they remain in the
  // server-side pending queue, and a refresh would wipe the optimistic entries.
  useEvent('session:batch-failed', (data) => {
    const d = data as { sessionId?: string; messageIds?: string[]; error?: string };
    if (d.sessionId === sessionId && Array.isArray(d.messageIds)) {
      onBatchFailed?.(d.messageIds, d.error ?? 'Send failed');
    }
  });

  // Errors: also trigger history refresh so optimistic messages clear.
  // EXCEPT delivery_failed — no turn ran, the optimistic messages must stay
  // visible as 'failed' (batch-failed handles their status), and a history
  // refetch would hit the very host that is down.
  useEvent('session:error', (data) => {
    const d = data as { sessionId?: string; errorKind?: string };
    if (d.sessionId === sessionId && d.errorKind !== 'delivery_failed') {
      setHistoryVersion((v) => v + 1);
    }
  });

  // WebSocket reconnect: re-fetch history to recover events lost during disconnect.
  // Without this, a turn that completed during disconnect would be invisible.
  // The absorption filter reconciles blocks against whatever arrives — no flag.
  // Hidden tabs defer until shown: a server restart reconnects every open tab,
  // and N hidden tabs × M session columns each firing a history fetch is the
  // burst that saturates the shared 6-connection pool.
  useEvent('_ws:reconnected', () => {
    runWhenVisible(`sch:reconnect:${sessionId}`, () => setHistoryVersion((v) => v + 1));
  });

  // Agent-sent messages: create synthetic optimistic message so it appears in the queue.
  // `side-thread-*` sources are TOOL PLUMBING (the cache warm-up, the self-summary
  // request): history hides those lines on purpose, so minting a "You" bubble for one
  // would paint a raw machine prompt into the timeline that nothing later removes.
  useEvent('session:message-queued', (data) => {
    const d = data as { sessionId?: string; messageId?: string; message?: string; source?: string; enqueuedAt?: string };
    const plumbing = d.source === 'ui' || (d.source ?? '').startsWith('side-thread-');
    if (d.sessionId === sessionId && !plumbing && d.messageId && d.message) {
      onAgentQueued?.({ queueId: d.messageId, text: d.message, ...(d.enqueuedAt ? { enqueuedAt: d.enqueuedAt } : {}) });
    }
  });

  // NOTE (single-timeline model): there is no turn-boundary cleanup effect
  // anymore. Absorption of streaming blocks into history is a render-time
  // filter (hiddenBlocks above) — idempotent, order-insensitive, nothing to
  // sequence against the history refetch. Optimistic-bubble dedup scans
  // messages[turnWatermark..] each render (below).

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-SCROLL — Dead simple. Standard chat pattern.
  //
  // - On open: scroll to bottom
  // - At bottom + new content: stay at bottom
  // - User scrolls up: STOP. No timer. No expiration. Just stop.
  // - Show floating "↓" arrow when not at bottom
  // - User scrolls back to bottom (or clicks arrow): resume auto-scroll
  // ═══════════════════════════════════════════════════════════════════════════

  const isAtBottom = useRef(true);
  // Selection guard: every auto-scroll write shifts content under the cursor,
  // which mid-drag makes the browser extend the selection to the bottom (the
  // "select lines 2-10 but get 2-to-bottom" bug). All scroll paths consult
  // this and skip while the user is drag-selecting or has a live selection
  // inside the container. While the gap stays small, isAtBottom stays true so
  // following resumes seamlessly; once suppressed content grows past
  // NEAR_BOTTOM_PX, suppressedScrollCheck converts the pause into the standard
  // "user scrolled up" state (isAtBottom=false + arrow) — holding a selection
  // to read IS that intent, and it avoids a silent teleport-to-bottom the
  // instant the selection clears.
  const selectionActive = useSelectionScrollGuard(containerRef);
  // Held selections keep their place when the timeline changes height around
  // them (at turn end the persisted twin renders above the frozen copy and used
  // to shove the selected line hundreds of px below the fold).
  useSelectionAnchoredScroll(containerRef);
  const scrollRafId = useRef<number | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Frames still owed by the composer-shrink chase (Path B-2), and the height
   *  that chase is allowed to close (the shrink itself, nothing the transcript
   *  grew by in the meantime). */
  const shrinkChaseRaf = useRef<number | null>(null);
  const shrinkOwed = useRef(0);
  const firstScrollDone = useRef(false);
  const initialLoadDone = useRef(false);  // true after Phase 2 completes for the first time
  const prevOptimisticLen = useRef(0);
  const [showScrollArrow, setShowScrollArrow] = useState(false);
  // Timestamp: ignore scroll events within the debounce window (350ms) of a resize.
  // Why? When sibling components grow (UserMessagesSummary, PlanPreviewSection, SessionNotes),
  // the flex container shrinks our scroll area. This can trigger a scroll event (browser adjusts
  // geometry), which falsely sets isAtBottom=false. By ignoring scroll events during the
  // debounce window, we prevent resize-induced geometry shifts from corrupting isAtBottom.
  const ignoreScrollUntil = useRef(0);
  // Last real input (wheel / touch / pointer / key) inside the scroller. A ref,
  // not a closure local, because two effects need the same answer: the scroll
  // handler's echo guard and the follower below both have to tell "the reader
  // moved" apart from "the box moved under the reader".
  const lastUserInput = useRef(0);

  // A scroll write was suppressed for an active selection. While the gap is
  // still small, keep isAtBottom=true (seamless resume). Once the suppressed
  // content has pushed the view further than NEAR_BOTTOM_PX from the bottom,
  // demote to the standard "user scrolled up" state — no silent teleport when
  // the selection clears, and the ↓ arrow appears as the affordance to return.
  const noteSuppressedScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap > NEAR_BOTTOM_PX) {
      isAtBottom.current = false;
      setShowScrollArrow(el.scrollHeight > el.clientHeight);
    }
  }, []);

  // ── Scroll debug logging (persisted via browser-logger → walnut logs -s browser) ──
  // Gated: every call is a console.log that the browser-logger forwards to the
  // server — on hot scroll/resize paths this amplifies main-thread starvation.
  // Instance uid: two mounts of the same session (second tab, dock card,
  // popout) log interleaved lines that read as ONE container flip-flopping
  // (inc-1786553756848 showed two monotonic sh series interleaved). The uid
  // separates the series so forensics can attribute each line to a mount.
  const instanceUid = useRef(Math.random().toString(36).slice(2, 6));
  const sid8 = `${sessionId.substring(0, 8)}#${instanceUid.current}`;
  // Render-state mirror for the always-on scroll tripwires below (they live in
  // event closures that must read CURRENT values without re-subscribing).
  const forensicsRef = useRef({ msgs: 0, blocks: 0, hidden: 0, trunc: 0, streaming: false });
  forensicsRef.current = { msgs: messages.length, blocks: blocks.length, hidden: hiddenBlocks.size, trunc: truncationOffset, streaming: isStreaming };
  const scrollLog = useCallback((layer: string, action: string, el?: HTMLElement | null) => {
    // Always log during the initial-load window (inc-1786654438334: the
    // load-time up-then-down jump left zero trace because all scroll writes
    // were gated). Bounded: a handful of lines per mount, then gated again.
    if (!scrollDebugEnabled() && initialLoadDone.current) return;
    if (el) {
      const top = Math.round(el.scrollTop);
      const ch = Math.round(el.clientHeight);
      const sh = Math.round(el.scrollHeight);
      const gap = sh - top - ch;
      console.log(`[scroll:${sid8}] ${layer} ${action} top=${top} ch=${ch} sh=${sh} gap=${gap} atBot=${isAtBottom.current}`);
    } else {
      console.log(`[scroll:${sid8}] ${layer} ${action} atBot=${isAtBottom.current}`);
    }
  }, [sid8]);

  // ── ALWAYS-ON scroll-jump tripwire (not gated by scrollDebugEnabled) ──
  // Fires only on anomalies (rare), so it can't amplify starvation like the
  // per-tick debug logging above. Captures the "scrolling up suddenly jumps to
  // top" class: a large scrollTop teleport or a scrollHeight collapse, with
  // enough render-state context (msgs/blocks/hidden/trunc) to attribute cause.
  const jumpForensics = useCallback((why: string, el: HTMLElement, extra = '') => {
    const f = forensicsRef.current;
    console.warn(`[scroll-jump:${sid8}] ${why} top=${Math.round(el.scrollTop)} sh=${Math.round(el.scrollHeight)} ch=${Math.round(el.clientHeight)} msgs=${f.msgs} blocks=${f.blocks} hidden=${f.hidden} trunc=${f.trunc} streaming=${f.streaming} atBot=${isAtBottom.current}${extra}`);
  }, [sid8]);

  // Reset on session switch
  useEffect(() => {
    // Always-on mount marker: lets forensics tell N mounts of the same session
    // apart (SessionPanel vs FocusDock vs popout vs second tab). One line per
    // mount/session-switch — negligible volume.
    console.log(`[scroll-mount:${sid8}] mounted path=${window.location.pathname}`);
    setHistoryVersion(0);
    turnWatermark.current = 0;
    watermarkInitialized.current = false;
    promptRefetchFired.current = false;
    clearPromptRefetchRetries();
    setEditingId(null);
    setTruncationOffset(0);
    pendingBottomDistance.current = null;
    renderWindowStart.current = null;
    renderWindowAnchor.current = null;
    blockIndexMap.current.clear();
    consumedQueueIds.current.clear();
    notifiedConsumedIds.current.clear();
    isAtBottom.current = true;
    firstScrollDone.current = false;
    initialLoadDone.current = false;
    ignoreScrollUntil.current = 0;
    prevOptimisticLen.current = 0;
    setShowScrollArrow(false);
    if (scrollRafId.current !== null) { cancelAnimationFrame(scrollRafId.current); scrollRafId.current = null; }
    if (resizeTimerRef.current) { clearTimeout(resizeTimerRef.current); resizeTimerRef.current = null; }
    if (shrinkChaseRaf.current !== null) { cancelAnimationFrame(shrinkChaseRaf.current); shrinkChaseRaf.current = null; }
    shrinkOwed.current = 0;
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    if (shrinkChaseRaf.current !== null) cancelAnimationFrame(shrinkChaseRaf.current);
  }, []);

  // Restore the user's reading position after "Show earlier" expands the
  // truncation window. Runs before paint (useLayoutEffect) so there is no
  // visible jump: same distance-to-bottom ⇒ the message the user was reading
  // stays exactly where it was, with the revealed batch above the viewport.
  // `messages` is a dep too: "Load N earlier" (lazy-tail backfill) replaces the
  // whole array without touching truncationOffset. Null-guarded, so ordinary
  // appends (dist === null) are a no-op.
  useLayoutEffect(() => {
    const dist = pendingBottomDistance.current;
    if (dist === null) return;
    pendingBottomDistance.current = null;
    const el = containerRef.current;
    if (!el) return;
    // Tripwire: a target above the viewport start clamps to 0 = teleport to
    // the very top. Happens when content COLLAPSED between the "Show earlier"
    // click (dist captured against the tall layout) and this restore (short
    // layout: sh - dist < 0). Always-on — this is the exact reported symptom.
    if (el.scrollHeight - dist < 0) {
      jumpForensics('anchor-clamped-to-top', el, ` dist=${Math.round(dist)}`);
    }
    el.scrollTop = el.scrollHeight - dist;
    // A programmatic scrollTop write fires a scroll event; the handler would
    // recompute isAtBottom correctly (we're far from bottom), but suppress the
    // resize-window race anyway so a concurrent sibling resize can't misread it.
    ignoreScrollUntil.current = Date.now() + 100;
  }, [truncationOffset, messages, jumpForensics]);

  // Listen for expand-to-message events from parent panels (when clicking a truncated message)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const { messageIndex } = (e as CustomEvent).detail;
      // Expand truncation to include the target message
      const needed = messages.length - messageIndex;
      if (needed > INITIAL_RENDER_LIMIT + truncationOffset) {
        setTruncationOffset(needed - INITIAL_RENDER_LIMIT);
      }
      // After React re-render, scroll to the target
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const target = el.querySelector(`[data-msg-index="${messageIndex}"]`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('user-messages-highlight');
            setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
          }
        });
      });
    };
    el.addEventListener('expand-to-message', handler);
    return () => el.removeEventListener('expand-to-message', handler);
  }, [messages.length, truncationOffset]);

  // ── Thread tree ────────────────────────────────────────────────────────────
  // Derived from the loaded rows + the record's anchors. Memoised on exactly those
  // two: it walks the whole transcript, and this component re-renders on every
  // streaming delta.
  //
  // The loaded rows include the user lines this browser has SENT but the transcript
  // has not caught up with yet. Without them the tree only learns about a new
  // thread when history refetches — which is turn end — so the outline, the map and
  // the child cards appeared a whole answer late while the bubble itself already
  // wore its thread (that decoration reads the anchor directly). A pre-assigned
  // uuid is the same id at a younger age, so filing the optimistic row under it
  // makes the structure appear in the frame the question is asked.
  const threadRows = useMemo(
    () => (threadsApi.anchors.length === 0
      ? messages
      : withPendingUserRows<ThreadTreeMessage>(messages, optimisticMessages)),
    [messages, optimisticMessages, threadsApi.anchors],
  );
  // A reply that opens with `[Q<n>]` files its whole turn under question n
  // (question-tag.ts): synthetic anchors, client only, so the tree, the stats
  // and every row's key agree without reading the tag twice.
  const headBySeq = useMemo(() => headsBySeq([...threadsApi.metaIndex.values()]), [threadsApi.metaIndex]);
  const tagAnchors = useMemo(
    () => (threadsApi.anchors.length === 0 ? threadsApi.anchors : withTagAnchors(threadRows as ThreadTreeMessage[], threadsApi.anchors, headBySeq)),
    [threadRows, threadsApi.anchors, headBySeq],
  );
  const threadTree = useMemo(
    () => buildThreadTree(threadRows, tagAnchors),
    [threadRows, tagAnchors],
  );
  const questionNumber = useMemo(() => questionNumbers(threadTree, threadsApi.metaIndex), [threadTree, threadsApi.metaIndex]);
  const keyBySeq = useMemo(() => keysBySeq(questionNumber), [questionNumber]);
  // Publish it to the panel (composer chip + the send path's "is this the newest
  // thread?" question). A session with anchors gets a fresh tree per history
  // change, so this costs the panel one extra render per refetch and converges
  // (the panel never feeds the tree back into `messages`); a session without
  // anchors gets the shared empty tree, whose stable identity makes this a no-op.
  const publishTree = threadsApi.setTree;
  // Complete = the whole transcript is in hand (a reload restore waits for it
  // before deciding the page it wanted is gone).
  const historyComplete = !loading && !phase2Pending && olderHidden === 0 && !olderWindowed;
  useEffect(() => { publishTree(threadTree, historyComplete); }, [publishTree, threadTree, historyComplete]);

  /** Tree Mode (the stack) vs Conversation Mode (the default). Only a session WITH
   *  questions (or an Ask pending) has a stack; one without renders exactly as
   *  before. */
  const stack = threadsApi.stack;
  const hasQuestions = threadTree.threads.length > 1 || !!stack.pending || stack.draftPages.length > 0;
  const stackMode = threadsApi.viewMode === 'stack' && hasQuestions;
  /** Conversation Mode with questions: every turn in order, each question's
   *  turns labelled; the stack path is the composer's target, never a filter. */
  const convMode = threadsApi.viewMode === 'linear' && hasQuestions;
  const currentKey = stackMode ? stack.currentKey : ROOT_THREAD_KEY;
  /** The question the composer posts into (both views). */
  const targetKey = hasQuestions ? stack.currentKey : ROOT_THREAD_KEY;
  const onQuestionPage = stackMode && currentKey !== ROOT_THREAD_KEY;
  // A question page owns its scroll (restored or landed by useThreadLanding): the
  // initial-load "always to the bottom" never overrides it; following does.
  const onQuestionPageRef = useRef(onQuestionPage);
  useLayoutEffect(() => { onQuestionPageRef.current = onQuestionPage; }, [onQuestionPage]);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  // A remembered scrollTop belongs to the page it was taken on: another page's
  // "Back to where I was" would scroll to a place that page never had. Before
  // paint, so the new page never shows the old page's Back for a frame.
  useLayoutEffect(() => {
    jumpReturnTop.current = null;
    setCanGoBack(false);
  }, [currentKey]);

  /** Anchor per user-row id — the one thing that knows a row's thread before the
   *  transcript does (the id IS the uuid we pre-assigned for that line). */
  const anchorByRowId = useMemo(() => {
    const map = new Map<string, SessionThreadAnchor>();
    for (const a of tagAnchors) {
      if (a?.msgId && a.parent) map.set(a.msgId, a);
    }
    return map;
  }, [tagAnchors]);

  /**
   * Thread of ONE row: the tree's answer first, the anchor's second.
   *
   * The tree is built from PERSISTED rows, so a just-sent bubble would read as top
   * level for the second or two before history absorbs it: the question page would
   * render the row outside the question the user is looking at. Its anchor is already recorded under the
   * pre-assigned uuid the row carries, which is enough to place it, and (for a
   * brand-new thread) to derive the depth and hue the tree is about to give it.
   */
  const rowThreadInfo = useCallback((rowId: string | undefined): ThreadRowInfo | undefined => {
    if (!rowId) return undefined;
    const known = threadTree.byRow.get(rowId);
    if (known) return known;
    const anchor = anchorByRowId.get(rowId);
    if (!anchor) return undefined;
    const key = threadKeyOf(anchor);
    const node = threadTree.byKey.get(key);
    if (node) return { key, depth: node.depth, hue: node.hue, isHead: node.headId === rowId };
    const parent = threadTree.byRow.get(anchor.parent);
    return {
      key,
      depth: (parent?.depth ?? 0) + 1,
      hue: hueForAnchor(threadTree, {
        parent: anchor.parent,
        ...(anchor.quote ? { quote: anchor.quote } : {}),
        source: anchor.source,
        label: '',
      }),
      isHead: true,
    };
  }, [threadTree, anchorByRowId]);

  const rowThreadKey = useCallback(
    (rowId: string | undefined): string => rowThreadInfo(rowId)?.key ?? ROOT_THREAD_KEY,
    [rowThreadInfo],
  );

  // ── Stack: which page is on screen ─────────────────────────────────────────
  // The stack (useThreadStack, owned by the panel) says which page is on screen;
  // this timeline only FILTERS its one row pipeline by that key. A page keeps its
  // rows loaded: the render window is a tail slice, so it is revealed back to the
  // page's head (and a pending page's parent reply), as an outline jump does.
  const currentNode = threadTree.byKey.get(currentKey);
  const pagePending = stackMode && stack.pending?.pageKey === currentKey ? stack.pending : undefined;
  const toast = useThreadToast();

  /** Row id → index in `messages`, for the window expansion below. */
  const rowIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    if (!stackMode) return map;
    for (let i = 0; i < messages.length; i++) {
      const id = messages[i].msgId ?? messages[i].walnutMessageId;
      if (id && !map.has(id)) map.set(id, i);
    }
    return map;
  }, [stackMode, messages]);

  useEffect(() => {
    if (!stackMode) return;
    const wanted: number[] = [];
    for (const rowId of [currentNode?.headId, pagePending?.parentMsgId]) {
      const at = rowId ? rowIndexOf.get(rowId) : undefined;
      if (at !== undefined) wanted.push(at);
    }
    if (wanted.length === 0) return;
    const needed = messages.length - Math.min(...wanted);
    if (needed > INITIAL_RENDER_LIMIT + truncationOffset) {
      setTruncationOffset(needed - INITIAL_RENDER_LIMIT);
    }
  }, [stackMode, currentNode, pagePending, rowIndexOf, messages.length, truncationOffset]);

  /**
   * The comment card (Conversation Mode): the composer's target shown beside its
   * passage, like a comment in a document. Open is a flag; WHICH question is the
   * stack's target, so a sidebar row, a turn label, a drawer row or an Ask all
   * swap the card by moving the target, Esc on the panel (target cleared) closes
   * it, and a pending question promoted by its first send stays on screen.
   */
  const [cardOpen, setCardOpen] = useState(false);
  const cardKey = threadsApi.viewMode === 'linear' && cardOpen && threadsApi.currentThreadKey !== ROOT_THREAD_KEY
    ? threadsApi.currentThreadKey : null;
  useEffect(() => { setCardOpen(false); }, [sessionId, threadsApi.viewMode]);
  /** What the open card's own box holds (the stack's composer probe sees only
   *  the panel composer). */
  const cardTextRef = useRef('');
  const onCardText = useCallback((text: string) => { cardTextRef.current = text; }, []);
  const cardKeyRef = useRef(cardKey);
  cardKeyRef.current = cardKey;
  /** The open card's words for a navigation away (none when no card is open,
   *  so the composer's own words decide). */
  const cardLeave = useCallback((): { leftText: string } | undefined => (cardKeyRef.current ? { leftText: cardTextRef.current } : undefined), []);
  const leavePending = stack.leavePending;
  /** The card closes; an Ask on it that was never written goes with it (only a
   *  sent question, or one with words typed for it, is kept). */
  const closeCard = useCallback((via: string = 'card-close') => {
    setCardOpen(false);
    const leave = cardLeave();
    cardTextRef.current = '';
    leavePending(leave?.leftText, via);
  }, [leavePending, cardLeave]);
  // Published: the Files tab measures the passage of a FILE question's card.
  const publishOpenCardKey = threadsApi.publishOpenCardKey;
  useEffect(() => { publishOpenCardKey(cardKey); }, [cardKey, publishOpenCardKey]);
  /** A question about a passage of a FILE (the Files tab), or null. */
  const filePlaceOf = useCallback((key: string): ThreadFilePlace | null => {
    const pend = stack.pending?.pageKey === key ? stack.pending : undefined;
    if (pend) {
      const path = fileOfParent(pend.parentMsgId);
      return path ? { path, ...(pend.line ? { line: pend.line } : {}) } : null;
    }
    return threadTree.byKey.get(key)?.file ?? null;
  }, [stack.pending, threadTree]);

  /** Ask on a passage (the pill): the stack pushes a pending page in this frame,
   *  or the question already about this passage. Nothing is written yet. */
  const askAboutQuote = useCallback((target: QuotePinTarget) => {
    if (threadsApi.viewMode === 'linear') {
      // Conversation Mode: the card opens beside the passage with its own
      // composer focused; the timeline stays where it is.
      stack.ask({ msgId: target.msgId, quote: target.quote }, { focusComposer: false });
      setCardOpen(true);
      return;
    }
    stack.ask({ msgId: target.msgId, quote: target.quote });
  }, [stack, threadsApi.viewMode]);

  /** Titles as every question surface shows them (AI title, else the fallback). */
  const titleOfKey = useCallback((key: string): string => {
    if (key === ROOT_THREAD_KEY) return MAIN_TITLE;
    if (stack.pending?.pageKey === key) return stack.pending.title;
    return displayTitleOf(threadTree.byKey.get(key), threadsApi.metaIndex).title;
  }, [stack.pending, threadTree, threadsApi.metaIndex]);

  /** The sliver: one bar per ancestor page, root first. */
  const sliver = useMemo(() => (stackMode
    ? sliverBars(stack.path.slice(0, -1).map((key) => {
      const node = threadTree.byKey.get(key);
      return { key, ...(node && node.depth > 0 ? { hue: node.hue } : {}), title: titleOfKey(key) };
    }))
    : []), [stackMode, stack.path, threadTree, titleOfKey]);

  // ── Outline (pinned messages + thread heads) ───────────────────────────────
  // Entries are ordered by TRANSCRIPT position, not by when they were pinned: the
  // outline is a map of the conversation, so it has to read in the conversation's
  // own order. A pin whose message isn't in the loaded array (older than the tail
  // window, /compact rewrote it) is placed by its message's TIMESTAMP among the
  // loaded rows rather than dropped or parked at the end — see outline-order.ts for
  // the rule and the report that fixed it. Its jump loads the older history first
  // (jumpToPlace), so the row is a real destination, not a dead entry.
  const pinTocEntries = useMemo(() => {
    if (pinsApi.pins.length === 0) {
      return [] as Array<TocEntry & { at: number; quoteExact?: string }>;
    }
    return placePins(pinsApi.pins, messages)
      .map(({ pin, at }) => {
        const fallback = pin.role === 'user' ? 'Your message' : 'Reply';
        const base = pin.label
          || (pin.quote ? pinLabelFor(pin.quote.exact, 'Quoted passage') : fallback);
        return {
          key: pinKeyOf(pin),
          msgId: pin.msgId,
          // The ❝ glyph is what tells the two kinds of row apart at a glance.
          label: pin.quote ? `❝ ${base}` : base,
          role: pin.role,
          ...(pin.timestamp ? { timestamp: pin.timestamp } : {}),
          ...(pin.quote ? { isQuote: true, quoteExact: pin.quote.exact } : {}),
          at,
        };
      });
  }, [pinsApi.pins, messages]);

  /**
   * The outline: pins in transcript order. On a stack page it lists only the
   * page's OWN pins (spec 5.11); the rest are counted in one faint row that opens
   * the drawer on Pinned. Questions are not outline rows any more: the drawer is
   * their overview.
   */
  const pagePins = useMemo(() => {
    if (!stackMode) return { entries: pinTocEntries, other: 0 };
    const entries: typeof pinTocEntries = [];
    let other = 0;
    for (const e of pinTocEntries) {
      const key = rowThreadKey(e.msgId);
      if (key === currentKey) entries.push(e);
      else if (!threadsApi.hiddenKeys.has(key)) other += 1;
    }
    return { entries, other };
  }, [stackMode, pinTocEntries, rowThreadKey, currentKey, threadsApi.hiddenKeys]);
  const tocEntries = useMemo<TocEntry[]>(
    () => pagePins.entries.map(({ at: _at, quoteExact: _q, ...entry }) => entry),
    [pagePins],
  );

  // Quote-pin paint. Costs nothing until a session actually has one (the hook
  // early-returns before installing its observer). The nonce covers the render
  // window growing/shrinking; the hook's own MutationObserver covers everything
  // else that re-renders a body (streaming deltas, the MD⇄Rich toggle).
  const quotePaint = useQuotePinPaint(
    containerRef, pinsApi.pins, quotePanelKey, messages.length + truncationOffset,
  );

  /** Jump to a place in the transcript: reveal its message (the render window is
   *  a tail slice), then centre it — the PASSAGE when there is one, the row
   *  otherwise — and flash it. The pre-jump scrollTop is remembered so "Back" can
   *  undo a jump; losing your reading place is the cost of a look otherwise.
   *  Shared by the outline's pins, the stack's pop fallback and the linear view's
   *  gutter bars, which all name a place the same way. `via` only labels the log
   *  lines. */
  const jumpToPlace = useCallback((
    msgId: string, quote: SessionPinnedQuote | undefined, via: string, opts?: { armBack?: boolean },
  ) => {
    // `armBack: false` (a stack pop's fallback): no outline Back, and no smooth
    // scroll either, since a pop lands instantly.
    const armBack = opts?.armBack !== false;
    const behavior: ScrollBehavior = armBack ? 'smooth' : 'auto';
    const el = containerRef.current;
    if (!el || !msgId) return;
    const index = messages.findIndex((m) => (m.msgId ?? m.walnutMessageId) === msgId);
    if (index < 0) {
      // The loaded rows are a TAIL window; a pin on an older message is a real
      // destination the window just does not hold yet. Fetch the rest (the same
      // request the "Load earlier messages" button makes) and finish the jump when
      // the row lands (the effect below). A row that is not there even then (a
      // /compact rewrote it) is logged, not silently ignored.
      if (olderHidden > 0 || olderWindowed) {
        log.info('session', 'pin jump: target is outside the loaded tail — loading the full history first', {
          sessionId, msgId, via,
        });
        pendingJump.current = { msgId, quote, via, armBack };
        loadFullHistory();
        return;
      }
      log.warn('session', 'pin jump: message not in the loaded transcript', { sessionId, msgId, via });
      return;
    }
    if (armBack) {
      jumpReturnTop.current = el.scrollTop;
      setCanGoBack(true);
    }
    // A jump is the user leaving the live tail on purpose; without this the
    // follow-bottom paths would drag them straight back down on the next delta.
    isAtBottom.current = false;
    const needed = messages.length - index;
    if (needed > INITIAL_RENDER_LIMIT + truncationOffset) {
      setTruncationOffset(needed - INITIAL_RENDER_LIMIT);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Identity first (`data-message-id`), index second: merged tool runs carry
        // only the index of their first member.
        const target = el.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`)
          ?? el.querySelector(`[data-msg-index="${index}"]`);
        if (!target) {
          log.warn('session', 'pin jump: target row did not render', { sessionId, msgId, index });
          return;
        }
        if (quote) {
          // The row may have just been revealed by the window expansion above, so
          // its paint doesn't exist yet — re-derive before asking for the Range.
          quotePaint.relocate();
          const range = quotePaint.locatePin({ msgId, quote });
          const rect = range?.getBoundingClientRect();
          if (range && rect && (rect.width || rect.height)) {
            const box = el.getBoundingClientRect();
            const delta = (rect.top + rect.height / 2) - (box.top + box.height / 2);
            el.scrollTo({ top: el.scrollTop + delta, behavior });
            flashRange(range);
            return;
          }
          // Passage gone (message edited, /compact rewrote it): the row is still
          // the right place to land, so fall through to the row flash.
          log.info('session', 'pin jump: passage did not locate — falling back to the row', {
            sessionId, msgId, via,
          });
        }
        target.scrollIntoView({ behavior, block: 'center' });
        target.classList.add('user-messages-highlight');
        setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
      });
    });
  }, [messages, truncationOffset, sessionId, quotePaint, olderHidden, olderWindowed, loadFullHistory]);

  // The second half of a jump to an unloaded row: the full history has landed (or
  // the load ended without it). Keyed on `messages` because that is what the load
  // replaces; `phase2Pending` false + no row = the load is over and the row is
  // gone for good (a rewrite), so the pending jump is dropped rather than left
  // armed to fire on some unrelated later refetch.
  useEffect(() => {
    const pending = pendingJump.current;
    if (!pending) return;
    const present = messages.some((m) => (m.msgId ?? m.walnutMessageId) === pending.msgId);
    if (present) {
      pendingJump.current = null;
      jumpToPlace(pending.msgId, pending.quote, pending.via, { armBack: pending.armBack !== false });
      return;
    }
    if (!phase2Pending) {
      pendingJump.current = null;
      log.warn('session', 'pin jump: message not in the transcript even after loading the full history', {
        sessionId, msgId: pending.msgId, via: pending.via,
      });
    }
  }, [messages, phase2Pending, jumpToPlace, sessionId]);

  /** An outline row's jump: the pin's passage. */
  const jumpToPin = useCallback((pinKey: string, opts?: { armBack?: boolean }) => {
    if (!pinKey) return;
    const pin = pinsApi.pins.find((p) => pinKeyOf(p) === pinKey);
    if (!pin?.msgId) return;
    jumpToPlace(pin.msgId, pin.quote, pinKey, opts);
  }, [pinsApi.pins, jumpToPlace]);

  const jumpBack = useCallback(() => {
    const el = containerRef.current;
    const top = jumpReturnTop.current;
    if (!el || top === null) return;
    jumpReturnTop.current = null;
    setCanGoBack(false);
    el.scrollTo({ top, behavior: 'smooth' });
  }, []);

  /**
   * The outline click. A pin on this page is a plain jump (and arms the rail's
   * Back). A pin on another page goes THROUGH the stack first (spec 5.11): the
   * panel pushes to its page and the pin lands once that page has rendered (the
   * effect below), instead of jumping to a row that is filtered out.
   */
  const handleTocJump = useCallback((pinKey: string) => {
    const pin = pinsApi.pins.find((p) => pinKeyOf(p) === pinKey);
    if (stackMode && pin) {
      const key = rowThreadKey(pin.msgId);
      if (key !== currentKeyRef.current) {
        threadsApi.requestPinJump(pinKey, key);
        return;
      }
    }
    jumpToPin(pinKey);
  }, [stackMode, pinsApi.pins, rowThreadKey, threadsApi, jumpToPin]);

  // A pin jump waiting for its page: land once the page on screen is the pin's.
  // Each request lands exactly ONCE: a later return to that page (Esc back to
  // root, where the landing restores the passage the user left) must not
  // replay an old jump and yank the view to the pin again.
  const pinJump = threadsApi.pinJump;
  const pinJumpLandedRef = useRef<typeof pinJump>(null);
  useEffect(() => {
    if (!pinJump || pinJump === pinJumpLandedRef.current) return;
    const pin = pinsApi.pins.find((p) => pinKeyOf(p) === pinJump.pinKey);
    if (!pin) return;
    if (stackMode && rowThreadKey(pin.msgId) !== currentKey) return;
    pinJumpLandedRef.current = pinJump;
    jumpToPin(pinJump.pinKey, { armBack: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request, or when its page arrives
  }, [pinJump?.seq, currentKey]);

  /**
   * Conversation Mode: the click on a turn's rule lands on the PASSAGE its
   * question hangs off (the reply the user selected in and pressed Ask).
   * Resolved from the tree when it knows the question, else from the row's own
   * anchor (a just-sent bubble, before history has absorbed it).
   */
  const jumpToThreadOrigin = useCallback((threadKey: string, rowId: string | undefined) => {
    const node = threadTree.byKey.get(threadKey);
    const anchor = rowId ? anchorByRowId.get(rowId) : undefined;
    const parent = node?.parent ?? anchor?.parent;
    if (!parent) return;
    const filePath = fileOfParent(parent);
    if (filePath) { onFileOpen?.(filePath, node?.file?.line ?? anchor?.line); return; }
    const quote = node ? node.quote : anchor?.quote;
    jumpToPlace(parent, quote, `thread-origin:${threadKey}`);
  }, [threadTree, anchorByRowId, jumpToPlace, onFileOpen]);

  /** `openCard` (declared further down): the bar opens the question's card. */
  const openCardRef = useRef<((key: string, via: string) => void) | null>(null);

  /**
   * Gutter-bar click for ONE row wrapper: only a press on the wrapper's own box
   * inside the bar's strip (border + padding, `THREAD_BAR_HIT_PX`) counts; the
   * message content is a child and keeps its own clicks. The bar is the question
   * itself, the same as its label: its card opens beside the passage (a file
   * question's in the Files tab), which brings the passage on screen. A row the
   * tree does not know yet (a just-sent bubble) only jumps to the passage.
   */
  const onThreadBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>, threadKey: string, rowId: string | undefined) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX > rect.left + THREAD_BAR_HIT_PX) return;
    const open = openCardRef.current;
    if (open && threadTree.byKey.has(threadKey)) { open(threadKey, 'bar'); return; }
    jumpToThreadOrigin(threadKey, rowId);
  }, [jumpToThreadOrigin, threadTree]);

  /**
   * Row wrapper props. Conversation Mode: a question's rows wear the grey
   * gutter bar (continuous across every wrapper kind), which is also the way
   * back to the passage. A stack page shows one question, so no bar; its head
   * row is marked so the page hides the quote block the quote head already shows.
   */
  const threadWrapperProps = useCallback((
    rowId: string | undefined, baseClass?: string,
  ): Record<string, unknown> => {
    const info = rowThreadInfo(rowId);
    const base = baseClass ? { className: baseClass } : {};
    if (stackMode) {
      return info?.isHead && info.key === currentKey && currentKey !== ROOT_THREAD_KEY
        ? { ...base, 'data-thread-head': '' }
        : base;
    }
    if (!info || info.depth < 1) return base;
    return {
      className: `${baseClass ? `${baseClass} ` : ''}session-msg--threaded`,
      'data-thread-row-depth': info.depth,
      'data-thread-current': info.key === targetKey ? 'true' : undefined,
      onClick: (e: React.MouseEvent<HTMLDivElement>) => onThreadBarClick(e, info.key, rowId),
    };
  }, [rowThreadInfo, stackMode, currentKey, targetKey, onThreadBarClick]);

  // Scroll handler: track whether user is near bottom.
  // Ignores scroll events caused by container resizes (which corrupt isAtBottom).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastLoggedAtBot: boolean | null = null;
    /** The ↓ arrow answers a GEOMETRY question ("is the newest row off screen?"),
     *  never an intent question, so it is computed from the box alone and kept
     *  out of every gate that exists to protect isAtBottom. Two states used to
     *  leave it hidden while thousands of px sat below the reader, with no way
     *  down but guessing (the 2026-09-16 report, "there is clearly more below
     *  and somehow I cannot scroll to it"): content that GROWS while the reader
     *  is stationary fires no scroll event at all, and a programmatic reposition
     *  (the Show-earlier anchor restore, a load-window correction) lands inside
     *  an ignoreScrollUntil window whose early return sits ABOVE the old arrow
     *  update. Both are covered now — the scroll path computes it before that
     *  gate, and the 2Hz sentinel poll re-checks it.
     *
     *  Deliberately NO local mirror of the state it sets. The old code kept one
     *  and skipped the update when it matched, but four follow-bottom paths
     *  outside this closure set the flag directly — so the mirror drifted, and a
     *  drifted mirror swallows exactly the update that would have brought the
     *  arrow back. React bails out on an unchanged value by itself. */
    const syncArrow = () => {
      setShowScrollArrow(el.scrollHeight > el.clientHeight
        && el.scrollTop + el.clientHeight < el.scrollHeight - NEAR_BOTTOM_PX);
    };
    // Jump tripwire state: previous geometry, to detect teleports between
    // consecutive scroll events. User scrolling (incl. momentum fling) moves
    // scrollTop ≤ a few hundred px per event; a single-event move of
    // thousands of px is programmatic or a browser clamp after content
    // collapsed under the viewport. Always-on (anomaly-frequency only).
    let prevTop = el.scrollTop;
    let prevSh = el.scrollHeight;
    // Flicker sentinel: sub-teleport content shifts (|dSh| 150..1000px) felt
    // as jitter while reading. Individually too small for the teleport
    // tripwire and too chatty to log each — aggregate and flush at most one
    // line per 2s: count + net/max shift + context. Always-on.
    let flickCount = 0;
    let flickNet = 0;
    let flickMax = 0;
    let flickLastLog = 0;
    const noteFlicker = (dSh: number, source: string) => {
      flickCount++;
      flickNet += dSh;
      if (Math.abs(dSh) > Math.abs(flickMax)) flickMax = dSh;
      const now = Date.now();
      if (now - flickLastLog > 2000) {
        flickLastLog = now;
        const f = forensicsRef.current;
        console.warn(`[scroll-flicker:${sid8}] ${source} n=${flickCount} net=${Math.round(flickNet)} max=${Math.round(flickMax)} top=${Math.round(el.scrollTop)} sh=${Math.round(el.scrollHeight)} msgs=${f.msgs} blocks=${f.blocks} hidden=${f.hidden} trunc=${f.trunc} streaming=${f.streaming} atBot=${isAtBottom.current}`);
        flickCount = 0; flickNet = 0; flickMax = 0;
      }
    };
    // User-intent tracking (inc-1786654438334 structural fix): a scroll event
    // is USER intent only if real input arrived recently — wheel, touch,
    // pointerdown (scrollbar drag), or a key. Content GROWTH also fires
    // scroll-position-relative changes (gap opens with no event at all, then
    // our own corrective write's echo arrives after MORE growth and reads
    // gap>NEAR_BOTTOM_PX) — those echoes used to flip isAtBottom=false with
    // zero user action, parking the view mid-history ("jumps up then down
    // while loading"). Growth may never flip isAtBottom; only people may.
    const markUserInput = () => { lastUserInput.current = Date.now(); };
    // Wheel-UP is unambiguous "stop following, I'm reading" intent — honor it
    // SYNCHRONOUSLY (inc-1786690697303: while streaming, debouncedScroll
    // re-arms ignoreScrollUntil every content tick, so the wheel's scroll
    // events were swallowed at the ignore gate → isAtBottom never flipped →
    // every follow-bottom path kept dragging the view down against the
    // user's fingers — the "can't scroll up, screen jitters" fight). Flipping
    // here (input event, not scroll echo) beats the gate: intent lands even
    // if every scroll event in flight gets ignored.
    const onWheel = (e: WheelEvent) => {
      markUserInput();
      if (e.deltaY < 0) {
        isAtBottom.current = false;
        ignoreScrollUntil.current = 0; // user input overrides any quiet window
        setShowScrollArrow(el.scrollHeight > el.clientHeight);
      }
    };
    const onTouchMove = () => {
      markUserInput();
      // Touch pan direction isn't in the event; just lift the suppression so
      // the resulting scroll events are evaluated instead of swallowed.
      ignoreScrollUntil.current = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', markUserInput, { passive: true });
    el.addEventListener('keydown', markUserInput, { passive: true });
    // A CLICK counts as input in its own right, not just the pointerdown that
    // usually precedes it: the follower below asks "did the reader grow this?",
    // and expanding a tool run is a click. Keyboard activation arrives as keydown.
    el.addEventListener('click', markUserInput, { passive: true });
    const onScroll = () => {
      const rawTop = el.scrollTop;
      const rawSh = el.scrollHeight;
      const dTop = rawTop - prevTop;
      const dSh = rawSh - prevSh;
      // scrollHeight collapse (content vanished under the user) or an upward
      // teleport (this includes the browser clamping scrollTop after a
      // collapse — the reported "scrolling up suddenly jumps to top").
      if (dSh < -1000 || dTop < -2000) {
        jumpForensics('teleport', el, ` dTop=${Math.round(dTop)} dSh=${Math.round(dSh)} ignored=${Date.now() < ignoreScrollUntil.current}`);
      } else if (!initialLoadDone.current && Math.abs(dTop) > 800) {
        // Load-window shift (inc-1786654438334): during initial load the view
        // visibly jumped up then back down, but every write path was silent —
        // the churn lived below the teleport threshold and load-time scroll
        // writes weren't logged. Catch ANY large scrollTop move before the
        // first Phase 2 completes, both directions.
        jumpForensics('load-shift', el, ` dTop=${Math.round(dTop)} dSh=${Math.round(dSh)}`);
      } else if (Math.abs(dSh) > 150 && !isAtBottom.current) {
        // Content height changed DURING a user scroll away from the bottom —
        // the reader-visible jitter class (at bottom, follow-bottom makes
        // growth expected; skip it there).
        noteFlicker(dSh, 'mid-scroll');
      }
      prevTop = rawTop;
      prevSh = rawSh;
      // Before the gate: whether the newest row is off screen does not depend on
      // whose write moved us there.
      syncArrow();
      // Skip scroll events triggered by ResizeObserver-induced geometry shifts
      if (Date.now() < ignoreScrollUntil.current) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
      // Echo guard: leaving-the-bottom requires recent user input. A no-input
      // "left bottom" is our own write racing content growth — heal it by
      // re-closing the gap instead of surrendering follow-bottom.
      if (isAtBottom.current && !nearBottom && Date.now() - lastUserInput.current > 500) {
        if (!selectionActive()) {
          el.scrollTop = el.scrollHeight;
          ignoreScrollUntil.current = Date.now() + 100;
        }
        return; // isAtBottom stays true
      }
      const prev = isAtBottom.current;
      isAtBottom.current = nearBottom;
      // Log only on transitions (not every scroll tick)
      if (nearBottom !== lastLoggedAtBot) {
        lastLoggedAtBot = nearBottom;
        const top = Math.round(el.scrollTop);
        const ch = Math.round(el.clientHeight);
        const sh = Math.round(el.scrollHeight);
        console.log(`[scroll:${sid8}] handler ${prev}→${nearBottom} top=${top} ch=${ch} sh=${sh}`);
      }
      syncArrow();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Stationary flicker sentinel: content shifting while the reader is NOT
    // scrolling fires no scroll event (unless the browser clamps), so poll
    // scrollHeight at 2Hz — one layout read per 500ms, negligible — and put
    // any shift through the same aggregator. Only while scrolled up (at
    // bottom, growth is expected follow-bottom churn).
    let pollSh = el.scrollHeight;
    const pollTimer = setInterval(() => {
      const sh = el.scrollHeight;
      const dSh = sh - pollSh;
      pollSh = sh;
      prevSh = sh; // keep onScroll's baseline in sync so one shift isn't double-counted
      if (Math.abs(dSh) > 150 && !isAtBottom.current) noteFlicker(dSh, 'stationary');
      // Growth under a stationary reader fires no scroll event, so this poll is
      // the only thing that can notice the newest row leaving the screen. Cheap:
      // the two reads above already forced the same layout.
      //
      // Deliberately NOT gated on isAtBottom. Opening a collapsed row while
      // parked at the bottom grows the transcript with no messages change, no
      // new blocks, no image load and no container resize — nothing any
      // follow-bottom path watches, and no scroll event either. The reader is
      // then above the newest row while intent still says "following", which is
      // precisely when they need the way back.
      syncArrow();
    }, 500);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', markUserInput);
      el.removeEventListener('keydown', markUserInput);
      el.removeEventListener('click', markUserInput);
      clearInterval(pollTimer);
    };
  }, [sid8, jumpForensics, selectionActive]);

  /** FOLLOW THE NEWEST ROW — the other half of "the way back is geometry".
   *
   *  Every other follow path keys on an EVENT: a new message, one more streaming
   *  block, an image's load, the scroller resizing. A transcript also grows with
   *  none of those: the streamed text block grows IN PLACE (one block, re-rendered
   *  every 150ms flush), a tool result is backfilled into a row that already
   *  exists, WebKit reserves a scrollbar track in a code block a beat late, a font
   *  swaps. `blocks.length` never moves, so Path A-2 fires once and never again,
   *  and the reader who was sitting at the bottom is left behind by however much
   *  the answer grew. Two reported shapes, same cause:
   *    · a long prose answer (no tool calls to bump the block count) scrolls away
   *      while it streams — measured at 1,164px adrift in both engines;
   *    · a finished turn whose last line ends up ~40px under the composer glass.
   *      That one is invisible to everything else: 40px is INSIDE the 80px
   *      near-bottom tolerance, so `isAtBottom` still says "following" and the ↓
   *      arrow stays hidden — nothing follows it and nothing offers a way down.
   *
   *  So this watches the BOX, at the cadence the growth happens: every frame while
   *  a turn streams, 2Hz otherwise (late layout — scrollbar tracks, fonts, decoded
   *  images — lands after the turn ends).
   *
   *  It only ever follows GROWTH, and that distinction is the whole safety
   *  argument: a gap that opened because `scrollHeight` grew is the box moving
   *  under a stationary reader, and closing it is what they asked for by staying
   *  at the bottom; a gap that opened because `scrollTop` FELL is the reader
   *  moving, and must be left alone — including the 40px nudge someone makes to
   *  read a clipped line, which a plain `isAtBottom` gate would have yanked back.
   *  `owed` latches the follow across ticks: the growth and the chance to act on
   *  it can land in different frames (a selection, a gesture still in flight), and
   *  a missed edge must not become a permanently short view.
   *
   *  Growth the READER caused is not followed either, and that is a deliberate
   *  product decision, not an implementation detail: opening a collapsed tool run
   *  while parked at the bottom means "show me that output", so the view stays put
   *  and the ↓ arrow becomes the way back (the 2026-09-16 decision behind
   *  `syncArrow`). Recent real input inside the scroller is what tells the two
   *  apart — a click that grows the transcript lands a frame or two after the
   *  click, far inside the window.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevSh = el.scrollHeight;
    let prevTop = el.scrollTop;
    let owed = false;
    // Aggregate log (one line per 2s at most): a per-frame line during streaming
    // would be its own main-thread problem, and the useful signal is "how much
    // did the follower have to close, how often".
    let closes = 0;
    let maxGap = 0;
    let lastLog = 0;
    const step = () => {
      const sh = el.scrollHeight;
      const top = el.scrollTop;
      const grew = sh > prevSh + 0.5;
      const readerMoved = top < prevTop - 0.5;
      prevSh = sh;
      prevTop = top;
      if (readerMoved) owed = false;
      if (grew && isAtBottom.current) {
        // Who grew it: the reader's own click/key (leave it, the arrow answers) or
        // the app writing output (follow it).
        owed = Date.now() - lastUserInput.current >= FOLLOW_INPUT_QUIET_MS;
      }
      if (!owed) return;
      // Intent lost (wheel-up, a drag away, the arrow's own hide) ends it.
      if (!isAtBottom.current) { owed = false; return; }
      // Mid-gesture: let the fingers finish before touching scrollTop, or the
      // write lands inside their scroll and reads as the box fighting back.
      if (Date.now() - lastUserInput.current < FOLLOW_INPUT_QUIET_MS) return;
      if (selectionActive()) { noteSuppressedScroll(); return; }
      const gap = sh - top - el.clientHeight;
      if (gap <= 2) { owed = false; return; }
      el.scrollTop = sh;
      prevTop = el.scrollTop;
      owed = false;
      closes++;
      if (gap > maxGap) maxGap = gap;
      const now = Date.now();
      if (now - lastLog > 2000) {
        lastLog = now;
        console.log(`[scroll-follow:${sid8}] closed n=${closes} maxGap=${Math.round(maxGap)} sh=${Math.round(sh)} streaming=${isStreaming}`);
        closes = 0; maxGap = 0;
      }
    };
    // 2Hz always: the post-turn shapes (scrollbar track, font swap, decoded
    // image) each open the gap once, and one tick closes it.
    const timer = setInterval(step, 500);
    // Per-frame while streaming: text arrives every ~150ms, and half a second of
    // lag behind live output is visible as the view trailing the words.
    let raf = 0;
    if (isStreaming) {
      const loop = () => { step(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sid8, isStreaming, selectionActive, noteSuppressedScroll]);

  // Mark initial load done once Phase 2 completes for the first time.
  // This prevents force-scroll from firing on batch-refresh re-fetches
  // (which also set phase2Pending=true in useSessionHistory).
  // Note: don't require firstScrollDone — Phase 2 might return 0 messages
  // (new session, empty history). Without this, initialLoadDone stays false
  // forever, and every batch refresh force-scrolls the user to bottom.
  useEffect(() => {
    if (!phase2Pending && !initialLoadDone.current) {
      initialLoadDone.current = true;
    }
  }, [phase2Pending]);

  // ── Scroll-to-bottom: 2 paths ──
  //
  // Path A — IMMEDIATE: The very first scroll when messages arrive (before paint, zero flash).
  //          Also used for live streaming blocks (blocks.length changes need instant follow).
  //
  // Path B — DEBOUNCED: Everything else (Phase 2 data, sibling resizes, batch refreshes).
  //          All rapid changes batch into ONE scroll after 250ms of quiet.
  //          This eliminates the 6+ visible jumps from siblings loading independently.
  //
  // The core invariant: isAtBottom tracks USER INTENT (did they scroll up?), not geometry.
  // Resize-induced scroll events are suppressed (ignoreScrollUntil) so they can't corrupt it.

  // Shared debounced scroll — used by Phase 2, resizes, and batch refreshes
  // Update ref in useEffect (not render top-level) to be safe in concurrent mode —
  // abandoned render passes can mutate refs with uncommitted values.
  const phase2PendingRef = useRef(phase2Pending);
  useEffect(() => { phase2PendingRef.current = phase2Pending; }, [phase2Pending]);
  const debouncedScroll = useCallback((reason: string) => {
    const forceScroll = phase2PendingRef.current && !initialLoadDone.current && !onQuestionPageRef.current;
    if (!forceScroll && !isAtBottom.current) return;
    // Suppress resize-induced scroll events during debounce window
    ignoreScrollUntil.current = Date.now() + 350;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const el = containerRef.current;
      const force = phase2PendingRef.current && !initialLoadDone.current && !onQuestionPageRef.current;
      if (!el || (!force && !isAtBottom.current)) {
        if (!isAtBottom.current && !force) scrollLog('debounced', `SKIP(${reason})`, el);
        return;
      }
      if (selectionActive()) {
        scrollLog('debounced', `SKIP-SELECTION(${reason})`, el);
        noteSuppressedScroll();
        return;
      }
      el.scrollTop = el.scrollHeight;
      isAtBottom.current = true;
      scrollLog('debounced', `SCROLL(${reason}${force ? ',forced' : ''})`, el);
    }, 250);
  }, [scrollLog, selectionActive, noteSuppressedScroll]);

  // Path A-3: LOAD-WINDOW BOTTOM PIN (inc-1786654438334 — "opens normal, jumps
  // up, then jumps back down while loading"). During initial load, content
  // keeps growing AFTER the pre-paint forced scroll (Phase 2 replace, images,
  // lazy row heights, sibling panels): scrollTop stays numerically fixed
  // (overflow-anchor:none) so the view visibly rides UP mid-history for the
  // 170-900ms until the debounced pass catches it. Kill the intermediate
  // frames: while the initial load hasn't settled and nobody has touched the
  // scroller, pin scrollTop to bottom EVERY FRAME. Self-terminates when the
  // load settles, and for good the moment the human scrolls (user intent wins).
  useEffect(() => {
    let raf: number | null = null;
    const started = Date.now();
    let quietFrames = 0;
    let lastSh = 0;
    let frame = 0;
    // User-INPUT authority: during load, isAtBottom can be corrupted by our
    // own write echoes (a scroll event delivered after content grew reads
    // gap>80 → flips it false with no user action; measured as the parked
    // 224px gap that IMG-FIX then refused to close). Until real input arrives
    // the pin owns the bottom; after it, the standard follow-bottom paths do.
    // The pin must STOP on that input, not keep running gated on isAtBottom:
    // a wheel-up flips isAtBottom=false, but the same frame's scroll event
    // lands inside the near-bottom band and flips it back, so the next frame
    // re-pinned. On a trackpad (tens of px per tick) the reader could never
    // leave the bottom until the fetch settled — 15s on a slow remote host
    // ("can't scroll up, it flickers and stays at the bottom until loaded").
    const el0 = containerRef.current;
    let stopped = false;
    // Wheel-down at the bottom is not reading intent; only an upward tick is.
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stop(); };
    function stop() {
      stopped = true;
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      el0?.removeEventListener('wheel', onWheel);
      el0?.removeEventListener('touchmove', stop);
      el0?.removeEventListener('pointerdown', stop);
      el0?.removeEventListener('keydown', stop);
    }
    el0?.addEventListener('wheel', onWheel, { passive: true });
    el0?.addEventListener('touchmove', stop, { passive: true });
    el0?.addEventListener('pointerdown', stop, { passive: true }); // scrollbar drag
    el0?.addEventListener('keydown', stop, { passive: true });
    const pin = () => {
      raf = null;
      if (stopped) return;
      // A question page owns its landing (a reload restores it): never pin it.
      if (onQuestionPageRef.current) { stop(); return; }
      frame++;
      const el = containerRef.current;
      if (el && !selectionActive()) {
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 2) {
          el.scrollTop = el.scrollHeight;
          isAtBottom.current = true; // heal echo corruption
          ignoreScrollUntil.current = Date.now() + 120;
        }
      }
      // Exit once: Phase 2 truly completed (phase2PendingRef — NOT
      // initialLoadDone, which is marked on the first commit before the
      // fetch even flags pending) AND geometry quiet ~1s AND every image is
      // decoded (late image loads reopened a 224px gap 4s after quiet).
      // Absolute 15s lifetime caps the raf loop.
      const sh = el?.scrollHeight ?? 0;
      quietFrames = sh === lastSh ? quietFrames + 1 : 0;
      lastSh = sh;
      let imagesPending = false;
      if (el && frame % 15 === 0) {
        for (const img of el.querySelectorAll('img')) {
          if (!(img as HTMLImageElement).complete) { imagesPending = true; break; }
        }
      }
      const settled = !phase2PendingRef.current && quietFrames >= 60 && !imagesPending;
      if (settled || Date.now() - started > 15_000) { stop(); return; }
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return stop;
  }, [sessionId, selectionActive]);

  // Path A-0: User just sent a message — force follow-bottom so the sent message
  // and subsequent streaming response are visible. Runs before A-1 so isAtBottom
  // is already true when the content-change scroll fires.
  // A send from the comment card is the exception: the reader is up at the
  // passage with the card, and the answer arrives in the card, so the timeline
  // stays where it is (the flag is armed by the card's send, consumed here).
  const cardSendHold = useRef(false);
  useLayoutEffect(() => {
    const len = optimisticMessages?.length ?? 0;
    if (len > prevOptimisticLen.current) {
      if (cardSendHold.current) {
        cardSendHold.current = false;
      } else {
        isAtBottom.current = true;
        setShowScrollArrow(false);
      }
    }
    prevOptimisticLen.current = len;
  }, [optimisticMessages?.length]);

  // 送达标记和等待提示会在后续帧增高内容，保持原本贴底的阅读位置。
  useEffect(() => {
    if (!isAtBottom.current || !(optimisticMessages?.length)) return;
    const el = containerRef.current;
    if (!el) return;
    if (selectionActive()) { noteSuppressedScroll(); return; }
    el.scrollTop = el.scrollHeight;
  }, [optimisticMessages, phase, selectionActive, noteSuppressedScroll]);

  // Path A-1: Content changes — immediate scroll, before paint (useLayoutEffect)
  // Fires on every messages/loading change. This is NOT the source of jumps — jumps come
  // from sibling resizes (handled by debounced Path B-2). Content changes are infrequent
  // (Phase 1, Phase 2, batch refresh) and each one correctly scrolls to the new bottom.
  //
  // CRITICAL: While phase2Pending, ALWAYS scroll regardless of isAtBottom. Phase 2 is a data
  // correction (streams→full history). A tiny accidental trackpad touch between Phase 1 and
  // Phase 2 can set isAtBottom=false, then Phase 2 arrives with 10x more content and we're
  // stuck at the top. During initial loading, user hasn't meaningfully scrolled up.
  useLayoutEffect(() => {
    if (!containerRef.current || messages.length === 0) return;
    const forceScroll = phase2Pending && !initialLoadDone.current && !onQuestionPageRef.current; // initial load only
    if (!forceScroll && !isAtBottom.current) return;
    // Selection wins over follow-bottom even on forced initial-load scrolls —
    // the user selecting means they're reading, not waiting for the bottom.
    if (selectionActive()) { noteSuppressedScroll(); return; }
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
    isAtBottom.current = true;
    firstScrollDone.current = true;
    scrollLog('content', `SCROLL(msgs=${messages.length}${forceScroll ? ',forced' : ''})`, containerRef.current);
  }, [loading, messages, phase2Pending, scrollLog, selectionActive, noteSuppressedScroll]);

  // Path A-2: Streaming — immediate scroll for new blocks (live output needs instant follow)
  useEffect(() => {
    if (!isAtBottom.current || blocks.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
    scrollRafId.current = requestAnimationFrame(() => {
      scrollRafId.current = null;
      if (!el || !isAtBottom.current) return;
      if (selectionActive()) { noteSuppressedScroll(); return; }
      el.scrollTop = el.scrollHeight;
      isAtBottom.current = true;
    });
  }, [blocks.length, selectionActive, noteSuppressedScroll]);

  // Path B-1: Content replacement (Phase 2, batch refresh) — debounced
  // The isAtBottom check is sufficient — Path A-1 already handles the immediate scroll.
  // This is a redundant safety net that fires 250ms later.
  useEffect(() => {
    if (!isAtBottom.current) return;
    debouncedScroll(`msgs=${messages.length}`);
  }, [messages, debouncedScroll]);

  // Path C: Image load corrector — fixes scrollHeight growth from async image loading.
  // Images in messages load asynchronously — each goes from 0px to natural height, growing
  // scrollHeight by thousands of px while scrollTop stays fixed. No other layer detects this
  // (messages ref didn't change, container didn't resize). Confirmed root cause of the
  // "goes to middle then comes back" jump (DRIFT logs showed +18,937px gaps).
  //
  // Uses capture-phase 'load' listener — img load events don't bubble, but capture catches
  // them. Fires only when an image actually finishes loading. Zero polling, zero overhead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onLoad = (e: Event) => {
      if (!isAtBottom.current) return;
      if (selectionActive()) { noteSuppressedScroll(); return; }
      const target = e.target as HTMLElement;
      if (target.tagName !== 'IMG') return;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap > 2) {
        el.scrollTop = el.scrollHeight;
        console.log(`[scroll:${sid8}] IMG-FIX gap=${gap}→0 src=${(target as HTMLImageElement).src.slice(-40)}`);
      }
    };
    el.addEventListener('load', onLoad, true); // capture phase — img load doesn't bubble
    return () => el.removeEventListener('load', onLoad, true);
  }, [sid8, selectionActive, noteSuppressedScroll]);

  // Path B-2: Container resize (sibling components loading) — debounced
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const newHeight = el.clientHeight;
      const delta = newHeight - prevHeight;
      if (delta !== 0) {
        scrollLog('resize', `delta=${delta > 0 ? '+' : ''}${Math.round(delta)}`, el);
        prevHeight = newHeight;
      }
      // A SHRINK while following is closed right here, before paint. The
      // composer is a flow sibling below this scroller, so every time it grows
      // (textarea autogrow, the recap tip landing after a turn, a note opening)
      // the scroller loses exactly that height off its bottom edge, and the
      // browser keeps scrollTop where it was: the newest rows would sit under
      // the composer for the debounce window (250ms, a visible flash on every
      // typed newline). ResizeObserver callbacks run after layout and before
      // paint, so a pin here is never seen. The debounced pass below stays as
      // the net for growth that lands in several steps.
      //
      // Gates: only while following, never over a selection, and only for the
      // gap the shrink itself opened (`shrinkOwed`, accumulated across shrinks
      // that land in quick succession). A larger gap means the transcript grew
      // at the same time, and whether to follow THAT is the geometric follower's
      // decision above (it refuses growth the reader caused, e.g. a click that
      // expanded a tool run); this pin never overrides it. No input-quiet gate
      // here: a shrink is the composer's doing, never the transcript's, and
      // "wheel to the end, start typing" must stay frame-perfect. A box that
      // measured 0 (a column the narrow layout hides) has nothing to pin.
      const closeShrinkGap = () => {
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap <= 2) { shrinkOwed.current = 0; return; }
        if (gap <= shrinkOwed.current + 2) el.scrollTop = el.scrollHeight;
      };
      if (delta < 0 && newHeight > 0 && isAtBottom.current && !selectionActive()) {
        shrinkOwed.current += -delta;
        closeShrinkGap();
        // Chromium keeps that write. WebKit reads it back correctly and then
        // REVERTS it at the frame's commit (the next scroll event carries the
        // pre-shrink position again: async scrolling overwrites a main-thread
        // write made in the ResizeObserver phase), while a write one frame later
        // sticks. So chase for a few frames, the way the composer-prefill jump
        // does, and stop the moment the reader is not following any more.
        if (shrinkChaseRaf.current !== null) cancelAnimationFrame(shrinkChaseRaf.current);
        let frames = 0;
        const chase = () => {
          shrinkChaseRaf.current = null;
          if (!isAtBottom.current || selectionActive()) { shrinkOwed.current = 0; return; }
          closeShrinkGap();
          if (frames++ < 3) shrinkChaseRaf.current = requestAnimationFrame(chase);
          else shrinkOwed.current = 0;
        };
        shrinkChaseRaf.current = requestAnimationFrame(chase);
      }
      debouncedScroll('resize');
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (shrinkChaseRaf.current !== null) cancelAnimationFrame(shrinkChaseRaf.current);
    };
  }, [debouncedScroll, scrollLog, selectionActive]);

  // Click handler for the scroll-to-bottom arrow
  const handleScrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottom.current = true;
    setShowScrollArrow(false);
  }, []);

  // Parent-requested jump to the bottom (a quote-to-ask prefill). Deliberately
  // NOT gated on isAtBottom or the selection guard: those protect the AUTOMATIC
  // follow paths from yanking a reader around, but this is the user's own
  // action — they clicked "Ask about this", so the composer is where they are
  // now, and the timeline must show the end of the conversation. Chased across
  // a few frames because the prefill grows the composer (multi-line quote),
  // which shrinks this scroller a frame or two later.
  useEffect(() => {
    if (!scrollToBottomNonce) return;
    let frames = 0;
    let raf = 0;
    const chase = () => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      isAtBottom.current = true;
      setShowScrollArrow(false);
      if (frames++ < 6) raf = requestAnimationFrame(chase);
    };
    raf = requestAnimationFrame(chase);
    return () => cancelAnimationFrame(raf);
  }, [scrollToBottomNonce]);

  // ── Deduplicate optimistic messages against persisted history ──
  //
  // handleBatchCompleted removes consumed messages outright (id-first, count
  // fallback). The remaining dedup handles edge cases where persisted history
  // grows and matches a pending/delivered msg the events missed.
  //
  // Rules live in optimistic-dedup.ts (pure, unit-tested): id-exact via
  // echo-claim walnutMessageId (any scope), text-multiset within
  // messages[turnWatermark..]. On shrink (/compact rewrote the JSONL) the
  // helper scans the whole rewritten array (inc-1783472776601).
  const allOptimistic = optimisticMessages ?? [];
  // Sticky consumption: dedup is a per-render DISPLAY filter over optimistic
  // state it doesn't own — durable removal normally comes from
  // handleBatchCompleted. When that event never fires (history refresh 502'd
  // during an SSH-down window), a match must still not resurface on a later
  // render after the watermark advances past the twin. Remember consumed
  // queueIds for the lifetime of this session view (cleared on session switch).
  const visibleOptimistic = allOptimistic.filter(m => !consumedQueueIds.current.has(m.queueId));
  const deduped = dedupeOptimisticMessages(visibleOptimistic, messages, turnWatermark.current,
    { historyFromStart: olderHidden === 0 && !olderWindowed });
  if (deduped.length !== visibleOptimistic.length) {
    const keptIds = new Set(deduped.map(m => m.queueId));
    for (const m of visibleOptimistic) {
      if (!keptIds.has(m.queueId)) consumedQueueIds.current.add(m.queueId);
    }
  }

  // GC notification: tell the owner (useSessionSend) which bubbles were
  // absorbed so its optimistic state doesn't grow unboundedly when the
  // batch-completed removal missed them (e.g. tempId race). Post-render —
  // parent setState during our render is illegal.
  // Deliberately NO deps array: consumedQueueIds is a ref mutated during
  // render (just above), so no dep could observe it — this must run after
  // EVERY render. notifiedConsumedIds makes it idempotent. "Fixing" the lint
  // by adding [onBatchCompleted] would silently stop bubble GC.
  useEffect(() => {
    if (!onBatchCompleted) return;
    const unnotified: string[] = [];
    for (const id of consumedQueueIds.current) {
      if (!notifiedConsumedIds.current.has(id)) {
        notifiedConsumedIds.current.add(id);
        unnotified.push(id);
      }
    }
    // count=0: id-only GC — removeBatchMessages must not fall back to
    // removing N delivered bubbles when none of these ids match.
    if (unnotified.length > 0) onBatchCompleted(0, unnotified);
  });

  // ── Assign blockIndex for non-deduped optimistic messages (set once, never updated) ──
  // Anchors are STABLE: blocks are append-only, so an index captured at send
  // time keeps pointing at the same block forever (reset only drops a fully
  // hidden array, clamping anchors to 0 — same visual position: top of the
  // next turn).
  // The launch prompt is the session's FIRST message, so it heads the
  // conversation (rendered above the persisted rows) instead of joining the live
  // timeline below them. It can arrive after the turn has streamed (a reload
  // mid-turn), and a transcript that never yields its row (a degraded read)
  // must not leave it pinned under the answer.
  const launchHead = deduped.filter(m => m.launch);
  const timelineOptimistic = launchHead.length > 0 ? deduped.filter(m => !m.launch) : deduped;
  for (const msg of timelineOptimistic) {
    if (!blockIndexMap.current.has(msg.queueId)) {
      blockIndexMap.current.set(msg.queueId, blocks.length);
    }
  }
  // Clean stale entries for messages no longer in optimistic state
  const dedupedIds = new Set(timelineOptimistic.map(m => m.queueId));
  for (const key of blockIndexMap.current.keys()) {
    if (!dedupedIds.has(key)) blockIndexMap.current.delete(key);
  }

  // ── Build interleaved timeline over VISIBLE blocks ──
  // hiddenBlocks (absorbed by history) don't render; visibility is decided
  // here, at render time, not by deleting state.
  const isResuming = !isStreaming && phase === 'IN_PROGRESS'
    && deduped.length > 0;
  const timeline = buildTimeline(blocks, timelineOptimistic, blockIndexMap.current, isStreaming, isResuming, hiddenBlocks);

  // Prepare both render partitions together so a persisted tool run can absorb
  // the unpersisted run at the streaming boundary instead of producing two rows.
  // MONOTONIC render window (inc-1786553756848 + the flash regression it
  // caused): the window is a TAIL slice, so message growth slides it forward
  // and evicts rows from the TOP — scrollHeight collapses by thousands of px
  // under the reader (teleport class). The first fix pinned the start only
  // while !isAtBottom — but that read a scroll-event-mutated ref DURING
  // render, so hovering near the bottom made the window oscillate
  // pin↔release every few renders: rows unmounted/remounted in bursts
  // ("full page → half page, text gone and back" flashing, 03:21 teleports
  // dTop=-8871/-10544 with atBot=true). Rule now: once a row is rendered it
  // STAYS rendered until session switch — the start index only ratchets
  // DOWN (Show-earlier clicks, backfill shifts). No isAtBottom involvement,
  // no render-time oscillation, nothing ever evicts above the reader.
  // Bounded by messages held (lazy tail = 400) per session view.
  // MEMOIZED history-parts pass (whale-session lag fix): this walk — and
  // crucially the OBJECT IDENTITIES it mints (part.memberMsgs arrays, the
  // thinking-merge `{...m}` clones) — must be stable across streaming frames.
  // The 150ms text-delta flush re-renders this component; before memoization
  // it rebuilt every part, so every memoized child (SessionMessage,
  // MergedHistoryToolRun) saw fresh props and re-rendered the whole
  // conversation — the measured 5-32s slow commits on 20K-event sessions.
  // Ref note: renderWindowStart is written inside the memo (a render-phase
  // ratchet, same as before); every write path to it is triggered by a dep
  // change (messages / truncationOffset), so the memo can never serve a
  // visibleStart computed from a stale ratchet.
  // The stack's root page windows over root rows (N9): the raw tail it needs to
  // hold that many of them, so the marks on earlier root answers stay reachable.
  // Read through a ref: the key function changes with every optimistic row, and
  // re-running this memo rebuilds every part (see above). A persisted row's key
  // depends only on the rows and the anchors, which the deps carry.
  const rootPageWindow = stackMode && currentKey === ROOT_THREAD_KEY;
  const rowThreadKeyRef = useRef(rowThreadKey);
  rowThreadKeyRef.current = rowThreadKey;
  const windowAnchors = rootPageWindow ? threadsApi.anchors : null;
  const { historyParts, hiddenCount } = useMemo(() => {
    const want = INITIAL_RENDER_LIMIT + truncationOffset;
    const keyOf = rowThreadKeyRef.current;
    const limit = rootPageWindow
      ? pageWindowLimit(messages.length, (i) => keyOf(messages[i].msgId ?? messages[i].walnutMessageId), ROOT_THREAD_KEY, want)
      : want;
    const window = computeRenderWindow(
      messages,
      limit,
      { start: renderWindowStart.current, anchor: renderWindowAnchor.current },
    );
    const visibleStart = window.start;
    renderWindowStart.current = visibleStart;
    renderWindowAnchor.current = window.anchor;
    const visibleMessages = messages.slice(visibleStart);
    const parts: HistoryPart[] = [];
    let historyRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
    let historyRunSeeded = false;
    let systemRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
    const pushHistoryStretch = (members: typeof historyRun, seeded: boolean) => {
      if (members.some(({ m }) => (m.tools?.length ?? 0) > 0)) {
        parts.push({ kind: 'run', members, memberMsgs: members.map(({ m }) => m), seeded });
      } else if (members.length > 0) {
        // Reasoning with no tool around it is one "Thinking ›" row, not a run
        // with an empty phrase.
        parts.push({ kind: 'msg', m: mergeThinkingOnly(members.map(({ m }) => m)), globalIndex: members[0].globalIndex });
      }
    };
    /** `ended` = a visible non-run message follows: trailing thinking-only rows
     *  led to THAT message (the parser has not merged them into it yet) and split
     *  off as its "Thinking ›" row; at history's tail they stay with the run,
     *  which the live stream continues. */
    const flushHistoryRun = (ended: boolean) => {
      const split = ended ? trailingThinkingOnlyStart(historyRun.map(({ m }) => m)) : historyRun.length;
      pushHistoryStretch(historyRun.slice(0, split), historyRunSeeded);
      pushHistoryStretch(historyRun.slice(split), false);
      historyRun = [];
      historyRunSeeded = false;
    };
    const flushSystemRun = () => {
      if (systemRun.length === 1) {
        parts.push({ kind: 'msg', ...systemRun[0] });
      } else if (systemRun.length > 1) {
        parts.push({ kind: 'system-run', members: systemRun, systemMembers: systemRun.map(({ m }) => systemGroupMemberFromHistory(m)) });
      }
      systemRun = [];
    };
    for (let i = 0; i < visibleMessages.length; i++) {
      const m = visibleMessages[i];
      const globalIndex = visibleStart + i;
      if (forkBoundaryIndex != null && globalIndex === forkBoundaryIndex) {
        flushHistoryRun(true);
        flushSystemRun();
      }
      if (m.role === 'system') {
        flushHistoryRun(true);
        systemRun.push({ m, globalIndex });
        continue;
      }
      flushSystemRun();
      // A thinking-only message rides the run like a tool-only one: the parser
      // merges reasoning into the message of the block it led to, so a row that
      // is ONLY thinking is a half-written message read mid-turn — inside the run
      // it sits where the stream showed it, instead of splitting "Ran 3 commands"
      // into three rows (flushHistoryRun hands trailing ones to what follows).
      if (isToolOnlyMessage(m) || isThinkingOnlyMessage(m)) {
        historyRun.push({ m, globalIndex });
        continue;
      }
      flushHistoryRun(true);
      // A message whose own thinking follows a thinking-only part (a run that
      // never reached a tool) absorbs it, so the reasoning before an answer is
      // one "Thinking ›" row above the prose. Never merge across the fork
      // divider (it renders inside the second part).
      const prevPart = parts[parts.length - 1];
      const prevIsThinkingOnly = prevPart?.kind === 'msg' && isThinkingOnlyMessage(prevPart.m);
      const atForkDivider = forkBoundaryIndex != null && globalIndex === forkBoundaryIndex;
      let msg = m;
      if (prevIsThinkingOnly && !atForkDivider
        && m.role === 'assistant' && (m.thinking ?? '').trim()) {
        msg = { ...m, thinking: `${prevPart.m.thinking}\n\n${m.thinking}` };
        parts.pop();
      }
      if (isTextPlusMergeableTools(msg)) {
        // CLI content order is prose first, tool_use after. Render the prose as
        // its own part and dissolve the tools FORWARD into the next run so a
        // text-carrying message no longer splits two adjacent runs apart.
        parts.push({ kind: 'msg', m: msg, globalIndex, suppressTools: true });
        historyRun.push({ m: { ...msg, text: '', thinking: undefined }, globalIndex });
        historyRunSeeded = true;
        continue;
      }
      parts.push({ kind: 'msg', m: msg, globalIndex });
    }
    flushHistoryRun(false);
    flushSystemRun();
    return { historyParts: parts, hiddenCount: visibleStart };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowThreadKeyRef: see above; windowAnchors stands for it
  }, [messages, truncationOffset, forkBoundaryIndex, rootPageWindow, windowAnchors]);
  // What `Show N earlier` counts: on the root page only root rows (N9), since
  // the rows of questions above it render on their own pages.
  const hiddenOnPage = useMemo(() => {
    if (!rootPageWindow) return hiddenCount;
    const keyOf = rowThreadKeyRef.current;
    return pageRowsBefore(hiddenCount, (i) => keyOf(messages[i].msgId ?? messages[i].walnutMessageId), ROOT_THREAD_KEY);
  }, [rootPageWindow, hiddenCount, messages, windowAnchors]);

  // ── Stack page: ONE question's slice of the SAME parts ──────────────────────
  // A stack page renders no rows of its own. It filters the parts the linear view
  // would render and hands them to the same renderer, which is why merged tool
  // runs, thinking rows, envelopes, optimistic bubbles and the live stream all
  // behave identically inside a question. Building a second pipeline here is how
  // this feature would quietly lose absorption and the working indicator.
  const partThreadKey = useCallback((part: HistoryPart): string => {
    const first = part.kind === 'msg' ? part.m : part.members[0].m;
    return rowThreadKey(first.msgId ?? first.walnutMessageId);
  }, [rowThreadKey]);

  // Pre-group once for both boundary detection and streaming rendering.
  const groupedBlocks = groupStreamingBlocks(blocks, hiddenBlocks);
  const groupedByIndex = new Map<number, GroupedStreamItem>();
  for (const g of groupedBlocks) {
    if (g.kind === 'task-group') groupedByIndex.set(g.index, g);
  }
  // Every subagent-lane block is consumed — it renders inside its Agent box
  // when that box is open, and nowhere at all when the anchor is hidden or
  // gone (the ledger + transcript own the run; see stream/group-blocks.ts).
  const consumedBlockIndices = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    if (isLaneChild(blocks[i])) consumedBlockIndices.add(i);
  }
  // Every running agent's lane goes to the Background tasks panel's live-lane
  // registry, anchor visible or not: a background agent's tool_call is absorbed by
  // history seconds after the spawn while the agent runs on, and its reader must
  // still be the stream, not a fetch. Published from an effect (never during
  // render); the store swallows empty→empty publishes.
  const streamLanes = collectLanes(blocks);
  useEffect(() => {
    if (!sessionId) return;
    const renderers = new Map<string, () => ReactNode>();
    for (const [rootId, lane] of streamLanes) {
      const anchor = lane.anchor;
      if (!anchor || streamAgentSettled(anchor)) continue;
      renderers.set(rootId, () => (
        <StreamingLane taskBlock={anchor} childBlocks={lane.children} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
      ));
    }
    setLiveLanes(sessionId, renderers);
    // The panel's Command rows read their Bash tool call and output from here.
    setToolSource(sessionId, { blocks, messages });
  });
  useEffect(() => () => {
    if (!sessionId) return;
    setLiveLanes(sessionId, new Map());
    setToolSource(sessionId, EMPTY_TOOL_SOURCE);
  }, [sessionId]);
  // A burst of Agent spawns (parallel tool_use blocks, or spawns with nothing but
  // lane traffic between them) is ONE `N running tasks` chip in the chat — never a
  // row per agent (the Background tasks panel lists them).
  const agentChipStart = new Map<number, number[]>();
  const agentChipMember = new Set<number>();
  {
    let open: number[] | null = null;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.kind === 'block') {
        const g = groupedByIndex.get(item.index);
        if (g && g.kind === 'task-group') {
          if (open) { open.push(i); agentChipMember.add(i); } else { open = [i]; agentChipStart.set(i, open); }
          continue;
        }
        if (consumedBlockIndices.has(item.index)) continue;
      }
      if (isTransparentStreamItem(item)) continue;
      open = null;
    }
  }

  /** What ends a run, for trailingThinkingStart: the block itself, 'other' for a
   *  visible row that is not a block (an optimistic user bubble, an Agent chip),
   *  undefined when nothing visible follows (the live tail). */
  const runEnder = (item: TimelineItem | undefined): StreamingBlock | 'other' | undefined => {
    if (!item || item.kind === 'indicator') return undefined;
    if (item.kind !== 'block') return 'other';
    return groupedByIndex.get(item.index)?.kind === 'task-group' ? 'other' : item.block;
  };
  /** A DOM-null item: it neither renders nor ends a run. A consumed lane block
   *  renders nowhere (its Agent card owns it); a group anchor is a visible row. */
  const isSilentStreamItem = (item: TimelineItem): boolean =>
    isTransparentStreamItem(item)
    || (item.kind === 'block' && consumedBlockIndices.has(item.index) && !groupedByIndex.has(item.index));

  // The live turn's first blocks continue history's last run across the
  // history/stream boundary. Trailing reasoning that led to whatever ended the
  // scan stays in the stream (it becomes its own row there, the way the
  // persisted message will render it).
  const leadingStreamRunIndices: number[] = [];
  {
    let ender: TimelineItem | undefined;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (isSilentStreamItem(item)) continue;
      if (isMergeableStreamItem(item, consumedBlockIndices, groupedByIndex)) {
        leadingStreamRunIndices.push(i);
        continue;
      }
      ender = item;
      break;
    }
    const members = leadingStreamRunIndices.map((i) => (timeline[i] as TimelineItem & { kind: 'block' }).block);
    leadingStreamRunIndices.length = trailingThinkingStart(members, runEnder(ender));
  }
  const lastHistoryPart = historyParts[historyParts.length - 1];
  const boundaryHistoryRun = lastHistoryPart?.kind === 'run' ? lastHistoryPart : null;
  // A fork divider is at this cross-source boundary when the fork's first
  // message has not persisted yet, so its index is one past history's tail.
  const boundaryHasForkDivider = forkBoundaryIndex != null
    && forkBoundaryIndex === messages.length;
  const mergeBoundary = boundaryHistoryRun != null
    && !boundaryHasForkDivider
    && leadingStreamRunIndices.length > 0;
  const boundaryStreamIndices = mergeBoundary ? new Set(leadingStreamRunIndices) : new Set<number>();
  const renderedHistoryParts = mergeBoundary ? historyParts.slice(0, -1) : historyParts;
  let lastAssistantTextIndex = -1;
  for (const part of historyParts) {
    if (part.kind === 'msg'
      && part.m.role === 'assistant'
      && (part.m.text ?? '').trim()) {
      lastAssistantTextIndex = part.globalIndex;
    }
  }

  // One pass folds finished tools AND the thinking that led to them into runs
  // (the CLI emits reasoning and the call it leads to as separate blocks; a turn
  // that thinks before every call must not read "Thinking › / Ran a command ›"
  // per step). A stretch that reached a tool is a tool run (runStart); one that
  // is only reasoning is a "Thinking ›" row (thinkingRunStart). Reasoning at the
  // end of a run that led to prose, an Agent or a plan card splits off into its
  // own row (trailingThinkingStart); at the live tail it stays and pulses.
  // DOM-null items between members don't split either; any visible non-member does.
  const runStart = new Map<number, number[]>();
  const runMember = new Set<number>();
  const thinkingRunStart = new Map<number, number[]>();
  const thinkingRunMember = new Set<number>();
  {
    let cur: number[] = [];
    const pushStretch = (indices: number[]) => {
      if (indices.length === 0) return;
      const hasTool = indices.some((k) => {
        const t = timeline[k];
        return t.kind === 'block' && t.block.type === 'tool_call';
      });
      const start = hasTool ? runStart : thinkingRunStart;
      const member = hasTool ? runMember : thinkingRunMember;
      start.set(indices[0], indices);
      for (let k = 1; k < indices.length; k++) member.add(indices[k]);
    };
    const flushRun = (ender: TimelineItem | undefined) => {
      const members = cur.map((i) => (timeline[i] as TimelineItem & { kind: 'block' }).block);
      const split = trailingThinkingStart(members, runEnder(ender));
      pushStretch(cur.slice(0, split));
      pushStretch(cur.slice(split));
      cur = [];
    };
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (boundaryStreamIndices.has(i)) continue;
      if (isSilentStreamItem(item)) continue;
      if (isMergeableStreamItem(item, consumedBlockIndices, groupedByIndex)) {
        cur.push(i);
      } else {
        flushRun(item);
      }
    }
    flushRun(undefined);
  }

  // System notices have their own grouping pass: skip DOM-null blocks without
  // letting them split a run, but stop at every visible non-system item.
  const systemRunStart = new Map<number, number[]>();
  const systemRunMember = new Set<number>();
  {
    let cur: number[] = [];
    const flushRun = () => {
      if (cur.length >= 2) {
        systemRunStart.set(cur[0], [...cur]);
        for (let k = 1; k < cur.length; k++) systemRunMember.add(cur[k]);
      }
      cur = [];
    };
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (boundaryStreamIndices.has(i)
        || isTransparentStreamItem(item)
        || (item.kind === 'block' && consumedBlockIndices.has(item.index))) {
        continue;
      }
      if (item.kind === 'block' && item.block.type === 'system') {
        cur.push(i);
      } else {
        flushRun();
      }
    }
    flushRun();
  }

  // Stream tail — the item still receiving tokens when streaming. Skips DOM-null
  // items (transparent, blocks of a subagent lane, which never render flat) so a
  // trailing signature-only artifact can't steal "liveness" from the real tail
  // block. The working indicator rides the tail of every live turn and must not
  // steal it either. `streamTailIdx` counts boundary-merged members (the run
  // that continues history needs to know when ITS tail is the live one);
  // `lastVisibleTimelineIdx` is the tail among the items the stream panel
  // renders itself.
  let streamTailIdx = -1;
  let lastVisibleTimelineIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === 'indicator' || isSilentStreamItem(item)) continue;
    if (streamTailIdx < 0) streamTailIdx = i;
    if (boundaryStreamIndices.has(i)) continue;
    lastVisibleTimelineIdx = i;
    break;
  }
  // Is a run's tail (`tailIdx`, its own last member) the reasoning still
  // streaming? Only then does the run's row pulse: a finished tool at the tail
  // is settled, and the working indicator already says the turn is live.
  const isThinkingTail = (tailIdx: number): boolean => {
    if (!isStreaming || tailIdx < 0 || tailIdx !== streamTailIdx) return false;
    const tail = timeline[tailIdx];
    return tail.kind === 'block' && tail.block.type === 'thinking';
  };
  /** The blocks of a run's timeline indices (every index a run pass collected
   *  passed isMergeableStreamItem, so this only narrows the type). */
  const runMembersOf = (indices: readonly number[]): StreamRunMember[] =>
    indices.flatMap((k): StreamRunMember[] => {
      const t = timeline[k];
      return t.kind === 'block' && isRunMemberBlock(t.block) ? [t.block] : [];
    });

  const hasContent = messages.length > 0 || timeline.length > 0 || isStreaming
    || deduped.length > 0;

  // Suppressed whenever the session has visible content — see history-unavailable.ts.
  const historyUnavailable = visibleHistoryUnavailable(error, hasContent);

  /** Finished live turns and their pages (recorded below, read above it). */
  const turnSegmentsRef = useRef<readonly StreamTurnSegment[]>([]);

  /** Question of an optimistic bubble: its pre-assigned uuid, when it has one. */
  const optimisticThreadKey = (m: OptimisticMessage): string =>
    rowThreadKey(m.msgId ?? m.userUuid ?? m.walnutMessageId);

  /**
   * Where the LIVE stream belongs: the turn of the newest user row, optimistic ones
   * included (the row that started this turn may not have persisted yet). The
   * blocks and the working indicator therefore show on exactly one page (the
   * question the model is answering), and a reader on another page learns about
   * the reply from that question's row (`Answering…`, then the unread dot).
   * A QUEUED row (pending / received) never claims the stream while a turn runs:
   * three Asks sent during one answer would otherwise pull that answer onto the
   * last one's page (C49). With nothing running, the oldest queued row is next.
   */
  // The turn's own tag wins over every guess below: the first text block of the
  // live turn (blocks after the last finished turn) opening with `[Q<n>]`.
  const liveTurnStart = turnSegmentsRef.current.length > 0 ? turnSegmentsRef.current[turnSegmentsRef.current.length - 1].end : 0;
  const liveTagKey = hasQuestions ? tagKeyOfBlocks(blocks, liveTurnStart, blocks.length, keyBySeq) : null;
  const liveStreamKey = (() => {
    if (!hasQuestions) return ROOT_THREAD_KEY;
    if (liveTagKey !== null) return liveTagKey;
    let nextQueued: OptimisticMessage | undefined;
    for (let i = deduped.length - 1; i >= 0; i--) {
      const m = deduped[i];
      if (m.role !== 'user' || m.status === 'failed') continue;
      if (m.status === 'pending' || m.status === 'received') { nextQueued = m; continue; }
      return optimisticThreadKey(m);
    }
    if (nextQueued && !isStreaming) return optimisticThreadKey(nextQueued);
    return threadTree.latestKey;
  })();
  // Both views with questions track which question each turn's output belongs
  // to: Tree Mode to put it on the right page, Conversation Mode for the card.
  const trackTurns = stackMode || convMode;
  const streamThreadKey = trackTurns ? liveStreamKey : ROOT_THREAD_KEY;
  const streamVisible = !stackMode || streamThreadKey === currentKey;
  // Finished turns keep their page until the transcript absorbs them. The CLI
  // answers delivered rows in order, one turn per delivery (rows delivered in the
  // same render are one batch), so a turn that ends belongs to the OLDEST delivery
  // not yet matched to a turn; with none known (mounted mid-turn), the newest
  // delivered bubble, else the newest persisted user row. Render-phase refs, idempotent: an owner is taken only when
  // a new segment is actually recorded.
  const turnBook = useRef<TurnBook>(newTurnBook());
  const turnSegments = turnSegmentsRef;
  if (trackTurns) {
    const book = turnBook.current;
    // Keyed by the row's own identity, never the queue id: a bubble's queue id
    // changes when the server acks it or the queue is rehydrated, and counting one
    // delivery twice shifts every later answer one page over.
    const rowIdOf = (m: OptimisticMessage) => m.userUuid ?? m.walnutMessageId ?? m.queueId;
    const fresh: OptimisticMessage[] = [];
    for (const m of deduped) {
      if (m.role !== 'user' || m.status !== 'delivered' || book.seen.has(rowIdOf(m))) continue;
      book.seen.add(rowIdOf(m));
      fresh.push(m);
    }
    const entries = deliveryEntries(fresh.map((m) => ({ key: optimisticThreadKey(m), uuid: !!m.userUuid })));
    const prev = turnSegments.current;
    const next = recordTurnSegments(prev, completedLen, blocks.length, null);
    const completing = next !== prev && next.length > 0 && next[next.length - 1].end === completedLen && completedLen > 0;
    const wasMounted = book.mounted;
    let owner = trackTurn(book, entries, isStreaming, completing) ?? null;
    if (completing) {
      if (owner === null && wasMounted) {
        for (let i = deduped.length - 1; i >= 0 && owner === null; i--) {
          const m = deduped[i];
          if (m.role === 'user' && m.status === 'delivered') owner = optimisticThreadKey(m);
        }
        for (let i = messages.length - 1; i >= 0 && owner === null; i--) {
          const m = messages[i];
          if (m.role === 'user') owner = rowThreadKey(m.msgId ?? m.walnutMessageId);
        }
      }
      turnSegments.current = recordTurnSegments(prev, completedLen, blocks.length, owner);
      // The owner's head id, never its key (a key carries the quoted passage).
      log.info('threads', 'turn ended', {
        sessionId,
        owner: owner === null ? 'unknown' : owner === ROOT_THREAD_KEY ? 'main' : 'question',
        ...(owner ? { headId: threadTree.byKey.get(owner)?.headId ?? '' } : {}),
        end: completedLen, queued: book.queue.length,
      });
    } else {
      turnSegments.current = next;
    }
  }
  useEffect(() => {
    turnSegments.current = [];
    turnBook.current = newTurnBook();
  }, [sessionId]);

  /** The page a live block renders on: its finished turn's tag, else that turn's
   *  recorded owner, else the live turn's key (tag first, see liveStreamKey). */
  const pageKeyOfBlock = (index: number): string => {
    const segs = turnSegments.current;
    let from = 0;
    for (const seg of segs) {
      if (index < seg.end) {
        const tagged = tagKeyOfBlocks(blocks, from, seg.end, keyBySeq);
        return tagged ?? blockPageKey(segs, index, streamThreadKey);
      }
      from = seg.end;
    }
    return streamThreadKey;
  };

  // The page's own rows: the SAME parts, filtered by row identity.
  const visibleHistoryParts = stackMode
    ? renderedHistoryParts.filter((part) => partThreadKey(part) === currentKey)
    : renderedHistoryParts;
  const boundaryRunVisible = !stackMode
    || (!!boundaryHistoryRun && partThreadKey(boundaryHistoryRun) === currentKey);

  // ── What every question surface reads, published to the panel (drawer too):
  // live states (queued / answering / failed), answers and questions per key.
  const threadStats = useMemo(
    () => (hasQuestions ? deriveThreadStats(messages, rowThreadKey) : null),
    [hasQuestions, messages, rowThreadKey],
  );
  // When a question's turn ENDS (the stream stops), it is answered now, even
  // before persisted history absorbs the reply: that clears `Answering…` and
  // dates the unread dot, so neither waits on (or hangs without) the refetch.
  const [streamEnds, setStreamEnds] = useState<ReadonlyMap<string, number>>(() => new Map());
  const streamKeyRef = useRef(liveStreamKey);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (isStreaming) streamKeyRef.current = liveStreamKey;
    else if (wasStreaming.current && hasQuestions && streamKeyRef.current !== ROOT_THREAD_KEY) {
      const key = streamKeyRef.current;
      setStreamEnds((m) => new Map(m).set(key, Date.now()));
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, liveStreamKey, hasQuestions]);
  useEffect(() => { setStreamEnds(new Map()); }, [sessionId]);

  // `deduped` is a fresh array every render: key the derivation on a string of
  // what it says about questions, or the publish below would loop the panel.
  const queuedSig = hasQuestions
    ? deduped.filter((m) => m.role === 'user' && !!m.userUuid)
      .map((m) => `${m.userUuid}:${m.status === 'failed' ? (m.parked ? 'parked' : 'failed') : m.status === 'delivered' ? 'processing' : 'pending'}`)
      .join('|')
    : '';
  const threadDerived = useMemo(() => {
    if (!threadStats) return EMPTY_DERIVED;
    const queued: Array<{ rowId: string; status: 'pending' | 'processing' }> = [];
    const turnEnds = new Map<string, 'ok' | 'error' | 'interrupted' | 'parked'>(threadStats.turnEnds);
    for (const entry of queuedSig ? queuedSig.split('|') : []) {
      const at = entry.lastIndexOf(':');
      const rowId = entry.slice(0, at);
      const status = entry.slice(at + 1);
      if (status === 'parked') turnEnds.set(rowId, 'parked');
      else if (status === 'pending') queued.push({ rowId, status });
      // Delivered: answering while a turn runs; once it ended, no longer live.
      else if (status === 'processing' && isStreaming) queued.push({ rowId, status });
    }
    const answeredAt = new Map(threadStats.answeredAt);
    for (const [key, at] of streamEnds) if (at > (answeredAt.get(key) ?? 0)) answeredAt.set(key, at);
    const streamingKey = isStreaming ? liveStreamKey : null;
    return {
      live: deriveThreadLiveStates({
        tree: threadTree, queued, streamingKey, turnEnds, hasAnswerAfter: (id) => threadStats.answered.has(id),
      }),
      answeredAt,
      lastAnswer: threadStats.lastAnswer,
      lastQuestion: threadStats.lastQuestion,
      answering: new Set(streamingKey && streamingKey !== ROOT_THREAD_KEY ? [streamingKey] : []),
    };
  }, [threadStats, queuedSig, isStreaming, liveStreamKey, threadTree, streamEnds]);
  const publishDerived = threadsApi.publishDerived;
  useEffect(() => { publishDerived(threadDerived); }, [publishDerived, threadDerived]);

  // Asked-from rows after each answer that has questions under it (spec 5.10).
  const askedGroups = useMemo(() => (stackMode ? askedFromGroups({
    tree: threadTree, currentKey, hiddenKeys: threadsApi.hiddenKeys, index: threadsApi.metaIndex,
    live: threadDerived.live, unreadKeys: threadsApi.unreadKeys, answeredAt: threadDerived.answeredAt,
    drafts: stack.draftPages,
  }) : null), [stackMode, threadTree, currentKey, threadsApi.hiddenKeys, threadsApi.metaIndex,
    threadDerived, threadsApi.unreadKeys, stack.draftPages]);
  const askedAfter = new Map<number, AskedFromRow[]>();
  if (askedGroups && askedGroups.size > 0) {
    let rows: AskedFromRow[] = [];
    visibleHistoryParts.forEach((part, i) => {
      const first = part.kind === 'msg' ? part.m : part.members[0].m;
      if (part.kind === 'msg' && first.role === 'user' && rows.length > 0 && i > 0) {
        askedAfter.set(i - 1, rows);
        rows = [];
      }
      const ids = part.kind === 'msg' ? [first.msgId ?? first.walnutMessageId] : part.members.map((x) => x.m.msgId ?? x.m.walnutMessageId);
      for (const id of ids) { const g = id ? askedGroups.get(id) : undefined; if (g) rows = [...rows, ...g]; }
    });
    if (rows.length > 0) askedAfter.set(visibleHistoryParts.length - 1, rows);
  }
  const openFromRow = useCallback((key: string) => stack.pushTo(key, 'asked-from'), [stack]);

  // ── The question map (always on screen in a session with questions) ──
  const [mapDoneOpen, setMapDoneOpen] = useState<ReadonlySet<string>>(() => new Set());
  const threadMap = useThreadMapLayout(containerRef, threadsApi.canAsk, {
    tree: threadTree,
    index: threadsApi.metaIndex,
    pins: pinsApi.pins,
    live: threadDerived.live,
    ...(stack.pending ? { pending: stack.pending } : {}),
    drafts: stack.drafts,
    currentKey: hasQuestions ? targetKey : null,
    doneGroupsOpen: mapDoneOpen,
  }, () => isAtBottom.current);
  const mapCounts = useMemo(
    () => (threadMap.shape ? threadCounts(threadTree, threadsApi.metaIndex, pinsApi.pins, threadDerived.live, threadsApi.hiddenKeys) : null),
    [threadMap.shape, threadTree, threadsApi.metaIndex, pinsApi.pins, threadDerived.live, threadsApi.hiddenKeys],
  );
  /** The passage a question (or a pending question) is about. */
  const passageOf = useCallback((key: string): { msgId: string; quote?: SessionPinnedQuote } | null => {
    const pend = stack.pending?.pageKey === key ? stack.pending : undefined;
    if (pend) return { msgId: pend.parentMsgId, quote: pend.quote };
    const node = threadTree.byKey.get(key);
    if (!node?.parent) return null;
    return { msgId: node.parent, ...(node.quote ? { quote: node.quote } : {}) };
  }, [stack.pending, threadTree]);

  /**
   * Open a question's card (Conversation Mode): it becomes the composer's target
   * and the card shows beside its passage. The timeline moves only when that
   * passage is off screen (an Ask on a selection has it on screen already; a
   * sidebar row's question may be a long way off).
   */
  const openCard = useCallback((key: string, via: string) => {
    if (threadsApi.viewMode !== 'linear') { stack.pushTo(key, via); return; }
    if (key !== stack.currentKey) stack.pushTo(key, via, cardLeave());
    setCardOpen(true);
    // A FILE question's card lives in the Files tab beside its passage: open
    // that file there when it is not the one on show; the timeline stays put.
    const place = filePlaceOf(key);
    if (place) {
      if (threadsApi.fileCardHost?.path !== place.path) onFileOpen?.(place.path, place.line);
      log.info('threads', 'file question card opened', { sessionId, key, path: place.path, via });
      return;
    }
    const passage = passageOf(key);
    const el = containerRef.current;
    if (!passage || !el) return;
    const box = el.getBoundingClientRect();
    const range = quotePaint.locatePin(passage);
    const r = range?.getBoundingClientRect();
    const onScreen = !!r && (r.width || r.height) && r.top >= box.top && r.bottom <= box.bottom - 40;
    if (!onScreen) jumpToPlace(passage.msgId, passage.quote, `card:${via}`, { armBack: false });
  }, [threadsApi.viewMode, threadsApi.fileCardHost?.path, stack, passageOf, filePlaceOf, onFileOpen, quotePaint, jumpToPlace, sessionId, cardLeave]);
  openCardRef.current = openCard;

  // The Files tab (a mark in a file, Ask here on a selection) and the sidebar
  // ask for a card through the threads api; the timeline owns it. Once per request.
  const cardRequest = threadsApi.cardRequest;
  const cardRequestSeenRef = useRef(0);
  useEffect(() => {
    if (!cardRequest || cardRequest.seq === cardRequestSeenRef.current) return;
    cardRequestSeenRef.current = cardRequest.seq;
    if (cardRequest.key === null) { closeCard(cardRequest.via); return; }
    openCard(cardRequest.key, cardRequest.via);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request
  }, [cardRequest?.seq]);

  const activateMapRow = useCallback((row: TreeRow) => {
    switch (row.kind) {
      case 'done-group':
        // Held open while it holds the current page: nothing to toggle.
        if (row.disclosureDisabled) return;
        setMapDoneOpen((prev) => {
          const next = new Set(prev);
          if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
          return next;
        });
        return;
      case 'pin':
        if (row.pinKey) handleTocJump(row.pinKey);
        return;
      case 'root': case 'thread': case 'pending': case 'draft':
        // Conversation Mode: the row is the composer's target, and its card
        // opens beside the passage. Tree Mode: its page.
        if (convMode) {
          if (row.kind === 'root') { if (!row.current) stack.pushTo(row.key, 'map', cardLeave()); closeCard(); return; }
          openCard(row.key, 'map');
          return;
        }
        if (row.current) return;
        stack.pushTo(row.key, 'map');
        return;
      default:
    }
  }, [handleTocJump, stack, convMode, openCard, closeCard, cardLeave]);
  const openMapList = useCallback(() => threadsApi.openDrawer(), [threadsApi]);
  const markDoneFromRow = useCallback((key: string) => { void threadsApi.actions?.done(key); }, [threadsApi.actions]);
  const notYetFromRow = useCallback((key: string) => { void threadsApi.actions?.notYet(key); }, [threadsApi.actions]);

  // Question marks on the page's answers, and the landing on every navigation.
  const locatePassage = useCallback(
    (p: { msgId: string; quote?: SessionPinnedQuote }) => quotePaint.locatePin(p),
    [quotePaint],
  );
  // Tree Mode paints the page's child questions in their hue; Conversation Mode
  // paints every asked passage the same grey, and a click opens its card.
  const markSpecs = useMemo(() => (stackMode
    ? markSpecsFor({ tree: threadTree, currentKey, hiddenKeys: threadsApi.hiddenKeys, index: threadsApi.metaIndex })
    : convMode ? allPassageMarks(threadTree, threadsApi.hiddenKeys, threadsApi.metaIndex)
      : NO_MARKS), [stackMode, convMode, threadTree, currentKey, threadsApi.hiddenKeys, threadsApi.metaIndex]);
  const markTips = useThreadMarks({
    sessionId, panelKey: quotePanelKey, enabled: stackMode || convMode, containerRef, specs: markSpecs,
    renderNonce: `${messages.length}:${truncationOffset}:${currentKey}`,
    locatePassage, onOpen: (key) => { if (stackMode) stack.pushTo(key, 'mark'); else openCard(key, 'mark'); },
  });
  useThreadLanding({
    sessionId, enabled: stackMode, targetOnly: threadsApi.viewMode === 'linear', containerRef, stack, tree: threadTree,
    locatePassage, jumpToPlace, toast, isAtBottom,
  });

  /** Conversation Mode: the label above a question's user row (the turn head)
   *  opens the question's card. */
  const selectTarget = useCallback((key: string) => { openCard(key, 'label'); }, [openCard]);
  const turnLabelFor = (rowId: string | undefined, role: string): React.ReactNode => {
    if (!convMode || role !== 'user' || !rowId) return null;
    const info = rowThreadInfo(rowId);
    if (!info || info.depth < 1) return null;
    const node = threadTree.byKey.get(info.key);
    const t = displayTitleOf(node, threadsApi.metaIndex);
    return (
      <ThreadTurnLabel
        threadKey={info.key}
        number={questionNumber.get(info.key)}
        title={t.title}
        naming={t.naming}
        status={node ? viewStatusOf(node, threadsApi.metaIndex, threadDerived.live) : undefined}
        unread={threadsApi.unreadKeys.has(info.key)}
        current={info.key === targetKey}
        onSelect={selectTarget}
      />
    );
  };

  // A drawer row picked in Conversation Mode: the question's card, beside its
  // passage (the stack already made it the target). Once per request.
  const headJump = threadsApi.headJump;
  const headJumpLandedRef = useRef<typeof headJump>(null);
  useEffect(() => {
    if (!headJump || headJump === headJumpLandedRef.current || !convMode) return;
    const node = threadTree.byKey.get(headJump.threadKey);
    if (!node || node.key === ROOT_THREAD_KEY) return;
    headJumpLandedRef.current = headJump;
    openCard(node.key, 'drawer-row');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request
  }, [headJump?.seq, convMode]);

  /**
   * ONE row renderer, called from three places: the linear timeline, the current
   * thread's turns, and an expanded ancestor turn. Extracted from the JSX map for
   * exactly that reason — a second copy would be a second set of thread bars,
   * fork dividers and copy-action rules to keep in sync.
   */
  const renderHistoryPart = (part: HistoryPart) => {
    if (part.kind === 'run') {
      const first = part.members[0];
      return (
        <div
          key={`mrun-${first.m.msgId ?? first.globalIndex}`}
          data-msg-index={first.globalIndex}
          {...threadWrapperProps(first.m.msgId ?? first.m.walnutMessageId, 'session-msg-bare')}
        >
          {!part.seeded && forkBoundaryIndex != null && first.globalIndex === forkBoundaryIndex && (
            <div className="session-fork-divider">
              <span className="session-fork-divider-label">Forked session starts here</span>
            </div>
          )}
          <MergedHistoryToolRun
            messages={part.memberMsgs}
            assistantLabel={assistantLabel}
            sessionId={sessionId}
            sessionCwd={sessionCwd}
            sessionHost={sessionHost}
            onTaskClick={onTaskClick}
            onSessionClick={onSessionClick}
            onFileOpen={onFileOpen}
          />
        </div>
      );
    }
    if (part.kind === 'system-run') {
      const first = part.members[0];
      return (
        <div
          data-msg-index={first.globalIndex}
          key={`sys-${first.m.msgId ?? first.globalIndex}`}
          {...threadWrapperProps(first.m.msgId ?? first.m.walnutMessageId, 'session-msg-bare')}
        >
          <SystemGroupRun members={part.systemMembers} />
        </div>
      );
    }
    const { m, globalIndex } = part;
    // Question rows wear their decoration through the wrapper (the gutter bar in
    // Conversation Mode); top-level rows stay exactly as they were.
    const rowId = m.msgId ?? m.walnutMessageId;
    return (
      <div
        key={m.msgId ?? m.walnutMessageId ?? `${m.role}:${m.timestamp}:${globalIndex}`}
        data-msg-index={globalIndex}
        data-message-id={m.msgId ?? m.walnutMessageId}
        // Read by the quote-pin selection pill, which only has the DOM row it
        // found the selection in — cheaper than threading the messages array
        // into an overlay that needs one row's metadata.
        data-msg-role={m.role}
        data-msg-ts={m.timestamp}
        {...threadWrapperProps(rowId)}
      >
        {forkBoundaryIndex != null && globalIndex === forkBoundaryIndex && (
          <div className="session-fork-divider">
            <span className="session-fork-divider-label">Forked session starts here</span>
          </div>
        )}
        {turnLabelFor(rowId, m.role)}
        <SessionMessage message={m} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} suppressTools={part.suppressTools} showCopyActions={globalIndex === lastAssistantTextIndex} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
      </div>
    );
  };

  const pageNode = stackMode && currentKey !== ROOT_THREAD_KEY ? threadTree.byKey.get(currentKey) : undefined;
  const pageMeta = pageNode ? metaOf(pageNode, threadsApi.metaIndex) : undefined;
  const pageStatus = pageNode ? viewStatusOf(pageNode, threadsApi.metaIndex, threadDerived.live) : undefined;
  // The page's last message is a parked queue row (never sent, N41).
  const pageLastTurn = pageNode?.turnIds[pageNode.turnIds.length - 1];
  const pageParked = !!pageLastTurn && queuedSig.split('|').includes(`${pageLastTurn}:parked`);
  const pageStrip = pageNode && pageStatus && threadsApi.actions ? (
    <ThreadResolvedStrip
      key={`strip-${currentKey}`}
      threadKey={currentKey}
      {...(pageMeta ? { meta: pageMeta } : {})}
      viewStatus={pageStatus}
      takeawayWaiting={pageMeta?.status === 'resolved' && threadDerived.answering.has(currentKey)}
      actions={threadsApi.actions}
      onRetry={() => threadsApi.retry(currentKey)}
      parked={pageParked}
    />
  ) : null;
  /** The page's rows, each answer followed by its Asked-from list (siblings in one
   *  keyed array, so a row's own key and identity never change). */
  const pageRows: React.ReactNode[] = [];
  // The resolved / failed strip closes the page's turns, BEFORE the last answer's
  // Asked-from list (spec 4 item 5, N30); rendered once, after the queue rows,
  // only when that last answer has no list.
  let stripPlaced = false;
  const lastPart = visibleHistoryParts.length - 1;
  visibleHistoryParts.forEach((part, i) => {
    pageRows.push(renderHistoryPart(part));
    const asked = askedAfter.get(i);
    if (asked && i === lastPart && pageStrip) { pageRows.push(pageStrip); stripPlaced = true; }
    if (asked) {
      pageRows.push(
        <ThreadAskedFromList
          key={`asked-${asked[0].key}`}
          rows={asked}
          onOpen={openFromRow}
          onRetry={threadsApi.retry}
          onMarkDone={markDoneFromRow}
          onNotYet={notYetFromRow}
        />,
      );
    }
  });

  // ── The comment card: the target question beside its passage (Conversation Mode).
  const cardLayerRef = useRef<HTMLDivElement | null>(null);
  const cardNode = cardKey ? threadTree.byKey.get(cardKey) : undefined;
  const cardPending = cardKey && stack.pending?.pageKey === cardKey ? stack.pending : undefined;
  const cardFile = cardKey ? filePlaceOf(cardKey) : null;
  const cardFileHost = cardFile && threadsApi.fileCardHost?.path === cardFile.path ? threadsApi.fileCardHost : null;
  const cardPlace = useThreadCardPlace({
    key: cardFile ? null : cardKey,
    containerRef,
    layerRef: cardLayerRef,
    locate: () => {
      const el = containerRef.current;
      if (!el || !cardKey) return null;
      const passage = passageOf(cardKey);
      if (passage?.quote) {
        const range = quotePaint.locatePin(passage);
        if (range) return range;
      }
      const esc = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&'));
      for (const id of [passage?.msgId, cardNode?.headId]) {
        if (!id) continue;
        const row = el.querySelector<HTMLElement>(`[data-message-id="${esc(id)}"]`);
        if (row) return row;
      }
      return null;
    },
  });
  // A click outside the card (and outside the controls that open one) closes it.
  useEffect(() => {
    if (!cardKey) return;
    const exempt = '.thread-card, .thread-map, .thread-drawer, .thread-menu, .thread-confirm, .quote-pin-pill, .thread-turn-label, .thread-mode-pill, .session-panel-header, .fv-thread-layer, .session-diff-ask-pill';
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || t.closest(exempt)) return;
      // Into the panel's composer: the question is written there now (its chip
      // names it, and its × lets go), so an Ask not sent yet stays the target,
      // and the words typed in the card come along into the composer.
      if (t.closest('.session-panel-input')) {
        const words = cardTextRef.current;
        setCardOpen(false);
        cardTextRef.current = '';
        if (words.trim()) {
          const detail: ComposerInsertDetail = { sessionId, text: words, mode: 'append', handled: false };
          window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
        }
        return;
      }
      closeCard('outside');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [cardKey, closeCard, sessionId]);
  const cardTurns = useMemo(() => cardTurnsOf(messages, cardNode), [messages, cardNode]);
  // A draft (an Ask left with words) opens with them in the card's box again.
  const cardInitialText = cardPending && !cardNode ? readComposerDraft(composerDraftKey(sessionId, cardPending.pageKey, threadTree)) : '';
  const cardStatus = cardNode ? viewStatusOf(cardNode, threadsApi.metaIndex, threadDerived.live) : undefined;
  const cardTitle = cardKey ? displayTitleOf(cardNode, threadsApi.metaIndex) : undefined;
  const cardBody = cardKey ? (
    <>
      {cardTurns.map((t) => (
        <div key={t.user.msgId ?? t.user.walnutMessageId} className="thread-card-turn">
          <p className="thread-card-q">{questionBodyOf(typedUserText(t.user.text ?? ''))}</p>
          {t.replies.map((r) => (
            <SessionMessage key={r.msgId ?? r.walnutMessageId} message={r} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} suppressTools onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
          ))}
        </div>
      ))}
      {/* Sent, not yet in the transcript: the question as typed, then the answer as it arrives. */}
      {deduped.filter((m) => m.role === 'user' && m.status !== 'failed' && optimisticThreadKey(m) === cardKey).map((m) => (
        <div key={`opt-${m.queueId}`} className="thread-card-turn" data-status={m.status}>
          <p className="thread-card-q">{questionBodyOf(typedUserText(m.text))}</p>
        </div>
      ))}
      {timeline.map((item) => {
        if (item.kind !== 'block' || item.block.type !== 'text' || pageKeyOfBlock(item.index) !== cardKey) return null;
        return (
          <div key={`live-${item.index}`} className="session-msg session-msg-assistant">
            <div className="session-msg-content">
              <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} live={isStreaming} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
            </div>
          </div>
        );
      })}
      {cardTurns.length === 0 && !deduped.some((m) => m.role === 'user' && optimisticThreadKey(m) === cardKey) && (
        <div className="thread-card-empty">No message in this question yet.</div>
      )}
    </>
  ) : null;
  const sendFromCard = useCallback(async (text: string) => {
    cardSendHold.current = true;
    try { return await threadsApi.sendToTarget(text); } finally { cardSendHold.current = false; }
  }, [threadsApi.sendToTarget]);
  const cardMenu = cardKey && cardNode && threadsApi.actions ? (
    <ThreadStackMenu
      variant="page" threadKey={cardKey} visibleDescendants={threadsApi.actions.visibleDescendantCount(cardKey)} hiddenCount={0}
      viewMode="linear" actions={threadsApi.actions} resolved={cardStatus === 'resolved'}
      onShowInTree={threadsApi.revealInTree} onShowAllInOrder={() => {}}
      onBackToQuestions={() => threadsApi.setViewMode('stack')} onShowHidden={() => {}}
    />
  ) : null;

  /** A queued question waits for the one being answered (spec 5.4). */
  const answeringTitle = titleOfKey(liveStreamKey);
  const pageQuote = pagePending?.quote ?? pageNode?.quote;
  const pageFile = currentKey !== ROOT_THREAD_KEY ? filePlaceOf(currentKey) : null;
  const pageHue = pageNode?.hue ?? (pagePending ? hueForAnchor(threadTree, {
    parent: pagePending.parentMsgId, ...(pagePending.quote ? { quote: pagePending.quote } : {}), source: 'selection', label: '',
  }) : 0);
  const parentOfPage = stack.path.length > 1 ? stack.path[stack.path.length - 2] : ROOT_THREAD_KEY;

  // Always mount the scroll container so containerRef is available for scroll effects.
  // Remote sessions have a gap between Phase 1 (empty, local streams) and Phase 2 (SSH fetch)
  // where containerRef was previously null, breaking auto-scroll.
  return (
    <>
      {/* Team tab bar — shown when session has team(s) */}
      {teams.length > 0 && (
        <div className="team-tab-bar">
          <button
            className={`team-tab-bar-item ${activeTeamTab === null ? 'team-tab-bar-item-active' : ''}`}
            onClick={() => setActiveTeamTab(null)}
          >
            Lead
          </button>
          {teams.map(t => {
            const doneCount = [...t.agentStatuses.values()].filter(s => s === 'done').length;
            return (
              <button
                key={t.teamName}
                className={`team-tab-bar-item ${activeTeamTab === t.teamName ? 'team-tab-bar-item-active' : ''}`}
                onClick={() => setActiveTeamTab(t.teamName)}
              >
                {t.teamName}
                <span className="team-tab-bar-count">{doneCount}/{t.agentStatuses.size}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Team view — shown when a team tab is active */}
      {activeTeamTab && sessionId && (
        <TeamCard
          sessionId={sessionId}
          teamName={activeTeamTab}
          agentStatuses={teams.find(t => t.teamName === activeTeamTab)?.agentStatuses}
        />
      )}

      {/* Dynamic-workflow / background-task progress — shown on the lead view only.
          Self-hides when there's no background activity (see WorkflowProgress).
          key={sessionId} forces a fresh remount on session switch so the panel's
          local UI state (expanded agent, open transcript modal, collapse override)
          can't leak from one session into the next. */}
      {!activeTeamTab && sessionId && <WorkflowProgress key={sessionId} sessionId={sessionId} />}
      <BackgroundTasksPanelHost sessionId={sessionId} />

      {/* Main conversation, hidden when a team tab is active. The stack frame
          wraps the ONE scroll container at every depth (display: contents for a
          session without questions, so nothing about it changes). */}
      <ThreadStackFrame
        active={stackMode}
        depth={stackMode ? stack.depth : 0}
        bars={sliver}
        containerRef={containerRef}
        header={(panelWidth) => {
          if (!stackMode || stack.depth === 0 || !threadsApi.actions) return null;
          return (
            <ThreadStackHeader
              sessionId={sessionId}
              path={stack.path.map((k) => threadTree.byKey.get(k)).filter((n): n is NonNullable<typeof n> => !!n)}
              {...(pagePending ? { pending: pagePending } : {})}
              index={threadsApi.metaIndex}
              live={threadDerived.live}
              panelWidth={panelWidth}
              actions={threadsApi.actions}
              onBack={() => stack.back('back')}
              onPopTo={(key) => stack.popTo(key, 'crumb')}
              onShowInTree={threadsApi.revealInTree}
              onShowAllInOrder={() => threadsApi.setViewMode('linear')}
              renameNonce={0}
            />
          );
        }}
        onPopTo={(key) => stack.popTo(key, 'sliver')}
      >
      <div
        className="session-history"
        ref={containerRef}
        onClick={handleContainerClick}
        data-view-mode={stackMode ? 'stack' : 'linear'}
        {...(threadMap.shape ? { 'data-thread-map': threadMap.shape } : {})}
        style={activeTeamTab ? { display: 'none' }
          : threadMap.shape === 'panel' ? { ['--thread-map-w' as string]: `${threadMap.panelWidth}px` } : undefined}
      >
        {/* The top-left corner of the timeline. A session with questions shows
            the question map there, always (every question and pin, where you
            are); one without shows the pinned-message outline, collapsed to
            ticks until hovered, self-hiding with no pins. Both live INSIDE the
            scroll container (like the ↓ button) so they can't stack over the
            panel header or the composer. */}
        {threadMap.shape && mapCounts ? (
          <ThreadMap
            shape={threadMap.shape}
            roomy={threadMap.roomy}
            scrollerRef={containerRef}
            boxWidth={threadMap.boxWidth}
            panelWidth={threadMap.shape === 'panel' ? threadMap.panelWidth : 0}
            rows={threadMap.rows}
            counts={mapCounts}
            unreadKeys={threadsApi.unreadKeys}
            answeredAt={threadDerived.answeredAt}
            canGoBack={canGoBack}
            onBack={jumpBack}
            onActivate={activateMapRow}
            onOpenList={openMapList}
            onCollapse={threadMap.setCollapsed}
          />
        ) : (
          <SessionPinnedToc
            entries={tocEntries}
            onJump={handleTocJump}
            onUnpin={pinsApi.unpin}
            canGoBack={canGoBack}
            onBack={jumpBack}
            {...(pagePins.other > 0 ? { moreCount: pagePins.other, onMore: () => threadsApi.openDrawer('pinned') } : {})}
          />
        )}
        <ThreadMarkTipLayer store={markTips} />
        {/* The comment card's layer: zero height at the top of the content, so a
            card placed from a passage's content coordinates scrolls with it. */}
        {cardKey && !cardFile && (
          <div ref={cardLayerRef} className="thread-card-layer">
            {cardPlace && (
              <ThreadCommentCard
                threadKey={cardKey}
                draft={!!cardPending && !cardNode}
                number={questionNumber.get(cardKey)}
                title={cardPending && !cardNode ? cardPending.title : cardTitle?.title ?? ''}
                naming={cardTitle?.naming}
                status={cardStatus}
                unread={threadsApi.unreadKeys.has(cardKey)}
                answering={threadDerived.answering.has(cardKey)}
                canAsk={threadsApi.canAsk}
                menu={cardMenu}
                initialText={cardInitialText}
                onTextChange={onCardText}
                onSend={sendFromCard}
                onClose={closeCard}
                style={cardPlace}
              >
                {cardBody}
              </ThreadCommentCard>
            )}
          </div>
        )}
        {/* A FILE question's card: the same card, drawn into the box the Files
            tab lends beside the passage (null until that file is on show). */}
        {cardKey && cardFile && cardFileHost?.place && createPortal(
          <ThreadCommentCard
            threadKey={cardKey}
            draft={!!cardPending && !cardNode}
            number={questionNumber.get(cardKey)}
            title={cardPending && !cardNode ? cardPending.title : cardTitle?.title ?? ''}
            naming={cardTitle?.naming}
            status={cardStatus}
            unread={threadsApi.unreadKeys.has(cardKey)}
            answering={threadDerived.answering.has(cardKey)}
            canAsk={threadsApi.canAsk}
            menu={cardMenu}
            initialText={cardInitialText}
            onTextChange={onCardText}
            onSend={sendFromCard}
            onClose={closeCard}
            style={cardFileHost.place}
          >
            {cardBody}
          </ThreadCommentCard>,
          cardFileHost.el,
        )}
        {/* Quote pins: the pill offered on a text selection, and the popover a
            click on a painted passage opens. Both portal to <body>; they live here
            so ONE listener set covers the whole timeline. Mounted only where pinning
            can actually persist — a timeline running on a stub pin store (the
            side-question drawer) must not offer a Pin button that silently does
            nothing. */}
        {pinsApi.canPinQuote && (
          <>
            <QuotePinSelectionBar
              containerRef={containerRef}
              sessionId={sessionId}
              onPin={pinsApi.pinQuote}
              {...(threadsApi.canAsk ? { onAsk: askAboutQuote } : {})}
            />
            <QuotePinPopover
              containerRef={containerRef}
              pins={pinsApi.pins}
              paintedRanges={quotePaint.paintedRanges}
              onUnpin={pinsApi.unpin}
              resetKey={currentKey}
            />
          </>
        )}
        {/* Loading / empty / error states rendered INSIDE the scroll container */}
        {/* Not over a launch prompt: a fresh session has nothing to load, and the
            spinner would push the first message down, then let it jump back up. */}
        {loading && messages.length === 0 && blocks.length === 0 && launchHead.length === 0 && <LoadingSpinner />}
        {/* Gate on the RAW flag: when an unavailable answer is suppressed because
            the session has content, it must not fall through to this generic
            banner and print the internal "HISTORY_UNAVAILABLE:" string. */}
        {error && !historyUnavailableRaw && (
          <div className="session-history-empty">
            <p className="text-muted">Failed to load history: {error}</p>
          </div>
        )}
        {historyUnavailable && (
          <div className="session-history-unavailable" role="status">
            <strong>History unavailable</strong>
            <span>{historyUnavailable}</span>
          </div>
        )}
        {/* Degraded connectivity: content below is the last-good parse; the
            live read (SSH/daemon) is failing. Auto-clears on next healthy fetch. */}
        {stale && !error && (
          <div className="session-history-stale-banner" role="status">
            Showing cached history — live connection unavailable ({stale}). Reconnecting…
          </div>
        )}
        {!error && !hasContent && !loading && !phase2Pending && (
          <div className="session-history-empty">
            <p className="text-muted">No conversation history found</p>
          </div>
        )}
        {/* Show a subtle loading indicator when Phase 2 (SSH) is still fetching */}
        {!hasContent && !loading && phase2Pending && (
          <div className="session-history-empty">
            <p className="text-muted">Loading remote session...</p>
          </div>
        )}
        {/* Persisted history messages — truncated to tail for performance.
            Full messages[] stays in memory; only the visible slice is rendered as DOM. */}
        {/* A question page is one question's turns: no transcript preamble above it
            (its rows are revealed into the render window when it opens). */}
        {!onQuestionPage && initialPrompt && (hiddenCount > 0 || olderHidden > 0 || olderWindowed) && (
          <div className="session-msg session-msg-user session-initial-prompt">
            <div className="session-msg-header">
              <span className="session-initial-prompt-label">Initial Prompt</span>
            </div>
            <div className="session-msg-content" onClick={handleInitialPromptClick}>
              {/* The typed words only: a stored turn can open with a machine block
                  Walnut prepended, and this preview has no room to fold one.
                  Markdown, not raw text: a URL the user typed into their prompt
                  is a link here exactly as it is in the full bubble below. */}
              <StableMarkdownBody text={typedUserText(initialPrompt)} cwd={sessionCwd} />
            </div>
          </div>
        )}
        {!onQuestionPage && hiddenOnPage > 0 && (
          <button
            className="session-show-earlier-btn"
            onClick={() => {
              isAtBottom.current = false;
              const el = containerRef.current;
              if (el) pendingBottomDistance.current = el.scrollHeight - el.scrollTop;
              setTruncationOffset(prev => prev + LOAD_MORE_BATCH);
            }}
          >
            Show {Math.min(hiddenOnPage, LOAD_MORE_BATCH)} earlier messages
            <span className="session-show-earlier-count">({hiddenOnPage + olderHidden} hidden)</span>
          </button>
        )}
        {/* Lazy tail exhausted: everything we HOLD is rendered, but the source
            has older messages we never fetched. One click fetches the rest.
            olderWindowed = bounded window read, count unknown (whale / cold
            tail-bounded read) — same button, uncounted label. */}
        {!onQuestionPage && hiddenOnPage === 0 && (olderHidden > 0 || olderWindowed) && (
          <button
            className="session-show-earlier-btn"
            disabled={phase2Pending}
            onClick={() => {
              isAtBottom.current = false;
              const el = containerRef.current;
              if (el) pendingBottomDistance.current = el.scrollHeight - el.scrollTop;
              loadFullHistory();
            }}
          >
            {phase2Pending
              ? 'Loading earlier messages…'
              : olderHidden > 0 ? `Load ${olderHidden} earlier messages` : 'Load earlier messages'}
          </button>
        )}
        {/* ── Stack page: the passage it exists for, then its own turns ──
            Everything below the quote head is rendered by the SAME row renderer
            the linear view uses; the stack only decides WHICH parts reach it. */}
        {stackMode && currentKey !== ROOT_THREAD_KEY && (
          <ThreadQuoteHead
            key={`qh-${currentKey}`}
            {...(pageQuote ? { quote: pageQuote } : {})}
            hue={pageHue}
            level={pageNode?.depth ?? stack.depth}
            // A file question's passage is in that file: name it, and open it.
            parentTitle={pageFile ? pageFile.path.split('/').pop() || pageFile.path : titleOfKey(parentOfPage)}
            samePassage={stack.samePassageKey === currentKey}
            onPop={() => { if (pageFile) onFileOpen?.(pageFile.path, pageFile.line); else stack.back('quote-head'); }}
          />
        )}
        {!onQuestionPage && launchHead.map((m) => (
          <div key={`launch-${m.queueId}`} data-launch-prompt="">
            <SessionMessage message={m} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
            <OptimisticImagePreviews images={m.images} />
          </div>
        ))}
        {pageRows}
        {boundaryRunVisible && mergeBoundary && boundaryHistoryRun && (
          <div
            key={`boundary-run-${boundaryHistoryRun.members[0].m.msgId ?? boundaryHistoryRun.members[0].globalIndex}`}
            data-msg-index={boundaryHistoryRun.members[0].globalIndex}
            {...threadWrapperProps(
              boundaryHistoryRun.members[0].m.msgId ?? boundaryHistoryRun.members[0].m.walnutMessageId,
              'session-msg-bare',
            )}
          >
            {!boundaryHistoryRun.seeded && forkBoundaryIndex != null && boundaryHistoryRun.members[0].globalIndex === forkBoundaryIndex && (
              <div className="session-fork-divider">
                <span className="session-fork-divider-label">Forked session starts here</span>
              </div>
            )}
            <MergedHistoryToolRun
              messages={boundaryHistoryRun.memberMsgs}
              trailingBlocks={runMembersOf(leadingStreamRunIndices)}
              trailingLive={isThinkingTail(leadingStreamRunIndices[leadingStreamRunIndices.length - 1])}
              assistantLabel={assistantLabel}
              sessionId={sessionId}
              sessionCwd={sessionCwd}
              sessionHost={sessionHost}
              onTaskClick={onTaskClick}
              onSessionClick={onSessionClick}
              onFileOpen={onFileOpen}
            />
          </div>
        )}

        {/* Turn timeline — interleaved blocks + ALL optimistic messages by blockIndex,
            preserving their correct visual positions until deduped by persisted history. */}
        {timeline.length > 0 && (
          <div className="session-streaming-panel">
            {timeline.map((item, i) => {
              // Stack page: a queued bubble shows on ITS question's page; the live
              // blocks and the working indicator show on the page whose turn they
              // belong to, as a group (one turn's output, never split across pages).
              if (stackMode) {
                if (item.kind === 'user') {
                  if (optimisticThreadKey(item.msg) !== currentKey) return null;
                } else if (item.kind === 'block') {
                  if (pageKeyOfBlock(item.index) !== currentKey) return null;
                } else if (!streamVisible) {
                  return null;
                }
              }
              if (boundaryStreamIndices.has(i) || isTransparentStreamItem(item)) return null;
              if (systemRunMember.has(i)) return null;
              const systemRunIdx = systemRunStart.get(i);
              if (systemRunIdx && item.kind === 'block') {
                const members = systemRunIdx.flatMap((index): SystemGroupMember[] => {
                  const member = timeline[index];
                  if (member.kind !== 'block' || member.block.type !== 'system') return [];
                  return [{
                    variant: member.block.variant,
                    message: member.block.message,
                    detail: member.block.detail,
                    key: `stream-system-${member.index}`,
                  }];
                });
                return (
                  <div key={`system-run-${item.index}`} className="session-msg-bare">
                    <SystemGroupRun members={members} />
                  </div>
                );
              }
              if (thinkingRunMember.has(i)) return null;
              const thinkingIdx = thinkingRunStart.get(i);
              if (thinkingIdx && item.kind === 'block') {
                const content = thinkingIdx
                  .map(k => {
                    const t = timeline[k];
                    return t.kind === 'block' && t.block.type === 'thinking' ? t.block.content : '';
                  })
                  .filter(s => s.trim())
                  .join('\n\n');
                // The same shell and key the stretch will have once a tool joins
                // it, so a reader who opened the reasoning keeps it open through
                // the fold.
                return (
                  <div key={`run-${item.index}`} className="session-msg-bare">
                    <ToolRunShell phrase="Thinking" failCount={0} running={isThinkingTail(thinkingIdx[thinkingIdx.length - 1])}>
                      <div className="chat-thinking-content">{content}</div>
                    </ToolRunShell>
                  </div>
                );
              }
              if (runMember.has(i)) return null;
              const runIdx = runStart.get(i);
              if (runIdx && item.kind === 'block') {
                // Tools and the reasoning between them, in arrival order — the
                // body a persisted run shows, so absorption changes nothing.
                const members = runMembersOf(runIdx);
                const { phrase, failCount } = streamRunSummary(members);
                const thinkingLive = isThinkingTail(runIdx[runIdx.length - 1]);
                return (
                  <div key={`run-${item.index}`} className="session-msg-bare">
                    <ToolRunShell phrase={phrase} failCount={failCount} running={thinkingLive}>
                      <StreamRunMembers
                        members={members}
                        live={thinkingLive}
                        sessionId={sessionId}
                        sessionCwd={sessionCwd}
                        sessionHost={sessionHost}
                        onTaskClick={onTaskClick}
                        onSessionClick={onSessionClick}
                        onFileOpen={onFileOpen}
                      />
                    </ToolRunShell>
                  </div>
                );
              }
              if (item.kind === 'indicator') {
                if (item.type === 'resuming') {
                  return (
                    <div key="ind-resuming" className="session-streaming-indicator">
                      <span className="session-streaming-dot" />
                      Waiting for response...
                    </div>
                  );
                }
                return (
                  <WorkingIndicator
                    key="ind-working"
                    label={assistantLabel}
                    tokens={Math.round(countStreamChars(blocks, hiddenBlocks) / 4)}
                  />
                );
              }

              if (item.kind === 'block') {
                // An Agent spawn burst renders as one chip at the first anchor.
                if (agentChipMember.has(i)) return null;
                const burst = agentChipStart.get(i);
                if (burst) {
                  const agents: KnownAgent[] = [];
                  for (const k of burst) {
                    const t = timeline[k];
                    const g = t.kind === 'block' ? groupedByIndex.get(t.index) : undefined;
                    if (g && g.kind === 'task-group') agents.push(knownAgentFromStream(g.taskBlock));
                  }
                  const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                  return (
                    <div key={`tg-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <BackgroundTasksChip sessionId={sessionId} agents={agents} />
                      </div>
                    </div>
                  );
                }

                // Skip subagent-lane blocks (rendered inside their Agent box or not at all)
                if (consumedBlockIndices.has(item.index)) return null;

                // Regular block rendering
                // Group consecutive blocks under one assistant header.
                // Show header on first block in each consecutive run.
                // (The old "Streaming" pill badge was retired — the tail
                // WorkingIndicator is now the only turn-is-live signal.)
                //
                // Only text/system blocks get the assistant "bubble" (padding +
                // rounded background). Tool-call and thinking blocks render flush
                // to the panel — the bubble padding on the first tool_call
                // produced a visible indent-jump against the following tool_calls.
                const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                const blockWantsBubble = item.block.type === 'text' || item.block.type === 'system';
                // `live` marks the block still receiving tokens: streaming AND
                // it is the last visible timeline item (crude but the only
                // per-block signal available — deltas always append at the tail).
                const isLiveTail = isStreaming && i === lastVisibleTimelineIdx;
                if (blockWantsBubble) {
                  // A reply that is still arriving is selectable prose like any
                  // other, so the streaming bubble wears the SAME identity a
                  // persisted row wears (`data-message-id` + `data-msg-role`) —
                  // that pair is the whole contract the quote pill reads off the
                  // DOM, and without it selecting inside a live answer offered
                  // no Copy, no Pin and no Ask at all (`selectionBody` requires
                  // a `[data-message-id]` ancestor).
                  //
                  // The id is the one the model's own `message_start` carried,
                  // which is exactly the id the persisted twin will have: the
                  // absorption filter pairs stream block to history row id-first
                  // (`computeAbsorbedIndices`). So a pin or a thread anchor made
                  // mid-answer still resolves after the turn lands, against the
                  // twin. A block with no id yet (a system notice, a snapshot
                  // without one) still gets a body so Copy works — Pin and Ask
                  // gate themselves on the id inside the pill.
                  //
                  // No `data-msg-ts`: a block that is still arriving has no
                  // settled message timestamp, and the pill's `timestamp` is
                  // optional everywhere it lands, so a pin made mid-answer simply
                  // shows no time in the outline until the row is reloaded.
                  const streamMsgId = item.block.type === 'text' ? item.block.msgId : undefined;
                  return (
                    <div
                      key={`b-${item.index}`}
                      className={isFirst ? 'session-msg session-msg-assistant' : ''}
                      {...(streamMsgId ? { 'data-message-id': streamMsgId, 'data-msg-role': 'assistant' } : {})}
                    >
                      {/* Always the body class: it is `word-break` only (no bubble
                          padding), and a text block that follows a tool call is
                          deliberately NOT `isFirst`, yet its prose is just as
                          quotable as the first block's. */}
                      <div className="session-msg-content">
                        <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} live={isLiveTail} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={`b-${item.index}`} className="session-msg-bare">
                    <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} live={isLiveTail} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                  </div>
                );
              }

              // kind === 'user'
              const m = item.msg;
              if (m.status === 'received' && editingId === m.queueId) {
                return (
                  <div key={`r-${m.queueId}`} className="session-msg-received">
                    <EditableQueuedMessage
                      message={m.text}
                      onSave={(newText) => {
                        setEditingId(null);
                        if (newText !== m.text) onEditQueued?.(m.queueId, newText);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                );
              }

              const wrapperClass = m.status === 'pending' ? 'session-msg-queued'
                : m.status === 'received' ? 'session-msg-received'
                : m.status === 'delivered' ? 'session-msg-delivered'
                : m.status === 'failed' ? 'session-msg-failed' : '';
              // An anchored send carries the uuid its anchor was recorded under, so
              // the bubble files under its question IMMEDIATELY (the same page the
              // persisted row will be on, no visible flip when history absorbs it).
              const optimisticRowId = m.msgId ?? m.userUuid ?? m.walnutMessageId;
              const queuedBehind = stackMode && isStreaming && (m.status === 'pending' || m.status === 'received')
                && optimisticThreadKey(m) !== liveStreamKey;

              return (
                <div key={`u-${m.queueId}`} {...threadWrapperProps(optimisticRowId, wrapperClass)}>
                  {turnLabelFor(optimisticRowId, 'user')}
                  <SessionMessage message={m} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                  {queuedBehind && (
                    <div className="thread-queue-note" role="status">Waits for “{answeringTitle}” to finish.</div>
                  )}
                  <OptimisticImagePreviews images={m.images} />
                  {m.status === 'received' && (
                    <>
                      <div className="session-msg-received-badge">Queued</div>
                      <div className="session-msg-queued-actions">
                        <button onClick={() => setEditingId(m.queueId)}>Edit</button>
                        <button onClick={() => onDeleteQueued?.(m.queueId)}>Delete</button>
                      </div>
                    </>
                  )}
                  {m.status === 'delivered' && (
                    <div className="session-msg-delivered-badge">Delivered ✓</div>
                  )}
                  {m.status === 'failed' && (
                    <>
                      <div className="session-msg-failed-badge">
                        {m.parked
                          ? `Not delivered. Auto-retry stopped${m.failedError ? ` (${m.failedError})` : ''}`
                          : `Send failed${m.failedError ? `: ${m.failedError}` : ''}`}
                      </div>
                      <div className="session-msg-queued-actions">
                        <button className="session-msg-retry-btn" onClick={() => onRetryFailed?.(m.queueId)}>Retry</button>
                        {/* A parked row still exists on disk, so Discard must delete it
                            server-side; Dismiss is local-only (the pending row it hides
                            still drains on its own). */}
                        {m.parked
                          ? <button onClick={() => onDeleteQueued?.(m.queueId)}>Discard</button>
                          : <button onClick={() => onDismissFailed?.(m.queueId)}>Dismiss</button>}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* The resolved / failed strip after the page's turns (spec 4, item 5),
            when the last answer has no Asked-from list to go before. */}
        {!stripPlaced && pageStrip}
        {/* Floating scroll-to-bottom arrow — sticky to bottom of scroll viewport */}
        <button
          className={`scroll-to-bottom-btn${showScrollArrow ? ' visible' : ''}`}
          onClick={handleScrollToBottom}
          aria-label="Scroll to bottom"
        >↓</button>
      </div>
      </ThreadStackFrame>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
    </>
  );
});
