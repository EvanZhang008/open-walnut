/**
 * The changed default instructions restated right after a compaction, in hooks of their own.
 *
 * A compaction drops what the instruction notices told a session, so everything its stored prompt
 * lacks is due again (instruction-notice.ts). The compaction's open_items hook may add only
 * HOOK_CONTEXT_MAX (Claude Code shows the model a 2 KB preview of more), so a long restatement used
 * to wait for the session's next message, and the turn the compaction happened in went on without
 * the rules (2026-11-18: a worker on an old prompt ran 74 s with none of them, the user's "only his
 * own yes" rule among them; the Walnut VP: "压缩后的指令重发不能让会话裸跑").
 *
 * Claude Code's limit holds per hook (checked 2026-11-18 on CLI 2.1.322: five SessionStart:compact
 * hooks of 9.4K each all reached the model whole, in no fixed order). So a session gets
 * INSTRUCTION_HOOK_PARTS more compaction hooks (compact-open-items-hook.ts); each asks for one part
 * (`open_items {"hook":"compact","part":i,"of":n}`), and the main hook (`"parts":n`) leaves the
 * instructions to them. Each part says which part it is. The restatement counts as told only once
 * every part was served for it; a part that never came (an older `walnut` on the host refuses the
 * argument and prints nothing) leaves it due, so the next message carries it, as before. One longer
 * than all the parts together (never seen yet) is not told by them either: the hooks give what they
 * hold and the next message carries it whole.
 */

import { hash, opensAuthor } from './instruction-diff.js';

/** How many compaction hooks carry the instructions: about 37 KB, past the longest seen (31 KB). */
export const INSTRUCTION_HOOK_PARTS = 4;
/** The most a hook may name (the op's and the route's bound). */
export const INSTRUCTION_HOOK_PARTS_MAX = 8;

/** A tagged line's text without its `[v…] ` version tag. */
const untagged = (line: string) => line.replace(/^\[v[0-9a-z]+\] /, '');
/** A line that scopes the lines below it: a heading, or a label such as "Removed, no longer in force:". */
const isHeading = (line: string) => untagged(line).startsWith('#');
const isLabel = (line: string) => !untagged(line).startsWith('- ') && untagged(line).trimEnd().endsWith(':');

/**
 * The lines that scope what follows `before` (the text already given), repeated at the top of the next
 * part so none of its lines reads out of scope (review, 2026-11-18: a "Removed, no longer in force:"
 * list cut in two left its second half reading as rules in force). These are the last top-level
 * heading, and, when the cut falls inside an item (renderDue puts blank lines only between items), the
 * item's first line with the last sub-heading and label inside it.
 */
function scopeAt(before: string, next: string): string[] {
  const lines = before.replace(/\n$/, '').split('\n');
  let heading: string | undefined;
  let item: string[] = [];
  let prev = '';
  for (const line of lines) {
    if (!line.trim()) { item = []; prev = ''; continue; }
    if (line.startsWith('#')) { heading = line; item = []; prev = ''; continue; }
    // renderDue puts no blank line after a plain rule, so a block or a gone item right after one starts
    // at its head line (review, 2026-11-18): inside an item the only untagged "- " lines are the last
    // list's (Removed), so an untagged head after one is always a new item.
    if (prev.startsWith('- ') && !line.startsWith('- ') && line === untagged(line)) item = [];
    item.push(line);
    prev = line;
  }
  const out: string[] = [];
  if (heading && !next.startsWith('#')) out.push(heading, '');
  // A run of plain rules ("- …" lines) has no head of its own: its heading is its scope.
  // A head cut mid-line (one line longer than the room) is never repeated as a head.
  const cutMidLine = item.length === 1 && !/\n$/.test(before);
  if (item.length && !untagged(item[0]).startsWith('- ') && !cutMidLine) {
    const [head, ...inside] = item;
    // A list label ("New:", "Removed, no longer in force:"), the author part inside it ("[v…] Added by X:")
    // and the sub-heading inside that, as renderDue and withParts nest them.
    let label: string | undefined;
    let author: string | undefined;
    let sub: string | undefined;
    for (const line of inside) {
      const tagged = line !== untagged(line);
      if (isHeading(line)) sub = line;
      else if (tagged && opensAuthor(untagged(line))) { author = line; sub = undefined; }
      else if (!tagged && isLabel(line)) { label = line; author = undefined; sub = undefined; }
    }
    out.push(`(Continued from the part before) ${head}`, ...[label, author, sub].filter((l): l is string => !!l));
  }
  return out;
}

