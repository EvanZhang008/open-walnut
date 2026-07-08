import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { useEvent } from '@/hooks/useWebSocket';
import { useLightbox } from '@/hooks/useLightbox';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { SessionMessage, PlanCard, CollapsedPlanWrite, GenericToolCall } from './SessionMessage';
import { dedupeOptimisticMessages } from './optimistic-dedup';
import { TeamCard } from './TeamCard';
import { WorkflowProgress } from './WorkflowProgress';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Lightbox } from '../common/Lightbox';
import type { SessionHistoryMessage } from '@/types/session';
import type { ImageAttachment } from '@/api/chat';
import { respondToPermission } from '@/api/sessions';
import { renderMarkdownWithRefs, findImagePaths, resolveImagePath } from '@/utils/markdown';
import { log } from '@/utils/log';

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
 *   pending → received → delivered → (removed by handleBatchCompleted)
 *
 *   - **pending**: User hit send. Message exists only in React state. Grey styling.
 *   - **received**: Server acknowledged the WS RPC. queueId updated to real messageId.
 *     Shows "Queued" badge with Edit/Delete actions.
 *   - **delivered**: Server wrote to FIFO or spawned --resume. Message is in Claude's
 *     stdin. Shows "Delivered" badge.
 *   - **removed**: When the turn completes (session:batch-completed), the first N
 *     optimistic messages are removed outright (count-based). The re-fetched
 *     persisted history already contains them.
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
 * **The fix:** Window-based dedup — only scan NEWLY APPEARED persisted messages
 * (messages[prevMsgLen..length]) when matching optimistic messages. This prevents
 * false matches against old history. `prevMsgLen` tracks the persisted message
 * count from the previous render, updated in useLayoutEffect.
 *
 * Count-based (multiset) matching: if the user sends "hi" twice and JSONL
 * contains one "hi", only one optimistic "hi" is removed.
 *
 * ## Turn boundary sequence (useLayoutEffect)
 *
 * When session:batch-completed fires → setHistoryVersion(+1) → history re-fetched:
 *
 * Render 1 (messages grow):
 *   useLayoutEffect fires → clearCompleted() — TURN-AWARE: drops only blocks
 *   before the last session:result boundary. Blocks of a next turn that started
 *   streaming during the (possibly multi-second) history refetch survive, and
 *   blockIndexMap anchors are shifted down by the removed count. (A full clear()
 *   here caused the "previous messages vanish while a new one is generating,
 *   then flash back" bug.)
 *   prevMsgLen NOT updated here (stays at old value).
 *
 * Render 2 (batched state updates from Render 1):
 *   blocks=[]. Dedup runs: optimistic messages matched against new persisted
 *   messages only (prevMsgLen still old → correct window).
 *   prevMsgLen updated in the else branch (no awaitingRefresh).
 *
 * ## prevMsgLen update timing (critical)
 *
 * prevMsgLen is intentionally NOT updated in the batch-completed path of useLayoutEffect.
 * The batch completion triggers re-renders (from clear()). Those re-renders must
 * still see prevMsgLen = old value so the dedup scan window covers the newly
 * appeared messages.
 *
 * ## handleBatchCompleted (useSessionSend)
 *
 * Removes exactly the batch's optimistic messages (id-first via messageIds,
 * count fallback) — see optimistic-dedup.ts.
 *
 * ## Unified timeline (buildTimeline)
 *
 * All optimistic messages participate in the timeline via
 * blockIndexMap — a Map<queueId, number> where the value is blocks.length at the
 * time the message was created. This preserves the message's visual position
 * relative to streaming blocks (interleaving). blockIndexMap is set once per
 * message and cleared on turn boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export interface OptimisticMessage extends SessionHistoryMessage {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  images?: ImageAttachment[];
  /** Error message when status is 'failed' */
  failedError?: string;
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
  onAgentQueued?: (msg: { queueId: string; text: string }) => void;
  onRetryFailed?: (queueId: string) => void;
  onDismissFailed?: (queueId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
  /** Bubbles the hook's isStreaming up so parents don't need to mount their
   *  own useSessionStream (which would double RPCs + defensive-clear paths). */
  onStreamingChange?: (isStreaming: boolean) => void;
}

/** Memoized text block that caches renderMarkdownWithRefs output */
function StreamingTextBlock({ content, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: { content: string; sessionCwd?: string; sessionHost?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  const html = useMemo(() => renderMarkdownWithRefs(content, sessionCwd), [content, sessionCwd]);
  const imagePaths = useMemo(() => findImagePaths(content), [content]);
  const handleClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost);
  return (
    <>
      <div
        className="markdown-body"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {imagePaths.length > 0 && (() => {
        const resolved = imagePaths
          .map((p) => ({ p, abs: resolveImagePath(p, sessionCwd) }))
          .filter((x): x is { p: string; abs: string } => x.abs !== null);
        if (resolved.length === 0) return null;
        return (
          <div className="tool-result-images">
            {resolved.map(({ p, abs }, i) => {
              const src = `/api/local-image?path=${encodeURIComponent(abs)}`;
              return (
                <div key={i} className="tool-result-image-item">
                  <img src={src} className="inline-image" data-lightbox-src={src} loading="lazy" />
                  <span className="inline-image-path">{p}</span>
                </div>
              );
            })}
          </div>
        );
      })()}
    </>
  );
}

/** Inline permission request card — Allow/Deny buttons for sensitive operations */
function PermissionRequestCard({ sessionId, requestId, toolName, input, reason, initialStatus }: {
  sessionId: string; requestId: string; toolName: string;
  input?: Record<string, unknown>; reason?: string;
  initialStatus?: 'pending' | 'allowed' | 'denied';
}) {
  const [status, setStatus] = useState<'pending' | 'loading' | 'allowed' | 'denied'>(initialStatus && initialStatus !== 'pending' ? initialStatus : 'pending');
  const [inputExpanded, setInputExpanded] = useState(false);

  const handleResponse = async (allow: boolean) => {
    setStatus('loading');
    try {
      await respondToPermission(sessionId, requestId, allow);
      setStatus(allow ? 'allowed' : 'denied');
    } catch {
      setStatus('pending'); // revert on error
    }
  };

  const inputPreview = input ? JSON.stringify(input, null, 2) : null;

  return (
    <div className={`permission-request-card permission-request-card--${status}`}>
      <div className="permission-request-header">
        <span className="permission-request-icon">{status === 'allowed' ? '\u2713' : status === 'denied' ? '\u2717' : '\u26A0\uFE0F'}</span>
        <span className="permission-request-tool">{toolName}</span>
        {reason && <span className="permission-request-reason">{reason}</span>}
      </div>
      {inputPreview && (
        <div className="permission-request-input">
          <button className="permission-request-input-toggle" onClick={() => setInputExpanded(p => !p)}>
            {inputExpanded ? '\u25BC' : '\u25B6'} Input
          </button>
          {inputExpanded && <pre className="permission-request-input-preview">{inputPreview}</pre>}
        </div>
      )}
      {status === 'pending' && (
        <div className="permission-request-actions">
          <button className="permission-request-btn permission-request-btn--allow" onClick={() => handleResponse(true)}>Allow</button>
          <button className="permission-request-btn permission-request-btn--deny" onClick={() => handleResponse(false)}>Deny</button>
        </div>
      )}
      {status === 'loading' && (
        <div className="permission-request-resolved">Sending...</div>
      )}
      {status === 'allowed' && (
        <div className="permission-request-resolved permission-request-resolved--allowed">Allowed</div>
      )}
      {status === 'denied' && (
        <div className="permission-request-resolved permission-request-resolved--denied">Denied</div>
      )}
    </div>
  );
}

/** Render a single streaming block */
const StreamingBlockView = memo(function StreamingBlockView({ block, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: { block: StreamingBlock; sessionId: string; sessionCwd?: string; sessionHost?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  if (block.type === 'text') {
    return <StreamingTextBlock content={block.content} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
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

  if (block.type === 'permission') {
    return (
      <PermissionRequestCard
        sessionId={sessionId}
        requestId={block.requestId}
        toolName={block.toolName}
        input={block.input}
        reason={block.reason}
        initialStatus={block.status}
      />
    );
  }

  if (block.type === 'thinking') {
    // `open` by default so the user sees thinking tokens stream in live.
    // Once the turn ends the user can collapse it manually; collapsing by
    // default defeats the whole point of --include-partial-messages for
    // thinking mode.
    return (
      <details open className="session-thinking-block" style={{ margin: '6px 0', opacity: 0.7, fontStyle: 'italic', fontSize: 13, borderLeft: '2px solid rgba(128,128,128,0.3)', paddingLeft: 8 }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>thinking…</summary>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{block.content}</div>
      </details>
    );
  }

  // Below: block.type === 'tool_call'
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

  // Suppress empty placeholder tool_call blocks from old stream buffers
  // (leftover from when content_block_start early-emitted with empty input —
  // see session a9f24f9a). A `calling` block with no input keys and no result
  // is a ghost; the real block with populated input arrives from the final
  // assistant JSONL line and replaces it.
  const inputKeys = block.input ? Object.keys(block.input).length : 0;
  if (block.status === 'calling' && inputKeys === 0 && !block.result) {
    return null;
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
      sessionHost={sessionHost}
      onTaskClick={onTaskClick}
      onSessionClick={onSessionClick}
      onFileOpen={onFileOpen ? (p) => onFileOpen(p) : undefined}
    />
  );
});

/** A streaming Task group — collapsible container for child blocks during live streaming */
interface StreamingTaskGroupProps {
  taskBlock: StreamingBlock & { type: 'tool_call' };
  childBlocks: StreamingBlock[];
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

function StreamingTaskGroup({ taskBlock, childBlocks, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: StreamingTaskGroupProps) {
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
            <StreamingBlockView key={ci} block={child} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
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
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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

// ── Auto-scroll constant ──
const NEAR_BOTTOM_PX = 80;  // px from bottom to consider "at bottom"

export const SessionChatHistory = memo(function SessionChatHistory({ sessionId, phase, initialPrompt, sessionCwd, sessionHost, optimisticMessages, onMessagesDelivered, onBatchCompleted, onBatchFailed, onEditQueued, onDeleteQueued, onAgentQueued, onRetryFailed, onDismissFailed, onTaskClick, onSessionClick, onFileOpen, onStreamingChange }: SessionChatHistoryProps) {
  const [historyVersion, setHistoryVersion] = useState(0);
  const awaitingRefresh = useRef(false);
  const pendingBatchTotal = useRef(0);
  // Queue message ids accompanying pendingBatchTotal (Phase 1 id-first removal).
  // Accumulated per batch-completed event, flushed together with the count.
  const pendingBatchIds = useRef<string[]>([]);
  // Track persisted message count to detect history growth (used for dedup windowing).
  const prevMsgLen = useRef(0);
  // queueIds already matched to a persisted twin — never re-render their bubble
  // (see "Sticky consumption" at the dedup call site). Reset on session switch.
  const consumedQueueIds = useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Message truncation — render only the tail to keep DOM count low ──
  const INITIAL_RENDER_LIMIT = 30;
  const LOAD_MORE_BATCH = 50;
  const [truncationOffset, setTruncationOffset] = useState(0);
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

  const { messages, loading, phase2Pending, error, stale, forkBoundaryIndex, lastDelta } = useSessionHistory(sessionId, historyVersion);
  const { blocks, isStreaming, clearCompleted } = useSessionStream(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the freshest delta in a ref so clearCompletedAndShift (invoked from a
  // layout effect / timeout that may run a tick after the delta arrives) always
  // hands the current evidence to the promotion.
  const lastDeltaRef = useRef(lastDelta);
  lastDeltaRef.current = lastDelta;

  // Turn-boundary cleanup: EVIDENCE-BASED — remove only completed-turn blocks that
  // have a twin in the just-arrived history delta; a next turn already streaming
  // (and anything the archive hasn't caught up on) is kept (fixes "messages 1-4
  // vanish while 5 is generating, then flash back"). blockIndexMap anchors
  // optimistic messages to absolute block indices → shift down by removed count.
  const clearCompletedAndShift = useCallback(() => {
    const removed = clearCompleted(lastDeltaRef.current);
    if (removed > 0) {
      for (const [k, v] of blockIndexMap.current) {
        blockIndexMap.current.set(k, Math.max(0, v - removed));
      }
    }
  }, [clearCompleted]);

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

  // Turn completed: remove the batch's optimistic messages and refresh history.
  const batchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent('session:batch-completed', (data) => {
    const d = data as { sessionId?: string; count?: number; messageIds?: string[] };
    if (d.sessionId === sessionId) {
      log.info('stream', `batch-completed count=${d.count ?? 1} ids=${d.messageIds?.length ?? 0} blocks=${blocks.length} isStreaming=${isStreaming}`, { sessionId });
      pendingBatchTotal.current += (d.count ?? 1);
      if (d.messageIds) pendingBatchIds.current.push(...d.messageIds);
      awaitingRefresh.current = true;
      setHistoryVersion((v) => v + 1);
      // Fallback: if JSONL history doesn't grow (FIFO-injected messages not in output),
      // force-clear after timeout. The batch count is authoritative.
      // Use 5s timeout (not 1s) to avoid racing with remote session history fetches
      // which can take 2-5s over SSH. A premature fallback clears awaitingRefresh
      // but not streaming blocks, causing the same turn to appear in both persisted
      // history AND the streaming timeline (2x duplication bug).
      if (batchTimeoutRef.current) clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = setTimeout(() => {
        if (awaitingRefresh.current && pendingBatchTotal.current > 0) {
          log.info('stream', `batch fallback timeout: clearing completed blocks+awaitingRefresh`, { sessionId });
          awaitingRefresh.current = false;
          // Turn-aware: clear only the completed turn's blocks (prevents 2x
          // duplication) while preserving a next turn already streaming.
          clearCompletedAndShift();
          onBatchCompleted?.(pendingBatchTotal.current, pendingBatchIds.current.length > 0 ? [...pendingBatchIds.current] : undefined);
          pendingBatchTotal.current = 0;
          pendingBatchIds.current = [];
        }
      }, 5000);
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
      awaitingRefresh.current = true;
      setHistoryVersion((v) => v + 1);
    }
  });

  // WebSocket reconnect: re-fetch history to recover events lost during disconnect.
  // Without this, a turn that completed during disconnect would be invisible.
  // awaitingRefresh tells the useLayoutEffect below to clear streaming blocks and
  // trigger scroll-to-bottom when the re-fetched history arrives with new messages.
  useEvent('_ws:reconnected', () => {
    awaitingRefresh.current = true;
    setHistoryVersion((v) => v + 1);
  });

  // Agent-sent messages: create synthetic optimistic message so it appears in the queue
  useEvent('session:message-queued', (data) => {
    const d = data as { sessionId?: string; messageId?: string; message?: string; source?: string };
    if (d.sessionId === sessionId && d.source !== 'ui' && d.messageId && d.message) {
      onAgentQueued?.({ queueId: d.messageId, text: d.message });
    }
  });

  // Zero-flash cleanup (runs before browser paints).
  // When session:batch-completed fires, the backend has authoritatively consumed the
  // batch's messages from the queue. Clear streaming blocks and remove the matching
  // optimistic messages once the re-fetched history grows.
  //
  // FIFO-injected user messages appear as queue-operation entries in the JSONL, so they're
  // now included in the persisted history at their correct chronological positions. The dedup
  // logic absorbs delivered messages once the re-fetched history contains them.
  // All optimistic messages live in the timeline (not a separate section) to maintain
  // their interleaved positions during the transition.
  useLayoutEffect(() => {
    if (awaitingRefresh.current) {
      log.info('stream', `useLayoutEffect: awaitingRefresh=true → clearCompleted() msgs=${messages.length} prevMsgLen=${prevMsgLen.current} batchTotal=${pendingBatchTotal.current}`, { sessionId });
      awaitingRefresh.current = false;
      // Cancel the fallback timeout — the history refresh completed normally
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current);
        batchTimeoutRef.current = null;
      }
      // Turn-aware clear: only the completed turn's blocks are now in persisted
      // history. If turn N+1 started streaming during the (possibly 7s+) history
      // refetch, its blocks + optimistic anchors survive — previously a full
      // clear() here made the live turn vanish until the next snapshot restored
      // it (the "flash" the user sees).
      clearCompletedAndShift();
      onBatchCompleted?.(pendingBatchTotal.current, pendingBatchIds.current.length > 0 ? [...pendingBatchIds.current] : undefined);
      pendingBatchTotal.current = 0;
      pendingBatchIds.current = [];
      // Do NOT update prevMsgLen here. The batch completion triggers re-renders
      // (from clear() and onBatchCompleted()). Those re-renders must still see
      // prevMsgLen = old value so the dedup scan covers the newly appeared messages
      // and removes the consumed optimistic message (prevents Pattern A duplicate).
    } else {
      // Normal growth path — just track the new length. Previously we had a
      // "defensive clear" branch here to wipe stale blocks when messages grew
      // without an awaitingRefresh signal, but that branch misfired during
      // live turns whenever a stale resubscribe snapshot flipped isStreaming
      // to false (see useSessionStream.ts non-regressive sync). The proper
      // cleanup path is awaitingRefresh above; any block staleness past that
      // is now handled by the hook's own lifecycle (session:result + clear()).
      prevMsgLen.current = messages.length;
    }
  }, [messages, clearCompletedAndShift, onBatchCompleted]);

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
  const scrollRafId = useRef<number | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // ── Scroll debug logging (persisted via browser-logger → walnut logs -s browser) ──
  const sid8 = sessionId.substring(0, 8);
  const scrollLog = useCallback((layer: string, action: string, el?: HTMLElement | null) => {
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

  // Reset on session switch
  useEffect(() => {
    setHistoryVersion(0);
    awaitingRefresh.current = false;
    pendingBatchTotal.current = 0;
    pendingBatchIds.current = [];
    prevMsgLen.current = 0;
    setEditingId(null);
    setTruncationOffset(0);
    blockIndexMap.current.clear();
    consumedQueueIds.current.clear();
    isAtBottom.current = true;
    firstScrollDone.current = false;
    initialLoadDone.current = false;
    ignoreScrollUntil.current = 0;
    prevOptimisticLen.current = 0;
    setShowScrollArrow(false);
    if (scrollRafId.current !== null) { cancelAnimationFrame(scrollRafId.current); scrollRafId.current = null; }
    if (batchTimeoutRef.current) { clearTimeout(batchTimeoutRef.current); batchTimeoutRef.current = null; }
    if (resizeTimerRef.current) { clearTimeout(resizeTimerRef.current); resizeTimerRef.current = null; }
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (batchTimeoutRef.current) clearTimeout(batchTimeoutRef.current);
    if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
  }, []);

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

  // Scroll handler: track whether user is near bottom.
  // Ignores scroll events caused by container resizes (which corrupt isAtBottom).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevArrowState = false;
    let lastLoggedAtBot: boolean | null = null;
    const onScroll = () => {
      // Skip scroll events triggered by ResizeObserver-induced geometry shifts
      if (Date.now() < ignoreScrollUntil.current) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
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
      const nextArrow = !nearBottom && el.scrollHeight > el.clientHeight;
      if (nextArrow !== prevArrowState) {
        prevArrowState = nextArrow;
        setShowScrollArrow(nextArrow);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [sid8]);

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
    const forceScroll = phase2PendingRef.current && !initialLoadDone.current;
    if (!forceScroll && !isAtBottom.current) return;
    // Suppress resize-induced scroll events during debounce window
    ignoreScrollUntil.current = Date.now() + 350;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const el = containerRef.current;
      const force = phase2PendingRef.current && !initialLoadDone.current;
      if (!el || (!force && !isAtBottom.current)) {
        if (!isAtBottom.current && !force) scrollLog('debounced', `SKIP(${reason})`, el);
        return;
      }
      el.scrollTop = el.scrollHeight;
      isAtBottom.current = true;
      scrollLog('debounced', `SCROLL(${reason}${force ? ',forced' : ''})`, el);
    }, 250);
  }, [scrollLog]);

  // Path A-0: User just sent a message — force follow-bottom so the sent message
  // and subsequent streaming response are visible. Runs before A-1 so isAtBottom
  // is already true when the content-change scroll fires.
  useLayoutEffect(() => {
    const len = optimisticMessages?.length ?? 0;
    if (len > prevOptimisticLen.current) {
      isAtBottom.current = true;
      setShowScrollArrow(false);
    }
    prevOptimisticLen.current = len;
  }, [optimisticMessages?.length]);

  // Path A-0b: Follow-up scroll for optimistic message lifecycle changes.
  // After sending, status badges (Queued → Delivered ✓) and indicators
  // ("Resuming session...") render in subsequent frames, growing scrollHeight.
  // Watch the full optimisticMessages array ref (changes on every status update)
  // and phase (changes when session resumes → "Resuming session..." appears).
  useEffect(() => {
    if (!isAtBottom.current || !(optimisticMessages?.length)) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [optimisticMessages, phase]);

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
    const forceScroll = phase2Pending && !initialLoadDone.current; // initial load only
    if (!forceScroll && !isAtBottom.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
    isAtBottom.current = true;
    firstScrollDone.current = true;
    scrollLog('content', `SCROLL(msgs=${messages.length}${forceScroll ? ',forced' : ''})`, containerRef.current);
  }, [loading, messages, phase2Pending, scrollLog]);

  // Path A-2: Streaming — immediate scroll for new blocks (live output needs instant follow)
  useEffect(() => {
    if (!isAtBottom.current || blocks.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
    scrollRafId.current = requestAnimationFrame(() => {
      scrollRafId.current = null;
      if (!el || !isAtBottom.current) return;
      el.scrollTop = el.scrollHeight;
      isAtBottom.current = true;
    });
  }, [blocks.length]);

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
  }, [sid8]);

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
      debouncedScroll('resize');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [debouncedScroll, scrollLog]);

  // Click handler for the scroll-to-bottom arrow
  const handleScrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottom.current = true;
    setShowScrollArrow(false);
  }, []);

  // ── Deduplicate optimistic messages against persisted history ──
  //
  // handleBatchCompleted removes consumed messages outright (id-first, count
  // fallback). The remaining dedup handles edge cases where persisted history
  // grows and matches a pending/delivered msg the events missed.
  //
  // Rules live in optimistic-dedup.ts (pure, unit-tested): newly-appeared
  // window on growth; full-array scan when history SHRANK (/compact rewrote
  // the JSONL — the old window pointed past the end forever, so delivered
  // bubbles stayed pinned at the bottom below newer content,
  // inc-1783472776601).
  const allOptimistic = optimisticMessages ?? [];
  // Sticky consumption: dedup is a per-render DISPLAY filter over optimistic
  // state it doesn't own — durable removal normally comes from
  // handleBatchCompleted (count-based). When that event never fires (history
  // refresh 502'd during an SSH-down window), a match must still not
  // resurface on a later render after prevMsgLen catches up and the scan
  // window moves past the twin. Remember consumed queueIds for the lifetime
  // of this session view (cleared on session switch).
  const visibleOptimistic = allOptimistic.filter(m => !consumedQueueIds.current.has(m.queueId));
  const deduped = dedupeOptimisticMessages(visibleOptimistic, messages, prevMsgLen.current);
  if (deduped.length !== visibleOptimistic.length) {
    const keptIds = new Set(deduped.map(m => m.queueId));
    for (const m of visibleOptimistic) {
      if (!keptIds.has(m.queueId)) consumedQueueIds.current.add(m.queueId);
    }
  }

  // ── Assign blockIndex for non-deduped optimistic messages (set once, never updated) ──
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
  // All remaining optimistic messages participate in the timeline.
  const isResuming = !isStreaming && phase === 'IN_PROGRESS'
    && deduped.length > 0;
  const timeline = buildTimeline(blocks, deduped, blockIndexMap.current, isStreaming, isResuming);

  const hasContent = messages.length > 0 || timeline.length > 0 || isStreaming
    || deduped.length > 0;

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

      {/* Main conversation — hidden when a team tab is active */}
      <div className="session-history" ref={containerRef} onClick={handleContainerClick} style={activeTeamTab ? { display: 'none' } : undefined}>
        {/* Loading / empty / error states rendered INSIDE the scroll container */}
        {loading && messages.length === 0 && blocks.length === 0 && <LoadingSpinner />}
        {error && (
          <div className="session-history-empty">
            <p className="text-muted">Failed to load history: {error}</p>
          </div>
        )}
        {/* Degraded connectivity: content below is the last-good parse; the
            live read (SSH/daemon) is failing. Auto-clears on next healthy fetch. */}
        {stale && !error && (
          <div className="session-history-stale-banner" role="status">
            ⚠ Showing cached history — live connection unavailable ({stale}). Reconnecting…
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
        {/* Persisted history messages — truncated to tail for performance.
            Full messages[] stays in memory; only the visible slice is rendered as DOM. */}
        {(() => {
          const visibleLimit = INITIAL_RENDER_LIMIT + truncationOffset;
          const visibleStart = Math.max(0, messages.length - visibleLimit);
          const visibleMessages = messages.slice(visibleStart);
          const hiddenCount = visibleStart;
          return (
            <>
              {hiddenCount > 0 && (
                <button
                  className="session-show-earlier-btn"
                  onClick={() => {
                    isAtBottom.current = false; // prevent auto-scroll when expanding upward
                    setTruncationOffset(prev => prev + LOAD_MORE_BATCH);
                  }}
                >
                  Show {Math.min(hiddenCount, LOAD_MORE_BATCH)} earlier messages
                  <span className="session-show-earlier-count">({hiddenCount} hidden)</span>
                </button>
              )}
              {visibleMessages.map((m, i) => {
                const globalIndex = visibleStart + i;
                return (
                  <div key={globalIndex} data-msg-index={globalIndex}>
                    {forkBoundaryIndex != null && globalIndex === forkBoundaryIndex && (
                      <div className="session-fork-divider">
                        <span className="session-fork-divider-label">Forked session starts here</span>
                      </div>
                    )}
                    <SessionMessage message={m} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* Turn timeline — interleaved blocks + ALL optimistic messages by blockIndex,
            preserving their correct visual positions until deduped by persisted history. */}
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
                          sessionId={sessionId}
                          sessionCwd={sessionCwd}
                          sessionHost={sessionHost}
                          onTaskClick={onTaskClick}
                          onSessionClick={onSessionClick}
                          onFileOpen={onFileOpen}
                        />
                      </div>
                    </div>
                  );
                }

                // Regular block rendering
                // Group consecutive blocks under one assistant header.
                // Show header on first block in each consecutive run.
                // "Streaming" badge only on the last block's group header.
                //
                // Only text/system blocks get the assistant "bubble" (padding +
                // rounded background). Tool-call and thinking blocks render flush
                // to the panel — the bubble padding on the first tool_call
                // produced a visible indent-jump against the following tool_calls.
                const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                const isInLastGroup = !timeline.slice(i).some(t => t.kind === 'user');
                const blockWantsBubble = item.block.type === 'text' || item.block.type === 'system';
                const headerEl = isFirst && (
                  <div className="session-msg-header">
                    <span className="session-msg-role">Walnut</span>
                    {isStreaming && isInLastGroup && <span className="session-streaming-badge">Streaming</span>}
                  </div>
                );
                if (blockWantsBubble) {
                  return (
                    <div key={`b-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      {headerEl}
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={`b-${item.index}`} className="session-msg-bare">
                    {headerEl}
                    <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
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

              return (
                <div key={`u-${m.queueId}`} className={wrapperClass}>
                  <SessionMessage message={m} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
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
                        Send failed{m.failedError ? ` — ${m.failedError}` : ''}
                      </div>
                      <div className="session-msg-queued-actions">
                        <button className="session-msg-retry-btn" onClick={() => onRetryFailed?.(m.queueId)}>Retry</button>
                        <button onClick={() => onDismissFailed?.(m.queueId)}>Dismiss</button>
                      </div>
                    </>
                  )}
                </div>
              );
            });
            })()}
          </div>
        )}
        {/* Floating scroll-to-bottom arrow — sticky to bottom of scroll viewport */}
        <button
          className={`scroll-to-bottom-btn${showScrollArrow ? ' visible' : ''}`}
          onClick={handleScrollToBottom}
          aria-label="Scroll to bottom"
        >↓</button>
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
    </>
  );
});
