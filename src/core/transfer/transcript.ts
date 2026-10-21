/**
 * An engine-neutral rendering of a session's conversation, for carrying it to a
 * session on another engine. The source is SessionHistoryMessage[] (the same
 * rows the UI shows, from a Claude JSONL or an ACP journal), so every engine
 * reads the same way.
 *
 * Two renderings: the FULL transcript (a markdown file the new session can
 * read and grep), and a SEED that fits a budget inside the first message (the
 * newest turns verbatim, the older ones counted and pointed at the file).
 */
import type { SessionHistoryMessage, SessionHistoryTool } from '../session-history.js';

const TOOL_INPUT_CHARS = 160;
const TOOL_RESULT_CHARS_FULL = 1_200;
const TOOL_RESULT_CHARS_SEED = 240;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolInputSummary(tool: SessionHistoryTool): string {
  const input = tool.input ?? {};
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, TOOL_INPUT_CHARS);
  }
  const json = JSON.stringify(input);
  return json === '{}' ? '' : oneLine(json, TOOL_INPUT_CHARS);
}

function toolLine(tool: SessionHistoryTool, resultChars: number): string {
  const input = toolInputSummary(tool);
  const head = `- ${tool.name}${input ? `: ${input}` : ''}${tool.isError ? ' (failed)' : ''}`;
  const result = tool.result?.trim();
  if (!result || resultChars <= 0) return head;
  return `${head}\n  → ${oneLine(result, resultChars)}`;
}

function renderMessage(m: SessionHistoryMessage, resultChars: number): string {
  if (m.role === 'system') return `_[${oneLine(m.text, 200)}]_`;
  const who = m.role === 'user' ? (m.injected ? 'Context (not typed by the user)' : 'User') : 'Assistant';
  const parts = [`**${who}:**`];
  const text = m.injected ? oneLine(m.text, 300) : m.text.trim();
  if (text) parts.push(text);
  for (const tool of m.tools ?? []) parts.push(toolLine(tool, resultChars));
  return parts.join('\n');
}

export interface TranscriptMeta {
  title: string;
  engine: string;
  host: string;
  cwd?: string;
}

/** The whole conversation as markdown. Thinking is left out (it is the old model's scratch work). */
export function renderTranscriptMarkdown(messages: readonly SessionHistoryMessage[], meta: TranscriptMeta): string {
  const body = messages
    .filter((m) => m.text.trim() || (m.tools?.length ?? 0) > 0)
    .map((m) => renderMessage(m, TOOL_RESULT_CHARS_FULL));
  return `${transcriptHeader(messages, meta)}\n${body.join('\n\n')}\n`;
}

/**
 * The same markdown, rendered a slice at a time so a long conversation never
 * holds the server's one event loop (a session of thousands of messages).
 */
export async function renderTranscriptMarkdownChunked(
  messages: readonly SessionHistoryMessage[], meta: TranscriptMeta, sliceSize = 200,
): Promise<string> {
  const body: string[] = [];
  for (let i = 0; i < messages.length; i += sliceSize) {
    for (const m of messages.slice(i, i + sliceSize)) {
      if (m.text.trim() || (m.tools?.length ?? 0) > 0) body.push(renderMessage(m, TOOL_RESULT_CHARS_FULL));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return `${transcriptHeader(messages, meta)}\n${body.join('\n\n')}\n`;
}

function transcriptHeader(messages: readonly SessionHistoryMessage[], meta: TranscriptMeta): string {
  return [
    `# Conversation transcript: ${meta.title}`,
    '',
    `Engine: ${meta.engine}. Host: ${meta.host}.${meta.cwd ? ` Directory: ${meta.cwd}.` : ''}`,
    `Turns: ${messages.filter((m) => m.role === 'user' && !m.injected).length}. Tool results are cut to ${TOOL_RESULT_CHARS_FULL} characters.`,
    '',
  ].join('\n');
}

export interface TranscriptSeed {
  text: string;
  /** Turns (user messages) left out of the seed; they are in the full transcript. */
  omittedTurns: number;
  keptTurns: number;
}

/** Split into turns: each starts at a real user message. */
function turnsOf(messages: readonly SessionHistoryMessage[]): SessionHistoryMessage[][] {
  const turns: SessionHistoryMessage[][] = [];
  for (const m of messages) {
    if (!m.text.trim() && !(m.tools?.length)) continue;
    const startsTurn = m.role === 'user' && !m.injected;
    if (startsTurn || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return turns;
}

/**
 * The newest turns that fit `maxChars`, oldest first. The first user message
 * is always kept (it states the goal), shortened if it alone is too long.
 */
export function renderTranscriptSeed(messages: readonly SessionHistoryMessage[], maxChars: number): TranscriptSeed {
  const turns = turnsOf(messages);
  if (turns.length === 0) return { text: '', omittedTurns: 0, keptTurns: 0 };
  const render = (t: SessionHistoryMessage[]): string => t.map((m) => renderMessage(m, TOOL_RESULT_CHARS_SEED)).join('\n\n');
  const head = render(turns[0]);
  const first = head.length > maxChars / 4 ? `${head.slice(0, Math.floor(maxChars / 4))}…` : head;
  let budget = maxChars - first.length;
  const kept: string[] = [];
  // From the newest back, rendering only what may fit: the old turns of a long
  // conversation are never rendered at all.
  for (let i = turns.length - 1; i >= 1; i--) {
    const text = render(turns[i]);
    if (text.length + 2 > budget) break;
    kept.unshift(text);
    budget -= text.length + 2;
  }
  const omitted = turns.length - 1 - kept.length;
  const gap = omitted > 0 ? [`_[${omitted} earlier turn${omitted === 1 ? '' : 's'} left out here; they are in the full transcript]_`] : [];
  return { text: [first, ...gap, ...kept].join('\n\n'), omittedTurns: omitted, keptTurns: kept.length + 1 };
}
