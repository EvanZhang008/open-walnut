/**
 * UI text is English (standard.md, "Words", rule 7; the user's rule: never write Chinese into code
 * or UI). 2026-11-27, the UI audit saw the Time page's Timeline switch read "胶带 Tape" etc.: the
 * plugin's view names and 16 more lines of its Timeline, Lanes and Chapters were Chinese.
 *
 * This finds CJK characters written as is in a string, a template or JSX text in web/src and every
 * plugin's code (examples/plugins and plugin-store) (comments and `\u` escapes do not count). Code that must hold CJK characters to
 * work on them (a tokenizer, a highlighter) is named in ALLOWED with why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
// CJK punctuation, kana, ideographs and Hangul; a full-width symbol (the U+FF0B plus) is not words.
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** Files whose CJK text is data the code works on, not words on screen (none today). */
const ALLOWED: Record<string, string> = {};

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

export function cjkTexts(file: string, src: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string }> = [];
  const check = (n: ts.Node, raw: string) => {
    if (CJK.test(raw)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: raw.trim().slice(0, 80) });
  };
  const visit = (n: ts.Node) => {
    // getText() is the source as written, so a `\u` escape is not a CJK character here.
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) check(n, n.getText());
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) check(n, n.getText());
    else if (ts.isJsxText(n)) check(n, n.getText());
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('UI text is English', () => {
  const pluginSrc = (base: string) => fs.existsSync(path.join(ROOT, base))
    ? fs.readdirSync(path.join(ROOT, base)).map((p) => path.join(ROOT, base, p, 'src')) : [];
  const roots = [path.join(ROOT, 'web/src'), ...pluginSrc('examples/plugins'), ...pluginSrc('plugin-store')];
  const hits: Record<string, Array<{ line: number; text: string }>> = {};
  for (const f of roots.flatMap(files)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOWED[rel]) continue;
    const h = cjkTexts(rel, fs.readFileSync(f, 'utf8'));
    if (h.length) hits[rel] = h;
  }

  it('no CJK words in a string or JSX text outside ALLOWED', () => {
    const list = Object.entries(hits).map(([f, h]) => `${f}\n${h.map((x) => `    :${x.line}  ${x.text}`).join('\n')}`);
    expect(list, `Write UI text in English:\n${list.join('\n')}`).toEqual([]);
  });

  it('finds CJK as written and skips escapes and comments', () => {
    expect(cjkTexts('x.tsx', "const a = '胶带 Tape'").length).toBe(1);
    expect(cjkTexts('x.tsx', "const a = <b>空闲</b>").length).toBe(1);
    expect(cjkTexts('x.ts', "const a = '\\u80f6'").length).toBe(0);
    expect(cjkTexts('x.ts', '// 胶带\nconst a = 1').length).toBe(0);
  });
});
