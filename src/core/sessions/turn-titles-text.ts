/**
 * The pure half of the outline's sections (turn-titles.ts): which user rows are
 * sections, the batched model input, the parse of its numbered answer, and the
 * write-once merge into `SessionRecord.turnTitles`.
 *
 * A section is one main-conversation user message: a row a person (or a peer
 * task) sent, not a line the CLI injected, not a question (a thread anchor's
 * head, which the question map already names), with words in it. The web
 * client applies the same rule (web/src/utils/outline-sections.ts), so the rows
 * the server titles are the rows the outline lists.
 */

import type { SessionThreadAnchor, SessionTurnTitle } from '../types.js';

/** A conversation is long enough for sections from this many user messages:
 *  below it the whole conversation is a couple of screens and reads by scrolling.
 *  Mirrored by SECTION_MIN_MESSAGES on the client. */
export const TURN_TITLE_MIN_MESSAGES = 8;
/** At most this many untitled messages go into one model call (the newest). */
export const TURN_TITLE_BATCH = 20;
/** Each message reaches the model as at most this many characters. */
export const TURN_TITLE_EXCERPT_CHARS = 300;
export const MAX_TURN_TITLE_CHARS = 80;
export const MAX_TURN_TITLE_ID_CHARS = 128;
/** The stored list keeps this many titles, newest first to stay. */
export const MAX_TURN_TITLES = 500;

export const TURN_TITLES_REQUIREMENT = [
  'Each numbered line below is one message the user sent in a long coding session, in order.',
  'Write a title for each one, for the conversation\'s table of contents: 2 to 6 words, a noun phrase naming what that message asks or does (its specific subject, never "User request" or "Follow-up"), in the same language as that message.',
  'Reply with exactly one line per message in the form `<number>. <title>` and nothing else.',
].join(' ');

/** The fields of a history row this module reads (SessionHistoryMessage). */
export interface TurnRowLike {
  role: 'user' | 'assistant' | 'system';
  text: string;
  msgId?: string;
  sourceUuid?: string;
  injected?: boolean;
  queued?: boolean;
}

export interface SectionCandidate {
  msgId: string;
  /** One line, at most TURN_TITLE_EXCERPT_CHARS. */
  excerpt: string;
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const TAG_RE = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/gi;

/** A message as one plain line: Walnut's hint blocks and tag markers off,
 *  whitespace collapsed. */
export function plainMessageLine(text: string): string {
  return text.replace(REMINDER_RE, ' ').replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** The main conversation's user messages, in transcript order. */
export function sectionCandidates(
  rows: readonly TurnRowLike[],
  anchors: readonly Pick<SessionThreadAnchor, 'msgId'>[] | undefined,
): SectionCandidate[] {
  const questions = new Set((anchors ?? []).map((a) => a.msgId));
  const seen = new Set<string>();
  const out: SectionCandidate[] = [];
  for (const row of rows) {
    if (row.role !== 'user' || row.injected || row.queued) continue;
    const id = row.msgId;
    if (!id || id.length > MAX_TURN_TITLE_ID_CHARS || seen.has(id)) continue;
    if (questions.has(id) || (row.sourceUuid && questions.has(row.sourceUuid))) continue;
    const line = plainMessageLine(row.text ?? '');
    if (!line) continue;
    seen.add(id);
    out.push({ msgId: id, excerpt: line.slice(0, TURN_TITLE_EXCERPT_CHARS) });
  }
  return out;
}

/** The next batch to title: the newest untitled candidates (at most `max`), in
 *  transcript order. `skip`: ids that failed too often this process. */
export function untitledBatch(
  candidates: readonly SectionCandidate[],
  titles: readonly SessionTurnTitle[] | undefined,
  skip: ReadonlySet<string> = new Set(),
  max = TURN_TITLE_BATCH,
): SectionCandidate[] {
  const titled = new Set((titles ?? []).filter((t) => t.title.trim()).map((t) => t.msgId));
  const open = candidates.filter((c) => !titled.has(c.msgId) && !skip.has(c.msgId));
  return open.slice(Math.max(0, open.length - max));
}

/** The model input: one numbered line per message. */
export function buildTurnTitlesMessage(batch: readonly SectionCandidate[]): string {
  return batch.map((c, i) => `${i + 1}. ${c.excerpt}`).join('\n');
}

/** One title as the outline shows it: wrappers and label echoes off, cut at a
 *  word boundary. `null` when nothing usable is left. */
export function cleanTurnTitle(raw: string): string | null {
  const text = raw
    .replace(/[\s.;:,|\u3002]+$/, '')
    .replace(/^[#>*`_\s]+|[*`_\s]+$/g, '')
    .replace(/^title\s*:\s*/i, '')
    // Quote marks, CJK corner brackets and the ideographic full stop included.
    .replace(/^["'“”\u300c]+|["'“”\u300d]+$/g, '')
    .replace(/[\s.;:,|\u3002]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2) return null;
  if (text.length <= MAX_TURN_TITLE_CHARS) return text;
  const cut = text.slice(0, MAX_TURN_TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > 30 ? cut.slice(0, space) : cut).trim();
}

const LINE_RE = /^\s*(?:[-*]\s*)?\(?(\d{1,3})\s*[.):\]-]\s*(.+)$/;

/** The numbered answer, read back: title per batch position (0-based). Lines
 *  without a number, numbers outside the batch and repeats are ignored. */
export function parseTurnTitlesAnswer(raw: string | null | undefined, count: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of (raw ?? '').split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const at = Number(m[1]) - 1;
    if (at < 0 || at >= count || out.has(at)) continue;
    const title = cleanTurnTitle(m[2]);
    if (title) out.set(at, title);
  }
  return out;
}

/**
 * Add titles to the stored list. Write-once: a message that already has a
 * non-empty title keeps it. The list is capped at MAX_TURN_TITLES, dropping the
 * oldest writes. `changed` is false when nothing was added.
 */
export function mergeTurnTitles(
  existing: readonly SessionTurnTitle[] | undefined,
  add: ReadonlyArray<{ msgId: string; title: string }>,
  nowIso: string,
): { list: SessionTurnTitle[]; changed: boolean } {
  const list = (existing ?? []).filter((t) => t && typeof t.msgId === 'string' && typeof t.title === 'string');
  const byId = new Map(list.map((t, i) => [t.msgId, i]));
  let changed = false;
  for (const a of add) {
    const title = a.title.trim().slice(0, MAX_TURN_TITLE_CHARS);
    if (!title || !a.msgId || a.msgId.length > MAX_TURN_TITLE_ID_CHARS) continue;
    const at = byId.get(a.msgId);
    if (at !== undefined) {
      if (list[at].title.trim()) continue;
      list[at] = { msgId: a.msgId, title, at: nowIso };
    } else {
      byId.set(a.msgId, list.length);
      list.push({ msgId: a.msgId, title, at: nowIso });
    }
    changed = true;
  }
  return { list: list.length > MAX_TURN_TITLES ? list.slice(list.length - MAX_TURN_TITLES) : list, changed };
}
