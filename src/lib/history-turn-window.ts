import { typedUserText } from './history-injected-banner.js';
import { isEnvelopeOnly, parseSessionEnvelopes } from './history-session-envelope.js';

export const INITIAL_HISTORY_TURNS = 10;
export const EARLIER_HISTORY_TURNS = 20;
const FALLBACK_HISTORY_ROWS = 75;

export interface HistoryTurnRow {
  role: string;
  text: string;
  injected?: boolean;
}

export function isHistoryUserTurn(message: HistoryTurnRow): boolean {
  if (message.role !== 'user' || message.injected || message.text.startsWith('Base directory for this skill:')) return false;
  const text = typedUserText(message.text).trim();
  return !!text && !/^\[Request interrupted by user( for tool use)?\]$/.test(text)
    && !isEnvelopeOnly(parseSessionEnvelopes(text));
}

export function historyTurnWindowLimit(
  messages: ReadonlyArray<HistoryTurnRow>,
  turns: number,
  includes: (index: number) => boolean = () => true,
  end = messages.length,
): number {
  let seenTurns = 0;
  let seenRows = 0;
  let fallbackStart = end;
  const fallbackRows = FALLBACK_HISTORY_ROWS;
  for (let i = end - 1; i >= 0; i--) {
    if (!includes(i)) continue;
    if (++seenRows <= fallbackRows) fallbackStart = i;
    if (isHistoryUserTurn(messages[i]) && ++seenTurns >= turns) return end - i;
  }
  return seenTurns > 0 ? end : end - fallbackStart;
}
