/**
 * A bare link in a card's few lines reads as a short label (2026-11-21, UI audit: a review link and
 * two local paths, each written out whole, wrapped over several lines and pushed a decision's
 * choices out of view). Only a link whose words are its own address (a URL or a path, no other
 * words) is relabelled: `host/…/last` for a URL (url-display.ts shortenUrl), `…/folder/file` for a
 * path. Where it goes is unchanged, and the whole address stays its tooltip.
 *
 * It works on the renderer's HTML (utils/markdown.ts), whose anchors hold plain text only.
 */
import { shortenUrl } from './url-display';

/** Words at most this long stay as they are. */
const KEEP = 36;
/** The longest label. */
const MAX = 40;

/** An anchor of plain words, or of one code span (a path the writer put in backticks). */
const ANCHOR = /<a\b([^>]*)>(<code>)?([^<]+)(<\/code>)?<\/a>/g;
const URL_ONLY = /^https?:\/\/\S+$/;
const PATH_ONLY = /^(?:~|\.{1,2})?\/?[^\s/]+(?:\/[^\s/]+)+\/?$|^\/[^\s/]+\/?$/;

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|#47|#x2F);/gi, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", '#47': '/', '#x2f': '/' })[e.toLowerCase()] ?? _);
}
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head));
}

/** A path's short label: its folder and file, `…/design-t3/index.html`. */
export function shortPath(path: string, max: number = MAX): string {
  if (path.length <= max) return path;
  const segs = path.replace(/\/$/, '').split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? path;
  const parent = segs[segs.length - 2];
  if (parent && parent.length + last.length + 3 <= max) return `…/${parent}/${last}`;
  // A long folder is cut in its middle rather than dropped: `index.html` alone says nothing.
  const room = max - last.length - 3;
  if (parent && room >= 8) return `…/${clip(parent, room)}/${last}`;
  return `…/${clip(last, max - 2)}`;
}

/** The label a link's own words get, or null when they stay. */
export function shortLinkLabel(words: string): string | null {
  const w = words.trim();
  if (w.length <= KEEP) return null;
  if (URL_ONLY.test(w)) return shortenUrl(w, MAX);
  if (PATH_ONLY.test(w)) return shortPath(w);
  return null;
}

export function shortLinkLabelsHtml(html: string): string {
  if (!html.includes('<a')) return html;
  return html.replace(ANCHOR, (whole, attrs: string, open: string | undefined, inner: string, close: string | undefined) => {
    if (!!open !== !!close) return whole;
    const words = decode(inner);
    const label = shortLinkLabel(words);
    if (!label || label === words.trim()) return whole;
    const title = /(?:^|\s)title="/.test(attrs) ? '' : ` title="${escape(words.trim())}"`;
    const text = escape(label);
    return `<a${attrs}${title} data-short-label="">${open ? `<code>${text}</code>` : text}</a>`;
  });
}
