/**
 * What the judge reads for one candidate (judge.ts): the session's turns around the user's message,
 * as text only (tool calls fold to a count), clipped so one call stays near 10k tokens. The
 * transcript reader is the one the console and task_history use (session-projection.ts).
 */
import type { ProjectedTranscriptMessage } from '../../session-projection.js';
import { parseCardAnswer } from './signals.js';

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

export const clip = (t: string, max = TEXT_MAX) => (t.length > max ? `${t.slice(0, max)} [... ${t.length - max} more characters]` : t);

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

/** The session's newest turns, after `afterAt` and up to now: what it did since a late judgment's window ends. */
export const LATER_TURNS = 2;
const LATER_TEXT_MAX = 1500;
/** A message the reflection itself sent (pipeline.ts correctionText, gatedNote, held-corrections.ts heldText). */
const REFLECTION_MAIL_RE = /'s reflection\b|\borg-reflection\b/;

export async function turnsSince(
  sessionId: string, afterAt: string, read: ReadTranscript = readTranscriptDefault, max = LATER_TURNS,
  mail = 0,
): Promise<TurnText[]> {
  const turns = toTurns(await read(sessionId, { visible: 40 })).filter((t) => t.at > afterAt);
  const clipped = (ts: TurnText[]) => ts.map((t) => ({ ...t, text: clip(t.text, LATER_TEXT_MAX) }));
  const own = max ? turns.filter((t) => t.role === 'assistant').slice(-max) : [];
  // `mail`: the newest of what other agents and Walnut told it since (a change withdrawn after the moment
  // arrives that way), taken apart from its own turns so neither crowds the other out, and never the
  // reflection's own corrections, which would read as their own proof (review of 77eeef8687).
  const told = mail ? turns.filter((t) => t.role === 'agent' && !REFLECTION_MAIL_RE.test(t.text.slice(0, 400))).slice(-mail) : [];
  return clipped([...own, ...told].sort((a, b) => a.at.localeCompare(b.at)));
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

/** A thread message as the reflection reads it: his words, and the node's answer to them. */
export interface ThreadTurnSource { at: string; text: string; answer?: { text: string; at: string } }

/** Turns of a thread's own conversation, the user's message at `idx` in it: a few before, and its answer. Pure. */
export function threadTurns(messages: readonly ThreadTurnSource[], idx: number, before = 4): TurnText[] {
  const out: TurnText[] = [];
  for (const m of messages.slice(Math.max(0, idx - before), idx + 1)) {
    out.push({ role: 'user', at: m.at, text: clip(m.text) });
    if (m.answer?.text) out.push({ role: 'assistant', at: m.answer.at, text: clip(m.answer.text) });
  }
  return splitCardAnswers(out);
}

/** The thread's answers after message `idx`: what the node did with his words since (the judge's LATER). Pure. */
export function threadLater(messages: readonly ThreadTurnSource[], idx: number, max = LATER_TURNS): TurnText[] {
  // Each answer once (one chat reply is filed under several messages), the first after his message kept
  // before the newest: the one right after is most often the one that did it (2026-11-24 replay).
  const seen = new Set<string>([messages[idx]?.answer?.text ?? '']);
  const answers = messages.slice(idx + 1).flatMap((m) => {
    if (!m.answer?.text || seen.has(m.answer.text)) return [];
    seen.add(m.answer.text);
    return [{ role: 'assistant' as const, at: m.answer.at, text: clip(m.answer.text, LATER_TEXT_MAX) }];
  });
  return answers.length <= max ? answers : [...answers.slice(0, 1), ...answers.slice(-(max - 1))];
}

/**
 * A card answer (`Answer to "<ask>": <words>`) as two turns: the ask is the agent's words, the rest
 * his, so the judge never reads (or quotes) the agent's ask as the user's. Pure.
 */
export function splitCardAnswers(turns: readonly TurnText[]): TurnText[] {
  return turns.flatMap((t) => {
    const card = t.role === 'user' ? parseCardAnswer(t.text) : null;
    return card ? [{ role: 'assistant' as const, at: t.at, text: card.ask }, { ...t, text: card.words }] : [t];
  });
}
