/**
 * The cached-history line, as one clean sentence (N2-22). The reason comes
 * from the server in two shapes, "Reconnecting to <host>" or a sentence of
 * its own ("Can't reach <host> right now."), and was pasted into
 * "(...). Reconnecting..." with its own punctuation, doubling both.
 */
export function staleBannerText(reason: string): string {
  const r = reason.trim().replace(/[\s.\u2026]+$/u, '');
  if (!r) return 'Showing cached history. Reconnecting...';
  if (/^reconnecting\b/i.test(r)) return `Showing cached history. ${r}...`;
  return `Showing cached history. ${r}. Reconnecting...`;
}
