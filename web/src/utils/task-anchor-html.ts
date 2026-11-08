import { NO_LINK_ELEMENTS, splitHtml, TAG_NAME_RE } from './bare-task-ids';

type RenderRef = (id: string, label?: string) => string;
const ATTR_RE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const ANCHOR_RE = /^<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>$/i;

function decode(text: string): string {
  return text.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const name = entity.slice(1, -1).toLowerCase();
    const named: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
    if (named[name] !== undefined) return named[name];
    const n = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}

function attrs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of text.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(result, name)) result[name] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return result;
}

function anchorRef(source: string, render: RenderRef): string | undefined {
  const match = ANCHOR_RE.exec(source);
  if (!match) return undefined;
  const a = attrs(match[1]!);
  const marker = a['data-task-id'] || a.class?.split(/\s+/).includes('task-link');
  const destination = /^\/tasks\/([a-z0-9-]+)\/?$/i.exec(a.href ?? '')?.[1];
  if (!marker && !destination) return undefined;
  const label = decode(match[2]!.replace(/<[^>]*>/g, ''));
  if (!destination || (a['data-task-id'] && a['data-task-id'] !== destination)) {
    return render('', label);
  }
  return render(destination, label);
}

function literalRef(source: string, render: RenderRef): string | undefined {
  const once = decode(source).trim();
  const decoded = /^&lt;(?:a\b|task-ref\b)/i.test(once) ? decode(once) : once;
  const anchor = anchorRef(decoded, render);
  if (anchor !== undefined) return anchor;
  const ref = /^<task-ref\s+((?:[^>"']|"[^"]*"|'[^']*')*)\s*\/?>$/i.exec(decoded);
  if (!ref) return undefined;
  const a = attrs(ref[1]!);
  return render(a.id ?? '', a.label);
}

function escapedAnchors(text: string, render: RenderRef): string {
  const lower = text.toLowerCase();
  const out: string[] = [];
  let at = 0;
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf('&lt;a', cursor);
    if (start === -1) break;
    const window = lower.slice(start, start + 4000);
    const open = window.indexOf('&gt;', 5);
    if (open === -1) { cursor = start + 5; continue; }
    const openEnd = start + open;
    const nextAt = window.indexOf('&lt;a', 5);
    const next = nextAt === -1 ? -1 : start + nextAt;
    if (next !== -1 && next < openEnd) { cursor = next; continue; }
    const closeAt = window.indexOf('&lt;/a&gt;', open + 4);
    if (closeAt === -1) { cursor = openEnd + 4; continue; }
    const close = start + closeAt;
    if (next !== -1 && next < close) { cursor = next; continue; }
    const end = close + 10;
    const replacement = literalRef(text.slice(start, end), render);
    if (replacement !== undefined) { out.push(text.slice(at, start), replacement); at = end; }
    cursor = end;
  }
  return out.length ? out.join('') + text.slice(at) : text;
}

export function normalizeTaskAnchorHtml(html: string, render: RenderRef): string {
  if (!/task-ref|task-link|\/tasks\//i.test(html)) return html;
  const parts = splitHtml(html);
  const out: string[] = [];
  const nextClose: number[] = [];
  let closingAnchor = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^<\/a>$/i.test(parts[i]!.s)) closingAnchor = i;
    nextClose[i] = closingAnchor;
  }
  let pre = 0;
  let code = 0;
  let blocked = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.tag) {
      out.push(pre || code || blocked ? part.s : escapedAnchors(part.s, render));
      continue;
    }
    const name = TAG_NAME_RE.exec(part.s)?.[1]?.toLowerCase();
    const closing = /^<\//.test(part.s);
    const selfClosing = /\/>$/.test(part.s);
    if (!pre && !code && !blocked && !closing && name === 'code') {
      const body = parts[i + 1];
      const close = parts[i + 2];
      if (body && !body.tag && close?.tag && /^<\/code>$/i.test(close.s)) {
        const replacement = literalRef(body.s, render);
        if (replacement !== undefined) { out.push(replacement); i += 2; continue; }
      }
    }
    if (!pre && !code && !blocked && !closing && name === 'a') {
      const end = nextClose[i]!;
      const a = attrs(part.s);
      const task = a['data-task-id'] || a.class?.split(/\s+/).includes('task-link') || /^\/tasks\//.test(a.href ?? '');
      if (end !== -1 && parts[end]!.at - part.at < 4000) {
        const source = parts.slice(i, end + 1).map((p) => p.s).join('');
        const inner = source.slice(part.s.length, source.length - parts[end]!.s.length);
        if (!task || (!/<a(?:\s|>)/i.test(inner) && !/\n[ \t]*\n/.test(inner))) {
          out.push(anchorRef(source, render) ?? source);
          i = end;
          continue;
        }
      }
      if (task) continue;
    }
    if (name === 'pre') pre = Math.max(0, pre + (closing ? -1 : selfClosing ? 0 : 1));
    if (name === 'code') code = Math.max(0, code + (closing ? -1 : selfClosing ? 0 : 1));
    if (name && NO_LINK_ELEMENTS.has(name)) blocked = Math.max(0, blocked + (closing ? -1 : selfClosing ? 0 : 1));
    out.push(part.s);
  }
  return out.join('');
}
