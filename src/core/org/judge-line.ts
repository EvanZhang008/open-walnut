/**
 * Reading a small model's one-line verdict, shared by the Threads judges that ask it to quote what
 * it rests on (thread-seen-check.ts: his words about an answer; thread-answered-check.ts: the words
 * of a reply that answer his question). The quote comes first and the verdict after an arrow, so the
 * model commits to its evidence before its word, and what it quotes can be checked against the text
 * it read. Pure.
 */

/** What a judge quotes, in straight or curly quotes. */
const QUOTED = /"([^"\n]*)"|\u201c([^\u201d\n]*)\u201d/g;

/**
 * The one word among `allowed` a judge's answer gives after its last arrow (anywhere, with no
 * arrow), quoted text left out: what it quotes is never its verdict (`"... => SAME" so OTHER` is
 * OTHER). `unsure` when it gives two, null when none. Pure.
 */
export function verdictWord(answer: string, allowed: RegExp, unsure: string): string | null {
  const text = answer.replace(QUOTED, ' ').toUpperCase();
  const arrow = text.lastIndexOf('=>');
  const words = new Set((arrow >= 0 ? text.slice(arrow + 2) : text).match(allowed) ?? []);
  return words.size === 0 ? null : words.size === 1 ? [...words][0] : unsure;
}

/**
 * The words a judge rests its verdict on: what it quotes on the line that holds its verdict (the
 * last with an arrow), or on the nearest line above when that one quotes nothing (it at times puts
 * the arrow on a line of its own); the whole answer when it wrote no arrow. Pure.
 */
export function quotedEvidence(answer: string): string[] {
  const quotes = (text: string): string[] => [...text.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter((q) => q && q !== '-');
  const lines = answer.split('\n');
  let at = lines.length - 1;
  while (at >= 0 && !lines[at].replace(QUOTED, ' ').includes('=>')) at--;
  if (at < 0) return quotes(answer);
  for (; at >= 0; at--) {
    const found = quotes(lines[at]);
    if (found.length) return found;
  }
  return [];
}
