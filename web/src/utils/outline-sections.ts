/**
 * The outline's sections: in a long conversation, one entry per message the
 * user sent in the main conversation, labelled with its short AI title
 * (SessionRecord.turnTitles, written by src/core/sessions/turn-titles.ts), so
 * the outline reads as the conversation's table of contents (2026-11-03).
 *
 * Pure, unit tested. The row rule is the server's (turn-titles-text.ts
 * sectionCandidates): a user row, not injected by the CLI, not still queued,
 * with words, in the main conversation (the caller says which rows are; a
 * question's rows belong to the question map). Sections appear only from
 * SECTION_MIN_MESSAGES of them; pins keep their own entries and order, and a
 * message pinned whole shows its pin, not a second entry.
 */
import type { SessionTurnTitle } from '@/types/session';

/** Mirrors TURN_TITLE_MIN_MESSAGES (src/core/sessions/turn-titles-text.ts). */
export const SECTION_MIN_MESSAGES = 8;
export const SECTION_LABEL_CHARS = 48;
const KEY_PREFIX = 'section:';
/** The map's `<n> sections` group key (a doneGroupsOpen entry no thread key can be). */
export const SECTIONS_GROUP_KEY = '\u0000sections';

export const sectionKeyOf = (msgId: string): string => `${KEY_PREFIX}${msgId}`;
/** The message a section key points at, or null for any other outline key. */
export function sectionMsgIdOf(key: string): string | null {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) || null : null;
}

export interface SectionRowLike {
  role: 'user' | 'assistant' | 'system';
  text: string;
  msgId?: string;
  walnutMessageId?: string;
  timestamp?: string;
  injected?: boolean;
  queued?: boolean;
}

export interface OutlineSection {
  msgId: string;
  /** Index in the loaded rows (the outline's order). */
  at: number;
  /** The AI title, else the message's cleaned first line. */
  label: string;
  /** False while the label is the fallback. */
  titled: boolean;
  timestamp?: string;
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const TAG_RE = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/gi;

/** What a section is called before its title arrives: the message's first line
 *  with markup off, cut at a word boundary to SECTION_LABEL_CHARS. */
export function sectionFallbackLabel(text: string): string {
  const cleaned = text.replace(REMINDER_RE, ' ').replace(TAG_RE, ' ');
  const line = cleaned.split('\n')
    .map((l) => l.replace(/^[\s#>*\-+`]+/, '').replace(/\s+/g, ' ').trim())
    .find(Boolean) ?? '';
  if (line.length <= SECTION_LABEL_CHARS) return line;
  const cut = line.slice(0, SECTION_LABEL_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space >= SECTION_LABEL_CHARS / 3 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * The sections of the rows on screen, in transcript order, or none when the
 * main conversation has fewer than SECTION_MIN_MESSAGES of them.
 */
export function outlineSections(
  rows: readonly SectionRowLike[],
  isMainRow: (rowId: string) => boolean,
  titles: readonly SessionTurnTitle[] | undefined,
): OutlineSection[] {
  const titleOf = new Map((titles ?? []).filter((t) => t.title?.trim()).map((t) => [t.msgId, t.title.trim()]));
  const seen = new Set<string>();
  const out: OutlineSection[] = [];
  rows.forEach((row, at) => {
    if (row.role !== 'user' || row.injected || row.queued) return;
    const id = row.msgId ?? row.walnutMessageId;
    if (!id || seen.has(id) || !isMainRow(id)) return;
    const fallback = sectionFallbackLabel(row.text ?? '');
    if (!fallback) return;
    seen.add(id);
    const title = titleOf.get(id);
    out.push({
      msgId: id, at, label: title ?? fallback, titled: !!title,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
    });
  });
  return out.length >= SECTION_MIN_MESSAGES ? out : [];
}

/** An outline entry as the merge sees it (TocEntry plus its position). */
export interface PlacedOutlineEntry {
  key: string;
  msgId: string;
  label: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  isQuote?: boolean;
  isSection?: boolean;
  quoteExact?: string;
  at: number;
}

/**
 * Pins and sections in one list, in transcript order. A section heads the
 * entries of its own message; a message pinned whole keeps only its pin.
 */
export function mergeOutline<P extends PlacedOutlineEntry>(
  pins: readonly P[],
  sections: readonly OutlineSection[],
): Array<P | PlacedOutlineEntry> {
  if (sections.length === 0) return [...pins];
  const pinnedWhole = new Set(pins.filter((p) => !p.isQuote).map((p) => p.msgId));
  const sectionEntries: PlacedOutlineEntry[] = sections
    .filter((s) => !pinnedWhole.has(s.msgId))
    .map((s) => ({
      key: sectionKeyOf(s.msgId), msgId: s.msgId, label: s.label, role: 'user', isSection: true, at: s.at,
      ...(s.timestamp ? { timestamp: s.timestamp } : {}),
    }));
  const out: Array<P | PlacedOutlineEntry> = [];
  // A stable sort: pins arrive in transcript order (placePins), and their own
  // tie order (whole-message pin first, then passages) is kept.
  const pinsInOrder = [...pins].sort((a, b) => a.at - b.at);
  let i = 0;
  let j = 0;
  while (i < pinsInOrder.length || j < sectionEntries.length) {
    if (j >= sectionEntries.length || (i < pinsInOrder.length && pinsInOrder[i].at < sectionEntries[j].at)) out.push(pinsInOrder[i++]);
    else out.push(sectionEntries[j++]);
  }
  return out;
}

/** Ids of sections still on their fallback label (what the server is asked to name). */
export function untitledSectionIds(sections: readonly OutlineSection[]): string[] {
  return sections.filter((s) => !s.titled).map((s) => s.msgId);
}

/** The outline rail draws at most this many ticks. */
export const MAX_RAIL_TICKS = 60;

/** The rail's ticks: every entry when they fit, else every pin plus the
 *  sections sampled evenly, in order (the list itself holds every entry). */
export function railTicks<T extends { isSection?: boolean }>(entries: readonly T[]): T[] {
  if (entries.length <= MAX_RAIL_TICKS) return [...entries];
  const sections = entries.filter((e) => e.isSection);
  const room = Math.max(0, MAX_RAIL_TICKS - (entries.length - sections.length));
  const step = sections.length / Math.max(1, room);
  const kept = new Set(room > 0 ? Array.from({ length: room }, (_, i) => sections[Math.floor(i * step)]) : []);
  return entries.filter((e) => !e.isSection || kept.has(e));
}
