/**
 * The raw view's turns (SessionRawView): for every turn, the input exactly as the
 * model received it (the user's text plus every Walnut hint, `rawText` from the
 * history projection) and the output exactly as it came back (each assistant
 * text, thinking and tool call in order). Pure: unit tested in
 * tests/web/raw-turns.test.ts.
 */
import type { SessionHistoryMessage } from '@/types/session';

export interface RawOutputPart {
  kind: 'text' | 'thinking' | 'tool';
  /** Text or thinking verbatim; a tool's name. */
  text: string;
  /** A tool call's input, as JSON. */
  input?: string;
  /** A tool's result, as returned (cut at RESULT_MAX characters). */
  result?: string;
  resultCut?: boolean;
}

export interface RawTurn {
  key: string;
  at: string;
  /** What the model received; '' for output with no input before it (the start of a window). */
  input: string;
  /** Whether Walnut added anything to what the user wrote. */
  hinted: boolean;
  /** Kinds of the hints the input carried. */
  hintKinds: string[];
  output: RawOutputPart[];
}

const RESULT_MAX = 4000;

function cut(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

export function rawTurnsOf(messages: readonly SessionHistoryMessage[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let cur: RawTurn | null = null;
  messages.forEach((m, i) => {
    if (m.role === 'user' && !m.injected) {
      cur = {
        key: m.msgId ?? `${m.timestamp}-${i}`,
        at: m.timestamp,
        input: m.rawText ?? m.text,
        hinted: m.rawText !== undefined && m.rawText !== m.text,
        hintKinds: (m.hints ?? []).map((h) => h.kind),
        output: [],
      };
      turns.push(cur);
      return;
    }
    if (m.role !== 'assistant') return;
    if (!cur) {
      cur = { key: `start-${i}`, at: m.timestamp, input: '', hinted: false, hintKinds: [], output: [] };
      turns.push(cur);
    }
    const turn: RawTurn = cur;
    if (m.thinking) turn.output.push({ kind: 'thinking', text: m.thinking });
    if (m.text) turn.output.push({ kind: 'text', text: m.text });
    for (const t of m.tools ?? []) {
      const r = typeof t.result === 'string' ? cut(t.result, RESULT_MAX) : null;
      turn.output.push({
        kind: 'tool',
        text: t.name,
        input: JSON.stringify(t.input ?? {}, null, 2),
        ...(r ? { result: r.text, ...(r.cut ? { resultCut: true } : {}) } : {}),
      });
    }
  });
  return turns;
}
