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
import { useCallback, useEffect, useState } from 'react';
import { noticeText } from '@open-walnut/history-session-envelope';

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

/** How long a card's summary may run (two lines on a wide column; CSS clamps the rest). */
export const FOLD_SUMMARY_MAX = 280;

/** A message's words as one plain line: a task chip reads as its label, other tags and code drop. */
function plainText(text: string): string {
  return text
    // What a body never shows (sanitized away or invisible): the element with its contents.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript|head|title|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:task-ref|walnut-task)\b[^<>]*?\blabel=(["'])(.*?)\1[^<>]*>/g, '$2')
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, '')
    .split('\n')
    .filter((l) => !/^\s*(```|~~~|\|)/.test(l))
    .map(plainLine)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The card's summary: the first of `sources` that says something past the title,
 * as plain words, cut to FOLD_SUMMARY_MAX. Undefined when nothing does.
 */
export function foldSummary(title: string | undefined, ...sources: (string | undefined)[]): string | undefined {
  const head = (title ?? '').replace(/…$/, '').trim();
  for (const source of sources) {
    if (!source) continue;
    let text = plainText(source);
    if (head && text.startsWith(head)) text = text.slice(head.length).replace(/^[\s:;,.\-\u2013]+/, '');
    if (!text || text === head) continue;
    const points = [...text];
    return points.length > FOLD_SUMMARY_MAX ? `${points.slice(0, FOLD_SUMMARY_MAX - 1).join('').trimEnd()}…` : text;
  }
  return undefined;
}

/** A Walnut notice's outcome as the card shows it (shared with the server's
 *  whole-session find, which searches the card's words as shown). */
export { noticeText };

/** A Walnut notice's folded title: the first sentence of its outcome. */
export function noticeTitle(statusLine: string | undefined): string | undefined {
  return statusLine ? fallbackTitle(noticeText(statusLine)) : undefined;
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
const listeners = new Set<() => void>();

/** Test seam. */
export function _clearOpenedFolds(): void {
  opened.clear();
}

/** Open these cards (the find bar stepping onto words in a folded card's
 *  body); false when every one was open already. */
export function openMessageFolds(keys: Iterable<string>): boolean {
  let changed = false;
  for (const k of keys) if (!opened.has(k)) { opened.add(k); changed = true; }
  if (changed) for (const fn of [...listeners]) fn();
  return changed;
}

/** Open/closed for one card, starting folded, remembered for the page. */
export function useMessageFold(key: string): [boolean, () => void] {
  const [, rerender] = useState(0);
  // Opened from outside (openMessageFolds): only a card that was closed re-renders.
  useEffect(() => {
    let was = opened.has(key);
    const fn = () => { const now = opened.has(key); if (now !== was) { was = now; rerender((n) => n + 1); } };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [key]);
  const toggle = useCallback(() => {
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    rerender((n) => n + 1);
  }, [key]);
  return [opened.has(key), toggle];
}
