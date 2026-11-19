/**
 * The matter an ask is about, across teams: the ticket, issue or review it names. Two asks of the
 * user about one matter are one ask, whatever their teams and words. 2026-11-18: a triage leader's
 * letter asked the user to approve deleting a dangling DNS record of a ticket, and a task imported
 * for that same ticket (another project, no shared leader) asked him again in its own words; the
 * same-ask fold compares words inside one team, so neither saw the other.
 *
 * A matter key is an id a person tells two of them apart by (`TKT-1101`, `ENG-12`, a ticket's
 * UUID): a task's own link tags of those kinds (matterKeysOfTask) and its id, and any such key of
 * an open task named in an ask's words (matterKeysInText): an ask naming the task that asks it
 * points at that ask. A task holding many of them (a triage leader that
 * tracks every ticket) has no matter of its own: only the keys its ask names count for it. Pure.
 */
import type { Task } from './types.js';

/** Link tag kinds whose id names one matter. */
const MATTER_KINDS: ReadonlySet<string> = new Set(['ticket', 'ticket-id', 'issue', 'cr', 'pr', 'mr', 'sim', 'incident']);
/** A task with more than this many keys of its own tracks many matters, not one. */
export const MAX_OWN_MATTERS = 6;
/** A key more open tasks than this hold is a wide event (a region's incident), not one matter. */
export const MAX_KEY_HOLDERS = 4;
/** Words naming more keys than this are a digest, not an ask about one matter. */
export const MAX_NAMED_MATTERS = 6;
/** An id worth matching: five or more characters, a digit among them, never a plain word. */
const KEY_RE = /^(?=[^\d]*\d)[a-z0-9][a-z0-9_.#/-]{4,}$/;

function keyOf(raw: string): string | undefined {
  let v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const segs = new URL(v).pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      const at = segs.map((s) => /\d/.test(s)).lastIndexOf(true);
      if (at < 0) return undefined;
      // A bare number (a pull request, an issue) is one only with its repo: `app/pull/12`, never
      // a word an ask can name, so only another task's own tag matches it.
      if (/^\d+$/.test(segs[at]!)) return segs.slice(Math.max(0, at - 2), at + 1).join('/').toLowerCase();
      v = segs[at]!;
    } catch { return undefined; }
  }
  const k = v.toLowerCase();
  return KEY_RE.test(k) ? k : undefined;
}

/** Every matter key in a task's link tags, however many. */
export function allMatterKeysOfTask(task: Pick<Task, 'tags'>): string[] {
  const out = new Set<string>();
  for (const tag of task.tags ?? []) {
    const at = tag.indexOf(':');
    if (at <= 0 || !MATTER_KINDS.has(tag.slice(0, at).toLowerCase())) continue;
    const k = keyOf(tag.slice(at + 1));
    if (k) out.add(k);
  }
  return [...out];
}

/** The matter a task is about: its keys, or none when it tracks more than MAX_OWN_MATTERS. */
export function matterKeysOfTask(task: Pick<Task, 'tags'>): string[] {
  const keys = allMatterKeysOfTask(task);
  return keys.length <= MAX_OWN_MATTERS ? keys : [];
}

/** The keys of `known` that `text` names as a whole token. */
export function matterKeysInText(text: string | undefined | null, known: ReadonlySet<string>): string[] {
  if (!text || !known.size) return [];
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9_.#-]+/)) {
    const t = tok.replace(/^[.#-]+|[.#-]+$/g, '');
    if (t && known.has(t)) out.add(t);
  }
  return [...out];
}

/** What the matter check reads of the store once: every open task's keys, and its own. */
export interface MatterIndex {
  /** Keys any task holds (the words an ask may name), but a wide one. */
  known: ReadonlySet<string>;
  own: (taskId: string) => string[];
  /** Whether a key is a task's id (a pointer at that task's ask, never a matter to fold on). */
  isTaskId: (key: string) => boolean;
}

export function matterIndex(everything: readonly Task[]): MatterIndex {
  const holders = new Map<string, number>();
  const isOpen = (t: Task) => t.phase !== 'COMPLETE' && t.status !== 'done';
  for (const t of everything) if (isOpen(t)) for (const k of matterKeysOfTask(t)) holders.set(k, (holders.get(k) ?? 0) + 1);
  const wide = (k: string) => (holders.get(k) ?? 0) > MAX_KEY_HOLDERS;
  const known = new Set<string>();
  const own = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const t of everything) {
    // A task's id is a key too: an ask that names the task asking it points at that ask.
    const id = t.id.toLowerCase();
    if (KEY_RE.test(id)) ids.add(id);
    own.set(t.id, [...matterKeysOfTask(t).filter((k) => !wide(k)), ...(KEY_RE.test(id) ? [id] : [])]);
    // A finished task's ticket is still a word to look for: its result is news for an open ask.
    for (const k of allMatterKeysOfTask(t)) if (!wide(k)) known.add(k);
    if (KEY_RE.test(id)) known.add(id);
  }
  return { known, own: (id) => own.get(id) ?? [], isTaskId: (k) => ids.has(k) };
}

/** The matter of an ask from `taskId`: the task's own keys and the keys its words name (a digest names none). */
export function askMatter(taskId: string, text: string | undefined | null, index: MatterIndex): Set<string> {
  const named = matterKeysInText(text, index.known);
  return new Set([...index.own(taskId), ...(named.length > MAX_NAMED_MATTERS ? [] : named)]);
}

/** The first key `keys` shares with `other` (keys, or words naming keys), or undefined. */
export function sharedMatter(keys: ReadonlySet<string>, other: Iterable<string>): string | undefined {
  for (const k of other) if (keys.has(k)) return k;
  return undefined;
}

/** The first of `keys` that `text` names, or undefined. */
export function matterNamedIn(keys: ReadonlySet<string>, text: string | undefined | null): string | undefined {
  return keys.size ? sharedMatter(keys, matterKeysInText(text, keys)) : undefined;
}

/** How a matter key reads to a session: its id as tagged (upper case for a tracker id). */
export function matterWords(key: string): string {
  return /^[a-z]+\d+$/.test(key) || /^[a-z][a-z0-9]*-\d+$/.test(key) ? key.toUpperCase() : key;
}