/**
 * Split `body` into chunks of at most `room` characters: at a blank line when one is in the last two
 * fifths, else at a line end, else (one line longer than the room) at a space. Each chunk after the
 * first opens with the headings and labels its lines sit under (scopeAt). Only the line breaks between
 * chunks are dropped, so a chunk keeps the indent its first line had.
 */
export function splitAtLines(body: string, room: number): string[] {
  const out: string[] = [];
  let rest = body.replace(/^\n+/, '').trimEnd();
  let given = '';
  let scope: string[] = [];
  while (rest) {
    const prefix = scope.length ? `${scope.join('\n')}\n` : '';
    // A scope that leaves no room for a line of its own is dropped rather than looping forever.
    const fit = prefix && room - prefix.length >= room / 3 ? room - prefix.length : room;
    const lead = fit === room ? '' : prefix;
    if (rest.length <= fit) { out.push(lead + rest); break; }
    const window = rest.slice(0, fit + 1);
    const blank = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    let end = blank >= fit * 0.6 ? blank : line > 0 ? line : space > fit / 2 ? space : fit;
    // Never between the two halves of a surrogate pair.
    if (end === fit && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? '')) end -= 1;
    const atSpace = end === space && end !== line;
    out.push(lead + rest.slice(0, end).trimEnd());
    // The line breaks at the cut go to what was given: a blank line there ends the item.
    const after = rest.slice(end);
    const breaks = /^\n*/.exec(after)![0];
    given += rest.slice(0, end) + breaks;
    rest = after.slice(breaks.length);
    if (atSpace) rest = rest.replace(/^ /, '');
    scope = scopeAt(given, rest);
  }
  return out;
}

/**
 * Parts served per session and restatement in the current round of hooks, until all are: then it
 * counts as told. A round is one compaction's hooks, which Claude Code runs together with a 20 s
 * timeout each: an entry older than ROUND_MS is another compaction's (a fork's, or an earlier one),
 * and never counts toward this one (review, 2026-11-18: three parts of a fork's round and one of the
 * real compaction's made a whole set while the conversation held one part).
 */
const served = new Map<string, { parts: Set<number>; at: number }>();
const ROUND_MS = 60_000;

/**
 * Note that part `part` of `count` (of a restatement whose text hashes to `key`) reached the session.
 * True exactly once per round: when this part completes the set.
 */
export function notePartServed(sessionId: string, key: string, part: number, count: number, now = Date.now()): boolean {
  for (const [k, v] of served) if (now - v.at > ROUND_MS) served.delete(k);
  const id = `${sessionId}:${key}`;
  const entry = served.get(id) ?? { parts: new Set<number>(), at: now };
  entry.parts.add(part);
  if (entry.parts.size < count) { served.set(id, entry); return false; }
  // Complete: the next compaction starts a round of its own.
  served.delete(id);
  return true;
}

export const restatementKey = (text: string) => hash(text);

/** For tests: forget every part served. */
export function _resetPartsServed(): void { served.clear(); }

/** The main hook's line in place of the instructions. */
export function instructionsInPartsLine(count: number, of: number): string {
  if (count <= of) {
    return `Walnut restates your changed default instructions right beside this, in ${count} part${count === 1 ? '' : 's'} `
      + 'of their own: where your system prompt or the summary differs from them, they win.';
  }
  return `Walnut restates your changed default instructions beside this, in ${of} parts, and they come in full in front of `
    + 'your next message too, as not all of them fit: where your system prompt or the summary differs from them, they win.';
}
