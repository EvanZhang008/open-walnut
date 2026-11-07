/**
 * Which copy of a word a search hit means, when the reader typed several words.
 *
 * A Notes search for "meadow violet" opens the note with the find bar on
 * "violet" (the words as typed are not in the note). The note can hold many
 * violets; the one the reader wants is the one next to "meadow". Both find
 * engines (utils/page-find.ts, utils/find-doc.ts) ask this for it.
 */

/** How far apart, in characters, two words still count as next to each other. */
const NEAR_CHARS = 200;

/** The typed words other than the one the bar searches (none when it searches them all). */
export function otherWords(typed: string, searched: string): string[] {
  const q = searched.trim().toLowerCase();
  if (!q || typed.trim().toLowerCase() === q) return [];
  const out = typed.split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !q.includes(w.toLowerCase()));
  return [...new Set(out)];
}

/**
 * The hit (an offset into `text`) with the most of `others` within
 * NEAR_CHARS of it, then the one closest to one of them; the first on a tie.
 * -1 when no other word is in the text at all (keep the usual pick).
 */
export function nearestToOthers(text: string, hits: readonly number[], others: readonly string[], caseSensitive: boolean): number {
  if (!hits.length || !others.length) return -1;
  const hay = caseSensitive ? text : text.toLowerCase();
  const spots = others.map((w) => {
    const needle = caseSensitive ? w : w.toLowerCase();
    const at: number[] = [];
    for (let i = hay.indexOf(needle); i !== -1 && at.length < 2000; i = hay.indexOf(needle, i + needle.length)) at.push(i);
    return at;
  }).filter((at) => at.length > 0);
  if (!spots.length) return -1;
  let best = -1;
  let bestNear = -1;
  let bestDist = Infinity;
  hits.forEach((h, i) => {
    let near = 0;
    let dist = Infinity;
    for (const at of spots) {
      let d = Infinity;
      for (const p of at) d = Math.min(d, Math.abs(p - h));
      if (d <= NEAR_CHARS) near += 1;
      dist = Math.min(dist, d);
    }
    if (near > bestNear || (near === bestNear && dist < bestDist)) {
      best = i;
      bestNear = near;
      bestDist = dist;
    }
  });
  return best;
}
