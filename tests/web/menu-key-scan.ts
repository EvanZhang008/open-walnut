/**
 * Keys that open a picker, read from the TypeScript AST, for menu-key-mark-guard.test.ts.
 *
 * A picker key is a key that shows words or a current value ("Auto model", "Default mode",
 * "Snooze", "Compare: main") and opens a list of choices. It wears MenuCaret and carries
 * aria-haspopup, so it looks and reads the same everywhere (2026-11-23: the new task draft's
 * "Auto model" key had neither, while "Default mode" beside it had both).
 *
 * A key here is a JSX element a person presses: a `<button>`, an element with an onClick, a role of
 * button or combobox, a tag named like a key (`Chip`, `FitButton`), or one that already carries
 * aria-haspopup. Three findings per file:
 *  - caretNoPopup: a key holding MenuCaret without aria-haspopup (or a MenuCaret in no key at all);
 *  - popupNoCaret: a key with aria-haspopup whose body shows words, without MenuCaret;
 *  - silentOpener: a key whose onClick opens a picker or menu (a toggle of an open state that shows a
 *    `*Picker` / `*Menu` / `*Popover`, or a `toggle*Picker()` call) with no aria-haspopup, unless it is
 *    a fold (aria-expanded beside DisclosureChevron).
 */
import ts from 'typescript';

export interface Finding { line: number; what: string }
export interface KeyFindings { caretNoPopup: Finding[]; popupNoCaret: Finding[]; silentOpener: Finding[] }

type El = ts.JsxElement | ts.JsxSelfClosingElement;
const opening = (el: El) => (ts.isJsxElement(el) ? el.openingElement : el);
const tagName = (el: El) => opening(el).tagName.getText();
const kids = (el: El | ts.JsxFragment): readonly ts.JsxChild[] => (ts.isJsxSelfClosingElement(el) ? [] : el.children);

