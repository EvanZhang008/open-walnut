/**
 * The composer's inline references.
 *
 * An entity reference (`<task-ref id="…" label="…"/>` and its session/project
 * siblings) is markup the CLI reads, not something a human should have to look
 * at while typing. So the textarea shows every reference as a readable inline
 * token, `@[Fix the thing]`, sitting IN the sentence where the user put it (the
 * same place a file reference's `@path` sits), and the message that goes out
 * has each token swapped back for its tag.
 *
 * A token carries the label only; the tag it stands for lives in a side table
 * (`RefTable`, label → tag) that the composer keeps beside the text. The table is
 * rebuilt from the tags whenever text arrives from outside (a persisted draft, a
 * prefill, a paste, a restore after a failed send), so no path needs to know
 * about it. A token whose label the table does not know is just the user's own
 * text and is sent as typed.
 *
 *   inlineRefs(text, table)   → { body, table }   tags → tokens (text → box)
 *   composeRefs(body, table)  → string            tokens → tags (box → message)
 *
 * History: from 2026-09-10 to 2026-10-02 a reference was a chip in a strip ABOVE
 * the textarea and the message was composed "tags first, then prose". The user
 * asked for the reference to be in the box itself, with the words (2026-10-02).
 *
 * PURE MODULE: no React, no DOM. It has to load in a bare node test.
 */
import { extractEntityRefs } from '@/utils/entity-ref-tags';

/** label → tag, in insertion order. */
export type RefTable = ReadonlyMap<string, string>;

export interface InlineRefSplit {
  /** What the textarea shows: prose with `@[label]` tokens, no tags. */
  body: string;
  /** Every label the body may carry, with the tag it stands for. */
  table: RefTable;
}

/** Matches one `@[label]` token; the label never contains a bracket or a newline. */
const TOKEN_RE = /@\[([^\[\]\n\r]+)\]/g;

/** Dedupe key for a tag: kind+id, never the label (a task can be renamed). */
function refKey(tag: string): string | null {
  const m = extractEntityRefs(tag)[0];
  return m ? `${m.kind}:${m.id}` : null;
}

/** The text a token shows for a tag: its label (its id when unlabeled), with
 *  the characters the token syntax reserves replaced and whitespace collapsed. */
function tokenLabel(tag: string): string {
  const m = extractEntityRefs(tag)[0];
  const raw = (m?.label || m?.id || '').replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw || 'reference';
}

/** `@[label]` */
export function refToken(label: string): string {
  return `@[${label}]`;
}

/**
 * The label a tag gets in `table`: the one it already has when the same entity
 * is there; otherwise its own label, made unique against a different entity that
 * happens to carry the same words (two tasks titled alike) by appending the id's
 * tail.
 */
function labelFor(tag: string, table: ReadonlyMap<string, string>): string {
  const key = refKey(tag);
  for (const [label, known] of table) {
    if (key !== null && refKey(known) === key && tokenLabel(known) === tokenLabel(tag)) return label;
  }
  const base = tokenLabel(tag);
  const taken = (label: string) => table.has(label) && refKey(table.get(label)!) !== key;
  if (!taken(base)) return base;
  const m = extractEntityRefs(tag)[0];
  const tail = (m?.id ?? '').slice(-4) || '2';
  let candidate = `${base} · ${tail}`;
  for (let n = 2; taken(candidate); n++) candidate = `${base} · ${tail}${n}`;
  return candidate;
}

/**
 * Join what is left after cutting a span out of a line. A cut leaves the two
 * sides touching, so the doubled space a removed `"<tag> "` used to leave is
 * collapsed here, and two words that would otherwise be glued together keep one
 * space between them. Only spaces and tabs are collapsed: a newline is layout
 * the user typed on purpose.
 */
function joinAcrossCut(head: string, tail: string): { text: string; caret: number } {
  if (head === '' || /\s$/.test(head)) {
    return { text: head + tail.replace(/^[ \t]+/, ''), caret: head.length };
  }
  if (tail !== '' && !/^\s/.test(tail)) return { text: `${head} ${tail}`, caret: head.length + 1 };
  return { text: head + tail, caret: head.length };
}

/**
 * Remove `[start, end)` from `text`, collapsing the gap it leaves, and report
 * where the caret belongs afterwards.
 */
export function cutSpan(text: string, start: number, end: number): { text: string; caret: number } {
  return joinAcrossCut(text.slice(0, start), text.slice(end));
}

/**
 * Replace every reference tag in `text` with its inline token, in place, and
 * return the table that maps the tokens back. `existing` is the table the
 * composer already holds: its entries stay (a token already in the box must keep
 * resolving), and a tag for an entity it knows reuses that entity's label.
 */
export function inlineRefs(text: string, existing: RefTable = new Map()): InlineRefSplit {
  const found = extractEntityRefs(text);
  const table = new Map(existing);
  if (found.length === 0) return { body: text, table };
  let body = '';
  let last = 0;
  for (const m of found) {
    const tag = text.slice(m.start, m.end);
    const label = labelFor(tag, table);
    if (!table.has(label)) table.set(label, tag);
    body += text.slice(last, m.start) + refToken(label);
    last = m.end;
  }
  body += text.slice(last);
  return { body, table };
}

/**
 * The message (and the persisted draft): the prose with each known token swapped
 * back for its tag, trimmed. Tokens the table does not know are the user's text
 * and go out as typed.
 */
export function composeRefs(body: string, table: RefTable): string {
  const prose = body.trim();
  if (table.size === 0 || !prose.includes('@[')) return prose;
  return prose.replace(TOKEN_RE, (whole, label: string) => table.get(label) ?? whole);
}

/** Every known token in `body`, with its `[start, end)` span, in order. */
export function listInlineRefs(body: string, table: RefTable): Array<{ label: string; tag: string; start: number; end: number }> {
  const out: Array<{ label: string; tag: string; start: number; end: number }> = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const tag = table.get(m[1]);
    if (!tag) continue;
    out.push({ label: m[1], tag, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * The known token that ends exactly at `caret`, if any: Backspace right after a
 * reference removes the whole token, the way a chip's × did, instead of leaving
 * `@[Fix the thin` behind.
 */
export function tokenEndingAt(body: string, caret: number, table: RefTable): { start: number; end: number } | null {
  if (caret <= 0 || body[caret - 1] !== ']') return null;
  const open = body.lastIndexOf('@[', caret - 1);
  if (open === -1) return null;
  const label = body.slice(open + 2, caret - 1);
  if (!label || /[\[\]\n\r]/.test(label) || !table.has(label)) return null;
  return { start: open, end: caret };
}
