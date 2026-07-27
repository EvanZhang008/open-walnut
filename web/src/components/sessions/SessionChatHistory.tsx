import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { scrollDebugEnabled } from '@/utils/scroll-debug';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { useEvent } from '@/hooks/useWebSocket';
import { useLightbox } from '@/hooks/useLightbox';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { SessionMessage, SessionThinking, PlanCard, CollapsedPlanWrite, GenericToolCall, TaskGroupPrompt, agentModelLabel, ToolRunShell, toolRunPhrase, isToolOnlyMessage, isThinkingOnlyMessage, isTextPlusMergeableTools, MergedHistoryToolRun, SystemGroupRun, SystemLineCollapsible, systemGroupMemberFromHistory, type SystemGroupMember } from './SessionMessage';
import { dedupeOptimisticMessages } from './optimistic-dedup';
import { computeRenderFilter, allBlocksAbsorbed, buildHistoryEvidence } from '@/stream/render-filter';
import { TeamCard } from './TeamCard';
import { WorkflowProgress } from './WorkflowProgress';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Lightbox } from '../common/Lightbox';
import type { SessionEngine, SessionHistoryMessage } from '@/types/session';
import type { ImageAttachment } from '@/api/chat';
import { respondToPermission } from '@/api/sessions';
import { renderMarkdownWithRefs, findImagePaths, resolveImagePath } from '@/utils/markdown';
import { log } from '@/utils/log';

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
  /** Error message when status is 'failed' */
  failedError?: string;
  /** Server-side text ACTUALLY enqueued to the CLI, when it differs from `text`.
   *  `text` is what the user typed (and what we render); with attachments the
   *  server prepends image refs before enqueueing, so the persisted echo carries
   *  the augmented form. Dedup must compare against THIS, not `text`, or an
   *  image message's bubble never matches its persisted twin and stays pinned at
   *  the bottom forever (inc-1785091339102). Set from the send RPC response. */
  dedupText?: string;
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
        <span className="permission-request-icon">{status === 'allowed' ? '\u2713' : status === 'denied' ? '\u2717' : '!'}</span>
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
const StreamingBlockView = memo(function StreamingBlockView({ block, sessionId, sessionCwd, sessionHost, live, onTaskClick, onSessionClick, onFileOpen }: { block: StreamingBlock; sessionId: string; sessionCwd?: string; sessionHost?: string; live?: boolean; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  if (block.type === 'text') {
    if (!block.content.trim()) return null;
    return <StreamingTextBlock content={block.content} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
  }

  if (block.type === 'system') {
    return (
      <SystemLineCollapsible
        variant={block.variant}
        message={block.message}
        detail={block.detail}
      />
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
    // Defensive: never render an empty/whitespace-only thinking block as an
    // expandable-but-blank row (signature-only or whitespace-delta artifacts).
    if (!block.content.trim()) return null;
    // Unified muted "Thinking ›" row (same language as merged tool runs).
    // Collapsed by default; `live` shows a pulsing dot while tokens stream.
    return <SessionThinking text={block.content} live={live} />;
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

/** A streaming Task group — collapsible container for child blocks during live streaming.
 *  `taskBlock` is absent for an ORPHAN group: a background subagent kept producing
 *  after its parent Agent tool_call left the streaming buffer (turn ended / re-send).
 *  Orphan identity comes from the children's subagentType/taskDescription instead. */
interface StreamingTaskGroupProps {
  taskBlock?: StreamingBlock & { type: 'tool_call' };
  childBlocks: StreamingBlock[];
  orphanSubagentType?: string;
  orphanTaskDescription?: string;
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

function StreamingTaskGroup({ taskBlock, childBlocks, orphanSubagentType, orphanTaskDescription, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: StreamingTaskGroupProps) {
  const [open, setOpen] = useState(true); // Default open during streaming
  const description = taskBlock
    ? (typeof taskBlock.input?.description === 'string'
        ? taskBlock.input.description
        : typeof taskBlock.input?.prompt === 'string'
          ? (taskBlock.input.prompt as string).slice(0, 80) + ((taskBlock.input.prompt as string).length > 80 ? '...' : '')
          : 'Task')
    : (orphanTaskDescription || 'Subagent (continued)');
  const subagentType = taskBlock
    ? (typeof taskBlock.input?.subagent_type === 'string' ? taskBlock.input.subagent_type : '')
    : (orphanSubagentType ?? '');
  const modelChip = agentModelLabel(taskBlock?.input);
  const isDone = taskBlock?.status === 'done';
  const isError = taskBlock?.status === 'error';
  const toolCount = childBlocks.filter(b => b.type === 'tool_call').length;

  return (
    <div className={`task-group ${open ? 'task-group--open' : ''} ${isDone ? 'task-group--done' : ''} ${isError ? 'task-group--error' : ''}`}>
      <button className="task-group-header" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="task-group-icon">
          {isError ? '\u2717' : isDone ? '\u2713' : '\u25B6'}
        </span>
        <span className="task-group-label">{taskBlock ? taskBlock.name : 'Agent'}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        {modelChip && <span className="task-group-model">{modelChip}</span>}
        <span className="task-group-description">{description}</span>
        {!open && toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
        {!isDone && !isError && <span className="task-group-streaming-dot" />}
      </button>
      {open && (
        <div className="task-group-body">
          {taskBlock && <TaskGroupPrompt input={taskBlock.input} />}
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
 * Returns an array of "grouped items": either a standalone block, a task group,
 * or an ORPHAN task group (children whose parent tool_call is absent — a
 * background subagent continuing after the turn ended / after a re-send).
 * Orphan children must NEVER render flat in the main conversation; they get a
 * synthesized box at the first child's position (bottom, for late arrivals).
 */
type GroupedStreamItem =
  | { kind: 'block'; block: StreamingBlock; index: number }
  | { kind: 'task-group'; taskBlock: StreamingBlock & { type: 'tool_call' }; childBlocks: StreamingBlock[]; index: number }
  | { kind: 'orphan-group'; parentToolUseId: string; childBlocks: StreamingBlock[]; subagentType?: string; taskDescription?: string; index: number };

/** Tool names whose streaming child blocks should be grouped under them. */
const GROUPABLE_STREAM_TOOLS = new Set(['Task', 'Agent']);

/** True when a streaming block merges into a muted "Ran N commands ›" run.
 *  Only COMPLETED generic tool_calls merge — a still-calling tool stays a
 *  full card so the user watches it live; it collapses into the run when done.
 *  Special blocks (Task/Agent anchors, plan cards, plan writes, ghosts) never merge. */
function isMergeableStreamItem(
  item: TimelineItem,
  consumed: Set<number>,
  groupedByIndex: Map<number, GroupedStreamItem>,
): item is TimelineItem & { kind: 'block'; block: StreamingBlock & { type: 'tool_call' } } {
  if (item.kind !== 'block') return false;
  const b = item.block;
  if (b.type !== 'tool_call') return false;
  if (b.status === 'calling') return false;
  if (groupedByIndex.has(item.index) || consumed.has(item.index)) return false;
  if (GROUPABLE_STREAM_TOOLS.has(b.name)) return false;
  if (b.name === 'ExitPlanMode') return false;
  if (b.name === 'Write' && typeof b.input?.file_path === 'string'
    && b.input.file_path.includes('.claude/plans/')) return false;
  // Ghost placeholder (empty input, no result) — renders null, don't count it
  if (!b.result && (!b.input || Object.keys(b.input).length === 0)) return false;
  return true;
}

function groupStreamingBlocks(blocks: StreamingBlock[], hidden?: Set<number>): GroupedStreamItem[] {
  // Find all groupable tool_call blocks (Task, Agent) — these are potential
  // parents. A HIDDEN parent (absorbed by history — its twin renders in the
  // persisted timeline) is treated as ABSENT: its still-visible late children
  // must form an ORPHAN group instead of anchoring to a block that no longer
  // renders (same scenario as physical removal in the old model).
  const parentToolUseIds = new Set<string>();
  let hasLaneChildren = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(b.name) && !hidden?.has(i)) {
      parentToolUseIds.add(b.toolUseId);
    }
    if ((b.type === 'tool_call' || b.type === 'text' || b.type === 'thinking') && b.parentToolUseId) {
      hasLaneChildren = true;
    }
  }

  if (parentToolUseIds.size === 0 && !hasLaneChildren) {
    // No groupable blocks — return flat list
    return blocks.map((block, index) => ({ kind: 'block', block, index }));
  }

  // Group child blocks under their parent. Children are tool_calls AND
  // text/thinking — the CLI inlines the subagent's whole conversation
  // (assistant text included) with parent_tool_use_id set. Children whose
  // parent tool_call is NOT in blocks form an orphan lane. HIDDEN children
  // are absorbed (their twin renders via the persisted message's group) —
  // exclude them so groups don't double-render content.
  const childBlocksByParent = new Map<string, StreamingBlock[]>();
  const consumedIndices = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const childParent = (b.type === 'tool_call' || b.type === 'text' || b.type === 'thinking')
      ? b.parentToolUseId : undefined;
    if (childParent) {
      consumedIndices.add(i);
      if (hidden?.has(i)) continue;
      const arr = childBlocksByParent.get(childParent);
      if (arr) arr.push(b);
      else childBlocksByParent.set(childParent, [b]);
    }
  }

  // Build grouped result. Orphan lanes surface at their FIRST child's position.
  const emittedOrphans = new Set<string>();
  const result: GroupedStreamItem[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (consumedIndices.has(i)) {
      const pid = (b.type === 'tool_call' || b.type === 'text' || b.type === 'thinking') ? b.parentToolUseId : undefined;
      // Anchor an orphan group at its first VISIBLE child — a hidden anchor
      // index emits no timeline item, so the box would never render.
      if (pid && !parentToolUseIds.has(pid) && !emittedOrphans.has(pid) && !hidden?.has(i)) {
        emittedOrphans.add(pid);
        const children = childBlocksByParent.get(pid) ?? [];
        if (children.length === 0) continue; // all children absorbed — nothing to box
        // Label from whichever child carries the subagent identity
        let subagentType: string | undefined;
        let taskDescription: string | undefined;
        for (const c of children) {
          if ((c.type === 'text' || c.type === 'tool_call') && (c.subagentType || c.taskDescription)) {
            subagentType = c.subagentType;
            taskDescription = c.taskDescription;
            break;
          }
        }
        result.push({ kind: 'orphan-group', parentToolUseId: pid, childBlocks: children, subagentType, taskDescription, index: i });
      }
      continue;
    }
    // parentToolUseIds membership already excludes HIDDEN parents — a hidden
    // parent falls through to a plain 'block' (skipped at render), and its
    // visible children boxed via the orphan path above.
    if (b.type === 'tool_call' && parentToolUseIds.has(b.toolUseId)) {
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

type HistoryPart = { kind: 'msg'; m: SessionHistoryMessage; globalIndex: number; suppressTools?: boolean }
  | { kind: 'run'; members: { m: SessionHistoryMessage; globalIndex: number }[];
      /** First member is a tools-only clone of the preceding msg part (same
       *  globalIndex) — skip the fork-divider check for it. */
      seeded?: boolean }
  | { kind: 'system-run'; members: { m: SessionHistoryMessage; globalIndex: number }[] };

function isTransparentStreamItem(item: TimelineItem): boolean {
  if (item.kind !== 'block') return false;
  const block = item.block;
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

  // Streaming/resuming indicator when no VISIBLE blocks yet
  if (visibleCount === 0) {
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

export const SessionChatHistory = memo(function SessionChatHistory({ sessionId, engine, phase, initialPrompt, sessionCwd, sessionHost, optimisticMessages, onMessagesDelivered, onBatchCompleted, onBatchFailed, onEditQueued, onDeleteQueued, onAgentQueued, onRetryFailed, onDismissFailed, onTaskClick, onSessionClick, onFileOpen, onStreamingChange }: SessionChatHistoryProps) {
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
  const assistantLabel = engine === 'codex' ? 'Codex' : 'Claude Code';
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

  // ── Message truncation — render only the tail to keep DOM count low ──
  const INITIAL_RENDER_LIMIT = 30;
  const LOAD_MORE_BATCH = 200;
  const [truncationOffset, setTruncationOffset] = useState(0);
  // "Show earlier" scroll anchor: distance-to-bottom captured at click time,
  // restored after the expanded batch renders. The container has
  // overflow-anchor:none, so without this the browser keeps scrollTop
  // numerically fixed and the newly inserted messages shove the user's
  // reading position out of view. Bottom distance is invariant to any
  // content inserted above the viewport.
  const pendingBottomDistance = useRef<number | null>(null);
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

  const { messages, loading, phase2Pending, error, stale, forkBoundaryIndex } = useSessionHistory(sessionId, historyVersion);
  const historyUnavailable = error?.startsWith('HISTORY_UNAVAILABLE:')
    ? error.slice('HISTORY_UNAVAILABLE:'.length)
    : null;
  const { blocks, isStreaming, resetIfAbsorbed } = useSessionStream(sessionId);
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
  const prevIsStreaming = useRef(false);
  useLayoutEffect(() => {
    if (isStreaming && !prevIsStreaming.current) {
      turnWatermark.current = messagesRef.current.length;
      watermarkInitialized.current = true;
    }
    prevIsStreaming.current = isStreaming;
  }, [isStreaming]);

  // ── Non-destructive absorption (the single-timeline core) ──
  // Which streaming blocks has persisted history already absorbed? Those are
  // HIDDEN at render time — never deleted at event time. Late history = brief
  // double-render that collapses when evidence lands; never a vanish.
  // Evidence walks the FULL history — memoized by messages ref so whale
  // sessions (5000+ msgs) don't re-walk on every streaming frame.
  const historyEvidence = useMemo(() => buildHistoryEvidence(messages), [messages]);
  // NOTE: turnWatermark.current is a ref read — invisible to the deps array,
  // so a watermark write alone never recomputes this memo. That is sound only
  // because every watermark write is triggered by a dep edge (messages /
  // isStreaming, via useLayoutEffect): the write lands after that render, and
  // the very next dep change (first delta appends a block within a frame)
  // re-runs the memo with the fresh value — worst case one frame of the old
  // watermark, which only widens the content window (duplicate-safe, never
  // vanish). If you ever write the watermark on an independent trigger, this
  // memo will keep serving a stale filter until some dep happens to change.
  const { hidden: hiddenBlocks, unmatched: unmatchedBlocks } = useMemo(
    () => computeRenderFilter({ blocks, messages, watermark: turnWatermark.current, isStreaming, historyEvidence }),
    [blocks, messages, isStreaming, historyEvidence],
  );

  // Divergence tripwire: a FINISHED block with no history twin is kept visible
  // (safe), but persistent misses mean archive & stream disagree — surface it.
  // Deduped per count so a stable divergence logs once, not every render.
  const lastUnmatchedLogged = useRef(0);
  useEffect(() => {
    if (isStreaming) return;
    if (unmatchedBlocks.length > 0 && unmatchedBlocks.length !== lastUnmatchedLogged.current) {
      log.warn('stream', `render-filter: ${unmatchedBlocks.length} completed block(s) had no delta twin — kept, not deleted`, {
        sessionId, unmatched: unmatchedBlocks.slice(0, 5),
      });
    }
    lastUnmatchedLogged.current = unmatchedBlocks.length;
  }, [unmatchedBlocks, isStreaming, sessionId]);

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
  useEvent('_ws:reconnected', () => {
    setHistoryVersion((v) => v + 1);
  });

  // Agent-sent messages: create synthetic optimistic message so it appears in the queue
  useEvent('session:message-queued', (data) => {
    const d = data as { sessionId?: string; messageId?: string; message?: string; source?: string };
    if (d.sessionId === sessionId && d.source !== 'ui' && d.messageId && d.message) {
      onAgentQueued?.({ queueId: d.messageId, text: d.message });
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
  // Gated: every call is a console.log that the browser-logger forwards to the
  // server — on hot scroll/resize paths this amplifies main-thread starvation.
  const sid8 = sessionId.substring(0, 8);
  const scrollLog = useCallback((layer: string, action: string, el?: HTMLElement | null) => {
    if (!scrollDebugEnabled()) return;
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
    turnWatermark.current = 0;
    watermarkInitialized.current = false;
    setEditingId(null);
    setTruncationOffset(0);
    pendingBottomDistance.current = null;
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
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
  }, []);

  // Restore the user's reading position after "Show earlier" expands the
  // truncation window. Runs before paint (useLayoutEffect) so there is no
  // visible jump: same distance-to-bottom ⇒ the message the user was reading
  // stays exactly where it was, with the revealed batch above the viewport.
  useLayoutEffect(() => {
    const dist = pendingBottomDistance.current;
    if (dist === null) return;
    pendingBottomDistance.current = null;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - dist;
    // A programmatic scrollTop write fires a scroll event; the handler would
    // recompute isAtBottom correctly (we're far from bottom), but suppress the
    // resize-window race anyway so a concurrent sibling resize can't misread it.
    ignoreScrollUntil.current = Date.now() + 100;
  }, [truncationOffset]);

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
  const deduped = dedupeOptimisticMessages(visibleOptimistic, messages, turnWatermark.current);
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

  // ── Build interleaved timeline over VISIBLE blocks ──
  // hiddenBlocks (absorbed by history) don't render; visibility is decided
  // here, at render time, not by deleting state.
  const isResuming = !isStreaming && phase === 'IN_PROGRESS'
    && deduped.length > 0;
  const timeline = buildTimeline(blocks, deduped, blockIndexMap.current, isStreaming, isResuming, hiddenBlocks);

  // Prepare both render partitions together so a persisted tool run can absorb
  // the unpersisted run at the streaming boundary instead of producing two rows.
  const visibleLimit = INITIAL_RENDER_LIMIT + truncationOffset;
  const visibleStart = Math.max(0, messages.length - visibleLimit);
  const visibleMessages = messages.slice(visibleStart);
  const hiddenCount = visibleStart;
  const historyParts: HistoryPart[] = [];
  let historyRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
  let historyRunSeeded = false;
  let systemRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
  const flushHistoryRun = () => {
    if (historyRun.length > 0) {
      historyParts.push({ kind: 'run', members: historyRun, seeded: historyRunSeeded });
      historyRun = [];
    }
    historyRunSeeded = false;
  };
  const flushSystemRun = () => {
    if (systemRun.length === 1) {
      historyParts.push({ kind: 'msg', ...systemRun[0] });
    } else if (systemRun.length > 1) {
      historyParts.push({ kind: 'system-run', members: systemRun });
    }
    systemRun = [];
  };
  for (let i = 0; i < visibleMessages.length; i++) {
    const m = visibleMessages[i];
    const globalIndex = visibleStart + i;
    if (forkBoundaryIndex != null && globalIndex === forkBoundaryIndex) {
      flushHistoryRun();
      flushSystemRun();
    }
    if (m.role === 'system') {
      flushHistoryRun();
      systemRun.push({ m, globalIndex });
      continue;
    }
    flushSystemRun();
    if (isToolOnlyMessage(m)) {
      historyRun.push({ m, globalIndex });
      continue;
    }
    flushHistoryRun();
    // Adjacent thinking collapses into ONE "Thinking ›" row: a thinking-only
    // message concatenates into a preceding thinking-only part, and a message
    // whose own thinking follows a thinking-only part absorbs it. Never merge
    // across the fork divider (it renders inside the second part).
    const prevPart = historyParts[historyParts.length - 1];
    const prevIsThinkingOnly = prevPart?.kind === 'msg' && isThinkingOnlyMessage(prevPart.m);
    const atForkDivider = forkBoundaryIndex != null && globalIndex === forkBoundaryIndex;
    let msg = m;
    if (prevIsThinkingOnly && !atForkDivider
      && m.role === 'assistant' && (m.thinking ?? '').trim()) {
      if (isThinkingOnlyMessage(m)) {
        prevPart.m = { ...prevPart.m, thinking: `${prevPart.m.thinking}\n\n${m.thinking}` };
        continue;
      }
      msg = { ...m, thinking: `${prevPart.m.thinking}\n\n${m.thinking}` };
      historyParts.pop();
    }
    if (isTextPlusMergeableTools(msg)) {
      // CLI content order is prose first, tool_use after. Render the prose as
      // its own part and dissolve the tools FORWARD into the next run so a
      // text-carrying message no longer splits two adjacent runs apart.
      historyParts.push({ kind: 'msg', m: msg, globalIndex, suppressTools: true });
      historyRun.push({ m: { ...msg, text: '', thinking: undefined }, globalIndex });
      historyRunSeeded = true;
      continue;
    }
    historyParts.push({ kind: 'msg', m: msg, globalIndex });
  }
  flushHistoryRun();
  flushSystemRun();

  // Pre-group once for both boundary detection and streaming rendering.
  const groupedBlocks = groupStreamingBlocks(blocks, hiddenBlocks);
  const groupedByIndex = new Map<number, GroupedStreamItem>();
  const consumedBlockIndices = new Set<number>();
  for (const g of groupedBlocks) {
    if (g.kind === 'task-group' || g.kind === 'orphan-group') {
      groupedByIndex.set(g.index, g);
      for (const child of g.childBlocks) {
        const childIdx = blocks.indexOf(child);
        if (childIdx >= 0) consumedBlockIndices.add(childIdx);
      }
    }
  }

  const leadingStreamRunIndices: number[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    // Empty live-tail text/thinking blocks become visible when tokens arrive;
    // until then they are transparent and neither render nor split a tool run.
    if (isTransparentStreamItem(item)) continue;
    if (isMergeableStreamItem(item, consumedBlockIndices, groupedByIndex)) {
      leadingStreamRunIndices.push(i);
      continue;
    }
    break;
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

  const runStart = new Map<number, number[]>();
  const runMember = new Set<number>();
  {
    let cur: number[] = [];
    const flushRun = () => {
      if (cur.length >= 1) {
        runStart.set(cur[0], [...cur]);
        for (let k = 1; k < cur.length; k++) runMember.add(cur[k]);
      }
      cur = [];
    };
    for (let i = 0; i < timeline.length; i++) {
      if (boundaryStreamIndices.has(i)) continue;
      if (isTransparentStreamItem(timeline[i])) continue;
      if (isMergeableStreamItem(timeline[i], consumedBlockIndices, groupedByIndex)) {
        cur.push(i);
      } else {
        flushRun();
      }
    }
    flushRun();
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

  // Adjacent streaming thinking blocks (the CLI emits one per message) merge
  // into a single "Thinking ›" row. DOM-null items between them don't split
  // the run; any visible non-thinking item does.
  const thinkingRunStart = new Map<number, number[]>();
  const thinkingRunMember = new Set<number>();
  {
    let cur: number[] = [];
    const flushRun = () => {
      if (cur.length >= 2) {
        thinkingRunStart.set(cur[0], [...cur]);
        for (let k = 1; k < cur.length; k++) thinkingRunMember.add(cur[k]);
      }
      cur = [];
    };
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (boundaryStreamIndices.has(i)
        || isTransparentStreamItem(item)
        || (item.kind === 'block' && consumedBlockIndices.has(item.index) && !groupedByIndex.has(item.index))) {
        continue;
      }
      if (item.kind === 'block' && item.block.type === 'thinking'
        && !item.block.parentToolUseId && !groupedByIndex.has(item.index)) {
        cur.push(i);
      } else {
        flushRun();
      }
    }
    flushRun();
  }

  // Last VISIBLE timeline index — the item still receiving tokens when
  // streaming. Skips DOM-null items (boundary-merged, transparent, blocks
  // consumed into a task/orphan group without anchoring one) so a trailing
  // signature-only artifact can't steal "liveness" from the real tail block.
  let lastVisibleTimelineIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (boundaryStreamIndices.has(i) || isTransparentStreamItem(item)) continue;
    if (item.kind === 'block'
      && consumedBlockIndices.has(item.index)
      && !groupedByIndex.has(item.index)) continue;
    lastVisibleTimelineIdx = i;
    break;
  }

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
        {error && !historyUnavailable && (
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
        {initialPrompt && hiddenCount > 0 && (
          <div className="session-msg session-msg-user session-initial-prompt">
            <div className="session-msg-header">
              <span className="session-initial-prompt-label">Initial Prompt</span>
            </div>
            <div className="session-msg-content">
              <div className="markdown-body">{initialPrompt}</div>
            </div>
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            className="session-show-earlier-btn"
            onClick={() => {
              isAtBottom.current = false;
              const el = containerRef.current;
              if (el) pendingBottomDistance.current = el.scrollHeight - el.scrollTop;
              setTruncationOffset(prev => prev + LOAD_MORE_BATCH);
            }}
          >
            Show {Math.min(hiddenCount, LOAD_MORE_BATCH)} earlier messages
            <span className="session-show-earlier-count">({hiddenCount} hidden)</span>
          </button>
        )}
        {renderedHistoryParts.map((part) => {
          if (part.kind === 'run') {
            const first = part.members[0];
            return (
              <div
                key={`mrun-${first.m.msgId ?? first.globalIndex}`}
                data-msg-index={first.globalIndex}
                className="session-msg-bare"
              >
                {!part.seeded && forkBoundaryIndex != null && first.globalIndex === forkBoundaryIndex && (
                  <div className="session-fork-divider">
                    <span className="session-fork-divider-label">Forked session starts here</span>
                  </div>
                )}
                <MergedHistoryToolRun
                  messages={part.members.map(({ m }) => m)}
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
                className="session-msg-bare"
                data-msg-index={first.globalIndex}
                key={`sys-${first.m.msgId ?? first.globalIndex}`}
              >
                <SystemGroupRun members={part.members.map(({ m }) => systemGroupMemberFromHistory(m))} />
              </div>
            );
          }
          const { m, globalIndex } = part;
          return (
            <div
              key={m.msgId ?? m.walnutMessageId ?? `${m.role}:${m.timestamp}:${globalIndex}`}
              data-msg-index={globalIndex}
              data-message-id={m.msgId ?? m.walnutMessageId}
            >
              {forkBoundaryIndex != null && globalIndex === forkBoundaryIndex && (
                <div className="session-fork-divider">
                  <span className="session-fork-divider-label">Forked session starts here</span>
                </div>
              )}
              <SessionMessage message={m} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} suppressTools={part.suppressTools} showCopyActions={globalIndex === lastAssistantTextIndex} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
            </div>
          );
        })}
        {mergeBoundary && boundaryHistoryRun && (
          <div
            key={`boundary-run-${boundaryHistoryRun.members[0].m.msgId ?? boundaryHistoryRun.members[0].globalIndex}`}
            data-msg-index={boundaryHistoryRun.members[0].globalIndex}
            className="session-msg-bare"
          >
            {!boundaryHistoryRun.seeded && forkBoundaryIndex != null && boundaryHistoryRun.members[0].globalIndex === forkBoundaryIndex && (
              <div className="session-fork-divider">
                <span className="session-fork-divider-label">Forked session starts here</span>
              </div>
            )}
            <MergedHistoryToolRun
              messages={boundaryHistoryRun.members.map(member => member.m)}
              trailingTools={leadingStreamRunIndices.flatMap((index) => {
                const item = timeline[index];
                return item.kind === 'block' && item.block.type === 'tool_call' ? [item.block] : [];
              })}
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
                const runIsLiveTail = isStreaming
                  && thinkingIdx.includes(lastVisibleTimelineIdx);
                return (
                  <div key={`think-run-${item.index}`} className="session-msg-bare">
                    <SessionThinking text={content} live={runIsLiveTail} />
                  </div>
                );
              }
              if (runMember.has(i)) return null;
              const runIdx = runStart.get(i);
              if (runIdx && item.kind === 'block') {
                const members = runIdx
                  .map(k => timeline[k])
                  .filter((t): t is TimelineItem & { kind: 'block' } => t.kind === 'block');
                const blocks_ = members.map(m => m.block).filter((b): b is StreamingBlock & { type: 'tool_call' } => b.type === 'tool_call');
                const phrase = toolRunPhrase(blocks_.map(b => b.name ?? 'unknown'));
                const failCount = blocks_.filter(b => b.status === 'error').length;
                return (
                  <div key={`run-${item.index}`} className="session-msg-bare">
                    <ToolRunShell phrase={phrase} failCount={failCount}>
                      {blocks_.map((b, bi) => (
                        <GenericToolCall
                          key={b.toolUseId ?? bi}
                          tool={{ name: b.name ?? 'unknown', input: b.input ?? {} }}
                          status={b.status === 'error' ? 'error' : 'done'}
                          result={b.result}
                          sessionCwd={sessionCwd}
                          sessionHost={sessionHost}
                          onTaskClick={onTaskClick}
                          onSessionClick={onSessionClick}
                          onFileOpen={onFileOpen ? (p) => onFileOpen(p) : undefined}
                        />
                      ))}
                    </ToolRunShell>
                  </div>
                );
              }
              if (item.kind === 'indicator') {
                return (
                  <div key={`ind-${item.type}`} className="session-streaming-indicator">
                    <span className="session-streaming-dot" />
                    {item.type === 'resuming' ? 'Resuming session...' : `${assistantLabel} is working...`}
                  </div>
                );
              }

              if (item.kind === 'block') {
                // Check if this block anchors a Task group (parent tool_call) or
                // an ORPHAN group (anchored at its FIRST child, which is itself a
                // consumed index — so this check must come before the skip below).
                const grouped = groupedByIndex.get(item.index);
                if (grouped && (grouped.kind === 'task-group' || grouped.kind === 'orphan-group')) {
                  const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                  const isInLastGroup = !timeline.slice(i).some(t => t.kind === 'user');
                  const showStreamingBadge = isFirst && isStreaming && isInLastGroup;
                  return (
                    <div key={`tg-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      {showStreamingBadge && (
                        <div className="session-msg-header">
                          <span className="session-streaming-badge">Streaming</span>
                        </div>
                      )}
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <StreamingTaskGroup
                          taskBlock={grouped.kind === 'task-group' ? grouped.taskBlock : undefined}
                          childBlocks={grouped.childBlocks}
                          orphanSubagentType={grouped.kind === 'orphan-group' ? grouped.subagentType : undefined}
                          orphanTaskDescription={grouped.kind === 'orphan-group' ? grouped.taskDescription : undefined}
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

                // Skip blocks that were consumed into a task/orphan group
                if (consumedBlockIndices.has(item.index)) return null;

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
                const showStreamingBadge = isFirst && isStreaming && isInLastGroup;
                const headerEl = showStreamingBadge ? (
                  <div className="session-msg-header">
                    <span className="session-streaming-badge">Streaming</span>
                  </div>
                ) : null;
                // `live` marks the block still receiving tokens: streaming AND
                // it is the last visible timeline item (crude but the only
                // per-block signal available — deltas always append at the tail).
                const isLiveTail = isStreaming && i === lastVisibleTimelineIdx;
                if (blockWantsBubble) {
                  return (
                    <div key={`b-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      {headerEl}
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <StreamingBlockView block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} live={isLiveTail} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={`b-${item.index}`} className="session-msg-bare">
                    {headerEl}
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
            })}
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
