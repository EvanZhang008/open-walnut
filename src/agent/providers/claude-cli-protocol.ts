/**
 * Pseudo-tool protocol for the claude-cli adapter.
 *
 * `claude -p` runs its own agent loop and never returns un-executed tool_use
 * blocks, so Walnut's tools can't ride the native tool_use channel. Instead we
 * speak a strict TEXT protocol: the system prompt embeds Walnut's tool schemas
 * plus an output contract (reply JSON or tool-call JSON), the adapter parses
 * the CLI's text back into synthetic `tool_use` ContentBlocks, and loop.ts
 * executes them exactly as it would for a native provider. Tool results are
 * fed back as an envelope text on a --resume'd CLI session.
 *
 * Everything here is a pure function — no I/O, no spawn — so the whole
 * protocol is unit-testable without a CLI.
 */
import { randomUUID } from 'node:crypto';
import type { ContentBlock, MessageParam, Tool } from './types.js';

// ── Output contract ──────────────────────────────────────────────────────────

/** What the model's reply parsed into. */
export type ProtocolReply =
  | { kind: 'reply'; text: string }
  | { kind: 'tool_calls'; calls: Array<{ name: string; input: Record<string, unknown> }>; leadText?: string }
  /** Looked like a tool-call attempt but wasn't valid protocol JSON. */
  | { kind: 'malformed'; text: string };

/**
 * Build the protocol section appended to the system prompt when the caller
 * passes tools. Kept terse: every token here is paid on EVERY call.
 */
export function buildToolProtocolSection(tools: Tool[]): string {
  const schemas = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  return [
    '## Tool protocol (MANDATORY output format)',
    '',
    'You have access to the tools listed below. You CANNOT run them yourself —',
    'the host application executes them for you. Your ENTIRE reply must be a',
    'single JSON object, one of:',
    '',
    '1. To answer the user directly:',
    '   {"reply": "<your full answer as markdown text>"}',
    '',
    '2. To call one or more tools (results come back in the next turn):',
    '   {"tool_calls": [{"name": "<tool name>", "input": {<arguments matching the schema>}}]}',
    '',
    'Rules:',
    '- Output ONLY the JSON object. No prose before or after. No code fences.',
    '- Escape newlines inside JSON strings as \\n.',
    '- Call tools ONLY from the list below; invent nothing.',
    '- When a `tool result` arrives, continue the task: either call more tools',
    '  or produce the final {"reply": ...}.',
    '',
    '### Available tools',
    '```json',
    JSON.stringify(schemas),
    '```',
  ].join('\n');
}

/**
 * Parse the CLI's text output against the contract.
 *
 * Tolerant by design — models occasionally wrap JSON in fences or prepend a
 * sentence. Extraction order:
 *  1. whole trimmed text as JSON
 *  2. fenced ```json block
 *  3. first balanced {...} spanning a "reply"/"tool_calls" key
 * Anything unparseable that clearly attempted a tool call → 'malformed' (the
 * adapter retries once with a corrective nudge); otherwise it's a plain reply.
 */
