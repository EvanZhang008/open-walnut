/**
 * Prompt caching utilities for Anthropic API calls.
 *
 * Injects cache_control markers on system prompt, tools, and messages
 * so the server can reuse stable prefixes across turns.
 * Markers are injected per-call, never stored in persistent history.
 */
import type {
  TextBlockParam,
  CacheControlEphemeral,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

export type CacheTTL = '5m' | '1h';

/** Milliseconds each CacheTTL maps to — single source of truth so the local
 *  staleness tracker (isWithinTTL) never drifts from the markers we inject. */
const TTL_MS: Record<CacheTTL, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

const DEFAULT_TTL: CacheTTL = '1h';
const DEFAULT_TTL_MS = TTL_MS[DEFAULT_TTL];

// ── System prompt ──

/**
 * Convert a system prompt string into a single cached TextBlockParam.
 *
 * The system prompt passed here must be the STABLE part only (role/sync/skills/
 * subagents) — it is byte-identical across turns, so the whole block (plus the
 * tools before it) is cacheable behind one breakpoint.
 *
 * IMPORTANT: volatile content (the per-turn memory context — task counts, daily
 * logs) must NOT go in the system prompt. Render order is tools → system →
 * messages, so anything volatile placed in `system` sits BEFORE the message
 * history and would invalidate the entire message-history cache every turn. The
 * volatile remainder is instead appended to the END of the message array, after
 * the message cache breakpoint — see `appendEphemeralContext`.
 */
export function toSystemBlocks(
  text: string,
  opts?: { ttl?: CacheTTL },
): TextBlockParam[] {
  const cacheControl: CacheControlEphemeral = {
    type: 'ephemeral',
    ttl: opts?.ttl ?? DEFAULT_TTL,
  };
  return [{ type: 'text', text, cache_control: cacheControl }];
}

// ── Tool definitions ──

/**
 * Clone the tools array and add a cache marker to the last tool.
 * Tool definitions don't change mid-session, so a single breakpoint
 * at the end covers all of them.
 */
export function addToolCacheMarker(
  tools: Tool[],
  ttl?: CacheTTL,
): Tool[] {
  if (tools.length === 0) return tools;

  const cloned = tools.map((t) => ({ ...t }));
  cloned[cloned.length - 1].cache_control = {
    type: 'ephemeral',
    ttl: ttl ?? DEFAULT_TTL,
  };
  return cloned;
}

// ── Message history ──

/**
 * Inject a cache marker on the last content block of the last user message.
 * This marks the entire conversation prefix (system + tools + prior messages)
 * as cacheable. The new assistant turn is the only fresh content.
 *
 * Handles both string content and array content formats.
 * Returns a shallow clone — does not mutate the input.
 */
export function injectMessageCacheMarkers(
  messages: MessageParam[],
  ttl?: CacheTTL,
): MessageParam[] {
  if (messages.length === 0) return messages;

  const cacheControl: CacheControlEphemeral = {
    type: 'ephemeral',
    ttl: ttl ?? DEFAULT_TTL,
  };

  // Find last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return messages;

  const result = messages.map((m, i) => {
    if (i !== lastUserIdx) return m;

    const msg = messages[lastUserIdx];
    const content = msg.content;

    // String content → convert to text block with cache marker
    if (typeof content === 'string') {
      return {
        ...msg,
        content: [
          { type: 'text' as const, text: content, cache_control: cacheControl },
        ],
      };
    }

    // Array content → clone and annotate last block
    if (Array.isArray(content) && content.length > 0) {
      const blocks = content.map((block, blockIdx) => {
        if (blockIdx === content.length - 1) {
          return { ...block, cache_control: cacheControl };
        }
        return block;
      });
      return { ...msg, content: blocks };
    }

    return msg;
  });

  return result as MessageParam[];
}

/**
 * Append volatile per-turn context (the memory context: task counts, daily logs)
 * to the END of the message array, AFTER the message cache breakpoint.
 *
 * This is the load-bearing half of the cache design. The volatile content must sit
 * after the breakpoint so the entire prior conversation prefix (tools + stable system
 * + all earlier messages) stays byte-identical across turns and keeps cache-hitting —
 * a rolling cache over the whole ~1M-token history. Putting this content anywhere in
 * `system` (before messages in render order) would invalidate the message-history
 * cache every turn instead.
 *
 * WHY the block itself is never cache-marked (evaluated 2026-08-13, don't redo the
 * math): prompt caching is positional, and this block must stay OUT of every prefix
 * the next turn replays (it changes per turn and is never persisted). Anchoring it to
 * the turn's first user message + a 4th (5m) breakpoint DOES let rounds 2+ read it —
 * but then every later round's 1h entry bakes the block's bytes into its prefix, so
 * the NEXT turn (whose history lacks the block) misses everything after the previous
 * user message and re-writes the previous turn's assistant+tool_results (~33K at 2x
 * write cost) to save ~11K×1 per extra round. At the measured ~2 rounds/turn that is
 * clearly not worth it; paying for the block as plain input each round is cheaper.
 *
 * Call this AFTER injectMessageCacheMarkers so the breakpoint is already on the last
 * real (persisted) message; we then append the ephemeral block past it.
 *
 * EPHEMERAL: the caller must inject this only into the transient array sent to the API,
 * never into persisted history — otherwise the volatile text freezes into the prefix
 * and bloats history. Returns a shallow clone; does not mutate the input.
 */
export function appendEphemeralContext(
  messages: MessageParam[],
  context: string,
): MessageParam[] {
  if (!context) return messages;

  const block = { type: 'text' as const, text: context };

  // Find the last user message and append the ephemeral block to its content.
  // (It already carries the cache breakpoint on its prior last block; the new block
  //  lands after the breakpoint, so it is never part of the cached prefix.)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  // No user message at all → append a fresh trailing user message carrying the context.
  if (lastUserIdx === -1) {
    return [...messages, { role: 'user', content: [block] } as MessageParam];
  }

  return messages.map((m, i) => {
    if (i !== lastUserIdx) return m;
    const content = m.content;
    if (typeof content === 'string') {
      return { ...m, content: [{ type: 'text' as const, text: content }, block] };
    }
    if (Array.isArray(content)) {
      return { ...m, content: [...content, block] };
    }
    return m;
  }) as MessageParam[];
}

// ── Context pruning ──

export interface PruneOptions {
  keepLastNTurns?: number;
  softTrimThreshold?: number;
  softTrimKeep?: number;
}

const DEFAULT_PRUNE_OPTS: Required<PruneOptions> = {
  keepLastNTurns: 4,
  softTrimThreshold: 50_000,
  softTrimKeep: 1500,
};

/**
 * Prune old conversation context to reduce token count.
 * - Keeps the last N turns (user+assistant pairs) intact.
 * - Soft-trims large tool_result content blocks in older turns:
 *   keeps first `softTrimKeep` + last `softTrimKeep` chars, trims the middle.
 *
 * A "turn" is a user+assistant message pair.
 */
export function pruneContext(
  messages: MessageParam[],
  opts?: PruneOptions,
): MessageParam[] {
  const {
    keepLastNTurns,
    softTrimThreshold,
    softTrimKeep,
  } = { ...DEFAULT_PRUNE_OPTS, ...opts };

  // Count turns: each user message followed by an assistant message = 1 turn
  // We protect the last N turns from pruning.
  // Work backwards to find the boundary.
  let turnCount = 0;
  let protectedFromIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      turnCount++;
      if (turnCount >= keepLastNTurns) {
        protectedFromIdx = i;
        break;
      }
    }
  }

  return messages.map((msg, idx) => {
    // Don't touch protected (recent) messages
    if (idx >= protectedFromIdx) return msg;

    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    const trimmedContent = content.map((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result' &&
        'content' in block &&
        typeof (block as { content?: unknown }).content === 'string'
      ) {
        const text = (block as { content: string }).content;
        if (text.length > softTrimThreshold) {
          const head = text.slice(0, softTrimKeep);
          const tail = text.slice(-softTrimKeep);
          return {
            ...block,
            content: `${head}\n\n...[trimmed ${text.length - softTrimKeep * 2} chars]...\n\n${tail}`,
          };
        }
      }
      return block;
    });

    return { ...msg, content: trimmedContent };
  }) as MessageParam[];
}

// ── TTL tracker ──

/**
 * Tracks when the last API call was made so we know if the server-side
 * cache is still warm. The cache TTL auto-refreshes on each cache hit,
 * so as long as calls are < DEFAULT_TTL apart, pruning is unnecessary.
 * The default window mirrors DEFAULT_TTL so this tracker never disagrees
 * with the markers we actually inject.
 */
export class CacheTTLTracker {
  private lastCallTimestamp = 0;

  /** Record that an API call just completed. */
  touch(): void {
    this.lastCallTimestamp = Date.now();
  }

  /** Check if the last call was within the given TTL window. */
  isWithinTTL(ttlMs: number = DEFAULT_TTL_MS): boolean {
    if (this.lastCallTimestamp === 0) return false;
    return Date.now() - this.lastCallTimestamp < ttlMs;
  }

  /** Reset for testing. */
  reset(): void {
    this.lastCallTimestamp = 0;
  }
}

/** Module-level singleton tracker. */
export const cacheTTLTracker = new CacheTTLTracker();
