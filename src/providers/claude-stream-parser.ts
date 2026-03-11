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
 *   {"type":"result","subtype":"success","result":"...","cost_usd":0.003}
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

/** Final result extracted from the result event */
export interface ClaudeStreamResult {
  result: string;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  isError?: boolean;
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

  // Final result event
  if (type === 'result') {
    const result = (parsed.result ?? parsed.error ?? '') as string;
    const isError = parsed.subtype === 'error';
    callbacks?.onResult?.({
      result,
      costUsd: parsed.cost_usd as number | undefined,
      durationMs: parsed.duration_ms as number | undefined,
      durationApiMs: parsed.duration_api_ms as number | undefined,
      isError,
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

  return [...blocks, incoming];
}
