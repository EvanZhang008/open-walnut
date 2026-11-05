/**
 * The messages the HTML preview's page sends the console (src/web/preview-bridge-script.ts),
 * checked one by one. The page is untrusted (its own scripts can post anything the bridge
 * can), so a message is taken only when it is one of these types with every field of the
 * kind and size that type has; anything else is dropped (readFrameMsg returns null).
 */

export type PreviewRect = { left: number; top: number; width: number; height: number };
/** A mark's rects in the frame's viewport: its client rects, and for a line under it its
 *  text fragments and the box its overflow clips it to ([left, top, right, bottom]). */
export interface FrameMarkRects { group: string; id: string; r: DOMRect[]; t?: DOMRect[]; c?: [number, number, number, number] | null }
export type FrameHit = { group: string; id: string };

export type FrameMsg =
  | { type: 'ready'; href: string; top: number }
  | { type: 'scroll'; top: number; rect: PreviewRect | null }
  | { type: 'selection'; text: string; rect: PreviewRect | null; x: number; y: number; v?: number; start?: number; end?: number }
  | { type: 'text'; v: number; text: string; over: boolean }
  | { type: 'probe'; href: string }
  /** The reader pressed on a link (pointerdown); the console checks the activation it brings. */
  | { type: 'press'; href: string }
  | { type: 'link'; href: string; handled?: boolean }
  | { type: 'external'; href: string }
  | { type: 'link-menu'; href: string; x: number; y: number }
  | { type: 'rects'; marks: FrameMarkRects[] }
  | { type: 'click'; hits: FrameHit[] }
  | { type: 'hover'; hits: FrameHit[] }
  | { type: 'find-result'; count: number; index: number }
  | { type: 'find-key' }
  | { type: 'escape' }
  /** The reader scrolled, pressed or typed in the page: a restore in progress stops. */
  | { type: 'user' };

const MAX_HREF = 8192;
const MAX_TEXT = 4_000_000;
const MAX_SEL = 20_000;
const MAX_ID = 64;
const MAX_MARKS = 200;
const MAX_RECTS = 400;

type Obj = Record<string, unknown>;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const int = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const name = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x);

function rect(x: unknown): PreviewRect | null | undefined {
  if (x === null) return null;
  const r = x as Obj;
  if (!r || typeof r !== 'object' || !num(r.left) || !num(r.top) || !num(r.width) || !num(r.height)) return undefined;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function rectList(x: unknown): DOMRect[] | null {
  if (!Array.isArray(x) || x.length > MAX_RECTS) return null;
  const out: DOMRect[] = [];
  for (const r of x) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(num)) return null;
    out.push(new DOMRect(r[0], r[1], r[2], r[3]));
  }
  return out;
}

function hitList(x: unknown): FrameHit[] | null {
  if (!Array.isArray(x) || x.length > 8) return null;
  const out: FrameHit[] = [];
  for (const h of x as Obj[]) {
    if (!h || typeof h !== 'object' || !name(h.group) || !str(h.id, MAX_ID)) return null;
    out.push({ group: h.group, id: h.id });
  }
  return out;
}

function markRects(x: unknown): FrameMarkRects[] | null {
  if (!Array.isArray(x) || x.length > MAX_MARKS) return null;
  const out: FrameMarkRects[] = [];
  for (const m of x as Obj[]) {
    if (!m || typeof m !== 'object' || !name(m.group) || !str(m.id, MAX_ID)) return null;
    const r = rectList(m.r);
    if (!r) return null;
    const e: FrameMarkRects = { group: m.group, id: m.id, r };
    if (m.t !== undefined) {
      const t = rectList(m.t);
      if (!t) return null;
      e.t = t;
    }
    if (m.c !== undefined && m.c !== null) {
      if (!Array.isArray(m.c) || m.c.length !== 4 || !m.c.every(num)) return null;
      e.c = m.c as [number, number, number, number];
    } else if (m.c === null) e.c = null;
    out.push(e);
  }
  return out;
}

/** The message, if it is one the bridge sends with the right shape; else null. */
export function readFrameMsg(data: unknown): FrameMsg | null {
  const d = data as Obj;
  if (!d || typeof d !== 'object' || d.walnutPreview !== 1 || typeof d.type !== 'string') return null;
  switch (d.type) {
    case 'ready':
      return str(d.href, MAX_HREF) && num(d.top) ? { type: 'ready', href: d.href, top: d.top } : null;
    case 'scroll': {
      const r = rect(d.rect);
      return num(d.top) && r !== undefined ? { type: 'scroll', top: d.top, rect: r } : null;
    }
    case 'selection': {
      const r = rect(d.rect);
      if (!str(d.text, MAX_SEL) || r === undefined || !num(d.x) || !num(d.y)) return null;
      const m: FrameMsg = { type: 'selection', text: d.text, rect: r, x: d.x, y: d.y };
      if (int(d.v) && int(d.start) && int(d.end)) { m.v = d.v; m.start = d.start; m.end = d.end; }
      return m;
    }
    case 'text':
      return int(d.v) && str(d.text, MAX_TEXT) && typeof d.over === 'boolean' ? { type: 'text', v: d.v, text: d.text, over: d.over } : null;
    case 'probe':
    case 'press':
    case 'external':
      return str(d.href, MAX_HREF) ? { type: d.type, href: d.href } : null;
    case 'link':
      if (!str(d.href, MAX_HREF) || (d.handled !== undefined && typeof d.handled !== 'boolean')) return null;
      return { type: 'link', href: d.href, ...(d.handled ? { handled: true } : {}) };
    case 'link-menu':
      return str(d.href, MAX_HREF) && num(d.x) && num(d.y) ? { type: 'link-menu', href: d.href, x: d.x, y: d.y } : null;
    case 'rects': {
      const marks = markRects(d.marks);
      return marks ? { type: 'rects', marks } : null;
    }
    case 'click':
    case 'hover': {
      const hits = hitList(d.hits);
      return hits ? { type: d.type, hits } : null;
    }
    case 'find-result':
      return int(d.count) && int(d.index) ? { type: 'find-result', count: d.count, index: d.index } : null;
    case 'find-key':
    case 'escape':
    case 'user':
      return { type: d.type };
    default:
      return null;
  }
}
