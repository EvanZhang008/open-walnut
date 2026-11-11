/**
 * Plain-text → clickable-token splitting + Slack-style URL shortening.
 *
 * For surfaces that show USER-TYPED plain text in a tight one-line slot (the
 * session notes bar today). Those surfaces can't go through the markdown
 * pipeline in `markdown.ts`: that one emits an HTML string for
 * `dangerouslySetInnerHTML` and applies block/inline markdown semantics, which
 * is wrong for a literal note. This module keeps the text literal and returns
 * TOKENS the caller renders as React nodes.
 *
 * Two jobs, both from the same 2026-07-29 report ("the link inside needs to be
 * clickable, and reduce in size — it is too long, like this in Slack"):
 *  1. `tokenizeUrls` — find the http(s) runs so they can become real anchors.
 *  2. `shortenUrl`   — render a long URL as a short LABEL (host + the meaningful
 *     path tail + the query's key) so one deploy link can't consume the whole
 *     row. The anchor's href stays the full URL; only the label shrinks.
 */

// The URL run rule (where a URL starts and ends in prose) is shared with the
// server's letter body linker, so it lives in src/lib/url-text.ts. Relative
// import on purpose: the markdown test tier runs this in a bare node env.
import { tokenizeUrls } from '../../../src/lib/url-text';

export { tokenizeUrls, trimTrailingPunctuation, trimUrlCjkTail, type TextToken } from '../../../src/lib/url-text';

/** Every distinct URL in a text, first-occurrence order. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenizeUrls(text)) {
    if (t.kind === 'url') seen.add(t.href);
  }
  return [...seen];
}

/** Keep the head and tail of a too-long string, eliding the middle. */
function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
}

/**
 * Default label budget. Sized so a typical deploy link keeps `host` + its LAST
 * path segment (`pipelines.…/…/change_history_v2`) — the two halves a human
 * recognizes. Callers in narrower slots can pass less.
 */
const DEFAULT_MAX = 56;

/**
 * Shorten a URL to a readable label of at most `max` chars.
 *
 * The value ordering matters and is NOT obvious: the LAST path segment outranks
 * the query string. A first attempt kept `?changes=…` and elided the path tail,
 * which produced `pipelines.example.com/…?changes=…` — technically short, but it
 * no longer told you what the link WAS (caught by the E2E). The last segment is
 * the human-readable name; the query is usually an opaque sha/blob and is what
 * made the URL huge in the first place.
 *
 * So, longest form first: full → elide MIDDLE path segments → drop the query →
 * middle-truncate the last segment itself → drop the path. The final fallback
 * middle-truncates, so the result ALWAYS fits `max`.
 *
 * Non-parseable input degrades to a scheme-stripped middle-truncation rather
 * than throwing — this runs during render.
 */
export function shortenUrl(raw: string, max: number = DEFAULT_MAX): string {
  let host: string, path: string, search: string, hash: string;
  try {
    const u = new URL(raw);
    host = u.host.replace(/^www\./, '');
    path = u.pathname.replace(/\/$/, '');
    search = u.search;
    hash = u.hash;
  } catch {
    return middleTruncate(raw.replace(/^https?:\/\//, ''), max);
  }

  const full = host + path + search + hash;
  if (full.length <= max) return full;

  // "?changes=…" — the param NAME says what the link is keyed on; the value
  // (a commit sha, a base64 blob) is the part worth throwing away.
  const firstParam = search ? search.slice(1).split(/[&=]/)[0] ?? '' : '';
  const q = search
    ? '?' + middleTruncate(firstParam, 14) + '=…'
    : hash ? '#…' : '';

  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  // Room the tail may occupy once "host/…/" is spent; keeps a very long slug
  // present-but-clipped instead of dropping it entirely.
  const tailBudget = max - host.length - 3;
  const clippedLast = last && tailBudget > 3 ? middleTruncate(last, tailBudget) : '';

  const candidates = [
    host + path + q,
    segs.length > 2 && last ? `${host}/${segs[0]}/…/${last}${q}` : null,
    segs.length > 1 && last ? `${host}/…/${last}${q}` : null,
    // Query dropped from here down — the path tail is worth more than the query.
    host + path,
    segs.length > 1 && last ? `${host}/…/${last}` : null,
    clippedLast && clippedLast !== last ? `${host}/…/${clippedLast}` : null,
    segs.length ? `${host}/…${q}` : null,
    segs.length ? `${host}/…` : null,
    host + q,
    host,
  ];
  for (const c of candidates) {
    if (c && c.length <= max) return c;
  }
  return middleTruncate(full, max);
}
