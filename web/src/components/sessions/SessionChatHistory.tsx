import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { useEvent } from '@/hooks/useWebSocket';
import { useLightbox } from '@/hooks/useLightbox';
import { SessionMessage, PlanCard, CollapsedPlanWrite, GenericToolCall } from './SessionMessage';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Lightbox } from '../common/Lightbox';
import type { SessionHistoryMessage } from '@/types/session';
import type { ImageAttachment } from '@/api/chat';
import { renderMarkdownWithRefs, findImagePaths, resolveImagePath } from '@/utils/markdown';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SESSION CHAT — OPTIMISTIC MESSAGE LIFECYCLE & DEDUP
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ## Two data sources displayed together
 *
 * 1. **Persisted history** (`messages`): Fetched from `/api/sessions/:id/history`.
 *    Server reads the Claude Code JSONL output file and parses it into messages.
 *    This is the source of truth after a turn completes.
 *
 * 2. **Optimistic messages** (`optimisticMessages`): Client-side state managed by
 *    `useSessionSend`. Shown immediately when the user sends a message, before
 *    the JSONL contains it.
 *
 * ## Optimistic message status lifecycle
 *
 *   pending → received → delivered → committed → (deduped away)
 *
 *   - **pending**: User hit send. Message exists only in React state. Grey styling.
 *   - **received**: Server acknowledged the WS RPC. queueId updated to real messageId.
 *     Shows "Queued" badge with Edit/Delete actions.
 *   - **delivered**: Server wrote to FIFO or spawned --resume. Message is in Claude's
 *     stdin. Shows "Delivered ✓" badge.
 *   - **committed**: Turn completed (session:batch-completed). The CLI has consumed
 *     the message. Renders as a normal user message in the timeline.
 *   - **deduped**: When the re-fetched persisted history contains this message,
 *     the dedup filter removes the optimistic copy. The persisted copy takes over.
 *
 * ## How Claude Code JSONL records user messages
 *
 * Claude Code CLI writes a JSONL file (one JSON object per line). There are two
 * ways user messages appear in JSONL:
 *
 * **Pattern A — FIFO delivery during a running turn (mid-stream messages):**
 *   The server writes to a named FIFO pipe that Claude CLI reads as stdin.
 *   Claude CLI logs queue-operation entries:
 *     { type: "queue-operation", operation: "enqueue", content: "hi", timestamp: "..." }
 *     { type: "queue-operation", operation: "dequeue", timestamp: "..." }
 *   Then a normal `{ type: "human_turn_start", message: { role: "user", content: "hi" } }`
 *   appears. The session-history parser (server-side) matches enqueue→dequeue pairs
 *   (Pattern A) and uses the normal user message that follows, skipping the enqueue.
 *
 *   IMPORTANT: Mid-stream FIFO messages may NOT produce a user entry in JSONL if:
 *   - The CLI finishes its turn before reading the FIFO
 *   - The FIFO write succeeds but Claude doesn't process it in the current turn
 *   In these cases, the enqueue has no matching dequeue → Pattern B.
 *
 * **Pattern B — Enqueue without dequeue (message consumed between turns):**
 *   The message was enqueued to the FIFO but the turn ended before Claude processed it.
 *   The JSONL has: { type: "queue-operation", operation: "enqueue", content: "hi" }
 *   with NO matching dequeue. The session-history parser synthesizes a user message
 *   from the enqueue entry at its chronological position.
 *
 * **Pattern C — --resume delivery (message sent while no process was running):**
 *   Server spawns `claude --resume <id> -p "message"`. Claude CLI logs a normal
 *   `{ type: "human_turn_start", message: { role: "user", content: "..." } }`.
 *   These always appear in JSONL.
 *
 * ## The dedup problem and solution
 *
 * When a turn completes, we re-fetch persisted history and need to remove optimistic
 * messages that now exist in the persisted data (to avoid showing them twice).
 *
 * **The bug (fixed):** Original dedup checked optimistic message text against the
 * last 10 user texts from ALL persisted history. If the user had previously sent "hi"
 * in an earlier turn, and then sent "hi" again mid-stream, the new "hi" was
 * incorrectly matched against the OLD "hi" and removed from the timeline.
 *
 * **The fix:** Two-tier dedup based on optimistic message status:
 *
 * - **Non-committed (pending/received/delivered):** Only dedup against NEWLY APPEARED
 *   persisted messages (messages[prevMsgLen..length]). This prevents false matches
 *   against old history. `prevMsgLen` tracks the persisted message count from the
 *   previous render, updated in useLayoutEffect.
 *
 * - **Committed:** Dedup against ALL persisted messages. Committed means the CLI has
 *   consumed this message, so its persisted counterpart exists somewhere in history.
 *   This handles multi-batch scenarios where prevMsgLen has advanced past the
 *   committed message's corresponding persisted entry.
 *
 * Both tiers use count-based (multiset) matching: if the user sends "hi" twice and
 * JSONL contains one "hi", only one optimistic "hi" is removed.
 *
 * ## Turn boundary sequence (useLayoutEffect)
 *
 * When session:batch-completed fires → setHistoryVersion(+1) → history re-fetched:
 *
 * Render 1 (messages grow):
 *   useLayoutEffect fires → clear() (blocks=[]), blockIndexMap.clear(),
 *   onBatchCompleted(count) → promotes optimistic to committed.
 *   prevMsgLen NOT updated here (stays at old value).
 *
 * Render 2 (batched state updates from Render 1):
 *   blocks=[], optimistic now has committed messages.
 *   Dedup runs: committed messages matched against ALL persisted (removed if found).
 *   Non-committed matched against new messages only (prevMsgLen still old → correct).
 *   prevMsgLen updated in the else branch (no awaitingRefresh).
 *
 * ## prevMsgLen update timing (critical)
 *
 * prevMsgLen is intentionally NOT updated in the batch-completed path of useLayoutEffect.
 * The batch completion triggers re-renders (from clear() and onBatchCompleted()).
 * Those re-renders must still see prevMsgLen = old value so the dedup scan covers
 * the newly appeared messages and removes committed optimistic messages that now
 * exist in persisted history.
 *
 * ## handleBatchCompleted (useSessionSend)
 *
 * 1. Removes previously committed messages (from earlier batches — now in persisted
 *    history, keeping them causes duplicates since prevMsgLen has advanced).
 * 2. Promotes the first `count` non-committed messages to 'committed'.
 *
 * ## Unified timeline (buildTimeline)
 *
 * All optimistic messages (active + committed) participate in the timeline via
 * blockIndexMap — a Map<queueId, number> where the value is blocks.length at the
 * time the message was created. This preserves the message's visual position
 * relative to streaming blocks (interleaving). blockIndexMap is set once per
 * message and cleared on turn boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export interface OptimisticMessage extends SessionHistoryMessage {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'committed';
  images?: ImageAttachment[];
}

