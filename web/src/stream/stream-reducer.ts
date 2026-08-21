/**
 * stream-reducer — THE single copy of streaming-block accumulation semantics.
 *
 * Three frontend mirrors used to re-implement these rules independently
 * (useSessionStream's rAF path, its synchronous flush path, and session-cache's
 * global WS listeners). Every new CLI stream format had to be fixed three
 * times, and missing one mirror produced the "split main text / vanished
 * blocks" incident family (inc-1783547185298). All mirrors now call these pure
 * functions. The server-side buffer (src/web/session-stream-buffer.ts) remains
 * a language-boundary twin whose semantics must stay aligned with these rules.
 *
 * Invariants encoded here:
 *  · LANE ISOLATION — blocks with parentToolUseId belong to an inline-subagent
 *    lane. Main-lane deltas anchor to the LAST MAIN-LANE block (never blindly
 *    blocks[len-1]) so interleaved subagent lines can't split main text
 *    mid-token. Lane deltas merge only within their own lane and never touch
 *    the main accumulator.
 *  · MESSAGE BOUNDARY (ACP dialect) — a change in msgId = a new message = a
 *    new block. Absent ids (legacy events/snapshots) merge freely.
 *  · TURN LIVENESS — merging is only allowed into a block PAST the
 *    completed-turn boundary (block index >= completedLen): a finished turn's
 *    final text must never be overwritten by the next turn's deltas. The check
 *    is on the merge target's INDEX, not the array length — trailing
 *    subagent-lane blocks can sit past the boundary while the last MAIN block
 *    is before it, and only the main block's own position decides liveness.
 *
 * All functions are pure: they take a readonly blocks array and return a new
 * array when something changed, or the SAME reference when nothing did (so
 * React setState callers skip no-op re-renders).
 */

// ── Block types (moved here from useSessionStream so the reducer, the hook,
//    the cache, and components all share one source; the hook re-exports them
//    for existing import sites) ────────────────────────────────────────────

/** A streaming block — text, tool call, or tool result */
export interface StreamingTextBlock {
  type: 'text';
  content: string;
  /** API message id (`msg_…`) this block belongs to — same id as the persisted
   *  history message, enabling id-based promotion instead of content matching.
   *  ACP-dialect rule: a CHANGE in msgId = a new message = a new block.
   *  Optional (absent on legacy events/snapshots). */
  msgId?: string;
  /** Non-null when this text belongs to an inline subagent (Agent/Task) —
   *  rendered inside the parent's task group, never as main-conversation text. */
  parentToolUseId?: string;
  /** Subagent identity — labels an ORPHAN task group when the parent Agent
   *  tool_call is gone (background subagent continuing after turn end). */
  subagentType?: string;
  taskDescription?: string;
}

export interface StreamingToolCallBlock {
  type: 'tool_call';
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
  planContent?: string;
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string;
  /** See StreamingTextBlock.subagentType/taskDescription. */
  subagentType?: string;
  taskDescription?: string;
}

export interface StreamingSystemBlock {
  type: 'system';
  variant: 'compact' | 'error' | 'info';
  message: string;
  detail?: string;
}

export interface StreamingPermissionBlock {
  type: 'permission';
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  reason?: string;
  /** Set when resolved (from snapshot or permission-resolved event). Absent = pending. */
  status?: 'pending' | 'allowed' | 'denied';
  /** ACP (codex) provider options — rendered as the real buttons
   * (Allow Once / Allow for Session / prefix amendment / Reject). */
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}

/** Model reasoning ("thinking" mode). Rendered gray/italic, collapsible. */
export interface StreamingThinkingBlock {
  type: 'thinking';
  content: string;
  /** See StreamingTextBlock.msgId. */
  msgId?: string;
  /** See StreamingTextBlock.parentToolUseId. */
  parentToolUseId?: string;
}

export type StreamingBlock =
  | StreamingTextBlock
  | StreamingToolCallBlock
  | StreamingSystemBlock
  | StreamingPermissionBlock
  | StreamingThinkingBlock;

