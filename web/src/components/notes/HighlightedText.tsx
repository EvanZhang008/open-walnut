import type { ReactNode } from 'react';

/**
 * XSS-safe search-match highlighting (no dangerouslySetInnerHTML).
 *
 * The notes search API returns snippets with the matched span wrapped in literal
 * `<mark>…</mark>` tags (see makeSnippet in the notes-v2 route). Instead of
 * injecting that string as HTML, we split on the mark tags and render REAL React
 * <mark> elements for matched groups and plain text nodes otherwise — everything
 * else in the snippet stays inert text, so a note containing `<img onerror=…>`
 * can never execute in a result row.
 */

const MARK_SPLIT_RE = /(<mark>[\s\S]*?<\/mark>)/g;
const MARK_CAPTURE_RE = /^<mark>([\s\S]*?)<\/mark>$/;

/** Render a string containing literal <mark> spans as text + real <mark> elements. */
export function HighlightedText({ text }: { text: string }) {
  if (!text) return null;
  if (!text.includes('<mark>')) return <>{text}</>;
  return (
    <>
      {text.split(MARK_SPLIT_RE).map((part, i) => {
        const m = MARK_CAPTURE_RE.exec(part);
        if (m) return <mark key={i} className="notes-search-mark">{m[1]}</mark>;
        return part ? <span key={i}>{part}</span> : null;
      })}
    </>
  );
}

const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Occurrence regex for one query token — mirror of the server's snippet rule
 * (notes-v2 tokenOccurrenceRe): Latin tokens start at a word boundary and the
 * mark extends to the word's end ("resident" marks "Non-Resident"'s whole
 * word); CJK substrings match anywhere. Capture-group form, NOT lookbehind —
 * older WebKit throws on lookbehind at regex parse time.
 */
function tokenOccurrenceRe(tok: string): RegExp {
  return CJK_RE.test(tok)
    ? new RegExp(`()(${escapeRe(tok)})`, 'giu')
    : new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(tok)}[\\p{L}\\p{N}]*)`, 'giu');
}

/**
 * Client-side title highlight: the server highlights snippets but NOT titles.
 * A contiguous whole-query hit marks the phrase; otherwise each matched query
 * TOKEN (server-tokenized `queryTokens`, so stopwords never light up) gets its
 * own mark — a multi-word query almost never appears verbatim in a title, but
 * its words do ("canada non resident tax" → "2025 US **Tax** — **Non-Resident**").
 * Skipped for very short queries (< 2 chars) — single-letter marks read as noise.
 */
export function HighlightedTitle({ text, query, tokens }: { text: string; query: string; tokens?: string[] }) {
  const q = query.trim();
  if (!text || q.length < 2) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx >= 0) {
    return (
      <>
        {text.slice(0, idx)}
        <mark className="notes-search-mark">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  }
  // Token-wise fallback. Ranges never overlap: tokens are deduped and each
  // match consumes to the word's end, so later shorter tokens can't split it.
  const ranges: Array<[number, number]> = [];
  for (const tok of tokens ?? []) {
    if (tok.length < 2) continue;
    const re = tokenOccurrenceRe(tok);
    let m: RegExpExecArray | null;
    while (ranges.length < 8 && (m = re.exec(text))) {
      const s = m.index + m[1].length;
      const e = s + m[2].length;
      if (!ranges.some(([rs, rEnd]) => s < rEnd && e > rs)) ranges.push([s, e]);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  if (ranges.length === 0) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], i) => {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(<mark key={i} className="notes-search-mark">{text.slice(s, e)}</mark>);
    cursor = e;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
