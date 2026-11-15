/**
 * Finds every place in web/src where a person types text, field by field, and says whether the
 * composer's mic writes into it (tests/web/compose-voice-guard.test.ts reads this).
 *
 * A field is a <textarea>, a text <input>, an element made editable (`contentEditable`), a rich
 * editor (TipTap's <EditorContent>, CodeMirror's `new EditorView`), a use of a component listed in
 * WRAPPED_BOXES (a box whose own <textarea> takes its caller's props), or a <MicInput>. A field
 * has the mic when, read from the source:
 *  - it is a <MicInput> (a one-line box with the mic inside), or sits inside a <MicField>, or
 *  - its `ref` is the `boxRef` of a <BoxMic>, <MicField> or <AnswerBox> in the same file, or the
 *    box a <MicButton> inserts into (`insertBox={() => X.current}`), or
 *  - it is an <EditorContent editor={X}> beside an <EditorMic editor={X}>.
 * The scan is per field, never per file: a second box beside one with a mic is its own entry.
 * The Board's sandboxed frames build their markup in strings, so they are read as text.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src');

/** Components that draw their own <textarea> or editable element from their caller's props. */
export const WRAPPED_BOXES = new Set(['GrowingTextarea', 'CollapsibleUrlEditor']);

/** `type` values of an <input> nobody types words into. */
const NOT_TYPED = new Set([
  'checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'date', 'time', 'datetime-local', 'month', 'week',
  'number', 'submit', 'button', 'reset', 'image',
]);

const MIC_HOSTS = new Set(['BoxMic', 'AnswerBox']);

export interface ComposeField {
  /** Path under web/src. */
  file: string;
  /** `file|signature`, unique in the file (a repeated signature gets `#2`, `#3`). */
  key: string;
  /** The tag and its most telling attribute, e.g. `textarea data-testid="org-node-instructions"`. */
  signature: string;
  line: number;
  /** The composer's mic writes into it. */
  mic: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attr(el: Opening, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** The attribute's value as written: `"x"` or the expression inside `{…}`. */
function attrText(a: ts.JsxAttribute | undefined): string | null {
  const init = a?.initializer;
  if (!init) return a ? 'true' : null;
  if (ts.isStringLiteral(init)) return JSON.stringify(init.text);
  if (ts.isJsxExpression(init) && init.expression) return init.expression.getText();
  return null;
}

/** The string literals an <input>'s `type` can take (both arms of a conditional). */
function typeValues(el: Opening): string[] | null {
  const a = attr(el, 'type');
  if (!a?.initializer) return null;
  if (ts.isStringLiteral(a.initializer)) return [a.initializer.text];
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else n.forEachChild(visit);
  };
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) visit(a.initializer.expression);
  return out.length ? out : null;
}

const SIGNATURE_ATTRS = ['data-testid', 'id', 'placeholder', 'aria-label', 'className', 'ref'];

function signatureOf(tag: string, el: Opening): string {
  for (const name of SIGNATURE_ATTRS) {
    const v = attrText(attr(el, name));
    if (v) return `${tag} ${name}=${v.replace(/\s+/g, ' ')}`;
  }
  const v = attrText(attr(el, 'value'));
  return v ? `${tag} value=${v.replace(/\s+/g, ' ')}` : tag;
}

function isFieldTag(tag: string, el: Opening): boolean {
  if (tag === 'textarea' || tag === 'MicInput' || tag === 'EditorContent' || WRAPPED_BOXES.has(tag)) return true;
  if (tag === 'input') {
    const types = typeValues(el);
    return !types || types.some((t) => !NOT_TYPED.has(t));
  }
  const editable = attr(el, 'contentEditable') ?? attr(el, 'contenteditable');
  if (!editable) return false;
  const v = attrText(editable);
  return v !== 'false' && v !== '"false"';
}

/** The ref expressions the file's mics write into. */
function micTargets(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText();
      if (MIC_HOSTS.has(tag)) {
        const box = attrText(attr(n, 'boxRef'));
        if (box) out.add(box);
      }
      if (tag === 'EditorMic') {
        const editor = attrText(attr(n, 'editor'));
        if (editor) out.add(`editor:${editor}`);
      }
      if (tag === 'MicButton') {
        const m = attrText(attr(n, 'insertBox'))?.match(/^\(\)\s*=>\s*([\w$.]+)\.current$/);
        if (m) out.add(m[1]);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function insideMicField(el: Opening): boolean {
  for (let n: ts.Node | undefined = el.parent; n; n = n.parent) {
    if (!ts.isJsxElement(n) || n.openingElement.tagName.getText() !== 'MicField') continue;
    const fields: Opening[] = [];
    const visit = (child: ts.Node) => {
      if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && isFieldTag(child.tagName.getText(), child)) fields.push(child);
      child.forEachChild(visit);
    };
    for (const child of n.children) visit(child);
    const box = attrText(attr(n.openingElement, 'boxRef'));
    const ref = attrText(attr(el, 'ref')) ?? attrText(attr(el, 'boxRef'));
    // A wrapper only wires the single box named by its ref, not every child.
    return fields.length === 1 && fields[0] === el && box !== null && ref === box;
  }
  return false;
}

export function fieldsOf(file: string, source: string): ComposeField[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const targets = micTargets(sf);
  const out: ComposeField[] = [];
  const seen = new Map<string, number>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText();
      if (isFieldTag(tag, n)) {
        const signature = signatureOf(tag, n);
        const count = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, count);
        const ref = attrText(attr(n, 'ref')) ?? attrText(attr(n, 'boxRef'));
        const editor = tag === 'EditorContent' ? attrText(attr(n, 'editor')) : null;
        out.push({
          file,
          signature,
          key: `${file}|${signature}${count > 1 ? `#${count}` : ''}`,
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          mic: tag === 'MicInput' || insideMicField(n) || (!!ref && targets.has(ref)) || (!!editor && targets.has(`editor:${editor}`)),
        });
      }
    }
    // CodeMirror: an editor built in code, never in JSX.
    if (ts.isNewExpression(n) && n.expression.getText() === 'EditorView') {
      const signature = 'new EditorView';
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      out.push({ file, signature, key: `${file}|${signature}${count > 1 ? `#${count}` : ''}`, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, mic: false });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** The Board frames' markup strings: `<textarea …`, `<input …` and `contenteditable` as written. */
export function frameFieldsOf(file: string, source: string): ComposeField[] {
  const out: ComposeField[] = [];
  for (const m of source.matchAll(/<(textarea|input)\b[^>]*>/g)) {
    const typed = m[0].match(/type="([^"]+)"/)?.[1];
    if (m[1] === 'input' && typed && NOT_TYPED.has(typed)) continue;
    const cls = m[0].match(/class="([^"]+)"/)?.[1];
    const signature = `${m[1]} class=${JSON.stringify(cls ?? '')}`;
    out.push({ file, signature, key: `${file}|${signature}`, line: source.slice(0, m.index).split('\n').length, mic: false });
  }
  return out;
}

export function scanComposeFields(root = WEB_SRC): ComposeField[] {
  const out: ComposeField[] = [];
  for (const full of walk(root)) {
    out.push(...fieldsOf(path.relative(root, full), fs.readFileSync(full, 'utf8')));
  }
  const board = path.join(root, 'components/board');
  for (const name of fs.readdirSync(board).filter((n) => n.endsWith('.frame.js'))) {
    out.push(...frameFieldsOf(path.relative(root, path.join(board, name)), fs.readFileSync(path.join(board, name), 'utf8')));
  }
  return out;
}