// ── Lane anchoring ──────────────────────────────────────────────────────────

function isLaneBlock(b: StreamingBlock): boolean {
  return (b.type === 'text' || b.type === 'thinking' || b.type === 'tool_call') && !!b.parentToolUseId;
}

/** Index of the last block NOT belonging to a subagent lane, or -1. */
export function lastMainLaneIndex(blocks: readonly StreamingBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isLaneBlock(blocks[i])) return i;
  }
  return -1;
}

/** Last MAIN-LANE text block anywhere in the array (skips trailing tool calls
 *  and lane blocks) — used to reconstruct the text accumulator from a snapshot
 *  so future deltas append to the right content.
 *
 *  `completedLen` is the turn boundary: blocks before it belong to FINISHED
 *  turns and MUST NOT seed the accumulator (inc-1786678797966). A snapshot
 *  taken between the next turn's markStreaming and its first delta carries the
 *  previous turn's blocks with isStreaming already true; seeding from one made
 *  the next turn's first delta append to the OLD answer's full text, so the
 *  rendered block read "…<entire previous answer>…<new answer>" — a duplicate
 *  that is really one concatenated block, not two rendered copies. Omit (or 0)
 *  to search the whole array, which is correct only for a live-turn buffer. */
export function lastMainLaneText(
  blocks: readonly StreamingBlock[],
  completedLen = 0,
): StreamingTextBlock | undefined {
  for (let i = blocks.length - 1; i >= Math.max(0, completedLen); i--) {
    const b = blocks[i];
    if (b.type === 'text' && !b.parentToolUseId) return b;
  }
  return undefined;
}

// ── Main-lane text ──────────────────────────────────────────────────────────

/** The index a main-lane TEXT delta may merge into, or -1 (→ push a new block).
 *  Merge requires: last main-lane block is text, SAME message (either side
 *  id-less counts as same — legacy compat), and the block is LIVE (index past
 *  the completed-turn boundary). */
function mainTextMergeTarget(
  blocks: readonly StreamingBlock[],
  msgId: string | undefined,
  completedLen: number,
): number {
  const idx = lastMainLaneIndex(blocks);
  if (idx < 0 || idx < completedLen) return -1;
  const last = blocks[idx];
  if (last.type !== 'text') return -1;
  if (msgId && last.msgId && last.msgId !== msgId) return -1;
  return idx;
}

/** Materialize the accumulated main-lane text into blocks: rewrite the live
 *  text block of the same message with the FULL accumulated content, or push a
 *  new block. `content` must be the whole message-so-far (callers own the
 *  accumulator), NOT an increment. */
export function writeMainText(
  blocks: readonly StreamingBlock[],
  content: string,
  msgId: string | undefined,
  completedLen: number,
): StreamingBlock[] {
  const next: StreamingTextBlock = { type: 'text', content, ...(msgId ? { msgId } : {}) };
  const target = mainTextMergeTarget(blocks, msgId, completedLen);
  if (target >= 0) {
    const updated = [...blocks];
    updated[target] = next;
    return updated;
  }
  return [...blocks, next];
}

/** Per-event main-lane text step for callers that keep their accumulator in
 *  lockstep with blocks (session-cache): merge → buffer grows by delta and the
 *  live block is rewritten with it; new block → buffer RESTARTS at delta. */
export function applyMainTextDelta(
  blocks: readonly StreamingBlock[],
  textBuffer: string,
  delta: string,
  msgId: string | undefined,
  completedLen: number,
): { blocks: StreamingBlock[]; textBuffer: string } {
  const target = mainTextMergeTarget(blocks, msgId, completedLen);
  const nextBuffer = target >= 0 ? textBuffer + delta : delta;
  return { blocks: writeMainText(blocks, nextBuffer, msgId, completedLen), textBuffer: nextBuffer };
}

