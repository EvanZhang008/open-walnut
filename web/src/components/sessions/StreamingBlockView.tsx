/**
 * StreamingBlockView — one streaming block as a chat row, plus the live-turn
 * WorkingIndicator. Shared by the main conversation (SessionChatHistory) and a
 * subagent's lane (LaneTimeline), so a subagent's transcript reads with exactly
 * the rows the main chat draws: the same tool cards, the same in-flight card
 * while a tool runs, the same "Thinking ›" row and the same working indicator.
 *
 * Permission cards live here too (they are a block type): one shared store per
 * request id, see web/src/stores/permission-request-store.ts.
 */

import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { SessionThinking, PlanCard, CollapsedPlanWrite, GenericToolCall, SystemLineCollapsible } from './SessionMessage';
import {
  isSettledPermission, respondToPermissionRequest, usePermissionRequest,
  type PermissionRequestStatus,
} from '@/stores/permission-request-store';
import { parseAskUserQuestionInput, buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection, type AskQuestion } from './ask-user-question';
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

/** Inline AskUserQuestion card — the CLI's multiple-choice tool, answered for real.
 *
 * AskUserQuestion is a requiresUserInteraction tool whose control_request reaches
 * walnut in EVERY mode (including bypass). Allowing it without `answers` makes the
 * CLI tell the model "user answered your questions" with nothing in it, so this card
 * renders the real options and submits the chosen labels as `answers`
 * (question text → label / free text). Option pills reuse the Personal AI's
 * QuestionPopover `qp-*` styles; the frame keeps the permission-card classes. */
function AskUserQuestionCard({ questions, onSubmit, onDismiss, status, busy, answered }: {
  questions: AskQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  onDismiss: () => void;
  status: PermissionRequestStatus;
  /** A response is in flight — the controls lock, but the card already shows the
   *  optimistic outcome (the store settles on click, not on the round-trip). */
  busy?: boolean;
  answered?: Record<string, string>;
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);
  const resolvedAnswers = answered ?? buildAskUserAnswers(questions, selections, otherText);

  if (isSettledPermission(status)) {
    return (
      <div className={`permission-request-card${settledCardClass(status)}`}>
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
        ) : status === 'denied' ? (
          <div className="permission-request-resolved permission-request-resolved--denied">Dismissed</div>
        ) : (
          /* Settled without this browser seeing the outcome — say that, never
             "Dismissed" (which claims the user did it). */
          <div className="permission-request-resolved">{SETTLED_LABEL[status]}</div>
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
                    disabled={busy}
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
                disabled={busy}
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
          disabled={!complete || busy}
          onClick={() => onSubmit(buildAskUserAnswers(questions, selections, otherText))}
        >
          {busy ? 'Sending...' : 'Submit'}
        </button>
        <button
          className="permission-request-btn permission-request-btn--deny"
          disabled={busy}
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
  // ONE store per request id, shared with the notification rail card and the
  // toast (web/src/stores/permission-request-store.ts). This card used to seed a
  // private useState ONCE from `initialStatus` and never re-read it — blocks
  // render under index keys, so nothing remounted it — which is why answering
  // from the rail left Approve/Deny armed here, and clicking them 404'd and
  // stamped "Denied" on a request the user had just approved.
  const stored = usePermissionRequest(requestId);
  // Fallback for a card the store has never seen: a reloaded page, or an entry
  // trimmed by the store's cap. The stream block's own status is the record.
  const status: PermissionRequestStatus = stored?.status
    ?? (initialStatus && initialStatus !== 'pending' ? initialStatus : 'pending');
  const busy = stored?.inFlight ?? false;
  const [inputExpanded, setInputExpanded] = useState(false);

  const handleResponse = (allow: boolean, optionId?: string, message?: string, answers?: Record<string, string>) => {
    void respondToPermissionRequest(sessionId, requestId, allow, {
      ...(optionId ? { optionId } : {}),
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {}),
    });
  };

  // AskUserQuestion answers ARE the permission response (see AskUserQuestionCard).
  const askQuestions = toolName === 'AskUserQuestion' ? parseAskUserQuestionInput(input) : null;
  if (askQuestions) {
    return (
      <AskUserQuestionCard
        questions={askQuestions}
        status={status}
        busy={busy}
        {...(stored?.answers ? { answered: stored.answers } : {})}
        onSubmit={(answers) => handleResponse(true, undefined, undefined, answers)}
        onDismiss={() => handleResponse(false, undefined, 'User dismissed the questions')}
      />
    );
  }

  const inputPreview = input ? JSON.stringify(input, null, 2) : null;
  const validAcpOptions = (acpOptions ?? []).filter(
    (o): o is { optionId: string; kind?: string; name?: string } => !!o.optionId,
  );

  return (
    <div className={`permission-request-card${settledCardClass(status)}`}>
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
                disabled={busy}
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
          <button className="permission-request-btn permission-request-btn--allow" disabled={busy} onClick={() => handleResponse(true)}>Allow</button>
          <button className="permission-request-btn permission-request-btn--deny" disabled={busy} onClick={() => handleResponse(false)}>Deny</button>
        </div>
      )}
      {status === 'allowed' && (
        <div className="permission-request-resolved permission-request-resolved--allowed">{SETTLED_LABEL.allowed}</div>
      )}
      {/* 'stale' and 'expired' are NOT the user's Deny: the first means the ask
          settled somewhere else and we never learned which way, the second that
          the server withdrew it. Naming them as such is the whole point of the
          shared store — this card used to print "Denied" for both. */}
      {(status === 'denied' || status === 'stale' || status === 'expired') && (
        <div className={`permission-request-resolved permission-request-resolved--${status === 'denied' ? 'denied' : 'stale'}`}>
          {SETTLED_LABEL[status]}
        </div>
      )}
      {/* A transient failure rolled the status back to pending, so the buttons
          above are armed again — say why they are still there. */}
      {status === 'pending' && stored?.failed && (
        <div className="permission-request-resolved">Could not send that — try again</div>
      )}
    </div>
  );
}

/** What a settled card says. 'stale'/'expired' deliberately avoid claiming an
 *  outcome nobody in this browser witnessed. */
const SETTLED_LABEL: Record<PermissionRequestStatus, string> = {
  pending: '',
  allowed: 'Allowed',
  denied: 'Denied',
  stale: 'Already answered',
  expired: 'Session ended',
};

/** Card tint for a settled request. Only allowed/denied have a colour — a
 *  stale/expired card keeps the neutral frame rather than borrowing the red one
 *  and reading as a denial. */
function settledCardClass(status: PermissionRequestStatus): string {
  return status === 'allowed' || status === 'denied'
    ? ` permission-request-card--${status}`
    : '';
}

/** Render a single streaming block */
export const StreamingBlockView = memo(function StreamingBlockView({ block, sessionId, sessionCwd, sessionHost, live, onTaskClick, onSessionClick, onFileOpen }: { block: StreamingBlock; sessionId: string; sessionCwd?: string; sessionHost?: string; live?: boolean; onTaskClick?: (taskId: string) => void; onSessionClick?: (sessionId: string) => void; onFileOpen?: (path: string, line?: number) => void }) {
  if (block.type === 'text') {
    if (!block.content.trim()) return null;
    return <StreamingTextBlock content={block.content} msgId={block.msgId} sessionCwd={sessionCwd} sessionHost={sessionHost} sessionId={sessionId} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
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
