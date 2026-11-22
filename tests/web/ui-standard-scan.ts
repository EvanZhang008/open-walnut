/**
 * What the UI standard (.claude/skills/walnut-ui-requirements/standard.md) calls a second style,
 * counted per file. Used by ui-standard-ratchet.test.ts.
 *
 * 2026-11-21: one screen showed a question card with grey rounded option buttons and a result card
 * with a filled blue Acknowledge and an outlined Snooze. Both were `.btn`, each restyled by its
 * card's own CSS. Each counter below is one way that happens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss, type Decl } from './css-scan';
import { tokenBreaks, TOKEN_KINDS, type TokenKind } from './ui-token-scan';

export { TOKEN_KINDS };

export const WEB_SRC = path.join(__dirname, '../../web/src');

/**
 * The button family (web/src/styles/buttons.css): a compound made only of these classes is the
 * family itself. The last three are slots inside a key (a compound trigger's value and caret, a
 * label that keeps the key's width), not variants.
 */
export const FAMILY = new Set(['btn', 'btn-sm', 'btn-primary', 'btn-danger', 'btn-ghost', 'btn-icon', 'btn-link', 'btn-block', 'btn-value', 'btn-caret', 'btn-reserve']);
/** The family's own file: it is the one place that draws `.btn`. */
export const FAMILY_CSS = 'styles/buttons.css';

/** Properties that change how a control looks (layout-only ones like margin or order are fine). */
const LOOK = /^(background|background-color|border|border-color|border-width|border-style|border-radius|padding|padding-inline|padding-block|font-size|font-weight|min-height|height|color|box-shadow)$/;

const classesOf = (compound: string) => [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);

