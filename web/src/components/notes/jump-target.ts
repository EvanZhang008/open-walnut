/**
 * Turn a search hit into ORDERED candidate needles for jumping the editor to
 * the matched region (most specific first).
 *
 * Why not just the first <mark>'s text (the old behavior): that is often a
 * short common word ("tax"), whose FIRST occurrence in the document is the
 * title — the jump landed at the top and read as "nothing happened". The
 * snippet already IS the matched region, so a context window starting at the
 * first mark is a near-unique needle that lands on the right paragraph; the
 * shorter candidates below it are fallbacks, not the primary target.
 */
export function jumpNeedles(opts: {
  snippet?: string;
  headingMatch?: string;
  query: string;
}): string[] {
  const out: string[] = [];
  const snippet = opts.snippet ?? '';
  const mIdx = snippet.indexOf('<mark>');
  if (mIdx >= 0) {
    const plain = snippet.replace(/<\/?mark>/g, '');
    const start = snippet.slice(0, mIdx).replace(/<\/?mark>/g, '').length;
    let ctx = plain.slice(start, start + 80);
    // Cleaning placeholders ([img]/[embed]) don't exist in the rendered doc —
    // a needle crossing one can never match. Stop before it.
    ctx = ctx.split(/\[(?:img|embed)\]/)[0];
    ctx = ctx.replace(/…+\s*$/, '');
    // Trim a trailing partial word (the 80-char cut lands mid-word).
    if (plain.length > start + 80) ctx = ctx.replace(/\s+\S*$/, '');
    ctx = ctx.trim();
    if (ctx.length >= 8) out.push(ctx);
    const markText = /<mark>([^<]{1,80})<\/mark>/.exec(snippet)?.[1]?.trim();
    if (markText) out.push(markText);
  }
  // Heading hits: the heading's own text is an exact, author-written anchor.
  if (opts.headingMatch) out.push(opts.headingMatch);
  const q = opts.query.trim();
  if (q) out.push(q);
  return [...new Set(out)];
}
