/**
 * A user line Claude Code drained from several queued sends, split back into its sends.
 *
 * When several sends wait in the CLI's queue, it runs them as ONE user line: their texts
 * joined with '\n' (a string line), or their blocks one after another (a line of blocks),
 * written under the last send's uuid with the others named in `mergedSendUuids`. Read as
 * one row, a person's words drained with a peer's reply read as the reply's card and lost
 * their bubble (2026-11-21). Both transcript parsers split it with these rules: the
 * primary's (history-parse.ts) and the phone's second reader (sessions/transcript-from-jsonl.ts).
 * Pure: no I/O.
 */

import { nonHumanOrigin, parseSessionEnvelopes } from '../lib/history-session-envelope.js';

/** The other sends' uuids on a user line Claude Code merged from several queued sends. */
export function mergedSendUuidsOf(raw: { mergedSendUuids?: unknown }): string[] | undefined {
  const list = raw.mergedSendUuids;
  if (!Array.isArray(list)) return undefined;
  const ids = list.filter((u): u is string => typeof u === 'string' && u.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * The sends of a user line of blocks, one group per send, or undefined. Walnut writes a send
 * with pictures as its images, then ONE text block (providers/user-line-images-core.ts), and a
 * plain send joins a line of blocks as one text block, so every send ends at a text block: the
 * line splits after each one. Only when that count is exactly the line's sends (its own plus
 * `mergedSendUuids`) and nothing but images and text is in it; anything else stays one row.
 */
export function joinedSendGroups<B extends { type?: unknown; text?: unknown }>(
  raw: { mergedSendUuids?: unknown; message?: { content?: unknown } },
): B[][] | undefined {
  const others = mergedSendUuidsOf(raw);
  const c = raw.message?.content as B[] | undefined;
  if (!others || !Array.isArray(c) || c.length === 0) return undefined;
  if (!c.every((b) => b?.type === 'image' || (b?.type === 'text' && typeof b.text === 'string'))) return undefined;
  if (c[c.length - 1]?.type !== 'text' || c.filter((b) => b.type === 'text').length !== others.length + 1) return undefined;
  const groups: B[][] = [[]];
  for (const b of c) {
    groups[groups.length - 1]!.push(b);
    if (b.type === 'text' && groups.length <= others.length) groups.push([]);
  }
  return groups;
}

/**
 * The run of queued texts (`queued`, in queue order) a string line joined: [first, last] with
 * `queued.slice(first, last + 1).join('\n')` equal to the line's text, at least two long, and
 * exactly `sends` long when the line names how many it joined. The earliest such run wins.
 */
export function joinedRun(queued: readonly string[], lineText: string, sends?: number): [number, number] | undefined {
  const wanted = lineText.trim();
  for (let s = 0; s < queued.length - 1; s++) {
    let joined = queued[s]!;
    for (let e = s + 1; e < queued.length; e++) {
      if (sends !== undefined && e - s + 1 > sends) break;
      joined += '\n' + queued[e];
      if (joined.trim() === wanted && (sends === undefined || e - s + 1 === sends)) return [s, e];
    }
  }
  return undefined;
}

/**
 * Whether one send of a drained line came from an agent. The line carries ONE origin, the
 * last send's, so a person's words drained after a peer's reply would read as the agent's:
 * only a send that is itself a Walnut envelope keeps the line's non-human origin.
 */
export function drainedSendIsAgent(lineOrigin: unknown, words: string): boolean {
  return nonHumanOrigin(lineOrigin) && parseSessionEnvelopes(words) !== null;
}
