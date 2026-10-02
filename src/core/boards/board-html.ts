/**
 * Reading a board's html on the server: the Walnut elements it names. Pure, no
 * I/O. The frame renders the same elements in the browser; the server reads
 * them to resolve task chips, to name a thread in a delivery, to hash the points
 * the user ticks as read, and to check a chosen option against the page.
 *
 * The server is the ONLY place a point's hash is computed (the frame echoes the
 * hash it was given), so "read" means "read this exact version" and any edit of
 * a point's html brings it back unread with no work by the leader.
 */

import crypto from 'node:crypto';

/** Item ids (thread, mark, project, check, choice): attribute values the board's author picks. */
export const BOARD_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** An own property of a map keyed by author-picked ids (`constructor` is a legal id). */
export function own<T>(map: Record<string, T> | undefined, id: string): T | undefined {
  return map && Object.hasOwn(map, id) ? map[id] : undefined;
}

const START_ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

/** One start tag's attribute text per match; quoted values may contain `>`. */
function startTags(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?=[\\s/>])${START_ATTRS}>`, 'gi');
  const out: string[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1]);
  return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (whole, dec, hex, name) => {
    if (name) return NAMED[name];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * A start tag's attributes, tokenized left to right the way a browser reads
 * them: a quoted value is consumed whole, so `title="see id='x'"` never answers
 * for `id`, and `data-id` is its own name. The first of a duplicate wins.
 */
function parseAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(attrs); m; m = re.exec(attrs)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return out;
}

/** Task ids named by `<walnut-task id="…">`, in document order, each once. */
export function extractTaskRefs(html: string): string[] {
  const seen = new Set<string>();
  for (const attrs of startTags(html, 'walnut-task')) {
    const id = parseAttrs(attrs).get('id');
    if (id) seen.add(id);
  }
  return [...seen];
}

export interface BoardThreadMeta {
  title?: string;
  task?: string;
}

/** The `title` / `task` of the `<walnut-thread id="threadId">` tag, or null when the html has none. */
export function threadMeta(html: string, threadId: string): BoardThreadMeta | null {
  for (const attrs of startTags(html, 'walnut-thread')) {
    const parsed = parseAttrs(attrs);
    if (parsed.get('id') !== threadId) continue;
    const title = parsed.get('title');
    const task = parsed.get('task');
    return { ...(title ? { title } : {}), ...(task ? { task } : {}) };
  }
  return null;
}

// ── <walnut-check id>: a point the user ticks as read ──

/** The hash of one point's inner html: whitespace runs collapse to one space, then sha1, first 12 hex. */
export function checkContentHash(inner: string): string {
  const text = inner.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Every `<walnut-check id="X">INNER</walnut-check>` on the page → the hash of
 * INNER (raw html). Attribute order and quote style are free; the first
 * occurrence of an id wins; an id outside the item id rule is skipped (it could
 * never be ticked). One linear pass pairs open and close tags on a stack, the
 * way the browser nests them, so an unclosed tag cannot make it quadratic.
 */
export function checkHashes(html: string): Record<string, string> {
  const re = new RegExp(`<walnut-check(?=[\\s/>])${START_ATTRS}>|</walnut-check\\s*>`, 'gi');
  const open: Array<{ id: string | undefined; at: number; start: number }> = [];
  const found: Array<{ id: string; at: number; hash: string }> = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0][1] !== '/') {
      open.push({ id: parseAttrs(m[1]).get('id'), at: m.index, start: m.index + m[0].length });
      continue;
    }
    const top = open.pop();
    if (top?.id && BOARD_ITEM_ID_RE.test(top.id)) {
      found.push({ id: top.id, at: top.at, hash: checkContentHash(html.slice(top.start, m.index)) });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const out: Record<string, string> = {};
  for (const f of found) if (!Object.hasOwn(out, f.id)) out[f.id] = f.hash;
  return out;
}

// ── <walnut-choice id options recommended? title? task?>: a decision ──

export interface BoardChoiceOption {
  value: string;
  label: string;
}

export interface BoardChoiceSpec {
  options: BoardChoiceOption[];
  recommended?: string;
  title?: string;
  task?: string;
}

/**
 * `key:Label,key:Label` (the format of walnut-mark's `states`): the server twin
 * of the frame core's parsePairs. A part with no colon is its own label; empty
 * keys are dropped; duplicates are kept, so the numbering matches the frame's.
 */
export function parsePairs(attr: string | undefined): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const part of String(attr ?? '').split(',')) {
    const i = part.indexOf(':');
    const key = (i < 0 ? part : part.slice(0, i)).trim();
    const label = (i < 0 ? part : part.slice(i + 1)).trim();
    if (key) out.push({ key, label: label || key });
  }
  return out;
}

/** Every `<walnut-choice>` on the page by id (first occurrence wins); `recommended` only when it names an option. */
export function choiceSpecs(html: string): Record<string, BoardChoiceSpec> {
  const out: Record<string, BoardChoiceSpec> = {};
  for (const attrs of startTags(html, 'walnut-choice')) {
    const parsed = parseAttrs(attrs);
    const id = parsed.get('id');
    if (!id || !BOARD_ITEM_ID_RE.test(id) || Object.hasOwn(out, id)) continue;
    const options = parsePairs(parsed.get('options')).map((p) => ({ value: p.key, label: p.label }));
    const recommended = parsed.get('recommended');
    const title = parsed.get('title');
    const task = parsed.get('task');
    out[id] = {
      options,
      ...(recommended && options.some((o) => o.value === recommended) ? { recommended } : {}),
      ...(title ? { title } : {}),
      ...(task ? { task } : {}),
    };
  }
  return out;
}
