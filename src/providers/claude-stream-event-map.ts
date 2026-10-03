/**
 * Single source of truth for how we classify every Claude CLI JSONL event type,
 * stream_event subtype, and content_block_delta.delta type.
 *
 * Rule: every event has one of THREE fates — parse / drop / unknown.
 * An "unknown" event MUST surface in the UI as a SystemBlock so we never
 * silently lose information when the CLI adds new event types. This is how
 * future fork additions (e.g. recap/away-summary if they ever move into -p
 * mode) will become immediately visible without a code change.
 *
 * Keep this file flat and declarative; the dispatcher in claude-code-session.ts
 * reads these tables, nothing more.
 *
 * **Why some things are dropped, not parsed** (load-bearing rationale):
 *   - content_block_start: has tool id+name but input={}; the final `assistant`
 *     JSONL line lands tens of ms later with the COMPLETE input. Early-emitting
 *     from here used to leave ghost empty "Write •" cards on screen because the
 *     GenericToolCall renderer reads the full `input` dict — and the later
 *     input_json_delta fragments never made it to a renderable shape. Real bug
 *     from session a9f24f9a. We wait for the final assistant line instead.
 *   - input_json_delta: paired with the dropped content_block_start; there is
 *     no useful partial UI we can render without reassembling JSON ourselves.
 *   - signature_delta: Anthropic-internal crypto signature for message
 *     integrity; contains no user content.
 *   - message_stop / content_block_stop: pure terminators, no payload.
 */

export type EventFate = 'parse' | 'drop' | 'unknown'

/** Top-level JSONL `type` field */
export const TOP_LEVEL_HANDLING = {
  parse: new Set([
    'system',       // init + arbitrary subtypes
    'assistant',    // text + tool_use blocks
    'user',         // command results / walnut-injected
    'tool',         // tool_result
    'result',       // turn end
    'stream_event', // SSE partial events (new)
    'rate_limit_event', // subscription usage window → per-host store, never a chat row
  ]),
  drop: {} as Record<string, string>, // reason by type
} as const

/** `stream_event.event.type` (Anthropic SSE sub-event) */
export const STREAM_EVENT_HANDLING = {
  parse: new Set([
    'message_start',       // capture msgId for dedup tracking
    'content_block_delta', // real content
    'message_delta',       // stop_reason + usage (already handled upstream)
  ]),
  drop: {
    'content_block_start': 'final `assistant` line carries the authoritative tool_use (id+name+input) within tens of ms; early-emitting with empty input creates stale UI cards when the full input never replaces them',
    'content_block_stop': 'terminator — we accumulate by content_block_delta',
    'message_stop': 'pure terminator, no payload',
  } as Record<string, string>,
} as const

/** `content_block_delta.delta.type` */
export const DELTA_HANDLING = {
  parse: new Set([
    'text_delta',       // → session:text-delta
    'thinking_delta',   // → session:thinking-delta
    'citations_delta',  // → append ※ marker to current text block
  ]),
  drop: {
    'signature_delta': 'anthropic-internal crypto signature, no user value',
    'input_json_delta': 'paired with content_block_start (also dropped); the final assistant line carries the complete input',
  } as Record<string, string>,
} as const

/** Classify a top-level JSONL type. */
export function classifyTopLevel(type: string): EventFate {
  if (TOP_LEVEL_HANDLING.parse.has(type)) return 'parse'
  if (type in TOP_LEVEL_HANDLING.drop) return 'drop'
  return 'unknown'
}

/** Classify a stream_event.event.type. */
export function classifyStreamEvent(eventType: string): EventFate {
  if (STREAM_EVENT_HANDLING.parse.has(eventType)) return 'parse'
  if (eventType in STREAM_EVENT_HANDLING.drop) return 'drop'
  return 'unknown'
}

/** Classify a content_block_delta.delta.type. */
export function classifyDelta(deltaType: string): EventFate {
  if (DELTA_HANDLING.parse.has(deltaType)) return 'parse'
  if (deltaType in DELTA_HANDLING.drop) return 'drop'
  return 'unknown'
}
