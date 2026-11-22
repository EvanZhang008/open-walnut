/**
 * Every header row in the web app's source: an element whose class names a head or header
 * (`*-head`, `*-header`, `*-heading`, `*-bar`, `*-toolbar`, `<header>`) and that holds both a title (a heading, or a `*title*` /
 * `*name*` class) and a button. Used by header-fit-ratchet.test.ts.
 *
 * 2026-11-21: the Org list's "New router", "Org chart" and gear squeezed its title "Org" to one
 * clipped letter in a 220 px column. A header row on the shared rule (components/common/HeaderFit.tsx)
 * carries `data-fit-header`; one without it is counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './css-scan';

export const WEB_SRC = path.join(__dirname, '../../web/src');

export interface HeaderRow { file: string; line: number; className: string; onRule: boolean }

const HEAD_CLASS = /(?:^|[\s"'`{}])([A-Za-z][\w-]*-(?:head|header|heading|bar|toolbar|titlebar|topbar))(?=[\s"'`}$]|$)/;
const TITLE = /<h[1-6][\s>]|className=\{?\s*[`'"][^`'"]*\b[\w-]*(?:title|name)\b[^`'"]*[`'"]|data-fit-title/;
const BUTTON = /<button[\s>]|<FitButton[\s>]|<[A-Z]\w*(?:Button|Btn|Menu|Toggle)[\s>/]|className=\{?\s*[`'"][^`'"]*\bbtn\b/;

/** Where the opening tag that starts at `at` ends (its `>`), past any `=>` inside its braces. */
function openTagEnd(text: string, at: number): number {
  let depth = 0;
  let quote = '';
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

/** The text of the element that opens at `at` (its tag up to the matching close), or null. */
function elementAt(text: string, at: number): string | null {
  const tag = /^<([A-Za-z][\w.]*)/.exec(text.slice(at))?.[1];
  if (!tag) return null;
  const re = new RegExp(`<(/?)${tag.replace('.', '\\.')}(?=[\\s>/])`, 'g');
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m[1] === '/' ? text.indexOf('>', m.index) : openTagEnd(text, m.index);
    if (end < 0) return null;
    re.lastIndex = end + 1;
    if (m[1] === '/') depth--;
    else if (text[end - 1] !== '/') depth++;
    if (depth === 0) return text.slice(at, end + 1);
  }
  return null;
}

export function headerRowsIn(file: string, text: string): HeaderRow[] {
  const rows: HeaderRow[] = [];
  for (const m of text.matchAll(/<([a-z][\w]*)\b/g)) {
    const at = m.index!;
    const openEnd = openTagEnd(text, at);
    if (openEnd < 0) continue;
    const open = text.slice(at, openEnd + 1);
    const cls = /className=\{?\s*[`'"]([^`'"]*)[`'"]/.exec(open)?.[1] ?? '';
    const head = HEAD_CLASS.exec(` ${cls} `)?.[1] ?? (m[1] === 'header' ? 'header' : null);
    if (!head) continue;
    const el = elementAt(text, at);
    if (!el) continue;
    const inner = el.slice(open.length);
    if (!TITLE.test(inner) || !BUTTON.test(inner)) continue;
    rows.push({ file, line: text.slice(0, at).split('\n').length, className: head, onRule: /data-fit-header/.test(open) });
  }
  return rows;
}

export function allHeaderRows(): HeaderRow[] {
  const out: HeaderRow[] = [];
  for (const file of walk(WEB_SRC, ['.tsx']).sort()) {
    out.push(...headerRowsIn(path.relative(WEB_SRC, file), fs.readFileSync(file, 'utf8')));
  }
  return out;
}

/** A row's key in an exemption list: its file and the class the scan names it by. */
export const rowKey = (r: Pick<HeaderRow, 'file' | 'className'>): string => `${r.file} ${r.className}`;

/** Header rows not on the shared rule and not exempt (keys of `exempt`), per file. */
export function offRuleCounts(rows = allHeaderRows(), exempt: Record<string, string> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (!r.onRule && !(rowKey(r) in exempt)) out[r.file] = (out[r.file] ?? 0) + 1;
  return out;
}
