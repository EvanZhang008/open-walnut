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

/** CSS classes whose rule cuts text off (an ellipsis or a line clamp), read from web/src's stylesheets. */
export function truncatingClasses(webSrc: string): Set<string> {
  const out = new Set<string>();
  const walkCss = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkCss(p);
      else if (e.name.endsWith('.css')) {
        const css = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (!/text-overflow\s*:\s*ellipsis|line-clamp\s*:\s*\d/.test(m[2])) continue;
          // Only the subject of the selector (its last compound) is the element that cuts.
          for (const sel of m[1].split(',')) {
            const last = sel.trim().split(/[\s>+~]+/).pop() ?? '';
            for (const c of last.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(c[1]);
          }
        }
      }
    }
  };
  walkCss(webSrc);
  return out;
}

/** A task's title as the rows write it. */
const TASK_TITLE = /\borgDisplayTitle\(|\bdisplayTitle\(|\b(task|t|sub|subtask|worker|dep|it|vm|row|n)\.title\b/;

export interface TaskTitleSite { file: string; line: number; classes: string[]; inRow: boolean }

function attrNames(el: ts.JsxOpeningLikeElement): string[] {
  return el.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText());
}

/**
 * Every element in web/src that cuts off a task's title (a truncating class on an element whose
 * child is the title, directly or through a const holding it), and whether it sits in a row the
 * peek expands as a whole (`inMarkedRow`).
 */
export function findTaskTitleSites(webSrc: string): TaskTitleSite[] {
  const cut = truncatingClasses(webSrc);
  const out: TaskTitleSite[] = [];
  for (const file of walk(webSrc, [])) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/title/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const isTitleExpr = (expr: ts.Expression, from: ts.Node): boolean => {
      const t = expr.getText();
      if (TASK_TITLE.test(t)) return true;
      if (!ts.isIdentifier(expr)) return false;
      // A const of the enclosing functions that holds the title.
      for (let p: ts.Node | undefined = from.parent; p; p = p.parent) {
        if (!(ts.isFunctionLike(p) || ts.isSourceFile(p))) continue;
        let found = false;
        const look = (n: ts.Node) => {
          if (found) return;
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === t && n.initializer && TASK_TITLE.test(n.initializer.getText())) found = true;
          else ts.forEachChild(n, look);
        };
        look(p);
        if (found) return true;
      }
      return false;
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const open = node.openingElement;
        const cnAttr = open.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'className');
        const classes = [...(cnAttr?.getText() ?? '').matchAll(/[A-Za-z0-9_-]+/g)].map((x) => x[0]).filter((c) => cut.has(c));
        const titled = node.children.some((c) => ts.isJsxExpression(c) && c.expression && isTitleExpr(c.expression, c));
        if (classes.length && titled && !attrNames(open).includes('data-peek')) {
          out.push({ file: path.relative(webSrc, file), line: sf.getLineAndCharacterOfPosition(open.getStart()).line + 1, classes, inRow: inMarkedRow(node) });
          ts.forEachChild(node, visit);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

const isMarked = (n: ts.Node): boolean => (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && attrNames(ts.isJsxElement(n) ? n.openingElement : n).includes('data-peek-row');

/**
 * In a marked row: an element ancestor carries `data-peek-row`, or the element is held in a
 * const (built apart, as StatusSections builds its title) that a marked element of the same
 * function renders as `{name}`, there or in a const it renders in turn.
 */
function inMarkedRow(node: ts.Node, depth = 0): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if (isMarked(p)) return true;
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) continue;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      if (depth > 3) return false;
      const name = p.name.text;
      let fn: ts.Node | undefined = p.parent;
      while (fn && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
      let found = false;
      const look = (n: ts.Node) => {
        if (found) return;
        if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression) && n.expression.text === name && inMarkedRow(n, depth + 1)) found = true;
        else ts.forEachChild(n, look);
      };
      if (fn) look(fn);
      return found;
    }
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}
