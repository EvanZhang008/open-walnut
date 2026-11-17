/**
 * A small CSS scanner for the stylesheet guards (no parser dependency): every
 * declaration of web/src's stylesheets with its enclosing style rule and at-rules.
 * Used by scrollbar-model-guard.test.ts and chat-palette-guard.test.ts.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function walk(dir: string, exts: string[], out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

export interface Decl {
  file: string;
  line: number;
  prop: string;
  value: string;
  /** Selector list of the innermost style rule holding the declaration. */
  selectors: string[];
  /** Preludes of every enclosing at-rule, outermost first, whitespace-normalised. */
  atRules: string[];
}

export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Split on top-level commas (not the ones inside `:is(a, b)`). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { out.push(norm(s.slice(from, i))); from = i + 1; }
  }
  out.push(norm(s.slice(from)));
  return out.filter(Boolean);
}

/**
 * A small CSS scanner, enough for these checks (no parser dependency): every
 * declaration with its enclosing style rule and at-rules. Comments are blanked
 * keeping their newlines; quotes and parentheses are respected, so a `;` inside
 * `url("data:...;...")` does not end a declaration.
 */
export function scanCss(file: string, raw: string): Decl[] {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const decls: Decl[] = [];
  const frames: string[] = [];
  let from = 0;
  let paren = 0;
  let quote = '';
  // Line starts, once: a lookup per declaration (slicing the text each time is quadratic).
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = (i: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const flush = (to: number) => {
    const chunk = text.slice(from, to);
    const colon = chunk.indexOf(':');
    const rule = [...frames].reverse().find((f) => !f.startsWith('@'));
    if (rule !== undefined && colon > 0 && chunk.trim()) {
      const lead = chunk.length - chunk.trimStart().length;
      decls.push({
        file,
        line: lineAt(from + lead),
        prop: chunk.slice(0, colon).trim().toLowerCase(),
        value: norm(chunk.slice(colon + 1)),
        selectors: splitTopLevel(rule),
        atRules: frames.filter((f) => f.startsWith('@')),
      });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { paren--; continue; }
    if (paren > 0) continue;
    if (c === '{') { frames.push(norm(text.slice(from, i))); from = i + 1; }
    else if (c === ';') { flush(i); from = i + 1; }
    else if (c === '}') { flush(i); frames.pop(); from = i + 1; }
  }
  return decls;
}
