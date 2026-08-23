/**
 * Plain-text preview derivation for letter envelopes and phone pushes.
 *
 * The agent SHOULD pass `text`, but most won't, so a letter's envelope line has
 * to be derived from its body. Bodies can be 200KB, and this runs on the web
 * server's single event loop, so every regex below only ever sees the first
 * PREVIEW_SOURCE_CHARS characters — bounded work regardless of body size.
 */

import { LETTER_PREVIEW_MAX_CHARS } from './types.js';

/** Enough source to fill 300 chars even after markup is stripped. */
const PREVIEW_SOURCE_CHARS = 8_000;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripHtml(html: string): string {
  return collapse(
    decodeEntities(
      html
        // Drop non-content elements wholesale — their text is never the preview.
        .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        // Block boundaries become spaces so words don't run together.
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ''),
    ),
  );
}

function stripMarkdown(md: string): string {
  return collapse(
    md
      // Fenced code: keep the code text out of the preview entirely.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // Images first (they'd otherwise read as links with an empty label).
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/[*_~]{1,3}/g, ''),
  );
}

/**
 * Derive the envelope/push preview: `text` when the agent supplied one,
 * otherwise the body stripped down to plain words. Always <= 300 chars.
 */
export function derivePreview(
  opts: { text?: string; html?: string; markdown?: string },
): string {
  const explicit = opts.text ? collapse(opts.text) : '';
  if (explicit) return truncatePreview(explicit);
  if (opts.html) return truncatePreview(stripHtml(opts.html.slice(0, PREVIEW_SOURCE_CHARS)));
  if (opts.markdown) return truncatePreview(stripMarkdown(opts.markdown.slice(0, PREVIEW_SOURCE_CHARS)));
  return '';
}

/** Hard-bound a preview string, cutting on a word edge when one is close. */
export function truncatePreview(text: string, max = LETTER_PREVIEW_MAX_CHARS): string {
  const clean = collapse(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max - 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
