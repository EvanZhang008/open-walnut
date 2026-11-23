/**
 * The words the web UI shows, read from web/src, and what breaks the "Words" rules of the UI standard
 * (.claude/skills/walnut-ui-requirements/standard.md), counted per file. Used by
 * ui-words-ratchet.test.ts.
 *
 * 2026-11-21, the UI audit on the user's data: the composer showed "btw" with no word on what it
 * does, and the same drawer was "Side thread" in the + menu; Settings showed the tool name
 * "org_send". Each counter below is one way that happens:
 *   - rawId: a tool, field or model id in UI text (snake_case, `opus-5-5`, `__local__`).
 *   - iconOnly: a <button> with no words, no aria-label and no title.
 *   - secondName: a second name for a concept the word list names (side thread for side chat).
 * A UI string is JSX text, the literal text of a text prop (aria-label, title, placeholder, label,
 * help, ...) and the literal text of such a field in an object (`{ label: 'Recent' }`). Text inside
 * <code>, <kbd> or <pre> is a value to copy, not a label, and is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walk } from './css-scan';

export const WEB_SRC = path.join(__dirname, '../../web/src');

/** Props and object fields whose text a person reads. */
const TEXT_PROPS = new Set(['aria-label', 'title', 'placeholder', 'label', 'help', 'alt', 'hint', 'description', 'heading', 'caption', 'tooltip', 'subtitle', 'emptyText', 'line', 'message', 'text', 'notice']);
/** Elements whose text is a value to copy or type, not a label. */
const CODE_TAGS = new Set(['code', 'kbd', 'pre', 'CodeText']);
/** A child that draws an icon, not words. */
const ICONISH = /(?:Icon|ICON|Glyph|GLYPH|Svg|SVG|Spinner|Logo|Avatar|Dot|Arrow|ARROW|Chevron|CHEVRON|Caret|CARET)$|^(?:ICON|GLYPH|SVG)_/;
/** Constants of the file being read: name -> draws an icon (JSX) or words (a string). */
let fileConsts = new Map<string, 'icon' | 'words'>();

/** A tool, field or model id: what a person never needs to read. */
export const RAW_ID: RegExp[] = [
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/, // snake_case: org_send, task_create, output_mode
  /\b(?:claude|opus|sonnet|haiku|fable|gpt)-[0-9]/, // a model id: opus-5-5, claude-3
  /__[a-z]+__/, // __local__
];

/** A second name for a concept of the word list (standard.md, "Words"), and the one to use. */
export const SECOND_NAMES: Array<{ re: RegExp; use: string }> = [
  { re: /\bside threads?\b/i, use: 'side chat' },
  { re: /\bbuiltin\b/i, use: 'Built-in' },
  { re: /^\s*built in\s*$/i, use: 'Built-in' },
  { re: /\b(?:save|saved|saving) as (?:a )?todo\b/i, use: 'task' },
  { re: /\bneeds? action\b/i, use: 'Needs you' },
];

export function hasRawId(text: string): boolean {
  return RAW_ID.some((re) => re.test(text));
}
export function secondNameOf(text: string): string | null {
  return SECOND_NAMES.find((n) => n.re.test(text))?.use ?? null;
}

/** Literals already read as a label or a text prop, so the sentence pass does not count them again. */
let seen = new Set<ts.Node>();

/** The literal words of an expression: string literals and the fixed parts of templates. */
function literalTexts(e: ts.Expression | undefined, out: string[] = []): string[] {
  if (!e) return out;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) { seen.add(e); out.push(e.text); }
  else if (ts.isTemplateExpression(e)) {
    seen.add(e);
    out.push([e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' '));
  } else if (ts.isConditionalExpression(e)) { literalTexts(e.whenTrue, out); literalTexts(e.whenFalse, out); }
  else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
    literalTexts(e.right, out);
    if (e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) literalTexts(e.left, out);
  } else if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) literalTexts(e.expression, out);
  return out;
}

