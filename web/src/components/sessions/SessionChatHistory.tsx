import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore, memo } from 'react';
import { scrollDebugEnabled } from '@/utils/scroll-debug';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { useEvent } from '@/hooks/useWebSocket';
import { useLightbox } from '@/hooks/useLightbox';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { SessionMessage, SessionThinking, PlanCard, CollapsedPlanWrite, GenericToolCall, TaskGroupPrompt, agentModelLabel, ToolRunShell, toolRunPhrase, isToolOnlyMessage, isThinkingOnlyMessage, isTextPlusMergeableTools, MergedHistoryToolRun, SystemGroupRun, SystemLineCollapsible, systemGroupMemberFromHistory, type SystemGroupMember } from './SessionMessage';
import { dedupeOptimisticMessages } from './optimistic-dedup';
import { parseHistoryUnavailable, visibleHistoryUnavailable } from './history-unavailable';
import { computeRenderFilter, allBlocksAbsorbed, buildHistoryEvidence } from '@/stream/render-filter';
import { getFinishedAgentIds, subscribeFinishedAgentIds } from '@/cache/finished-agents-store';
import { groupStreamingBlocks, groupLaneChildren, countAgentTree, GROUPABLE_STREAM_TOOLS, type GroupedStreamItem } from '@/stream/group-blocks';
import { TeamCard } from './TeamCard';
import { WorkflowProgress } from './WorkflowProgress';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Lightbox } from '../common/Lightbox';
import type { SessionEngine, SessionHistoryMessage } from '@/types/session';
import type { ImageAttachment } from '@/api/chat';
import { respondToPermission } from '@/api/sessions';
import { parseAskUserQuestionInput, buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection, type AskQuestion } from './ask-user-question';
import { renderMarkdownWithRefs, findImagePaths, resolveImagePath } from '@/utils/markdown';
import { useSelectionScrollGuard, useSelectionFrozen, useSelectionFrozenWith } from '@/utils/selection-guard';
import { runWhenVisible, visibleInterval } from '@/utils/page-visibility';
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
  /**
   * Bump to jump the timeline to the bottom, exactly like clicking the ↓ arrow.
   * Unconditional by design — the caller is acting ON the user's behalf (they
   * clicked "Ask about this", so the composer is where they now are), which is
   * why this ignores isAtBottom and the selection guard that the automatic
   * follow-bottom paths respect. 0/undefined = no-op (initial mount).
   */
  scrollToBottomNonce?: number;
}

