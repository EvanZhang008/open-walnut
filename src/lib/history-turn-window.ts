import { typedUserText } from './history-injected-banner.js';
import { isEnvelopeOnly, parseSessionEnvelopes } from './history-session-envelope.js';

export const INITIAL_HISTORY_TURNS = 10;
export const EARLIER_HISTORY_TURNS = 20;
const FALLBACK_HISTORY_ROWS = 75;

export interface HistoryTurnRow {
  role: string;
  text: string;
  injected?: boolean;
  /** The CLI's `origin` says a person did not type this row (sessions/transcript-sent-by.ts). */
  agentOrigin?: boolean;
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

/** The two fields of a question's anchor the window reads (SessionThreadAnchor fits). */
export interface HistoryQuestionAnchor {
  msgId?: string;
  parent?: string;
}

/** A row's ids, as the thread tree reads them (web/src/utils/thread-tree.ts). */
export interface HistoryRowIds {
  role: string;
  msgId?: string;
  userUuid?: string;
  walnutMessageId?: string;
  sourceUuid?: string;
}

/**
 * The ids the session's Ask here questions know their turns by: every turn of a
 * question (its first message and each follow-up, from the composer or a card's
 * box) is written with an anchor under its user row's id. The web also files a
 * turn by its `[Qn]` tag when no anchor was written (question-tag.ts
 * withTagAnchors); the server does not see those, so its window may hold a few
 * main turns fewer than the web counts, never more rows than it needs to drop.
 */
export function questionTurnIds(anchors: ReadonlyArray<HistoryQuestionAnchor> | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const a of anchors ?? []) if (a?.msgId && a.parent) ids.add(a.msgId);
  return ids;
}

/**
 * Is this a user row of an Ask here question, not of the main conversation? Read
 * by the id the thread tree files it under (`threadIdOf`: the uuid it was sent
 * under, else its row id).
 */
export function isQuestionTurnRow(message: HistoryRowIds, ids: ReadonlySet<string>): boolean {
  if (message.role !== 'user' || ids.size === 0) return false;
  const id = message.sourceUuid ?? message.msgId ?? message.userUuid ?? message.walnutMessageId;
  return !!id && ids.has(id);
}

/**
 * The window's `includes` for the main conversation: a question's rows show
 * folded under one row each, so its turns are not turns of the window
 * (2026-11-11 review: after a dozen follow-ups in the cards, a reopened session
 * showed no message of the main conversation, only "Load earlier turns").
 */
export function mainLineRows(
  messages: ReadonlyArray<HistoryRowIds>,
  anchors: ReadonlyArray<HistoryQuestionAnchor> | undefined,
): ((index: number) => boolean) | undefined {
  const ids = questionTurnIds(anchors);
  if (ids.size === 0) return undefined;
  return (i) => !isQuestionTurnRow(messages[i], ids);
}