/** Flush a pending text accumulator into the live main-lane text block (or
 *  push one), PRESERVING the target block's msgId — the buffer only ever holds
 *  a single message's text (the delta handler starts a new block on msgId
 *  change), so no message-boundary check is needed here. No-op (same ref) on
 *  an empty buffer. Used before a context switch (tool-use / system / result)
 *  where the caller resets the buffer afterwards. */
export function flushMainTextBuffer(
  blocks: readonly StreamingBlock[],
  textBuffer: string,
  completedLen: number,
): StreamingBlock[] {
  if (!textBuffer) return blocks as StreamingBlock[];
  const idx = lastMainLaneIndex(blocks);
  const last = idx >= 0 ? blocks[idx] : undefined;
  if (last && last.type === 'text' && idx >= completedLen) {
    const updated = [...blocks];
    updated[idx] = { type: 'text', content: textBuffer, ...(last.msgId ? { msgId: last.msgId } : {}) };
    return updated;
  }
  return [...blocks, { type: 'text', content: textBuffer }];
}

// ── Main-lane thinking ──────────────────────────────────────────────────────

/** Append a thinking increment to the live main-lane thinking block of the
 *  same message, or push a new block. Unlike text (whole-buffer rewrite), the
 *  committed content lives in the block itself and `incoming` is only the
 *  not-yet-flushed increment. */
export function appendMainThinking(
  blocks: readonly StreamingBlock[],
  incoming: string,
  msgId: string | undefined,
  completedLen: number,
): StreamingBlock[] {
  const idx = lastMainLaneIndex(blocks);
  const last = idx >= 0 ? blocks[idx] : undefined;
  const sameMessage =
    last && last.type === 'thinking' && (!msgId || !last.msgId || last.msgId === msgId);
  if (sameMessage && last.type === 'thinking' && idx >= completedLen) {
    const updated = [...blocks];
    updated[idx] = { type: 'thinking', content: last.content + incoming, ...(msgId ? { msgId } : {}) };
    return updated;
  }
  return [...blocks, { type: 'thinking', content: incoming, ...(msgId ? { msgId } : {}) }];
}

// ── Subagent lanes ──────────────────────────────────────────────────────────

export interface LaneTextEvent {
  delta: string;
  msgId?: string;
  parentToolUseId: string;
  subagentType?: string;
  taskDescription?: string;
}

/** Merge a subagent-lane TEXT delta into this lane's own open text block, or
 *  push a new lane block. Scans backwards within the lane: a text block of the
 *  same lane merges if the message matches (id-less counts as same); a
 *  DIFFERENT msgId or an intervening lane tool_call ends the lane's text flow
 *  → new block. Blocks of other lanes / the main lane are skipped — they never
 *  interrupt this lane. Never touches the main accumulator. */
export function appendLaneText(
  blocks: readonly StreamingBlock[],
  ev: LaneTextEvent,
): StreamingBlock[] {
  const { delta, msgId, parentToolUseId, subagentType, taskDescription } = ev;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.parentToolUseId === parentToolUseId) {
      if (!msgId || !b.msgId || b.msgId === msgId) {
        const updated = [...blocks];
        updated[i] = { ...b, content: b.content + delta, ...(msgId ? { msgId } : {}) };
        return updated;
      }
      break; // same lane, different message → new block
    }
    if (b.type === 'tool_call' && b.parentToolUseId === parentToolUseId) break; // lane's text flow interrupted
  }
  return [
    ...blocks,
    {
      type: 'text', content: delta, ...(msgId ? { msgId } : {}), parentToolUseId,
      ...(subagentType ? { subagentType } : {}),
      ...(taskDescription ? { taskDescription } : {}),
    },
  ];
}

/** Same isolation rule as appendLaneText, for thinking. A lane text OR
 *  tool_call interrupts the lane's thinking flow. */
