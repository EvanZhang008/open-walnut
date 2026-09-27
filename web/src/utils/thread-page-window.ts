/**
 * The stack's root page windows over ITS OWN rows (N9). The transcript's render
 * window counts raw messages, but on the root page most of the tail can belong
 * to questions (rendered on their own pages), so "the last 30 messages" left a
 * handful of root rows on screen and a `Show 46 earlier` button that revealed 6.
 * Both helpers take `keyAt(i)`: the thread key of message i.
 */

/** Raw tail length that holds `want` rows of `pageKey` (all of them when fewer). */
export function pageWindowLimit(count: number, keyAt: (i: number) => string, pageKey: string, want: number): number {
  if (want <= 0) return 0;
  let seen = 0;
  for (let i = count - 1; i >= 0; i--) {
    if (keyAt(i) !== pageKey) continue;
    seen += 1;
    if (seen >= want) return count - i;
  }
  return count;
}

/** How many rows of `pageKey` sit before raw index `end` (the hidden ones). */
export function pageRowsBefore(end: number, keyAt: (i: number) => string, pageKey: string): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (keyAt(i) === pageKey) n += 1;
  return n;
}