const tagName = (n: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText();
const attrsOf = (n: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes).properties;

function exprShowsWords(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return false;
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return showsWords(e);
  if (ts.isParenthesizedExpression(e)) return exprShowsWords(e.expression);
  if (ts.isIdentifier(e)) {
    const known = fileConsts.get(e.text);
    return known ? known === 'words' : !ICONISH.test(e.text);
  }
  if (ts.isCallExpression(e)) return !/icon|glyph/i.test(e.expression.getText());
  if (ts.isConditionalExpression(e)) return exprShowsWords(e.whenTrue) || exprShowsWords(e.whenFalse);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return exprShowsWords(e.right);
  return true;
}

/** Does this JSX child show words (or might it: data, a component of words)? */
function showsWords(child: ts.Node): boolean {
  if (ts.isJsxText(child)) return child.text.trim().length > 0;
  if (ts.isJsxExpression(child)) return exprShowsWords(child.expression);
  if (ts.isJsxFragment(child)) return child.children.some(showsWords);
  if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
    const tag = tagName(child);
    if (tag === 'svg' || tag === 'path') return false;
    if (tag === 'img') return attrsOf(child).some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'alt');
    if (/^[A-Z]/.test(tag)) return !ICONISH.test(tag.split('.').pop()!);
    // A span that is hidden from readers is decoration.
    if (attrsOf(child).some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'aria-hidden')) return false;
    return ts.isJsxElement(child) && child.children.some(showsWords);
  }
  return false;
}

/** A <button> a reader gets no words for: no text, no aria-label, no title. */
function isUnnamedIconButton(n: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (tagName(n) !== 'button') return false;
  for (const a of attrsOf(n)) {
    if (ts.isJsxSpreadAttribute(a)) return false; // its name may come with the spread
    const name = a.name.getText();
    if (name === 'aria-label' || name === 'aria-labelledby' || name === 'title') return false;
  }
  return !(ts.isJsxElement(n) && n.children.some(showsWords));
}

type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
const literalText = (n: Literal) => (ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join('') : n.text);

/** Words (two or more, with a space) that are not only for a log, a test id, a comparison or a class list. */
function isPhrase(n: Literal): boolean {
  const text = literalText(n);
  if (!/[A-Za-z] [A-Za-z]/.test(text)) return false;
  if (text.trim().split(/\s+/).every((w) => /^[a-z0-9_-]+$/.test(w) && /-/.test(w))) return false; // a class list
  for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText();
      if (/^(?:log|console|logger)\b|\.(?:debug|info|warn|error)$|^(?:fetch|apiFetch|apiGet|apiPost|querySelector|matchMedia)/.test(callee)) return false;
      if (/querySelector|locator|getBy|startsWith|includes|test|match|replace|split/.test(callee)) return false;
    }
    if (ts.isJsxAttribute(p) && /^(?:className|data-|style|key|id|href|src)/.test(p.name.getText())) return false;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) return false;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return false;
    if (ts.isPropertyAssignment(p) && /^(?:className|class|testId|id|key)$/.test(p.name.getText())) return false;
  }
  return true;
}

/** A phrase of three words or more: copy a person may read. */
const isProse = (n: Literal) => (literalText(n).match(/[A-Za-z]{2,}/g) ?? []).length >= 3;

export interface WordHit { kind: 'rawId' | 'iconOnly' | 'secondName' | 'longHelp'; line: number; text: string }

