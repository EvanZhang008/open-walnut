/**
 * Shared JSONL parser for Claude Code `--output-format stream-json` output.
 *
 * Converts individual JSONL lines into StreamingBlock objects that the frontend
 * can render. Used by InlineSubagent (main agent tool).
 * TODO: JsonlTailer could be refactored to use this parser.
 *
 * The JSONL format:
 *   {"type":"system","subtype":"init","model":"...","session_id":"..."}
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}
 *   {"type":"tool","tool_use_id":"...","content":"..."}
 *   {"type":"result","subtype":"success","result":"...","total_cost_usd":0.003}
 */

/** Streaming block types — mirrors the frontend StreamingBlock union in useSessionStream.ts.
 *  Backend needs its own definitions since it can't import from the frontend package.
 *  Keep these in sync with web/src/hooks/useSessionStream.ts. */
export interface StreamingTextBlock {
  type: 'text';
  content: string;
}

export interface StreamingToolCallBlock {
  type: 'tool_call';
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
  parentToolUseId?: string;
}

export interface StreamingSystemBlock {
  type: 'system';
  variant: 'compact' | 'error' | 'info';
  message: string;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock;

/** Metadata extracted from the init event */
export interface ClaudeStreamInit {
  sessionId: string;
  model?: string;
  cwd?: string;
}

/** Token usage carried on the CLI's final `result` line. All fields optional —
 *  the CLI reports a session-accumulated total (see fork QueryEngine result line). */
export interface ClaudeStreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Final result extracted from the result event */
export interface ClaudeStreamResult {
  result: string;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  isError?: boolean;
  /** Token usage from the result line's `usage` object, when present. */
  usage?: ClaudeStreamUsage;
}

/**
 * Parse a single JSONL line from `claude -p --output-format stream-json`.
 *
 * Returns null for lines that don't produce a visible block (e.g. system init).
 * Side effects are communicated via the optional callbacks.
 */
export function parseClaudeJsonlLine(
  line: string,
  callbacks?: {
    onInit?: (init: ClaudeStreamInit) => void;
    onResult?: (result: ClaudeStreamResult) => void;
  },
): StreamingBlock | StreamingBlock[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // skip unparseable lines
  }

  const type = parsed.type as string;

  // System init event — extract metadata
  if (type === 'system' && parsed.subtype === 'init') {
    callbacks?.onInit?.({
      sessionId: parsed.session_id as string,
      model: parsed.model as string | undefined,
      cwd: parsed.cwd as string | undefined,
    });
    return null;
  }

  // System status events — skip (mode changes etc.)
  if (type === 'system') {
    return null;
  }

  // Assistant message — extract text and tool_use content blocks
  if (type === 'assistant') {
    const message = parsed.message as { content?: unknown[] } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return null;

    const blocks: StreamingBlock[] = [];
    for (const block of content) {
      const blockType = (block as { type?: string }).type;
      if (blockType === 'text') {
        const text = (block as { text?: string }).text;
        if (text) {
          blocks.push({ type: 'text', content: text });
        }
      } else if (blockType === 'tool_use') {
        const toolBlock = block as { id?: string; name?: string; input?: Record<string, unknown> };
        blocks.push({
          type: 'tool_call',
          toolUseId: toolBlock.id ?? '',
          name: toolBlock.name ?? 'unknown',
          input: toolBlock.input,
          status: 'calling',
        });
      }
    }
    return blocks.length === 1 ? blocks[0] : blocks.length > 0 ? blocks : null;
  }

  // Tool result — update a prior tool_call block
  if (type === 'tool') {
    const toolUseId = parsed.tool_use_id as string;
    const rawContent = parsed.content;
    const content = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent);
    // Return a tool_call block with result filled in — the consumer
    // should match by toolUseId and merge
    return {
      type: 'tool_call',
      toolUseId,
      name: '', // consumer should merge with existing
      result: content,
      status: 'done',
    };
  }

  // SSE partial event (from --include-partial-messages). InlineSubagent
  // consumes this so tool cards appear before full input arrives and text
  // streams progressively. We only surface text_delta and thinking_delta
  // here — the full `assistant` line that lands later provides the canonical
  // tool_use entry and accumulateBlock concats consecutive text blocks.
  if (type === 'stream_event') {
    const se = parsed as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } };
    const inner = se.event;
    if (inner?.type !== 'content_block_delta') return null;
    const delta = inner?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return { type: 'text', content: delta.text };
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      // Tag thinking with a system block so the UI shows it distinctly from
      // final assistant text without requiring a new block shape here.
      return { type: 'system', variant: 'info', message: `[thinking] ${delta.thinking}` };
    }
    return null;
  }

  // Final result event
  if (type === 'result') {
    const result = (parsed.result ?? parsed.error ?? '') as string;
    const isError = parsed.subtype === 'error';
    // The CLI's result line carries a `usage` object (input/output/cache tokens);
    // surface it so a text-only adapter can report real token counts.
    const rawUsage = parsed.usage as Record<string, unknown> | undefined;
    const usage: ClaudeStreamUsage | undefined = rawUsage && typeof rawUsage === 'object'
      ? {
          input_tokens: typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : undefined,
          output_tokens: typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : undefined,
          cache_creation_input_tokens: typeof rawUsage.cache_creation_input_tokens === 'number' ? rawUsage.cache_creation_input_tokens : undefined,
          cache_read_input_tokens: typeof rawUsage.cache_read_input_tokens === 'number' ? rawUsage.cache_read_input_tokens : undefined,
        }
      : undefined;
    callbacks?.onResult?.({
      result,
      // Claude Code's result event uses `total_cost_usd` (matches SDKResultMessage);
      // fall back to the legacy `cost_usd` for older CLI output.
      costUsd: (parsed.total_cost_usd ?? parsed.cost_usd) as number | undefined,
      durationMs: parsed.duration_ms as number | undefined,
      durationApiMs: parsed.duration_api_ms as number | undefined,
      isError,
      usage,
    });
    // Emit a system block for the final result
    return {
      type: 'system',
      variant: isError ? 'error' : 'compact',
      message: result,
    };
  }

  return null; // unknown event type
}

/**
 * Accumulate a parsed block into an existing StreamingBlock array.
 * Handles merging tool results with their corresponding tool_call blocks.
 */
export function accumulateBlock(
  blocks: StreamingBlock[],
  incoming: StreamingBlock,
): StreamingBlock[] {
  // Tool result — merge with existing tool_call by toolUseId
  if (incoming.type === 'tool_call' && incoming.result !== undefined && !incoming.name) {
    const idx = blocks.findIndex(
      (b) => b.type === 'tool_call' && b.toolUseId === incoming.toolUseId,
    );
    if (idx >= 0) {
      const existing = blocks[idx] as StreamingToolCallBlock;
      const updated = [...blocks];
      const isError = incoming.result?.startsWith('Error:') || incoming.result?.startsWith('ToolError:');
      updated[idx] = {
        ...existing,
        result: incoming.result,
        status: isError ? 'error' : 'done',
      };
      return updated;
    }
    // No matching tool_call found — add as-is
  }

  // Consecutive text blocks — concat into the last block so streamed deltas
  // accumulate in one paragraph instead of producing many 1-char blocks.
  if (incoming.type === 'text') {
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') {
      const updated = [...blocks];
      updated[updated.length - 1] = { type: 'text', content: last.content + incoming.content };
      return updated;
    }
  }

  return [...blocks, incoming];
}
