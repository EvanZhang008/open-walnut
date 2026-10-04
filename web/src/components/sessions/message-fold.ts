/**
 * Folded session-message cards: what the one-line summary says, and which cards
 * the reader opened.
 *
 * A message between sessions arrives as a card (SessionProvenanceCard inbound,
 * SessionOutboundCard outbound). Open, a reply is a wall of detail the reader
 * did not ask for yet, so every card starts folded to its sender and a title:
 * the sender's own TL;DR (`title` on task_send) when it gave one, else the first
 * sentence of its words. Pure apart from the open-set, which lives for the page
 * so a card the reader opened stays open when its row remounts.
 */
import { useCallback, useState } from 'react';

/** How long a derived title may run before it is cut. */
export const FOLD_TITLE_MAX = 140;

/** Markdown that would print as noise in a one-line title. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence of a message, as a one-line title. Used only when the sender
 * gave no `title`: the text is still the sender's own, just shortened.
 */
export function fallbackTitle(text: string | undefined, max = FOLD_TITLE_MAX): string | undefined {
  if (!text) return undefined;
  let line = '';
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~|\|)/.test(raw)) continue;
    line = plainLine(raw);
    if (line) break;
  }
  if (!line) return undefined;
  // End at the first sentence when it is long enough to stand alone.
  // A CJK full stop needs no space after it.
  const stop = /[.!?](?=\s|$)|[\u3002\uff01\uff1f]/g;
  for (let m = stop.exec(line); m; m = stop.exec(line)) {
    if (m.index >= 16) { line = line.slice(0, m.index + 1); break; }
  }
  const points = [...line];
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : line;
}

/** How a subtask notice names the child (envelope-kit buildSubtaskNotification). */
const SUBTASK_WHO = /^Your subtask ".*" \([^()\s]+\) /;

/**
 * A Walnut notice's folded title: the first sentence of its outcome. A subtask
 * notice opens by naming the child, which the card's sender line already does
 * (and a long task title would push the outcome past the cut), so that part goes.
 */
export function noticeTitle(statusLine: string | undefined): string | undefined {
  if (!statusLine) return undefined;
  const rest = statusLine.replace(SUBTASK_WHO, '');
  return fallbackTitle(rest === statusLine ? rest : rest.charAt(0).toUpperCase() + rest.slice(1));
}

/** A stable key for one card: the text it was built from. */
export function foldKey(text: string): string {
  // FNV-1a, 32-bit: enough to tell a page's messages apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${text.length}`;
}

const opened = new Set<string>();

/** Test seam. */
export function _clearOpenedFolds(): void {
  opened.clear();
}

/** Open/closed for one card, starting folded, remembered for the page. */
export function useMessageFold(key: string): [boolean, () => void] {
  const [, rerender] = useState(0);
  const toggle = useCallback(() => {
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    rerender((n) => n + 1);
  }, [key]);
  return [opened.has(key), toggle];
}