/** Every UI string of one file (with its line), and the unnamed icon buttons. */
export function scanFile(file: string, text: string): WordHit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: WordHit[] = [];
  fileConsts = new Map();
  seen = new Set();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
      if (ts.isJsxElement(init) || ts.isJsxSelfClosingElement(init) || ts.isJsxFragment(init)) fileConsts.set(n.name.text, showsWords(init) ? 'words' : 'icon');
      else if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)) fileConsts.set(n.name.text, 'words');
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const check = (s: string, at: ts.Node) => {
    if (!s.trim()) return;
    if (hasRawId(s)) hits.push({ kind: 'rawId', line: lineOf(at), text: s.trim() });
    if (secondNameOf(s)) hits.push({ kind: 'secondName', line: lineOf(at), text: s.trim() });
  };
  const helpLength = (texts: string[], at: ts.Node) => {
    for (const t of texts) if (t.trim().length > HELP_MAX) hits.push({ kind: 'longHelp', line: lineOf(at), text: t.trim() });
  };
  const visit = (n: ts.Node, inCode: boolean) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === 'help') {
      const init = n.initializer;
      helpLength(init && ts.isStringLiteral(init) ? [init.text] : init && ts.isJsxExpression(init) ? literalTexts(init.expression) : [], n);
    } else if (ts.isPropertyAssignment(n) && n.name.getText().replace(/['"]/g, '') === 'help') helpLength(literalTexts(n.initializer), n);
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (isUnnamedIconButton(n)) hits.push({ kind: 'iconOnly', line: lineOf(n), text: n.getText(sf).slice(0, 80) });
      if (CODE_TAGS.has(tagName(n))) inCode = true;
    }
    if (ts.isJsxText(n) && !inCode) check(n.text, n);
    else if (ts.isJsxAttribute(n) && TEXT_PROPS.has(n.name.getText())) {
      const init = n.initializer;
      if (init && ts.isStringLiteral(init)) check(init.text, n);
      else if (init && ts.isJsxExpression(init)) for (const s of literalTexts(init.expression)) check(s, n);
      if (init && ts.isStringLiteral(init)) return;
    } else if (ts.isJsxExpression(n) && !inCode && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      for (const s of literalTexts(n.expression)) check(s, n);
    } else if (ts.isPropertyAssignment(n) && TEXT_PROPS.has(n.name.getText().replace(/['"]/g, ''))) {
      for (const s of literalTexts(n.initializer)) check(s, n);
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !seen.has(n) && !inCode && isPhrase(n)) {
      // Any other words in the source may reach a person (a control's name, a list of what a
      // switch stops, an error line), unless they only go to a log: a second name of a concept
      // is a phrase ("Side thread"), a raw id is caught in a sentence of three words or more.
      const s = literalText(n);
      if (secondNameOf(s)) hits.push({ kind: 'secondName', line: lineOf(n), text: s.trim() });
      if (isProse(n) && hasRawId(s)) hits.push({ kind: 'rawId', line: lineOf(n), text: s.trim() });
      return;
    }
    ts.forEachChild(n, (c) => visit(c, inCode));
  };
  visit(sf, false);
  return hits;
}

/**
 * Files whose sentences are written for an agent, not shown to a person (a prompt a button sends,
 * a table of field names), and why. Tool names belong there.
 */
export const NOT_SHOWN: Record<string, string> = {
  'apps/mail/mail-ask.ts': 'the prompt the mail app sends to an agent',
  'components/apps-page/plugin-ask.ts': 'the prompt the Apps page sends to an agent',
  'components/board/useAskForBoard.ts': 'the prompt that asks a lead for a Board',
  'components/drawing/drawing-assistant-context.ts': 'the context a drawing hands its assistant',
  'components/org/main-quick-actions.ts': 'the prompts of Main\'s quick actions',
  'hooks/task-list-merge.ts': 'a table of task fields and how each reaches the UI, for a test',
};

/**
 * A setting's help line, at most this many characters: two short lines under its label. More is a
 * page of text, not a setting (2026-11-21, the user on the Org settings panel: "the setting is
 * shit", "no taste"); the rest goes on hover or in the docs.
 */
export const HELP_MAX = 120;

export type WordCounts = Record<WordHit['kind'], Record<string, number>>;

export function scanAll(): { counts: WordCounts; hits: Record<string, WordHit[]> } {
  const counts: WordCounts = { rawId: {}, iconOnly: {}, secondName: {}, longHelp: {} };
  const hits: Record<string, WordHit[]> = {};
  for (const file of walk(WEB_SRC, ['.tsx', '.ts']).sort()) {
    if (/\.(test|spec)\.|\.d\.ts$/.test(file)) continue;
    const rel = path.relative(WEB_SRC, file);
    if (NOT_SHOWN[rel]) continue;
    const found = scanFile(rel, fs.readFileSync(file, 'utf8'));
    if (!found.length) continue;
    hits[rel] = found;
    for (const h of found) counts[h.kind][rel] = (counts[h.kind][rel] ?? 0) + 1;
  }
  return { counts, hits };
}
