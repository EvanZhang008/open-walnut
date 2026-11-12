/**
 * Finds every element in web/src whose native `title` only repeats its own text: the one
 * job such a title had was to show a cut-off row in full, and the in-place peek
 * (web/src/utils/truncation-peek.ts) does that now, so the dark tooltip would only open on
 * top of the pill's text or repeat text already in full view. Shared by the guard test and
 * by the codemod that took them out.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface RepeatedTitle { file: string; line: number; tag: string; title: string; start: number; end: number }

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx') && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

function attr(el: ts.JsxOpeningElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
}

/** The element's text as written: one `{expr}` or one run of plain text, ignoring layout whitespace. */
function soleText(node: ts.JsxElement): { expr?: string; text?: string } | null {
  const kids = node.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim()));
  if (kids.length !== 1) return null;
  const k = kids[0];
  if (ts.isJsxExpression(k) && k.expression) return { expr: k.expression.getText() };
  if (ts.isJsxText(k)) return { text: k.text.trim().replace(/\s+/g, ' ') };
  return null;
}

export function findRepeatedTitles(webSrc: string): RepeatedTitle[] {
  const out: RepeatedTitle[] = [];
  for (const file of walk(webSrc, [])) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('title=')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const open = node.openingElement;
        const title = attr(open, 'title');
        const peek = attr(open, 'data-peek');
        const optedOut = peek?.initializer && ts.isStringLiteral(peek.initializer) && peek.initializer.text === 'off';
        const own = title?.initializer && !optedOut ? soleText(node) : null;
        if (title && own) {
          const init = title.initializer!;
          const same = ts.isJsxExpression(init)
            ? !!init.expression && own.expr !== undefined && init.expression.getText() === own.expr
            : ts.isStringLiteral(init) && own.text !== undefined && init.text.trim() === own.text;
          if (same) {
            out.push({
              file: path.relative(webSrc, file),
              line: sf.getLineAndCharacterOfPosition(title.getStart()).line + 1,
              tag: open.tagName.getText(),
              title: init.getText(),
              start: title.getFullStart(),
              end: title.getEnd(),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