/** Compounds of one selector, without pseudo-classes and pseudo-elements. */
function compounds(selector: string): string[] {
  const bare = selector.replace(/::?[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  return bare.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
}

/**
 * Classes the TSX writes next to `btn` (`className="btn btn-sm org-ask-tool"`): a CSS rule on one of
 * them restyles the shared button even though its selector never names `.btn`.
 */
export function btnCompanions(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=\{?\s*[`'"]([^`'"]*)[`'"]/g)) {
      const words = m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
      if (!words.includes('btn')) continue;
      for (const w of words) if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(w) && !FAMILY.has(w)) out.add(w);
    }
  }
  return out;
}

/** `.scope .btn`, `.btn.my-card-btn`, `.my-card-btn` written beside `btn`: the shared button restyled for one place. */
export function restylesBtn(selector: string, companions: Set<string> = new Set()): boolean {
  const parts = compounds(selector);
  const at = parts.findIndex((c) => classesOf(c).includes('btn'));
  if (at < 0) return classesOf(parts[parts.length - 1] ?? '').some((c) => companions.has(c));
  if (at > 0) return true; // an ancestor scope
  return classesOf(parts[at]).some((c) => !FAMILY.has(c)) || parts.length > 1;
}

/** `.my-thing-btn { background; border-radius }`: a button, pill or chip with a look of its own. */
export function isOwnControl(selector: string): boolean {
  const parts = compounds(selector);
  const last = parts[parts.length - 1] ?? '';
  const cls = classesOf(last);
  if (cls.includes('btn')) return false; // counted by restylesBtn
  return cls.some((c) => /(-btn|-button|-pill|-chip)$/.test(c));
}

/**
 * A phone's finger size: a rule that only sets a key's height or width inside a phone or
 * coarse-pointer query (44 px targets). That is a size for the device, not a second look.
 */
const SIZE = /^(min-height|height|min-width|width)$/;
function fingerSize(decls: Decl[]): boolean {
  const look = decls.filter((d) => LOOK.test(d.prop) || SIZE.test(d.prop));
  return look.length > 0 && look.every((d) => SIZE.test(d.prop) && d.atRules.some((a) => /pointer:\s*coarse|max-width/.test(a)));
}

/**
 * The one input box (web/src/styles/input-box.css): the classes the TSX writes beside `wn-input`
 * (the boxes: chat-input-box, answer-box, ...) and beside `wn-input-send` (their send keys).
 * 2026-11-21, the user on a Threads reply box: "it's oval ... everything should be unified".
 */
export function inputParts(): { boxes: Set<string>; keys: Set<string> } {
  const boxes = new Set<string>();
  const keys = new Set<string>();
  const STATE = /^(is-|has-)/;
  for (const file of walk(WEB_SRC, ['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    // A plain string, or a template literal's fixed words (its `${...}` parts left out).
    for (const m of text.matchAll(/className=\{?\s*(?:`((?:[^`$]|\$\{[^}]*\})*)`|'([^']*)'|"([^"]*)")/g)) {
      const fixed = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      const words = fixed.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(w));
      const into = words.includes('wn-input') ? boxes : words.includes('wn-input-send') ? keys : null;
      if (!into) continue;
      for (const w of words) if (!w.startsWith('wn-input') && !STATE.test(w)) into.add(w);
    }
  }
  return { boxes, keys };
}

/** The file that alone gives the input box its look. */
export const INPUT_HOME = 'styles/input-box.css';
const BOX_LOOK = /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-(color|width|style))?|border(-(top|bottom)-(left|right))?-radius|box-shadow|outline(-(color|width|style))?|height|min-height)$/;
const KEY_LOOK = /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-(color|width|style))?|border(-(top|bottom)-(left|right))?-radius|width|height|min-width|min-height|padding(-(top|right|bottom|left|inline|block))?|color|opacity|box-shadow)$/;
/** Rows inside a box that hold its keys: a key in one of them is still the box's own key. */
const KEY_ROWS = new Set(['chat-input-controls', 'chat-input-compact-actions', 'answer-box-tools', 'thread-card-mic']);

/** Compounds of one selector, with what `:is()` / `:where()` name kept (each alternative's last compound). */
function inputCompounds(selector: string): string[] {
  const opened = selector.replace(/:(?:is|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, inner: string) =>
    inner.split(',').map((alt) => alt.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? '').join(''));
  return compounds(opened);
}

/** A rule that gives an input box, its send key, or a key inside it a look of its own. */
export function restylesInput(selector: string, decls: { prop: string }[], parts: { boxes: Set<string>; keys: Set<string> }): boolean {
  const cs = inputCompounds(selector);
  const last = classesOf(cs[cs.length - 1] ?? '');
  const before = cs.slice(0, -1).flatMap(classesOf);
  const sets = (re: RegExp) => decls.some((d) => re.test(d.prop));
  if (last.some((c) => parts.boxes.has(c) || c === 'wn-input')) return sets(BOX_LOOK);
  if (last.some((c) => parts.keys.has(c) || c === 'wn-input-send')) return sets(KEY_LOOK);
  const inBox = before.some((c) => parts.boxes.has(c) || c === 'wn-input' || KEY_ROWS.has(c));
  if (inBox && last.some((c) => c === 'mic-btn' || c === 'picture-attach')) return sets(KEY_LOOK);
  return false;
}
/**
 * A class that names the words telling one item from another (standard.md, "Text that does not
 * fit"): `.todo-item-title`, `.org-rail-name`, `.mail-subject`, `.nfc-summary`.
 */
export const TITLE_CLASS = /(^|-)(title|name|subject|summary|heading|headline)$/;

/** `.x-title { text-overflow: ellipsis }` or a line clamp on it: a view cutting its own title. */
export function cutsTitle(selector: string): boolean {
  const parts = compounds(selector);
  return classesOf(parts[parts.length - 1] ?? '').some((c) => TITLE_CLASS.test(c));
}

const CUTS = (prop: string, value: string) => (prop === 'text-overflow' && /ellipsis/.test(value)) || (/(^|-)line-clamp$/.test(prop) && !/^(none|unset|initial)$/.test(value.trim()));

export type Counts = {
  restyledBtn: Record<string, number>;
  ownControl: Record<string, number>;
  rawAccent: Record<string, number>;
  bareButton: Record<string, number>;
  restyledInput: Record<string, number>;
  cutTitle: Record<string, number>;
} & Record<TokenKind, Record<string, number>>;

/** Roles of a choice control (segmented, tabs, switches, boxes): their own components, not buttons. */
const CHOICE_ROLE = /\brole=["'{`]*(tab|radio|switch|checkbox|option|menuitemradio|menuitemcheckbox)\b/;

/** The end of the JSX value that starts at `i` (a quoted string or a balanced `{...}`), exclusive. */
function valueEnd(src: string, i: number): number {
  let depth = 0;
  let quote = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) { quote = ''; if (depth === 0) return i + 1; } continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return i;
}

/** The opening tags of every `<button` in a TSX source (strings and `{...}` values skipped whole). */
export function buttonTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<button\b/g)) {
    let i = m.index! + 7;
    while (i < src.length && src[i] !== '>') {
      i = src[i] === '"' || src[i] === "'" || src[i] === '{' ? valueEnd(src, i) : i + 1;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

/**
 * A `<button>` drawn outside the family: no `btn` among the words of its className (a static
 * string, a template, or an expression that names it), and not a choice control.
 */
export function isBareButton(tag: string): boolean {
  if (CHOICE_ROLE.test(tag)) return false;
  const at = tag.search(/\bclassName=/);
  if (at < 0) return true;
  const start = at + 'className='.length;
  const value = tag.slice(start, valueEnd(tag, start));
  // The input box's send key is its own control (styles/input-box.css, standard.md "Inputs").
  if (/(^|[\s"'`{(])wn-input-send(?=$|[\s"'`}$])/.test(value)) return false;
  return !/(^|[\s"'`{(])btn(?=$|[\s"'`}$])/.test(value);
}

/** Rules (one per file and selector list) in each file that break each rule of the standard. */
export function countAll(): Counts {
  const out =  { restyledBtn: {}, ownControl: {}, rawAccent: {}, ...Object.fromEntries(TOKEN_KINDS.map((k) => [k, {}])), bareButton: {}, restyledInput: {}, cutTitle: {} } as Counts;
  const bump = (m: Record<string, number>, f: string) => { m[f] = (m[f] ?? 0) + 1; };
  const companions = btnCompanions();
  const parts = inputParts();
  for (const file of walk(WEB_SRC, ['.css']).sort()) {
    const rel = path.relative(WEB_SRC, file);
    const rules = new Map<string, Decl[]>();
    for (const d of scanCss(rel, fs.readFileSync(file, 'utf8'))) {
      const key = d.selectors.join(', ');
      rules.set(key, [...(rules.get(key) ?? []), d]);
      for (const kind of tokenBreaks(d)) bump(out[kind], rel);
    }
    for (const [, decls] of rules) {
      const sels = decls[0].selectors;
      const sets = (re: RegExp) => decls.some((d) => re.test(d.prop));
      if (decls.some((d) => LOOK.test(d.prop)) && !fingerSize(decls) && sels.some((x) => restylesBtn(x, companions))) bump(out.restyledBtn, rel);
      else if (sets(/^background(-color)?$/) && sets(/^border-radius$/) && sels.some(isOwnControl)) bump(out.ownControl, rel);
      if (rel !== INPUT_HOME && sels.some((x) => restylesInput(x, decls, parts))) bump(out.restyledInput, rel);
      if (rel !== 'styles/text-fit.css' && decls.some((d) => CUTS(d.prop, d.value)) && sels.some(cutsTitle)) bump(out.cutTitle, rel);
    }
  }
  for (const file of walk(WEB_SRC, ['.css', '.ts', '.tsx']).sort()) {
    const n = (fs.readFileSync(file, 'utf8').match(/#(?:007aff|0a84ff)\b/gi) ?? []).length;
    if (n) out.rawAccent[path.relative(WEB_SRC, file)] = n;
  }
  for (const file of walk(WEB_SRC, ['.tsx']).sort()) {
    // The choice controls' own buttons (a chip, a disclosure) are their family, not the button one
    // (standard.md, "Choice controls").
    if (path.relative(WEB_SRC, file).startsWith('components/controls/')) continue;
    const n = buttonTags(fs.readFileSync(file, 'utf8')).filter(isBareButton).length;
    if (n) out.bareButton[path.relative(WEB_SRC, file)] = n;
  }
  return out;
}