export function parseProtocolReply(raw: string): ProtocolReply {
  const text = raw.trim();
  if (!text) return { kind: 'reply', text: '' };

  const candidates: string[] = [];
  if (text.startsWith('{')) candidates.push(text);
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const embedded = extractFirstJsonObject(text);
  if (embedded) candidates.push(embedded);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (!parsed) continue;
    if (Array.isArray(parsed.tool_calls)) {
      const calls = parsed.tool_calls
        .filter((c): c is { name: string; input?: Record<string, unknown> } =>
          !!c && typeof (c as { name?: unknown }).name === 'string')
        .map((c) => ({ name: c.name, input: (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown> }));
      if (calls.length > 0) {
        const lead = text.startsWith(candidate) ? undefined : text.slice(0, text.indexOf(candidate)).replace(/```(?:json)?\s*$/, '').trim();
        return { kind: 'tool_calls', calls, ...(lead ? { leadText: lead } : {}) };
      }
    }
    if (typeof parsed.reply === 'string') {
      return { kind: 'reply', text: parsed.reply };
    }
  }

  // No valid protocol JSON. The single most common violation is a {"reply":
  // ...} whose string body contains LITERAL newlines (invalid JSON control
  // chars) — strict parsing fails, but the payload is trivially recoverable.
  // Without this, the raw JSON envelope would leak into the chat as the
  // assistant's reply.
  if (/^\s*\{\s*"reply"/.test(text)) {
    const m = text.match(/"reply"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
    if (m) return { kind: 'reply', text: unescapeJsonString(m[1]) };
    return { kind: 'malformed', text };
  }
  // A broken tool-call attempt → corrective retry; anything else is prose.
  if (/"tool_calls"|"tool"\s*:/.test(text)) return { kind: 'malformed', text };
  return { kind: 'reply', text };
}

/** Best-effort unescape for the reply-recovery path (literal newlines pass through). */
function unescapeJsonString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.startsWith('u')) return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      default: return c; // \" \\ \/ and anything else → the char itself
    }
  });
}

function tryParse(s: string): { reply?: unknown; tool_calls?: unknown[] } | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v as { reply?: unknown; tool_calls?: unknown[] } : null;
  } catch {
    return null;
  }
}

/** First balanced top-level {...} that mentions a protocol key. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.search(/\{\s*"(?:reply|tool_calls)"/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── Synthetic tool_use blocks ────────────────────────────────────────────────

/**
 * Turn parsed calls into Anthropic-shaped tool_use ContentBlocks so loop.ts
 * executes them through its normal path. IDs are namespaced `clitool_` so the
 * result serializer can recognize its own turns later.
 */
export function synthesizeToolUseBlocks(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  leadText?: string,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (leadText) blocks.push({ type: 'text', text: leadText } as ContentBlock);
  for (const call of calls) {
    blocks.push({
      type: 'tool_use',
      id: `clitool_${randomUUID()}`,
      name: call.name,
      input: call.input,
    } as ContentBlock);
  }
  return blocks;
}

// ── Tool-result feedback ─────────────────────────────────────────────────────

/**
 * Serialize the loop's tool_result user turn into the envelope text sent on
 * the resumed CLI session. Structured content (image blocks) is flattened —
 * this channel is text.
 */
export function serializeToolResults(content: MessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
    if (b.type !== 'tool_result') continue;
    const body = flattenResultContent(b.content);
    parts.push([
      `tool result${b.is_error ? ' (ERROR)' : ''}:`,
      '```',
      body,
      '```',
    ].join('\n'));
  }
  parts.push('Continue per the tool protocol: reply with ONE JSON object — more {"tool_calls": ...} or the final {"reply": ...}.');
  return parts.join('\n\n');
}

function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      if (blk.type === 'text' && typeof blk.text === 'string') return blk.text;
      if (blk.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** True when a messages-array tail is a tool_result feedback turn. */
export function isToolResultTurn(msg: MessageParam | undefined): boolean {
  if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => (b as { type?: string }).type === 'tool_result');
}

/** Corrective nudge sent (once) when the model broke the protocol. */
export const PROTOCOL_RETRY_PROMPT =
  'Your previous reply violated the tool protocol. Respond again with ONLY one '
  + 'valid JSON object: {"reply": "..."} or {"tool_calls": [{"name": "...", "input": {...}}]}. '
  + 'No prose, no code fences.';

// ── Conversation identity (for --resume chaining) ────────────────────────────

/**
 * Fingerprint a conversation so consecutive adapter calls of the SAME butler
 * conversation resume one CLI session. The system prompt + the first user
 * message are stable for a conversation's lifetime; the message COUNT grows.
 * Collisions (two conversations with identical system + first message) are
 * broken by the prefix-length check the adapter performs before resuming.
 */
export function conversationKey(system: string, messages: MessageParam[]): string {
  const first = messages.find((m) => m.role === 'user');
  // Key on the first TEXT BLOCK only, never the serialized block array: the
  // cache layer rewrites the last user message (cache_control markers,
  // ephemeral context blocks) so on turn 1 the first message is volatile as a
  // structure but stable as text. JSON.stringify here made every conversation's
  // first continuation miss the session map and cold-replay the history.
  let firstText = '';
  if (first) {
    if (typeof first.content === 'string') firstText = first.content;
    else if (Array.isArray(first.content)) {
      const t = first.content.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined;
      firstText = t?.text ?? '';
    }
  }
  // djb2 — cheap, stable, no crypto need (key is an in-process Map key only).
  let hash = 5381;
  const s = `${system} ${firstText}`;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(36)}_${firstText.length}`;
}
