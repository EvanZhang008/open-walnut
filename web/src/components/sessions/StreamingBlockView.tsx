/**
 * StreamingBlockView — one streaming block as a chat row, plus the live-turn
 * WorkingIndicator. Shared by the main conversation (SessionChatHistory) and a
 * subagent's lane (LaneTimeline), so a subagent's transcript reads with exactly
 * the rows the main chat draws: the same tool cards (a running one inside its
 * closed run), the same "Thinking ›" row and the same working indicator.
 *
 * Permission cards live here too (they are a block type): one shared store per
 * request id, see web/src/stores/permission-request-store.ts.
 */

import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { stripQuestionTag } from '@/utils/question-tag';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { SessionThinking, PlanCard, CollapsedPlanWrite, GenericToolCall, SystemLineCollapsible } from './SessionMessage';
import { PermissionRequestCard } from './PromptCards';
import { findImagePaths, resolveImagePath } from '@/utils/markdown';
import { SuggestSegments, useSuggestSegments } from '@/components/chat/SuggestSegments';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { useSelectionFrozen } from '@/utils/selection-guard';
import { visibleInterval } from '@/utils/page-visibility';

/** Memoized text block that caches renderMarkdownWithRefs output */
function StreamingTextBlock({ content, msgId, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick, onFileOpen }: { content: string; msgId?: string; sessionCwd?: string; sessionHost?: string; sessionId?: string; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  // Freeze the rendered content while the user is selecting inside this block —
  // each delta otherwise swaps innerHTML and destroys the selection's anchor
  // nodes (the "selection disappears while generating" bug). Catches up the
  // moment the selection clears.
  const { value: displayContent, hostRef } = useSelectionFrozen(content);
  // `<suggest>` cards, re-parsed on every delta: the parser HIDES a card whose
  // `</suggest>` has not landed, so a growing block shows its prose and no card
  // until the closer arrives — never half a card. Scoped by `msgId` (the same id
  // the persisted history row carries), so a receipt recorded mid-turn is still
  // the same key after a reload. Split on the FROZEN value so the selection
  // freeze covers the card too.
  const { segments, useSegments } = useSuggestSegments(displayContent, msgId);
  const imagePaths = useMemo(() => findImagePaths(displayContent), [displayContent]);
  const handleClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost, sessionId);
  return (
    <>
      {/* Distinct keys, so the mid-stream flip from "plain html" to "segments"
          REMOUNTS the host instead of asking React to turn a
          dangerouslySetInnerHTML node into a children node in place. */}
      {useSegments ? (
        <div key="segments" ref={hostRef}>
          <SuggestSegments segments={segments} cwd={sessionCwd} scope={msgId} onClick={handleClick} />
        </div>
      ) : (
        <RichMarkdown
          key="html"
          hostRef={hostRef}
          text={displayContent}
          cwd={sessionCwd}
          scope={msgId}
          onClick={handleClick}
        />
      )}
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

// The prompt cards (permission, AskUserQuestion) live in PromptCards.tsx.

/** Render a single streaming block */
export const StreamingBlockView = memo(function StreamingBlockView({ block, sessionId, sessionCwd, sessionHost, live, onTaskClick, onSessionClick, onFileOpen }: { block: StreamingBlock; sessionId: string; sessionCwd?: string; sessionHost?: string; live?: boolean; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  if (block.type === 'text') {
    // The reply tag (`[Q<n>]`, question-tag.ts) files the turn; it is not prose,
    // and neither is the turn-end marker, half-written or whole (turn-end-marker.ts).
    const content = stripTurnMarker(stripQuestionTag(block.content), true);
    if (!content.trim()) return null;
    return <StreamingTextBlock content={content} msgId={block.msgId} sessionCwd={sessionCwd} sessionHost={sessionHost} sessionId={sessionId} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
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

  // A taken-line marker is a place, not content (stream/chat-order.ts).
  if (block.type === 'user_line') return null;

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
export function countStreamChars(blocks: StreamingBlock[], hidden?: Set<number>): number {
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
export function WorkingIndicator({ label, tokens, startedAt }: {
  label: string;
  tokens: number;
  /** Epoch ms the work began, when the caller knows it (a subagent's ledger
   *  start): elapsed counts from there instead of from mount, so a reader opened
   *  mid-run shows the run's age, not the reader's. */
  startedAt?: number;
}) {
  const startRef = useRef(startedAt ?? Date.now());
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)));
  useEffect(() => {
    // visibleInterval: no 1Hz re-render in hidden tabs; elapsed derives from
    // the clock, so the catch-up tick on return is exact.
    return visibleInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)));
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