/** Memoized text block that caches renderMarkdownWithRefs output */
function StreamingTextBlock({ content, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick, onFileOpen }: { content: string; sessionCwd?: string; sessionHost?: string; sessionId?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  // Freeze the rendered content while the user is selecting inside this block —
  // each delta otherwise swaps innerHTML and destroys the selection's anchor
  // nodes (the "selection disappears while generating" bug). Catches up the
  // moment the selection clears.
  const { value: displayContent, hostRef } = useSelectionFrozen(content);
  const html = useMemo(() => renderMarkdownWithRefs(displayContent, sessionCwd), [displayContent, sessionCwd]);
  const imagePaths = useMemo(() => findImagePaths(displayContent), [displayContent]);
  const handleClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost, sessionId);
  return (
    <>
      <div
        ref={hostRef}
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

/** Inline AskUserQuestion card — the CLI's multiple-choice tool, answered for real.
 *
 * AskUserQuestion is a requiresUserInteraction tool whose control_request reaches
 * walnut in EVERY mode (including bypass). Allowing it without `answers` makes the
 * CLI tell the model "user answered your questions" with nothing in it, so this card
 * renders the real options and submits the chosen labels as `answers`
 * (question text → label / free text). Option pills reuse the Personal AI's
 * QuestionPopover `qp-*` styles; the frame keeps the permission-card classes. */
function AskUserQuestionCard({ questions, onSubmit, onDismiss, status, answered }: {
  questions: AskQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  onDismiss: () => void;
  status: 'pending' | 'loading' | 'allowed' | 'denied';
  answered?: Record<string, string>;
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);
  const resolvedAnswers = answered ?? buildAskUserAnswers(questions, selections, otherText);

  if (status === 'allowed' || status === 'denied') {
    return (
      <div className={`permission-request-card permission-request-card--${status}`}>
        <div className="permission-request-header">
          <span className="permission-request-icon">{status === 'allowed' ? '✓' : '✗'}</span>
          <span className="permission-request-tool">AskUserQuestion</span>
        </div>
        {status === 'allowed' ? (
          <div className="permission-request-resolved permission-request-resolved--allowed">
            {Object.entries(resolvedAnswers).length > 0
              ? Object.entries(resolvedAnswers).map(([q, a]) => (
                <div key={q} className="ask-user-answer-line">{'·'} {q} {'→'} {a}</div>
              ))
              : 'Answered'}
          </div>
        ) : (
          <div className="permission-request-resolved permission-request-resolved--denied">Dismissed</div>
        )}
      </div>
    );
  }

  return (
    <div className="permission-request-card ask-user-question-card">
      <div className="permission-request-header">
        <span className="permission-request-icon">{'❓'}</span>
        <span className="permission-request-tool">Agent has a question</span>
      </div>
      {questions.map((q) => {
        const picked = selections[q.question] ?? [];
        return (
          <div key={q.question} className="ask-user-question">
            {q.header && <div className="qp-chip">{q.header}</div>}
            <div className="qp-question">{q.question}</div>
            {q.options.length > 0 && (
              <div className="qp-options">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    className={`qp-option ${picked.includes(opt.label) ? 'qp-option-selected' : ''}`}
                    title={opt.description}
                    disabled={status === 'loading'}
                    onClick={() => setSelections(prev => ({
                      ...prev,
                      [q.question]: toggleAskUserSelection(prev[q.question], opt.label, q.multiSelect),
                    }))}
                  >
                    {opt.label}
                    {opt.description && <span className="qp-option-desc">{opt.description}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="qp-input-row">
              <input
                className="qp-input"
                placeholder={q.options.length > 0 ? 'Other (type your own answer)...' : 'Type your answer...'}
                value={otherText[q.question] ?? ''}
                disabled={status === 'loading'}
                onChange={(e) => setOtherText(prev => ({ ...prev, [q.question]: e.target.value }))}
                {...NO_AUTOFILL_PROPS}
              />
            </div>
          </div>
        );
      })}
      <div className="permission-request-actions">
        <button
          className="permission-request-btn permission-request-btn--allow"
          disabled={!complete || status === 'loading'}
          onClick={() => onSubmit(buildAskUserAnswers(questions, selections, otherText))}
        >
          {status === 'loading' ? 'Sending...' : 'Submit'}
        </button>
        <button
          className="permission-request-btn permission-request-btn--deny"
          disabled={status === 'loading'}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Inline permission request card — Allow/Deny buttons for sensitive operations.
 * ACP (codex) requests carry provider options (Allow Once / Allow for Session /
 * prefix amendment / Reject) — render those as the real buttons so "always
 * allow" is actually reachable; the bare Allow/Deny pair could only ever send
 * allow_once, which made codex re-prompt on every retry of the same command. */
function PermissionRequestCard({ sessionId, requestId, toolName, input, reason, initialStatus, acpOptions }: {
  sessionId: string; requestId: string; toolName: string;
  input?: Record<string, unknown>; reason?: string;
  initialStatus?: 'pending' | 'allowed' | 'denied';
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}) {
  const [status, setStatus] = useState<'pending' | 'loading' | 'allowed' | 'denied'>(initialStatus && initialStatus !== 'pending' ? initialStatus : 'pending');
  const [inputExpanded, setInputExpanded] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | undefined>();

  const handleResponse = async (allow: boolean, optionId?: string, message?: string, answers?: Record<string, string>) => {
    setStatus('loading');
    try {
      await respondToPermission(sessionId, requestId, allow, message, optionId, answers);
      if (answers) setSubmittedAnswers(answers);
      setStatus(allow ? 'allowed' : 'denied');
    } catch (err) {
      // 404 = the request no longer exists server-side (answered elsewhere,
      // auto-cancelled, or the turn died). Reverting to 'pending' bred zombie
      // cards the user clicked forever (2026-08-11: 8 approve→404 loops on 2
      // cards). Settle the card as denied-stale instead of re-arming it.
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) {
        setStatus('denied');
      } else {
        setStatus('pending'); // transient (network/5xx): let the user retry
      }
    }
  };

  // AskUserQuestion answers ARE the permission response (see AskUserQuestionCard).
  const askQuestions = toolName === 'AskUserQuestion' ? parseAskUserQuestionInput(input) : null;
  if (askQuestions) {
    return (
      <AskUserQuestionCard
        questions={askQuestions}
        status={status}
        answered={submittedAnswers}
        onSubmit={(answers) => void handleResponse(true, undefined, undefined, answers)}
        onDismiss={() => void handleResponse(false, undefined, 'User dismissed the questions')}
      />
    );
  }

  const inputPreview = input ? JSON.stringify(input, null, 2) : null;
  const validAcpOptions = (acpOptions ?? []).filter(
    (o): o is { optionId: string; kind?: string; name?: string } => !!o.optionId,
  );

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
      {status === 'pending' && validAcpOptions.length > 0 && (
        <div className="permission-request-actions">
          {validAcpOptions.map((o) => {
            const isReject = o.kind?.startsWith('reject') ?? false;
            return (
              <button
                key={o.optionId}
                className={`permission-request-btn ${isReject ? 'permission-request-btn--deny' : 'permission-request-btn--allow'}`}
                onClick={() => handleResponse(!isReject, o.optionId)}
              >
                {o.name ?? o.optionId}
              </button>
            );
          })}
        </div>
      )}
      {status === 'pending' && validAcpOptions.length === 0 && (
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
    return <StreamingTextBlock content={block.content} sessionCwd={sessionCwd} sessionHost={sessionHost} sessionId={sessionId} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
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
        acpOptions={block.acpOptions}
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
      sessionId={sessionId}
      onTaskClick={onTaskClick}
      onSessionClick={onSessionClick}
      onFileOpen={onFileOpen}
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
  /** Orphan variant's own lane id — needed to derive the nested per-level view. */
  orphanParentToolUseId?: string;
  orphanSubagentType?: string;
  orphanTaskDescription?: string;
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

function StreamingTaskGroup({ taskBlock, childBlocks, orphanParentToolUseId, orphanSubagentType, orphanTaskDescription, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: StreamingTaskGroupProps) {
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

  // Nested view: direct children render flat; a nested Agent/Task spawned by
  // THIS agent becomes an inner StreamingTaskGroup holding its own subtree
  // (recursive — matches history rendering where childMessages nest per level).
  // childBlocks arrive root-flattened from groupStreamingBlocks; selfId lets
  // groupLaneChildren re-derive the per-level structure.
  const selfId = taskBlock?.toolUseId ?? orphanParentToolUseId;
  const nestedItems = open && selfId ? groupLaneChildren(selfId, childBlocks) : null;
  // Header chip: "N subagents (M nested)" — visible without expanding, so the
  // user can read the fan-out (e.g. 2 direct + 2 spawned deeper = 4 total)
  // straight off the top-level box.
  const agentTree = selfId ? countAgentTree(selfId, childBlocks) : { direct: 0, total: 0 };

  return (
    <div className={`task-group ${open ? 'task-group--open' : ''} ${isDone ? 'task-group--done' : ''} ${isError ? 'task-group--error' : ''}`}>
      <button className="task-group-header" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '▼' : '▶'}</span>
        <span className="task-group-icon">
          {isError ? '✗' : isDone ? '✓' : '▶'}
        </span>
        <span className="task-group-label">{taskBlock ? taskBlock.name : 'Agent'}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        {modelChip && <span className="task-group-model">{modelChip}</span>}
        <span className="task-group-description">{description}</span>
        {agentTree.total > 0 && (
          <span className="task-group-agent-count" title={`This agent spawned ${agentTree.direct} subagent${agentTree.direct !== 1 ? 's' : ''} directly${agentTree.total > agentTree.direct ? `; ${agentTree.total - agentTree.direct} more spawned deeper in the tree` : ''}`}>
            ⑂ {agentTree.direct}{agentTree.total > agentTree.direct ? `+${agentTree.total - agentTree.direct}` : ''} agent{agentTree.total !== 1 ? 's' : ''}
          </span>
        )}
        {!open && toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
        {!isDone && !isError && <span className="task-group-streaming-dot" />}
      </button>
      {open && (
        <div className="task-group-body">
          {taskBlock && <TaskGroupPrompt input={taskBlock.input} />}
          {(nestedItems ?? childBlocks.map((block, index) => ({ kind: 'block' as const, block, index }))).map((item, ci) => {
            if (item.kind === 'task-group' || item.kind === 'orphan-group') {
              return (
                <StreamingTaskGroup
                  key={`nested-${ci}`}
                  taskBlock={item.kind === 'task-group' ? item.taskBlock : undefined}
                  childBlocks={item.childBlocks}
                  orphanParentToolUseId={item.kind === 'orphan-group' ? item.parentToolUseId : undefined}
                  orphanSubagentType={item.kind === 'orphan-group' ? item.subagentType : undefined}
                  orphanTaskDescription={item.kind === 'orphan-group' ? item.taskDescription : undefined}
                  sessionId={sessionId}
                  sessionCwd={sessionCwd}
                  sessionHost={sessionHost}
                  onTaskClick={onTaskClick}
                  onSessionClick={onSessionClick}
                  onFileOpen={onFileOpen}
                />
              );
            }
            return (
              <StreamingBlockView key={ci} block={item.block} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
            );
          })}
          {childBlocks.length === 0 && !isDone && (
            <div className="task-group-empty">Working...</div>
          )}
        </div>
      )}
    </div>
  );
}

// Grouping semantics (task groups / orphan subagent lanes / hidden-parent
// asymmetry) live in the pure module so the chat lab can replay production
// traces through the exact projection the timeline renders.

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

/**
 * Rough size of everything streamed so far (chars), for the working
 * indicator's token figure (chars/4 ≈ tokens — a progress signal, not an
 * exact usage number). MUST include tool calls: agentic turns are mostly
 * tool activity (and thinking is often not streamed), so a text-only count
 * sits frozen while the turn visibly works — the "token count never goes
 * up" bug. Tool input/result sizes are cached per block object (the reducer
 * replaces a block object whenever it changes), so growth costs O(new
 * blocks), not a JSON.stringify sweep per render frame.
 */
const toolCharCache = new WeakMap<object, number>();
function countStreamChars(blocks: StreamingBlock[], hidden?: Set<number>): number {
  let n = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (hidden?.has(i)) continue; // absorbed by history — not this turn's live output
    const b = blocks[i];
    if (b.type === 'text' || b.type === 'thinking') {
      n += b.content.length;
    } else if (b.type === 'tool_call') {
      let c = toolCharCache.get(b);
      if (c === undefined) {
        c = b.result?.length ?? 0;
        try { c += JSON.stringify(b.input ?? {}).length; } catch { /* non-serializable input */ }
        toolCharCache.set(b, c);
      }
      n += c;
    }
  }
  return n;
}

/** "168" / "1.2k" — compact token figure for the working indicator. */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Claude-app-style live-turn indicator: "<label> is working…" with a scanning
 * underline + elapsed seconds · streamed-token estimate. It mounts when the turn starts
 * (the indicator timeline item only exists while isStreaming, and React keys
 * it stably), so elapsed time is simply time-since-mount — no cross-component
 * turn clock to maintain.
 */
function WorkingIndicator({ label, tokens }: { label: string; tokens: number }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    // visibleInterval: no 1Hz re-render in hidden tabs; elapsed derives from
    // the clock, so the catch-up tick on return is exact.
    return visibleInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
  }, []);
  return (
    <div className="session-working-indicator">
      <span className="session-working-label">{label} is working…</span>
      <span className="session-working-meta">
        {elapsed}s{tokens > 0 ? ` · ${formatTokenCount(tokens)} tokens` : ''}
      </span>
    </div>
  );
}

// ── Auto-scroll constant ──
const NEAR_BOTTOM_PX = 80;  // px from bottom to consider "at bottom"

// Divergence-tripwire settle window: the unmatched set must survive this long
// unchanged (no new turn, no history fetch in flight) before evidence ships.
// Sized above the observed post-turn delta round-trip (~1.2s on SSH sessions,
// inc-1786496042099) so a normal turn-end never reports; a real divergence is
// persistent and merely reports a few seconds later. Tests can shrink it via
// window.__tripwireSettleMs.
const TRIPWIRE_SETTLE_MS = (typeof window !== 'undefined'
  && (window as unknown as { __tripwireSettleMs?: number }).__tripwireSettleMs) || 8_000;

export const SessionChatHistory = memo(function SessionChatHistory({ sessionId, engine, phase, initialPrompt, sessionCwd, sessionHost, optimisticMessages, onMessagesDelivered, onBatchCompleted, onBatchFailed, onEditQueued, onDeleteQueued, onAgentQueued, onRetryFailed, onDismissFailed, onTaskClick, onSessionClick, onFileOpen, onStreamingChange, scrollToBottomNonce }: SessionChatHistoryProps) {
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
  // Monotonic render-window start: once computed, only ratchets DOWN (older)
  // so already-rendered rows never unmount from the top (see visibleStart).
  // null = fresh session view. Index into messages[].
  const renderWindowStart = useRef<number | null>(null);
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
        // The reading pin is an index too — shift it by the same insertion
        // count or it would point k rows too old after a backfill.
        if (renderWindowStart.current !== null) {
          renderWindowStart.current = Math.min(messages.length, renderWindowStart.current + k);
        }
      }
    }
    prevFirstMsgId.current = first;
  }, [messages]);
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
    setEditingId(null);
    setTruncationOffset(0);
    pendingBottomDistance.current = null;
    renderWindowStart.current = null;
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

  // Scroll handler: track whether user is near bottom.
  // Ignores scroll events caused by container resizes (which corrupt isAtBottom).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevArrowState = false;
    let lastLoggedAtBot: boolean | null = null;
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
    let lastUserInput = 0;
    const markUserInput = () => { lastUserInput = Date.now(); };
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
      // Skip scroll events triggered by ResizeObserver-induced geometry shifts
      if (Date.now() < ignoreScrollUntil.current) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
      // Echo guard: leaving-the-bottom requires recent user input. A no-input
      // "left bottom" is our own write racing content growth — heal it by
      // re-closing the gap instead of surrendering follow-bottom.
      if (isAtBottom.current && !nearBottom && Date.now() - lastUserInput > 500) {
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
      const nextArrow = !nearBottom && el.scrollHeight > el.clientHeight;
      if (nextArrow !== prevArrowState) {
        prevArrowState = nextArrow;
        setShowScrollArrow(nextArrow);
      }
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
    }, 500);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', markUserInput);
      el.removeEventListener('keydown', markUserInput);
      clearInterval(pollTimer);
    };
  }, [sid8, jumpForensics, selectionActive]);

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
  // frames: while the initial load hasn't settled and the user is at bottom,
  // pin scrollTop to bottom EVERY FRAME. Self-terminates when initialLoadDone
  // flips (checked per-frame — it's a ref); a user scrolling up mid-load flips
  // isAtBottom=false and the pin yields immediately (user intent wins).
  useEffect(() => {
    let raf: number | null = null;
    const started = Date.now();
    let quietFrames = 0;
    let lastSh = 0;
    let frame = 0;
    // User-INPUT authority: during load, isAtBottom can be corrupted by our
    // own write echoes (a scroll event delivered after content grew reads
    // gap>80 → flips it false with no user action; measured as the parked
    // 224px gap that IMG-FIX then refused to close). Real reading intent
    // arrives as wheel/touch — until one occurs, the pin owns the bottom.
    let userScrolled = false;
    const el0 = containerRef.current;
    const markUser = () => { userScrolled = true; };
    el0?.addEventListener('wheel', markUser, { passive: true });
    el0?.addEventListener('touchmove', markUser, { passive: true });
    const pin = () => {
      raf = null;
      frame++;
      const el = containerRef.current;
      if (el && (userScrolled ? isAtBottom.current : true) && !selectionActive()) {
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
      if (settled || Date.now() - started > 15_000) {
        el0?.removeEventListener('wheel', markUser);
        el0?.removeEventListener('touchmove', markUser);
        return;
      }
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      el0?.removeEventListener('wheel', markUser);
      el0?.removeEventListener('touchmove', markUser);
    };
  }, [sessionId, selectionActive]);

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
    const forceScroll = phase2Pending && !initialLoadDone.current; // initial load only
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
  const { historyParts, hiddenCount } = useMemo(() => {
    let visibleStart = Math.max(0, messages.length - (INITIAL_RENDER_LIMIT + truncationOffset));
    if (renderWindowStart.current !== null) {
      visibleStart = Math.min(visibleStart, renderWindowStart.current);
    }
    renderWindowStart.current = visibleStart;
    const visibleMessages = messages.slice(visibleStart);
    const parts: HistoryPart[] = [];
    let historyRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
    let historyRunSeeded = false;
    let systemRun: { m: SessionHistoryMessage; globalIndex: number }[] = [];
    const flushHistoryRun = () => {
      if (historyRun.length > 0) {
        parts.push({ kind: 'run', members: historyRun, memberMsgs: historyRun.map(({ m }) => m), seeded: historyRunSeeded });
        historyRun = [];
      }
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
      const prevPart = parts[parts.length - 1];
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
    flushHistoryRun();
    flushSystemRun();
    return { historyParts: parts, hiddenCount: visibleStart };
  }, [messages, truncationOffset, forkBoundaryIndex]);

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
    // The working indicator rides the tail of every live turn — it must not
    // steal "liveness" from the actual last content block.
    if (item.kind === 'indicator') continue;
    if (boundaryStreamIndices.has(i) || isTransparentStreamItem(item)) continue;
    if (item.kind === 'block'
      && consumedBlockIndices.has(item.index)
      && !groupedByIndex.has(item.index)) continue;
    lastVisibleTimelineIdx = i;
    break;
  }

  const hasContent = messages.length > 0 || timeline.length > 0 || isStreaming
    || deduped.length > 0;

  // Suppressed whenever the session has visible content — see history-unavailable.ts.
  const historyUnavailable = visibleHistoryUnavailable(error, hasContent);

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
        {initialPrompt && (hiddenCount > 0 || olderHidden > 0 || olderWindowed) && (
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
            <span className="session-show-earlier-count">({hiddenCount + olderHidden} hidden)</span>
          </button>
        )}
        {/* Lazy tail exhausted: everything we HOLD is rendered, but the source
            has older messages we never fetched. One click fetches the rest.
            olderWindowed = bounded window read, count unknown (whale / cold
            tail-bounded read) — same button, uncounted label. */}
        {hiddenCount === 0 && (olderHidden > 0 || olderWindowed) && (
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
                className="session-msg-bare"
                data-msg-index={first.globalIndex}
                key={`sys-${first.m.msgId ?? first.globalIndex}`}
              >
                <SystemGroupRun members={part.systemMembers} />
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
              messages={boundaryHistoryRun.memberMsgs}
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
                          sessionId={sessionId}
                          onTaskClick={onTaskClick}
                          onSessionClick={onSessionClick}
                          onFileOpen={onFileOpen}
                        />
                      ))}
                    </ToolRunShell>
                  </div>
                );
              }
              if (item.kind === 'indicator') {
                if (item.type === 'resuming') {
                  return (
                    <div key="ind-resuming" className="session-streaming-indicator">
                      <span className="session-streaming-dot" />
                      Resuming session...
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
                // Check if this block anchors a Task group (parent tool_call) or
                // an ORPHAN group (anchored at its FIRST child, which is itself a
                // consumed index — so this check must come before the skip below).
                const grouped = groupedByIndex.get(item.index);
                if (grouped && (grouped.kind === 'task-group' || grouped.kind === 'orphan-group')) {
                  const isFirst = i === 0 || timeline[i - 1].kind !== 'block';
                  return (
                    <div key={`tg-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      <div className={isFirst ? 'session-msg-content' : ''}>
                        <StreamingTaskGroup
                          taskBlock={grouped.kind === 'task-group' ? grouped.taskBlock : undefined}
                          childBlocks={grouped.childBlocks}
                          orphanParentToolUseId={grouped.kind === 'orphan-group' ? grouped.parentToolUseId : undefined}
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
                  return (
                    <div key={`b-${item.index}`} className={isFirst ? 'session-msg session-msg-assistant' : ''}>
                      <div className={isFirst ? 'session-msg-content' : ''}>
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
                        {m.parked
                          ? `Not delivered — auto-retry stopped${m.failedError ? ` (${m.failedError})` : ''}`
                          : `Send failed${m.failedError ? ` — ${m.failedError}` : ''}`}
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
