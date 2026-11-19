/**
 * What the judge reads for one candidate (judge.ts): the session's turns around the user's message,
 * as text only (tool calls fold to a count), clipped so one call stays near 10k tokens. The
 * transcript reader is the one the console and task_history use (session-projection.ts).
 */
import type { ProjectedTranscriptMessage } from '../../session-projection.js';

/** `user` is the person's own words; `agent` a delivery from another task or from Walnut (a note, a notice). */
export interface TurnText { role: 'user' | 'agent' | 'assistant'; at: string; text: string; tools?: number; toolLines?: string[] }

export type ReadTranscript = (sessionId: string, opts: { before?: string; visible?: number }) => Promise<ProjectedTranscriptMessage[]>;

const TEXT_MAX = 3500;
const CONTEXT_MAX = 26_000;
/** The session's reply read after his message: what it did with his words. */
const AFTER_MS = 30 * 60_000;

export const readTranscriptDefault: ReadTranscript = async (sessionId, opts) => {
  const { buildSessionTranscript } = await import('../../session-projection.js');
  return (await buildSessionTranscript(sessionId, { live: true, ...opts })).messages;
};

/** Tool calls shown by name and input line before a text turn: the last few, short. */
const TOOL_LINES_MAX = 6;
const TOOL_LINE_MAX = 140;
/** The session's replies read after the moment: what it did with his words, an admission included. */
const REPLIES_AFTER = 3;

const clip = (t: string, max = TEXT_MAX) => (t.length > max ? `${t.slice(0, max)} [... ${t.length - max} more characters]` : t);

/** Rows to turns: text rows kept, tool and thinking rows folded into the next text turn's count. */
export function toTurns(rows: readonly ProjectedTranscriptMessage[]): TurnText[] {
  const out: TurnText[] = [];
  let tools = 0;
  let lines: string[] = [];
  for (const r of rows) {
    if (r.kind === 'tool') {
      tools++;
      lines.push(clip(`${r.text}${r.detail ? `: ${r.detail}` : ''}`.replace(/\s+/g, ' '), TOOL_LINE_MAX));
      if (lines.length > TOOL_LINES_MAX) lines.shift();
      continue;
    }
    if (r.kind === 'thinking') continue;
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    if (r.role === 'user' && r.sentBy === 'cli') continue;
    const person = r.role === 'user' && r.sentBy !== 'agent';
    const text = (person && r.personText ? r.personText : r.text).trim();
    if (!text) continue;
    // Another session's mail or a notice reads short: the judge needs only what it asked.
    const role = r.role === 'assistant' ? 'assistant' : person ? 'user' : 'agent';
    out.push({ role, at: r.timestamp, text: role === 'agent' ? clip(text, 600) : text, ...(tools ? { tools, toolLines: lines } : {}) });
    tools = 0;
    lines = [];
  }
  return out;
}

/** The turns from a little before `fromAt` to the session's first reply after `toAt`, newest kept within the budget. */
export async function turnsAround(
  sessionId: string, fromAt: string, toAt: string, read: ReadTranscript = readTranscriptDefault, opts: { turnsBefore?: number } = {},
): Promise<TurnText[]> {
  const before = new Date(Date.parse(toAt) + AFTER_MS).toISOString();
  const turns = toTurns(await read(sessionId, { before, visible: 40 }));
  const firstIdx = turns.findIndex((t) => t.at >= fromAt);
  const start = Math.max(0, (firstIdx < 0 ? turns.length : firstIdx) - (opts.turnsBefore ?? 3));
  let endIdx = turns.length;
  let replies = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].at > toAt && turns[i].role === 'assistant' && ++replies === REPLIES_AFTER) { endIdx = i + 1; break; }
  }
  const picked = turns.slice(start, endIdx).map((t) => ({ ...t, text: clip(t.text) }));
  let used = 0;
  const kept: TurnText[] = [];
  for (let i = picked.length - 1; i >= 0; i--) {
    used += picked[i].text.length;
    if (used > CONTEXT_MAX && kept.length) break;
    kept.unshift(picked[i]);
  }
  return kept;
}

/** The session's last text turn before `at` (what he answered), or undefined. */
export function lastAssistantBefore(turns: readonly TurnText[], at: string): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant' && turns[i].at < at) return turns[i].text;
  return undefined;
}

/** The turns as the judge reads them. */
export function renderTurns(turns: readonly TurnText[]): string {
  const who = { user: 'USER', agent: 'MESSAGE FROM ANOTHER AGENT OR WALNUT', assistant: 'SESSION' } as const;
  return turns.map((t) => {
    const tools = t.tools ? ` (after ${t.tools} tool calls${t.toolLines?.length ? `, the last ${t.toolLines.length}: ${t.toolLines.map((l) => `[${l}]`).join(' ')}` : ''})` : '';
    return `[${t.at}] ${who[t.role]}${tools}:\n${t.text}`;
  }).join('\n\n');
}