function attr(el: El, name: string): ts.JsxAttribute | undefined {
  return opening(el).attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
/** A string attribute's value, the text of an expression's, or '' for a bare attribute. */
function attrText(a: ts.JsxAttribute | undefined): string | undefined {
  if (!a) return undefined;
  const v = a.initializer;
  if (!v) return '';
  if (ts.isStringLiteral(v)) return v.text;
  return v.expression?.getText() ?? '';
}

/** aria-haspopup present and not "false" (a value it picks at run time counts). */
export function hasPopup(el: El): boolean {
  return popupKind(el) !== undefined;
}

/**
 * What a key says it opens: its aria-haspopup ('menu', 'listbox', 'dialog', 'true', or the text of a
 * value picked at run time), or undefined. A spread of the shared menu hook's props
 * (useMenuButton's `buttonProps`) counts as 'menu', a spread object naming aria-haspopup as its value.
 */
export function popupKind(el: El): string | undefined {
  const v = attrText(attr(el, 'aria-haspopup'));
  if (v !== undefined) return /^(?:false|['"]false['"])$/.test(v.trim()) ? undefined : v;
  for (const p of opening(el).attributes.properties) {
    if (!ts.isJsxSpreadAttribute(p)) continue;
    const text = p.expression.getText();
    const named = /['"]aria-haspopup['"]\s*:\s*['"](\w+)['"]/.exec(text);
    if (named) return named[1];
    if (/\bbuttonProps\b/.test(text)) return 'menu';
  }
  return undefined;
}

const KEY_TAG = /^(?:button|[A-Z]\w*(?:Button|Chip|Pill|Key))$/;
export function isKey(el: El): boolean {
  if (KEY_TAG.test(tagName(el)) || attr(el, 'onClick') || attr(el, 'aria-haspopup')) return true;
  return /^(?:button|combobox)$/.test(attrText(attr(el, 'role')) ?? '');
}

/** Marks and pictures: no words of their own. */
const ICON_TAG = /^(?:svg|img|MenuCaret|DisclosureChevron|\w*(?:Icon|Glyph|Avatar|Ring|Dot|Spinner))$/;
/** A value that draws an icon or a count, not words: ICON_X, ICONS[id], someIcon, count, n.length. */
const ICON_NAME = /^(?:ICON_\w+|ICONS|\w*[Ii]con\w*|\w*[Gg]lyph\w*)$/;
const COUNT_NAME = /^(?:\w*[Cc]ount|length|size|total|n|num\w*|badge\w*)$/;

const letters = (s: string) => /\p{L}{2,}|\p{L}\s|\s\p{L}$|^\p{L}$/u.test(s.replace(/&#?\w+;/g, ' ').trim());

function lastName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return lastName(e.expression);
  if (ts.isCallExpression(e)) return lastName(e.expression);
  if (ts.isNonNullExpression(e)) return lastName(e.expression);
  return '';
}

function exprWords(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return exprWords(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return letters(e.text);
  if (ts.isTemplateExpression(e)) return letters(e.head.text) || e.templateSpans.some((s) => letters(s.literal.text) || exprWords(s.expression));
  if (ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isConditionalExpression(e)) return exprWords(e.whenTrue) || exprWords(e.whenFalse);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return exprWords(e.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) return exprWords(e.left) || exprWords(e.right);
    return false;
  }
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return nodeWords(e);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) {
    const n = lastName(e);
    if (ts.isElementAccessExpression(e) && ICON_NAME.test(lastName(e.expression))) return false;
    return !ICON_NAME.test(n) && !COUNT_NAME.test(n);
  }
  return false;
}

/** Whether an element or fragment shows words: text, or a value that is not an icon or a count. */
export function nodeWords(el: El | ts.JsxFragment): boolean {
  if (!ts.isJsxFragment(el)) {
    if (ICON_TAG.test(tagName(el)) || attrText(attr(el, 'aria-hidden')) === 'true') return false;
    if (/\b(?:sr-only|visually-hidden)\b/.test(attrText(attr(el, 'className')) ?? '')) return false;
  }
  return kids(el).some((c) => {
    if (ts.isJsxText(c)) return letters(c.text);
    if (ts.isJsxExpression(c)) return !!c.expression && exprWords(c.expression);
    return nodeWords(c as El | ts.JsxFragment);
  });
}

/** Whether a key's own body (and the props it hands its marks through) holds MenuCaret. */
export function holdsCaret(el: El): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText() === 'MenuCaret') found = true;
    else ts.forEachChild(n, visit);
  };
  visit(el);
  return found;
}

const holds = (el: El, tag: RegExp) => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (!found && (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && tag.test(n.tagName.getText())) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(el);
  return found;
};

/**
 * What a key opens, by the component it shows: a picker or a menu (a list of choices), or any
 * popup (a popover or flyout of any kind too). `{open && <ModelPicker`, `<ProjectPickerFlyout open={open}`.
 */
const PICKER_TAG = /(?:Picker|Menu|Dropdown|Listbox|Select)$/;
const POPUP_TAG = /(?:Picker|Menu|Dropdown|Listbox|Select|Popover|Flyout|Popup)$/;
/** An open state named for what it opens: `pickerOpen`, `menuOpen`, `showDropdown`. */
const PICKER_STATE = /picker|menu|dropdown/i;
const POPUP_STATE = /picker|menu|dropdown|popover|flyout|popup/i;

/** The state names a file shows each kind under, read from `x && <Tag`, `x ? <Tag` and `<Tag open={x}`. */
function shownStates(sf: ts.SourceFile): { picker: Set<string>; popup: Set<string> } {
  const out = { picker: new Set<string>(), popup: new Set<string>() };
  const add = (tag: string, cond: string) => {
    for (const id of cond.match(/\b[a-z]\w*/g) ?? []) {
      if (PICKER_TAG.test(tag)) out.picker.add(id);
      if (POPUP_TAG.test(tag)) out.popup.add(id);
    }
  };
  const shown = (e: ts.Expression): string | undefined => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isCallExpression(e) && /createPortal$/.test(e.expression.getText()) && e.arguments[0]) return shown(e.arguments[0]);
    return ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) ? tagName(e) : undefined;
  };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const tag = shown(n.right);
      if (tag) add(tag, n.left.getText());
    }
    if (ts.isConditionalExpression(n)) {
      const tag = shown(n.whenTrue);
      if (tag) add(tag, n.condition.getText());
    }
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) {
      const open = attr(n, 'open');
      if (open?.initializer && !ts.isStringLiteral(open.initializer)) add(tagName(n), attrText(open) ?? '');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The text of what a key's onClick runs: the inline handler, the file's function it names, or that name (a prop). */
function clickText(el: El, sf: ts.SourceFile): string {
  const init = attr(el, 'onClick')?.initializer;
  const e = init && !ts.isStringLiteral(init) ? init.expression : undefined;
  if (!e) return '';
  if (!ts.isIdentifier(e)) return e.getText();
  let body = '';
  const visit = (n: ts.Node) => {
    if (body) return;
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.getText() === e.text) body = n.getText();
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return body || e.text;
}

/**
 * What a key's press opens, from its handler: 'picker' (a list of choices), 'popup' (a popover of
 * another kind), or undefined. It toggles or sets an open state the file shows one under
 * (`setOpen((v) => !v)`, `setMenu(menu ? null : 'x')`, `setPickerOpen(true)`), calls
 * `toggle*Picker()`, `open*Menu()` or `onOpen*Picker`, or hands the press to the draft menu's `menuTriggerProps`.
 */
export function opens(el: El, sf: ts.SourceFile, states = shownStates(sf)): 'picker' | 'popup' | undefined {
  if (opening(el).attributes.properties.some((p) => ts.isJsxSpreadAttribute(p) && /\bmenuTriggerProps\(/.test(p.expression.getText()))) return 'picker';
  const body = clickText(el, sf);
  if (!body) return undefined;
  if (/\b(?:toggle|open|onOpen)\w*(?:Picker|Menu|Dropdown)\b/.test(body)) return 'picker';
  if (/\btoggle\w*(?:Popover|Flyout|Popup)\s*\(/.test(body)) return 'popup';
  let kind: 'picker' | 'popup' | undefined;
  for (const m of body.matchAll(/\bset([A-Z]\w*)\(\s*(?:\(?\s*\w+\s*\)?\s*=>\s*!|!\s*\w|[\w.]+\s*\?|true\b|['"]\w)/g)) {
    const state = m[1]![0]!.toLowerCase() + m[1]!.slice(1);
    if (PICKER_STATE.test(state) || states.picker.has(state)) return 'picker';
    if (POPUP_STATE.test(state) || states.popup.has(state)) kind = 'popup';
  }
  return kind;
}

/** A list popup (menu, listbox, tree, grid, `true`), or a value picked at run time that may be one. */
const LIST_POPUP = /^(?:menu|listbox|tree|grid|true|)$|['"](?:menu|listbox|tree|grid|true)['"]/;

/**
 * A row's own mark, which stands instead of the caret: a row of a menu or a list that opens more
 * ends with DisclosureChevron (standard.md, Big menus 6), and a fold turns one. One key, one mark.
 */
const rowMark = (el: El) => holds(el, /^Disclosure(?:Chevron|Button)$/);
const inMenu = (el: El) => /^(?:menuitem\w*|option|tab)$/.test(attrText(attr(el, 'role')) ?? '');

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const brief = (el: El) => opening(el).getText().replace(/\s+/g, ' ').slice(0, 100);

/** The innermost key around a node: up through props (`trailing={<MenuCaret />}`) too. */
function keyAround(n: ts.Node): El | undefined {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) && isKey(p)) return p;
  }
  return undefined;
}

export function scanKeys(text: string, fileName = 'x.tsx'): KeyFindings {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: KeyFindings = { caretNoPopup: [], popupNoCaret: [], silentOpener: [] };
  const states = shownStates(sf);
  const seen = new Set<El>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (tagName(n) === 'MenuCaret') {
        const key = keyAround(n);
        if (!key) out.caretNoPopup.push({ line: lineOf(sf, n), what: 'MenuCaret in no key' });
        else if (!hasPopup(key) && !seen.has(key)) { seen.add(key); out.caretNoPopup.push({ line: lineOf(sf, key), what: brief(key) }); }
      } else if (isKey(n) && !/^Disclosure/.test(tagName(n))) {
        const kind = popupKind(n);
        if (kind === undefined) {
          const fold = attr(n, 'aria-expanded') && rowMark(n);
          if (!fold && !inMenu(n) && opens(n, sf, states)) out.silentOpener.push({ line: lineOf(sf, n), what: brief(n) });
        } else if (!holdsCaret(n) && !rowMark(n) && !inMenu(n) && nodeWords(n)
          && (LIST_POPUP.test(kind) || opens(n, sf, states) === 'picker')) {
          out.popupNoCaret.push({ line: lineOf(sf, n), what: brief(n) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
