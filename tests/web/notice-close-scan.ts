/**
 * Finds every card and notice in the web UI's source and whether it has its close (the scan behind
 * tests/web/notice-close-guard.test.ts).
 *
 * A member is:
 *  - an element of a notice part: <NoticeCard>, <PanelNotice>, <AskCardFrame> (every notice, banner
 *    and ask card is drawn as one of them);
 *  - an element of its own markup with role="alert", "status" or "note";
 *  - an element of its own markup whose root class names a notice: its first class ends in -banner,
 *    -notice, -toast, -alert, -callout or -receipt (or is that word alone).
 * Its close is NoticeClose (the one ×), a part's `onClose`, or a button inside it whose label says
 * it closes (Dismiss, Close, Hide).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(__dirname, '../..');

export interface Member {
  file: string;
  line: number;
  /** The part (NoticeCard) or the root class (session-error-banner). */
  name: string;
  closes: boolean;
  text: string;
}

const PARTS = ['NoticeCard', 'PanelNotice', 'AskCardFrame'];
const ROOT_CLASS = /^(?:[a-z0-9]+-)*(?:banner|notice|toast|alert|callout|receipt)$/;
/** A close inside the element: the one ×, a part's onClose, or a key that says it closes. */
const CLOSES = /<NoticeClose\b|\bonClose(?:=(?!\{\s*undefined\s*\})|:(?!\s*undefined\b)|,\s)/;

export function sources(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ':(glob)web/src/**/*.tsx', ':(glob)plugin-store/**/*.tsx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !/\.test\.tsx$/.test(f)).filter((f) => fs.existsSync(path.join(ROOT, f)));
}

/** Code without comments, the same length (offsets and line numbers still match the file). */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

/** Where the element that opens at `at` ends: its matching close tag, or its own `/>`. */
function elementEnd(src: string, at: number, tag: string): number {
  // The opening tag's own end: the first `>` outside braces and quotes.
  let i = at + 1 + tag.length;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { if (depth === 0 || c === '`') quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  if (src[i - 1] === '/') return i + 1;
  // Count nested elements of the same tag to its matching close.
  const open = new RegExp(`<${tag}(?=[\\s>/])`, 'g');
  const close = new RegExp(`</${tag}\\s*>`, 'g');
  let level = 1;
  let pos = i + 1;
  while (level > 0) {
    open.lastIndex = pos;
    close.lastIndex = pos;
    const o = open.exec(src);
    const c = close.exec(src);
    if (!c) return src.length;
    if (o && o.index < c.index) {
      const selfEnd = src.indexOf('>', o.index);
      if (src[selfEnd - 1] !== '/') level++;
      pos = selfEnd + 1;
    } else {
      level--;
      pos = c.index + c[0].length;
    }
  }
  return pos;
}

const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length;

export function membersOf(file: string, raw: string): Member[] {
  const src = blankComments(raw);
  const out: Member[] = [];
  for (const part of PARTS) {
    const re = new RegExp(`<${part}(?=[\\s>/])`, 'g');
    for (const m of src.matchAll(re)) {
      const end = elementEnd(src, m.index!, part);
      const text = src.slice(m.index!, end);
      out.push({ file, line: lineOf(src, m.index!), name: part, closes: CLOSES.test(text), text });
    }
  }
  // A live region or a note of its own markup: role="alert", "status" or "note" says it is a notice
  // to the reader (2026-11-27: the Org page's reorg reminder, a role="note" with a word key Close).
  const live = /<([a-z][a-z0-9]*)\b(?:[^<>]|=>)*?\brole=["'](alert|status|note)["']/g;
  for (const m of src.matchAll(live)) {
    const end = elementEnd(src, m.index!, m[1]!);
    const text = src.slice(m.index!, end);
    const cls = /className=\{?\s*["'`]([^"'`$\s]*)/.exec(src.slice(m.index!, src.indexOf('>', m.index!)))?.[1];
    if (cls && ROOT_CLASS.test(cls)) continue; // counted below by its class
    out.push({ file, line: lineOf(src, m.index!), name: `role=${m[2]}${cls ? `.${cls}` : ''}`, closes: CLOSES.test(text), text });
  }
  // An element of its own markup: <tag className="root ..."> or className={`root ...`}.
  const own = /<([a-z][a-z0-9]*)\b(?:[^<>]|=>)*?\bclassName=\{?\s*["'`]([^"'`$]*)/g;
  for (const m of src.matchAll(own)) {
    const first = m[2]!.trim().split(/\s+/)[0] ?? '';
    if (!ROOT_CLASS.test(first)) continue;
    const end = elementEnd(src, m.index!, m[1]!);
    const text = src.slice(m.index!, end);
    out.push({ file, line: lineOf(src, m.index!), name: first, closes: CLOSES.test(text), text });
  }
  return out;
}

export function allMembers(): Member[] {
  return sources().flatMap((f) => membersOf(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
}