export function appendLaneThinking(
  blocks: readonly StreamingBlock[],
  ev: { delta: string; msgId?: string; parentToolUseId: string },
): StreamingBlock[] {
  const { delta, msgId, parentToolUseId } = ev;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'thinking' && b.parentToolUseId === parentToolUseId) {
      if (!msgId || !b.msgId || b.msgId === msgId) {
        const updated = [...blocks];
        updated[i] = { ...b, content: b.content + delta, ...(msgId ? { msgId } : {}) };
        return updated;
      }
      break;
    }
    if ((b.type === 'text' || b.type === 'tool_call') && b.parentToolUseId === parentToolUseId) break;
  }
  return [...blocks, { type: 'thinking', content: delta, ...(msgId ? { msgId } : {}), parentToolUseId }];
}

// ── Tool calls ──────────────────────────────────────────────────────────────

export interface ToolUseEvent {
  toolUseId: string;
  toolName: string;
  input?: Record<string, unknown>;
  planContent?: string;
  parentToolUseId?: string;
  subagentType?: string;
  taskDescription?: string;
}

/** Find an existing tool_call by id (dup diagnostics at the closest layer to the UI). */
export function findToolCall(
  blocks: readonly StreamingBlock[],
  toolUseId: string,
): StreamingToolCallBlock | undefined {
  return blocks.find(
    (b): b is StreamingToolCallBlock => b.type === 'tool_call' && b.toolUseId === toolUseId,
  );
}

export function appendToolCall(
  blocks: readonly StreamingBlock[],
  ev: ToolUseEvent,
): StreamingBlock[] {
  const { toolUseId, toolName, input, planContent, parentToolUseId, subagentType, taskDescription } = ev;
  return [
    ...blocks,
    {
      type: 'tool_call', toolUseId, name: toolName, input, status: 'calling',
      ...(planContent ? { planContent } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(taskDescription ? { taskDescription } : {}),
    },
  ];
}

/** Mark the newest still-'calling' tool_call with this id as done/error and
 *  attach the result. No match → same reference (no-op render). */
export function backfillToolResult(
  blocks: readonly StreamingBlock[],
  toolUseId: string,
  result: string,
  isError: boolean,
): StreamingBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'tool_call' && b.toolUseId === toolUseId && b.status === 'calling') {
      const updated = [...blocks];
      updated[i] = { ...b, status: isError ? 'error' : 'done', result };
      return updated;
    }
  }
  return blocks as StreamingBlock[];
}

// ── System notices ──────────────────────────────────────────────────────────

export function appendSystemBlock(
  blocks: readonly StreamingBlock[],
  ev: { variant: 'compact' | 'error' | 'info'; message: string; detail?: string },
): StreamingBlock[] {
  return [...blocks, { type: 'system', variant: ev.variant, message: ev.message, detail: ev.detail }];
}

// ── Permission requests ─────────────────────────────────────────────────────

export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  reason?: string;
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}

/** Add one permission card. Re-emits are expected while a request is pending. */
export function appendPermissionBlock(
  blocks: readonly StreamingBlock[],
  ev: PermissionRequestEvent,
): StreamingBlock[] {
  if (blocks.some((b) => b.type === 'permission' && b.requestId === ev.requestId)) {
    return blocks as StreamingBlock[];
  }
  return [...blocks, {
    type: 'permission',
    requestId: ev.requestId,
    toolName: ev.toolName,
    input: ev.input,
    reason: ev.reason,
    acpOptions: ev.acpOptions,
  }];
}

/** Settle a permission card. Unknown request ids are a no-op. */
export function resolvePermissionBlock(
  blocks: readonly StreamingBlock[],
  requestId: string,
  allowed: boolean,
): StreamingBlock[] {
  let changed = false;
  const status = allowed ? 'allowed' as const : 'denied' as const;
  const next = blocks.map((block) => {
    if (block.type !== 'permission' || block.requestId !== requestId || block.status === status) {
      return block;
    }
    changed = true;
    return { ...block, status };
  });
  return changed ? next : blocks as StreamingBlock[];
}
