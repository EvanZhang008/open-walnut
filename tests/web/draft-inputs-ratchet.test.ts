/**
 * Every box a person can type into keeps its unsent words, or says why not.
 *
 * 2026-10-27, the user: "all the input boxes must save permanently". A reply
 * typed into the Ask here card was gone after they went to chat elsewhere and
 * came back: that box held its words in React state only.
 *
 * The rule, read off the source: each `<textarea>`, text `<input>` and
 * `contentEditable` element in web/src carries, in its own opening tag,
 *   - `data-draft-key={…}`: its words live in the draft store (hooks/useDraft.ts,
 *     utils/drafts.ts) under that key, or
 *   - `data-no-draft="<reason>"`: it holds no unsent words worth keeping. The
 *     reasons are a closed list (NO_DRAFT_REASONS), so "I did not bother" is not one.
 * Each `<ChatInput>` passes a `draftKey`. A new box that does neither fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');

/**
 * Why a box may keep nothing:
 *  - search: a search, filter or find box; its query is not a message.
 *  - picker: a combobox or palette query that picks an item and is gone.
 *  - number: a number, size or count spinner that applies as it changes.
 *  - autosave: it edits a stored value and saves it as it changes or on blur,
 *    so the value itself is the draft.
 *  - secret: a password, token or key: never written to storage in clear.
 *  - rename: an inline rename that commits on Enter or blur (Esc cancels).
 *  - document: a document editor with its own save (files, notes).
 *  - mirror: a read-only or hidden mirror of text kept elsewhere (copy buffer,
 *    measuring box, a box driven by a parent that keeps the draft).
 */
export const NO_DRAFT_REASONS = ['search', 'picker', 'number', 'autosave', 'secret', 'rename', 'document', 'mirror'] as const;

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'submit', 'button', 'reset', 'image',
  'date', 'datetime-local', 'time', 'month', 'week',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** The opening tag starting at `start` (`<name …>`), braces and strings respected. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (depth > 0 && (c === '"' || c === "'" || c === '`')) { quote = c; continue; }
    if (depth === 0 && (c === '"' || c === "'")) { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

export interface BoxSite { file: string; line: number; tag: string; kind: 'textarea' | 'input' | 'editable' | 'ChatInput' }

export function boxSites(): BoxSite[] {
  const sites: BoxSite[] = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.resolve(ROOT, '../..'), file);
    const lineOf = (i: number) => src.slice(0, i).split('\n').length;
    // A tag named in a comment (`// the <textarea>`, ` * an <input>`) is prose, not a box.
    const inComment = (i: number) => {
      const head = src.slice(src.lastIndexOf('\n', i - 1) + 1, i);
      return /^\s*(\*|\/\/|\/\*)/.test(head) || /(^|\s)\/\/\s/.test(head);
    };
    for (const m of src.matchAll(/<(textarea|input|ChatInput)\b/g)) {
      if (inComment(m.index!)) continue;
      const tag = openingTag(src, m.index!);
      const kind = m[1] as BoxSite['kind'];
      if (kind === 'input') {
        const t = /\btype=["']([\w-]+)["']/.exec(tag)?.[1];
        if (t && NON_TEXT_INPUT_TYPES.has(t)) continue;
      }
      sites.push({ file: rel, line: lineOf(m.index!), tag, kind });
    }
    // contentEditable on any other element.
    for (const m of src.matchAll(/<([A-Za-z][\w.]*)\b[^<>]*?\bcontentEditable\b/g)) {
      if (m[1] === 'textarea' || m[1] === 'input' || inComment(m.index!)) continue;
      const tag = openingTag(src, m.index!);
      if (/contentEditable=\{false\}/.test(tag)) continue;
      sites.push({ file: rel, line: lineOf(m.index!), tag, kind: 'editable' });
    }
  }
  return sites;
}

function verdict(site: BoxSite): string | null {
  if (site.kind === 'ChatInput') return /\bdraftKey=/.test(site.tag) ? null : 'a <ChatInput> without draftKey';
  if (/\bdata-draft-key=/.test(site.tag)) return null;
  const reason = /\bdata-no-draft=["']([\w-]+)["']/.exec(site.tag)?.[1];
  if (reason) return (NO_DRAFT_REASONS as readonly string[]).includes(reason) ? null : `unknown data-no-draft reason "${reason}"`;
  return 'neither data-draft-key nor data-no-draft';
}

describe('every input box keeps its unsent draft', () => {
  const sites = boxSites();

  it('finds the boxes (the scanner still works)', () => {
    expect(sites.length).toBeGreaterThan(50);
    expect(sites.some((s) => s.file.endsWith('ThreadCommentCard.tsx') && s.kind === 'textarea')).toBe(true);
  });

  it('each box keeps its words (data-draft-key / draftKey) or names why not (data-no-draft)', () => {
    const bad = sites.map((s) => ({ s, why: verdict(s) })).filter((x) => x.why)
      .map(({ s, why }) => `${s.file}:${s.line} <${s.kind}>: ${why}`);
    expect(bad, `Wire these through useDraft (or ChatInput draftKey), or mark data-no-draft="<${NO_DRAFT_REASONS.join('|')}>":\n${bad.join('\n')}`).toEqual([]);
  });

  it('the Ask here card keeps its reply under the question\'s key', () => {
    const card = sites.find((s) => s.file.endsWith('ThreadCommentCard.tsx') && s.kind === 'textarea');
    expect(card?.tag).toMatch(/data-draft-key=\{draft\.key/);
  });
});
