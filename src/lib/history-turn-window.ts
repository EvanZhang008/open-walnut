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

/**
 * A row something SENT into the session: a person's message, or a delivery from
 * another task or from Walnut. Not a line the CLI wrote itself (a skill dump,
 * the interrupt marker, an injected context row).
 */
export function isHistorySentRow(message: HistoryTurnRow): boolean {
  if (message.role !== 'user' || message.injected || message.text.startsWith('Base directory for this skill:')) return false;
  const text = typedUserText(message.text).trim();
  return !!text && !/^\[Request interrupted by user( for tool use)?\]$/.test(text);
}

export function isHistoryUserTurn(message: HistoryTurnRow): boolean {
  return isHistorySentRow(message) && !isEnvelopeOnly(parseSessionEnvelopes(typedUserText(message.text).trim()));
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
