/**
 * The latest words of each ask's conversation, for its row in the side panel's drawer and the
 * Continue lists (review 2026-11-06 round 3: every finished ask's second line read "Take a look",
 * which told the rows apart no more than the dot did). An ask's row says where it stopped: what it
 * asks the person when it really needs them, else these words (ext-tasks-model.ts askRowDetail).
 *
 * Read from the conversation itself (its newest messages, a small tail), at most a few rows at a
 * time and only for a row whose ask moved since it was read (`stamp`), and kept in this browser so
 * the next open shows them at once.
 */
import type { Task } from '@open-walnut/core';

/** How much of the words a row keeps: its single line cuts what it cannot show. */
export const ASK_WORDS_MAX = 160;
const KEY = 'walnut.ext-panel.ask-words';
const KEEP = 80;

export interface KeptWords { text: string; stamp: string; at: number }
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | null => { try { return window.localStorage; } catch { return null; } };

/** When the ask last moved: words read at an older stamp may be of an earlier turn. */
export function wordsStamp(task: Pick<Task, 'updated_at'> & { last_session_update?: string }): string {
  return String(task.last_session_update ?? task.updated_at ?? '');
}

/**
 * The words a conversation's newest reply ended on, as one plain line: markup and code left out,
 * the end kept (where a reply puts its question or its result). '' when it has none yet. Pure.
 */
export function wordsOfMessages(messages: ReadonlyArray<{ role: string; text?: string }>): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && (m.text ?? '').trim());
  if (!last) return '';
  const plain = (last.text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= ASK_WORDS_MAX) return plain;
  const tail = plain.slice(-ASK_WORDS_MAX);
  // Start the tail at a sentence, else a word, so it never opens mid-word.
  const cut = tail.search(/(?<=[.!?。！？])\s*\S|\s\S/);
  return `…${(cut >= 0 && cut < ASK_WORDS_MAX / 2 ? tail.slice(cut) : tail).trim()}`;
}

let cache: { raw: string | null; all: Record<string, KeptWords> } = { raw: null, all: {} };
function readAll(s: Store | null): Record<string, KeptWords> {
  let raw: string | null = null;
  try { raw = s?.getItem(KEY) ?? null; } catch { return {}; }
  if (raw === cache.raw) return cache.all;
  let all: Record<string, KeptWords> = {};
  try { const v = JSON.parse(raw ?? '{}'); if (v && typeof v === 'object') all = v as Record<string, KeptWords>; } catch { /* unreadable: start over */ }
  cache = { raw, all };
  return all;
}

/** The words kept for this ask, with the stamp they were read at, or null. */
export function keptWords(taskId: string, s: Store | null = browserStore()): KeptWords | null {
  const w = readAll(s)[taskId];
  return w && typeof w.text === 'string' && typeof w.stamp === 'string' ? w : null;
}

export function keepWords(taskId: string, text: string, stamp: string, s: Store | null = browserStore(), now = Date.now()): void {
  const all = { ...readAll(s), [taskId]: { text: text.slice(0, ASK_WORDS_MAX + 1), stamp, at: now } };
  const kept = Object.entries(all).filter(([, v]) => v && typeof v.at === 'number').sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  try { s?.setItem(KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* full or blocked: read again next open */ }
}

/**
 * The rows whose words to read now: the first `max` shown that have a conversation and moved
 * since their words were read (or were never read). Pure.
 */
export function wordsToRead(
  rows: ReadonlyArray<{ id: string; task?: Task }>,
  sessionOf: (t: Task) => string | null,
  kept: (taskId: string) => KeptWords | null,
  max = 8,
): Array<{ taskId: string; sessionId: string; stamp: string }> {
  const out: Array<{ taskId: string; sessionId: string; stamp: string }> = [];
  for (const r of rows.slice(0, max)) {
    if (!r.task) continue;
    const sessionId = sessionOf(r.task);
    if (!sessionId) continue;
    const stamp = wordsStamp(r.task);
    if (kept(r.id)?.stamp === stamp) continue;
    out.push({ taskId: r.id, sessionId, stamp });
  }
  return out;
}
