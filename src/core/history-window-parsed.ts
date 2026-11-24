/**
 * Parsed older-history windows of a transcript too large for the full read, kept by the bytes
 * they were parsed from (session-history.ts readSessionHistoryRangeHere). The window's text is
 * kept already (jsonl-window.ts); its parse was not, so every older page parsed its 4 MB windows
 * again. 2026-11-24: one caller paged one 60 MB session back in time slices 635 times in an hour,
 * each page parsing up to four windows, and its parses were in the server's 5.7 GB burst.
 *
 * A window of one file incarnation (host, path, epoch) between fixed offsets is the same bytes
 * however the file grows, so its parse is too; the key also carries the injected lines merged
 * into it. Readers get their own array (the message rows are shared, read only).
 */
import { registerMemoryHolder } from './observability/memory-ledger.js';
import type { SessionHistoryMessage } from './session-history.js';

/** Source text the kept parses come from, at most: a parse holds a few times its text. */
const KEPT_PARSED_MAX_CHARS = 24 * 1024 * 1024;

interface Kept { messages: readonly SessionHistoryMessage[]; chars: number }
const kept = new Map<string, Kept>();
let keptChars = 0;

export function parsedWindowKey(file: string, start: number, stop: number, injected: readonly string[]): string {
  const tail = injected.length ? `${injected.length}:${injected[injected.length - 1]!.length}:${injected.reduce((n, l) => n + l.length, 0)}` : '0';
  return `${file}\u0000${start}\u0000${stop}\u0000${tail}`;
}

/** The kept parse of this window, as a new array; undefined when none. */
export function keptParsedWindow(key: string): SessionHistoryMessage[] | undefined {
  const hit = kept.get(key);
  if (!hit) return undefined;
  kept.delete(key);
  kept.set(key, hit);
  return [...hit.messages];
}

export function keepParsedWindow(key: string, messages: readonly SessionHistoryMessage[], chars: number): void {
  const prev = kept.get(key);
  if (prev) { keptChars -= prev.chars; kept.delete(key); }
  if (chars > KEPT_PARSED_MAX_CHARS) return;
  kept.set(key, { messages: [...messages], chars });
  keptChars += chars;
  while (keptChars > KEPT_PARSED_MAX_CHARS) {
    const oldest = kept.keys().next();
    if (oldest.done) break;
    keptChars -= kept.get(oldest.value)?.chars ?? 0;
    kept.delete(oldest.value);
  }
}

/** Tests only. */
export function _resetParsedWindowsForTests(): void {
  kept.clear();
  keptChars = 0;
}

registerMemoryHolder({
  name: 'history-window.parsed',
  budgetBytes: 96 * 1024 * 1024,
  // A parse holds about twice its source text in strings, counted as UTF-16.
  read: () => ({ entries: kept.size, chars: keptChars * 2 }),
});