/** Renders base64 image thumbnails for optimistic messages */
function OptimisticImagePreviews({ images }: { images?: ImageAttachment[] }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="chat-image-previews" style={{ padding: '0 16px 8px' }}>
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
  workStatus?: string;
  /** Initial prompt text to display at the top of the timeline (first user message). */
  initialPrompt?: string;
  /** Session working directory — used to resolve relative image paths in tool results */
  sessionCwd?: string;
  optimisticMessages?: OptimisticMessage[];
  onMessagesDelivered?: (count: number) => void;
  onBatchCompleted?: (count: number) => void;
  onEditQueued?: (queueId: string, newText: string) => void;
  onDeleteQueued?: (queueId: string) => void;
  onAgentQueued?: (msg: { queueId: string; text: string }) => void;
  onClearCommitted?: () => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

/** Memoized text block that caches renderMarkdownWithRefs output */
function StreamingTextBlock({ content, sessionCwd, onTaskClick, onSessionClick }: { content: string; sessionCwd?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void }) {
  const navigate = useNavigate();
  const html = useMemo(() => renderMarkdownWithRefs(content), [content]);
  const imagePaths = useMemo(() => findImagePaths(content), [content]);
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        e.preventDefault();
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
      return;
    }
    const sessionAnchor = target.closest('a.session-link') as HTMLAnchorElement | null;
    if (sessionAnchor) {
      const sessionId = sessionAnchor.dataset.sessionId;
      if (sessionId) {
        e.preventDefault();
        onSessionClick ? onSessionClick(sessionId) : navigate(`/sessions?id=${sessionId}`);
      }
    }
  }, [navigate, onTaskClick, onSessionClick]);
  return (
    <>
      <div
        className="markdown-body"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {imagePaths.length > 0 && (
        <div className="tool-result-images">
          {imagePaths.map((p, i) => {
            const src = `/api/local-image?path=${encodeURIComponent(resolveImagePath(p, sessionCwd))}`;
            return (
              <div key={i} className="tool-result-image-item">
                <img src={src} className="inline-image" data-lightbox-src={src} loading="lazy" />
                <span className="inline-image-path">{p}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Render a single streaming block */
const StreamingBlockView = memo(function StreamingBlockView({ block, sessionCwd, onTaskClick, onSessionClick }: { block: StreamingBlock; sessionCwd?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void }) {
  if (block.type === 'text') {
    return <StreamingTextBlock content={block.content} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />;
  }

  if (block.type === 'system') {
    const icon = block.variant === 'error' ? '\u26A0\uFE0F'
      : block.variant === 'compact' ? '\u2699\uFE0F' : '\u2713';
    return (
      <div className={`session-system-line session-system-line--${block.variant}`}>
        <span className="session-system-icon">{icon}</span>
        <span className="session-system-text">{block.message}</span>
        {block.detail && <span className="session-system-detail">{block.detail}</span>}
      </div>
    );
  }

  // ExitPlanMode with plan content → PlanCard (check planContent field, then input.plan)
  if (block.name === 'ExitPlanMode') {
    const content = block.planContent
      ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : null);
    if (content) {
      return <PlanCard content={content} />;
    }
  }

  // Write to plans → collapsed row
  if (block.name === 'Write' && typeof block.input?.file_path === 'string'
    && block.input.file_path.includes('.claude/plans/')) {
    return <CollapsedPlanWrite filePath={block.input.file_path} />;
  }

  // Tool call block — reuse GenericToolCall for full expand/collapse support
  const toolObj = { name: block.name ?? 'unknown', input: block.input ?? {} };
  const status = block.status === 'error' ? 'error' : block.status === 'done' ? 'done' : 'calling';
  return (
    <GenericToolCall
      tool={toolObj}
      status={status}
      result={block.result}
      sessionCwd={sessionCwd}
      onTaskClick={onTaskClick}
      onSessionClick={onSessionClick}
    />
  );
});

/** A streaming Task group — collapsible container for child blocks during live streaming */
interface StreamingTaskGroupProps {
  taskBlock: StreamingBlock & { type: 'tool_call' };
  childBlocks: StreamingBlock[];
  sessionCwd?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

function StreamingTaskGroup({ taskBlock, childBlocks, sessionCwd, onTaskClick, onSessionClick }: StreamingTaskGroupProps) {
  const [open, setOpen] = useState(true); // Default open during streaming
  const description = typeof taskBlock.input?.description === 'string'
    ? taskBlock.input.description
    : typeof taskBlock.input?.prompt === 'string'
      ? (taskBlock.input.prompt as string).slice(0, 80) + ((taskBlock.input.prompt as string).length > 80 ? '...' : '')
      : 'Task';
  const subagentType = typeof taskBlock.input?.subagent_type === 'string' ? taskBlock.input.subagent_type : '';
  const isDone = taskBlock.status === 'done';
  const isError = taskBlock.status === 'error';
  const toolCount = childBlocks.filter(b => b.type === 'tool_call').length;

  return (
    <div className={`task-group ${open ? 'task-group--open' : ''} ${isDone ? 'task-group--done' : ''} ${isError ? 'task-group--error' : ''}`}>
      <button className="task-group-header" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="task-group-icon">
          {isError ? '\u2717' : isDone ? '\u2713' : '\u25B6'}
        </span>
        <span className="task-group-label">{taskBlock.name}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        <span className="task-group-description">{description}</span>
        {!open && toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
        {!isDone && !isError && <span className="task-group-streaming-dot" />}
      </button>
      {open && (
        <div className="task-group-body">
          {childBlocks.map((child, ci) => (
            <StreamingBlockView key={ci} block={child} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
          ))}
          {childBlocks.length === 0 && !isDone && (
            <div className="task-group-empty">Working...</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Group streaming blocks by parentToolUseId.
 * Returns an array of "grouped items": either a standalone block or a task group.
 */
type GroupedStreamItem =
  | { kind: 'block'; block: StreamingBlock; index: number }
  | { kind: 'task-group'; taskBlock: StreamingBlock & { type: 'tool_call' }; childBlocks: StreamingBlock[]; index: number };

/** Tool names whose streaming child blocks should be grouped under them. */
const GROUPABLE_STREAM_TOOLS = new Set(['Task', 'Agent']);

function groupStreamingBlocks(blocks: StreamingBlock[]): GroupedStreamItem[] {
  // Find all groupable tool_call blocks (Task, Agent) — these are potential parents
  const parentToolUseIds = new Set<string>();
  for (const b of blocks) {
    if (b.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(b.name)) {
      parentToolUseIds.add(b.toolUseId);
    }
  }

  if (parentToolUseIds.size === 0) {
    // No groupable blocks — return flat list
    return blocks.map((block, index) => ({ kind: 'block', block, index }));
  }

  // Group child blocks under their parent
  const childBlocksByParent = new Map<string, StreamingBlock[]>();
  const consumedIndices = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'tool_call' && b.parentToolUseId && parentToolUseIds.has(b.parentToolUseId)) {
      const arr = childBlocksByParent.get(b.parentToolUseId);
      if (arr) arr.push(b);
      else childBlocksByParent.set(b.parentToolUseId, [b]);
      consumedIndices.add(i);
    }
  }

  // Build grouped result
  const result: GroupedStreamItem[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (consumedIndices.has(i)) continue;
    const b = blocks[i];
    if (b.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(b.name)) {
      result.push({
        kind: 'task-group',
        taskBlock: b,
        childBlocks: childBlocksByParent.get(b.toolUseId) ?? [],
        index: i,
      });
    } else {
      result.push({ kind: 'block', block: b, index: i });
    }
  }
  return result;
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
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(value.trim() || message); }
          if (e.key === 'Escape') onCancel();
        }}
        className="session-msg-edit-textarea"
        rows={2}
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

/**
 * Interleave streaming blocks and active optimistic messages by blockIndex.
 * Each user message was sent at a specific blocks.length — it renders at that position.
 */
function buildTimeline(
  blocks: StreamingBlock[],
  activeOptimistic: OptimisticMessage[],
  blockIndexMap: Map<string, number>,
  isStreaming: boolean,
  isResuming: boolean,
): TimelineItem[] {
  const items: TimelineItem[] = [];

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
    items.push({ kind: 'block', block: blocks[i], index: i });
  }

  // Trailing user messages (blockIndex >= blocks.length — sent after all current blocks)
  const trailingIndices = [...usersByIndex.keys()].filter(k => k >= blocks.length).sort((a, b) => a - b);
  for (const idx of trailingIndices) {
    for (const msg of usersByIndex.get(idx)!) {
      items.push({ kind: 'user', msg });
    }
  }

  // Streaming/resuming indicator when no blocks yet
  if (blocks.length === 0) {
    if (isResuming && !isStreaming) {
      items.push({ kind: 'indicator', type: 'resuming' });
    } else if (isStreaming) {
      items.push({ kind: 'indicator', type: 'working' });
    }
  }

  return items;
}

// ── Auto-scroll constants ──
const SCROLL_THRESHOLD = 300;  // px from bottom to consider "near bottom"
const USER_SCROLL_LOCK_MS = 15_000;  // pause auto-scroll for 15s when user scrolls up

export function SessionChatHistory({ sessionId, workStatus, initialPrompt, sessionCwd, optimisticMessages, onMessagesDelivered, onBatchCompleted, onEditQueued, onDeleteQueued, onAgentQueued, onClearCommitted, onTaskClick, onSessionClick }: SessionChatHistoryProps) {
  const [historyVersion, setHistoryVersion] = useState(0);
  const awaitingRefresh = useRef(false);
  const pendingBatchTotal = useRef(0);
  const prevMsgLen = useRef(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { lightboxSrc, openLightbox, closeLightbox } = useLightbox();

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

  const { messages, loading, phase2Pending, error } = useSessionHistory(sessionId, historyVersion);
  const { blocks, isStreaming, clear } = useSessionStream(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Message delivery lifecycle ──
  // 1. User sends → optimistic msg added (status: 'pending', grey)
  // 2. Server delivers to CLI (FIFO/resume) → 'session:messages-delivered' → status: 'delivered' (normal)
  // 3. Turn completes → 'session:batch-completed' → promote to committed, refresh history

  // Messages delivered to CLI: transition from grey (pending) to normal (delivered).
  useEvent('session:messages-delivered', (data) => {
    const d = data as { sessionId?: string; count?: number };
    if (d.sessionId === sessionId) {
      onMessagesDelivered?.(d.count ?? 1);
    }
  });

  // Turn completed: promote messages to committed and refresh history.
  const batchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent('session:batch-completed', (data) => {
    const d = data as { sessionId?: string; count?: number };
    if (d.sessionId === sessionId) {
      pendingBatchTotal.current += (d.count ?? 1);
      awaitingRefresh.current = true;
      setHistoryVersion((v) => v + 1);
      // Fallback: if JSONL history doesn't grow (FIFO-injected messages not in output),
      // force-clear after 1s. The batch count is authoritative.
      if (batchTimeoutRef.current) clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = setTimeout(() => {
        if (awaitingRefresh.current && pendingBatchTotal.current > 0) {
          awaitingRefresh.current = false;
          onBatchCompleted?.(pendingBatchTotal.current);
          pendingBatchTotal.current = 0;
        }
      }, 1000);
    }
  });

  // Errors: also trigger history refresh so optimistic messages clear
  useEvent('session:error', (data) => {
    if ((data as { sessionId?: string }).sessionId === sessionId) {
      awaitingRefresh.current = true;
      setHistoryVersion((v) => v + 1);
    }
  });

  // Agent-sent messages: create synthetic optimistic message so it appears in the queue
  useEvent('session:message-queued', (data) => {
    const d = data as { sessionId?: string; messageId?: string; message?: string; source?: string };
    if (d.sessionId === sessionId && d.source !== 'ui' && d.messageId && d.message) {
      onAgentQueued?.({ queueId: d.messageId, text: d.message });
    }
  });

  // Zero-flash cleanup (runs before browser paints).
  // When session:batch-completed fires, the backend has authoritatively consumed N messages
  // from the queue. Clear streaming blocks and promote optimistic messages to 'committed'
  // once the re-fetched history grows.
  //
  // FIFO-injected user messages appear as queue-operation entries in the JSONL, so they're
  // now included in the persisted history at their correct chronological positions. The dedup
  // logic (recentUserTexts) absorbs committed messages once the re-fetched history contains
  // them. All optimistic messages live in the timeline (not a separate section) to maintain
  // their interleaved positions during the transition.
  useLayoutEffect(() => {
    if (awaitingRefresh.current && messages.length > prevMsgLen.current) {
      awaitingRefresh.current = false;
      clear();
      blockIndexMap.current.clear(); // Reset for next turn
      onBatchCompleted?.(pendingBatchTotal.current);
      pendingBatchTotal.current = 0;
      // Do NOT update prevMsgLen here. The batch completion triggers re-renders
      // (from clear() and onBatchCompleted()). Those re-renders must still see
      // prevMsgLen = old value so the dedup scan covers the newly appeared messages
      // and removes the committed optimistic message (prevents Pattern A duplicate).
    } else {
      prevMsgLen.current = messages.length;
    }
  }, [messages, clear, onBatchCompleted]);

  // Track which sessionId we last scrolled to bottom for — prevents stale-data scroll
  // when sessionId changes without key (e.g., TaskDetailPage), and gates delayed retries.
  const scrolledForSessionRef = useRef<string | null>(null);

  // ── Smart auto-scroll refs (declared early so session-switch reset can clear them) ──
  const userScrollLockUntil = useRef(0); // timestamp when lock expires
  const lastScrollTop = useRef(0);
  const programmaticScrollUntil = useRef(0); // timestamp-based guard for programmatic scrolls
  // Deadline for initial auto-scroll window — after initial scroll, we keep correcting
  // for up to 2s to handle CSS transitions, Phase 2 data, initialPrompt, image loads.
  const initialScrollDeadline = useRef(0);

  // Reset on session switch (consolidated — includes scroll flag + blockIndexMap + scroll lock)
  useEffect(() => {
    setHistoryVersion(0);
    awaitingRefresh.current = false;
    pendingBatchTotal.current = 0;
    prevMsgLen.current = 0;
    setEditingId(null);
    scrolledForSessionRef.current = null;
    blockIndexMap.current.clear();
    userScrollLockUntil.current = 0;
    lastScrollTop.current = 0;
    programmaticScrollUntil.current = 0;
    initialScrollDeadline.current = 0;
    if (batchTimeoutRef.current) { clearTimeout(batchTimeoutRef.current); batchTimeoutRef.current = null; }
  }, [sessionId]);

  // Cleanup timeout on unmount
  useEffect(() => () => { if (batchTimeoutRef.current) clearTimeout(batchTimeoutRef.current); }, []);

  // Helper: scroll to bottom and mark as programmatic (suppresses user-scroll detection for 100ms)
  const scrollToBottom = (el: HTMLElement) => {
    programmaticScrollUntil.current = Date.now() + 100;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  };

  // Scroll to bottom on initial load — useLayoutEffect fires BEFORE paint so the user
  // never sees a flash of the chat scrolled to top.
  // Guard: only scroll when the messages belong to the CURRENT sessionId (prevents stale-data scroll
  // when the component updates in-place without key={sessionId}).
  useLayoutEffect(() => {
    if (!loading && messages.length > 0 && containerRef.current
      && scrolledForSessionRef.current !== sessionId) {
      scrolledForSessionRef.current = sessionId;
      initialScrollDeadline.current = Date.now() + 2000; // 2s auto-scroll correction window
      scrollToBottom(containerRef.current);
    }
  }, [loading, messages, sessionId]);

  // ── Resilient scroll correction via ResizeObserver + MutationObserver ──
  // After the initial scroll, content can shift due to:
  //   - CSS width transition on sessions area (250ms from collapsed → visible)
  //   - Phase 2 history data replacing Phase 1 (async, different message set)
  //   - initialPrompt prop arriving (adds content at the top of the container)
  //   - Images / code blocks loading (async height changes)
  // Instead of fragile fixed-delay timers (150ms/400ms), observe actual DOM changes
  // and re-scroll reactively during a 2s window after the initial scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || scrolledForSessionRef.current !== sessionId) return;
    if (!initialScrollDeadline.current) return;

    // Past the deadline: do one final scroll correction and stop
    if (Date.now() > initialScrollDeadline.current) {
      if (userScrollLockUntil.current < Date.now()) {
        scrollToBottom(el);
      }
      return;
    }

    // Within the 2s window: observe DOM changes and re-scroll reactively.
    // Only scroll if still at top (scrollTop=0, never scrolled visually) or near bottom.
    // This respects user scroll-up: if user scrolled to the middle, don't override.
    const tryScroll = () => {
      const target = containerRef.current;
      if (!target || target.scrollHeight <= target.clientHeight) return;
      const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - SCROLL_THRESHOLD;
      const stillAtTop = target.scrollTop === 0;
      if (!nearBottom && !stillAtTop) return; // user scrolled to middle — respect it
      scrollToBottom(target);
    };

    // Immediate correction on this render
    tryScroll();

    // ResizeObserver: fires when container dimensions change (CSS transition, flex reflow)
    const ro = new ResizeObserver(tryScroll);
    ro.observe(el);

    // MutationObserver: fires when child elements change (new messages, initialPrompt, images)
    const mo = new MutationObserver(tryScroll);
    mo.observe(el, { childList: true, subtree: true });

    // Auto-disconnect when deadline expires
    const remaining = Math.max(100, initialScrollDeadline.current - Date.now() + 100);
    const timer = setTimeout(() => {
      ro.disconnect();
      mo.disconnect();
      // Final scroll after observers disconnect
      tryScroll();
    }, remaining);

    return () => {
      ro.disconnect();
      mo.disconnect();
      clearTimeout(timer);
    };
  }, [loading, messages, sessionId]);

  // ── Render-based scroll correction ──
  // Catches layout shifts from siblings (e.g., UserMessagesSummary growing above the scroll
  // container, squeezing its height) that observers on the container itself might miss due to
  // effect cleanup timing. Runs on every render but only does work during the 2s initial window.
  useEffect(() => {
    if (scrolledForSessionRef.current !== sessionId) return;
    if (!initialScrollDeadline.current || Date.now() > initialScrollDeadline.current) return;
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el || el.scrollHeight <= el.clientHeight) return;
      if (userScrollLockUntil.current > Date.now()) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
      const stillAtTop = el.scrollTop === 0;
      if (nearBottom || stillAtTop) scrollToBottom(el);
    });
    return () => cancelAnimationFrame(raf);
  }); // intentionally no deps — runs every render during the 2s window

  // ── Smart auto-scroll: scroll to bottom on new content, but pause when user scrolls up ──
  // When the user manually scrolls up, we lock auto-scroll for USER_SCROLL_LOCK_MS.
  // After the lock expires, the next new content triggers auto-scroll to bottom.
  // User scrolling back to bottom clears the lock immediately.

  // Detect user scroll-up: set a 15s lock.
  // Re-attaches when loading finishes (containerRef becomes available).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore programmatic scrolls (timestamp-based guard, robust against multi-fire)
      if (Date.now() < programmaticScrollUntil.current) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
      // User scrolled up away from bottom → lock auto-scroll
      if (!nearBottom && el.scrollTop < lastScrollTop.current) {
        userScrollLockUntil.current = Date.now() + USER_SCROLL_LOCK_MS;
      }
      // User scrolled back to bottom manually → clear lock
      if (nearBottom) {
        userScrollLockUntil.current = 0;
      }
      lastScrollTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loading]); // re-run when loading finishes so containerRef.current is available

  // Auto-scroll on new streaming content, respecting the user-scroll lock
  const streamScrollRaf = useRef<number | null>(null);
  useEffect(() => {
    if ((isStreaming || (optimisticMessages && optimisticMessages.length > 0)) && containerRef.current) {
      if (streamScrollRaf.current !== null) cancelAnimationFrame(streamScrollRaf.current);
      streamScrollRaf.current = requestAnimationFrame(() => {
        streamScrollRaf.current = null;
        const el = containerRef.current;
        if (!el) return;
        // If user-scroll lock is active, don't auto-scroll
        if (userScrollLockUntil.current > Date.now()) return;
        // Lock expired or never set → scroll to bottom
        scrollToBottom(el);
      });
    }
  }, [blocks, isStreaming, optimisticMessages]);

  useEffect(() => {
    return () => {
      if (streamScrollRaf.current !== null) {
        cancelAnimationFrame(streamScrollRaf.current);
        streamScrollRaf.current = null;
      }
    };
  }, []);

  // ── Deduplicate optimistic messages against persisted history ──
  // Non-committed messages: only dedup against NEWLY APPEARED messages ([prevMsgLen..length)).
  // This prevents old persisted messages (e.g., a previous "hi" from an earlier turn)
  // from incorrectly absorbing a new mid-stream "hi" optimistic message.
  // Committed messages: dedup against ALL persisted messages. Committed means the CLI
  // has consumed the message, so its persisted counterpart exists somewhere in history.
  // This handles multi-batch scenarios where prevMsgLen has advanced past the committed
  // message's corresponding persisted entry.
  // Uses count-based (multiset) matching so duplicate texts dedup correctly.
  const allOptimistic = optimisticMessages ?? [];
  const newUserTextCounts = new Map<string, number>();
  for (let i = prevMsgLen.current; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      const t = messages[i].text;
      newUserTextCounts.set(t, (newUserTextCounts.get(t) ?? 0) + 1);
    }
  }
  // Full persisted text counts — used only for committed message dedup
  const allUserTextCounts = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'user') {
      allUserTextCounts.set(m.text, (allUserTextCounts.get(m.text) ?? 0) + 1);
    }
  }

  const deduped = allOptimistic.filter(m => {
    if (m.status === 'committed') {
      // Committed: dedup against ALL persisted messages (safe — CLI consumed it)
      const c = allUserTextCounts.get(m.text);
      if (c && c > 0) {
        allUserTextCounts.set(m.text, c - 1);
        return false;
      }
      return true;
    }
    // Non-committed: only dedup against new messages (avoids false positives)
    const c = newUserTextCounts.get(m.text);
    if (c && c > 0) {
      newUserTextCounts.set(m.text, c - 1);
      return false; // absorbed by a newly persisted message
    }
    return true; // not in new persisted messages — keep in timeline
  });

  // ── Assign blockIndex for ALL non-deduped optimistic messages (set once, never updated) ──
  // Both active AND committed messages stay in the timeline to preserve their interleaved
  // positions. Committed messages keep their blockIndex from when they were created.
  for (const msg of deduped) {
    if (!blockIndexMap.current.has(msg.queueId)) {
      blockIndexMap.current.set(msg.queueId, blocks.length);
    }
  }
  // Clean stale entries for messages no longer in optimistic state
  const dedupedIds = new Set(deduped.map(m => m.queueId));
  for (const key of blockIndexMap.current.keys()) {
    if (!dedupedIds.has(key)) blockIndexMap.current.delete(key);
  }

  // ── Build interleaved timeline ──
  // All optimistic messages (active + committed) participate in the timeline
  // so committed messages keep their correct visual position until deduped.
  const isResuming = !isStreaming && workStatus === 'in_progress'
    && deduped.some(m => m.status !== 'committed');
  const timeline = buildTimeline(blocks, deduped, blockIndexMap.current, isStreaming, isResuming);

  const hasContent = messages.length > 0 || timeline.length > 0 || isStreaming
    || deduped.length > 0;

  // Always mount the scroll container so containerRef is available for scroll effects.
  // Remote sessions have a gap between Phase 1 (empty, local streams) and Phase 2 (SSH fetch)
  // where containerRef was previously null, breaking auto-scroll.
  return (
    <>
      <div className="session-history" ref={containerRef} onClick={handleContainerClick}>
        {/* Loading / empty / error states rendered INSIDE the scroll container */}
        {loading && messages.length === 0 && blocks.length === 0 && <LoadingSpinner />}
        {error && (
          <div className="session-history-empty">
            <p className="text-muted">Failed to load history: {error}</p>
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
        {/* Initial prompt — the first user message that started this session */}
        {initialPrompt && (
          <div className="session-msg session-msg-user session-initial-prompt">
            <div className="session-msg-header">
              <span className="session-msg-role">You</span>
              <span className="session-initial-prompt-label">Initial Prompt</span>
            </div>
            <div className="session-msg-content">
              <div className="markdown-body">{initialPrompt}</div>
            </div>
          </div>
        )}
        {/* Persisted history messages */}
        {messages.map((m, i) => (
          <div key={i} data-msg-index={i}>
            <SessionMessage message={m} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
          </div>
        ))}

        {/* Turn timeline — interleaved blocks + ALL optimistic messages by blockIndex.
            Both active (pending/received/delivered) and committed messages stay in the timeline
            to preserve their correct visual positions until deduped by persisted history. */}
        {timeline.length > 0 && (
          <div className="session-streaming-panel">
            {(() => {
              // Pre-group streaming blocks by parentToolUseId for Task grouping
              const groupedBlocks = groupStreamingBlocks(blocks);
              // Build a lookup: block original index → grouped item
              const groupedByIndex = new Map<number, GroupedStreamItem>();
              const consumedBlockIndices = new Set<number>();
              for (const g of groupedBlocks) {
                if (g.kind === 'task-group') {
                  groupedByIndex.set(g.index, g);
                  // Mark child block indices as consumed so they don't render separately
                  for (const child of g.childBlocks) {
                    if (child.type === 'tool_call') {
                      const childIdx = blocks.indexOf(child);
                      if (childIdx >= 0) consumedBlockIndices.add(childIdx);
                    }
                  }
                }
              }

              return timeline.map((item, i) => {
              if (item.kind === 'indicator') {
                return (
                  <div key={`ind-${item.type}`} className="session-streaming-indicator">
                    <span className="session-streaming-dot" />
                    {item.type === 'resuming' ? 'Resuming session...' : 'Walnut is working...'}
                  </div>
                );
              }

              if (item.kind === 'block') {
                // Skip blocks that were consumed into a task group
                if (consumedBlockIndices.has(item.index)) return null;

                // Check if this block is a Task group parent
                const grouped = groupedByIndex.get(item.index);
                if (grouped && grouped.kind === 'task-group') {
                  const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                  const isInLastGroup = !timeline.slice(i).some(t => t.kind === 'user');
                  return (
                    <div key={`tg-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      {isFirst && (
                        <div className="session-msg-header">
                          <span className="session-msg-role">Walnut</span>
                          {isStreaming && isInLastGroup && <span className="session-streaming-badge">Streaming</span>}
                        </div>
                      )}
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <StreamingTaskGroup
                          taskBlock={grouped.taskBlock}
                          childBlocks={grouped.childBlocks}
                          sessionCwd={sessionCwd}
                          onTaskClick={onTaskClick}
                          onSessionClick={onSessionClick}
                        />
                      </div>
                    </div>
                  );
                }

                // Regular block rendering
                // Group consecutive blocks under one assistant header.
                // Show header on first block in each consecutive run.
                // "Streaming" badge only on the last block's group header.
                const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                const isInLastGroup = !timeline.slice(i).some(t => t.kind === 'user');
                return (
                  <div key={`b-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                    {isFirst && (
                      <div className="session-msg-header">
                        <span className="session-msg-role">Walnut</span>
                        {isStreaming && isInLastGroup && <span className="session-streaming-badge">Streaming</span>}
                      </div>
                    )}
                    <div className={isFirst ? 'session-msg-content' : ''}>
                      <StreamingBlockView block={item.block} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
                    </div>
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
                : m.status === 'delivered' ? 'session-msg-delivered' : '';

              return (
                <div key={`u-${m.queueId}`} className={wrapperClass}>
                  <SessionMessage message={m} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
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
                </div>
              );
            });
            })()}
          </div>
        )}
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
    </>
  );
}
