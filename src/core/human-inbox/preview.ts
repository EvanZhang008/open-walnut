/**
 * Plain-text preview derivation for letter envelopes and phone pushes.
 *
 * The agent SHOULD pass `text`, but most won't, so a letter's envelope line has
 * to be derived from its body. Bodies can be 200KB, and this runs on the web
 * server's single event loop, so every regex below only ever sees the first
 * PREVIEW_SOURCE_CHARS characters — bounded work regardless of body size.
 */

import { LETTER_PREVIEW_MAX_CHARS } from './types.js';
import { findAgentTextRefs } from '../../lib/agent-text-refs.js';

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

/** Clean old router envelopes at read time without reading or rewriting their bodies. */
export function cleanLegacyPreview(text: string): string {
  const clean = collapse(text.slice(0, PREVIEW_SOURCE_CHARS));
  const reason = /^From: .*? Subject: .*? Why it is yours:\s*(.+)$/i.exec(clean);
  return truncatePreview(reason?.[1] ?? clean.replace(/^From: .*? Subject:\s*/i, ''));
}

function markdownSummary(markdown: string): string {
  const source = markdown.slice(0, PREVIEW_SOURCE_CHARS);
  const reason = /^\*\*Why it is yours:\*\*\s*(.+)$/im.exec(source);
  if (reason) return stripMarkdown(reason[1]!);
  const lines = source.split('\n');
  let fence = '';
  const prose: string[] = [];
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = '';
      continue;
    }
    if (fence) continue;
    if (!line.trim()) { if (prose.length) break; continue; }
    if (/^\s{0,3}(?:#{1,6}\s|(?:[-*_]\s*){3,}$)|^\s*\||^\s*\*\*(?:From|Subject):\*\*/i.test(line)) {
      if (prose.length) break;
      continue;
    }
    const clean = stripMarkdown(line);
    if (clean) prose.push(clean);
    if (/^\s{0,3}(?:[-*+]|\d+\.)\s/.test(line) && prose.length) break;
  }
  if (prose.length) return prose.join(' ');
  const heading = lines.find((line) => /^\s{0,3}#{1,6}\s/.test(line));
  return heading ? stripMarkdown(heading) : '';
}

/** Derive a short envelope summary from explicit text or the first prose block. */
export function derivePreview(
  opts: { text?: string; html?: string; markdown?: string },
): string {
  const explicit = opts.text ? collapse(opts.text) : '';
  if (explicit) return truncatePreview(explicit);
  if (opts.html) {
    const source = opts.html.slice(0, PREVIEW_SOURCE_CHARS).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const prose = source.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, '')
      .split(/<\/?(?:br|p|div|li|tr|td)\b[^>]*>/i).map(stripHtml).find(Boolean);
    return truncatePreview(prose || stripHtml(source));
  }
  if (opts.markdown) return truncatePreview(markdownSummary(opts.markdown));
  return '';
}

/** Hard-bound a preview string, cutting on a word edge when one is close. */
export function truncatePreview(text: string, max = LETTER_PREVIEW_MAX_CHARS): string {
  const clean = collapse(text);
  if (clean.length <= max) return clean;
  const crossing = findAgentTextRefs(clean.slice(0, PREVIEW_SOURCE_CHARS)).find((ref) => ref.start < max && ref.end > max);
  if (crossing) return clean.slice(0, crossing.start).replace(/[\s"'(\[]+$/, '').trimEnd();
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max - 40) return cut.slice(0, lastSpace).trimEnd();
  const tail = cut.slice(lastSpace + 1);
  if (/^["'(\[]*(?:~?\/|https?:\/\/)/.test(tail)) return cut.slice(0, lastSpace + 1).trimEnd();
  return cut.trimEnd();
}
