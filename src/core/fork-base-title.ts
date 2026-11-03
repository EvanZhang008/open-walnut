/** Pure fork-title helpers, kept apart from fork-title.ts (model calls) so any module or test can use them. */

/**
 * A source title with every fork decoration taken off, so a fork of a fork names its
 * root once: `Fork of Fork of X`, `label - fork of X` and any mix of them, however deep,
 * give back the name under them. One pass took off one layer, so a source already
 * carrying two gave its fork three (2026-11-03: a session five forks deep printed
 * "Fork of" five times as its sender name). Falls back to the title when nothing is left.
 */
export function forkBaseTitle(title: string): string {
  let base = (title ?? '').trim();
  for (;;) {
    const next = base.replace(/^(?:fork of\s+)+/i, '').replace(/\s+-\s+fork of\s+.*$/i, '').trim();
    if (next === base || !next) break;
    base = next;
  }
  return base || (title ?? '').trim();
}

/** The placeholder a fork is born with: one `Fork of` before its source's base name. */
export function forkTitleOf(sourceTitle: string): string {
  return `Fork of ${forkBaseTitle(sourceTitle)}`;
}
