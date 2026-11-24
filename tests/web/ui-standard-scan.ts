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
 * The plugins this repo ships (plugin-store/<id>/src): their pages draw keys in the same console, so
 * the button counts cover them too (2026-11-23: Rhythm's keys had a family of their own). Their files
 * are keyed from WEB_SRC (`../../plugin-store/...`), as the rest.
 */
export const PLUGIN_SRC = path.join(__dirname, '../../plugin-store');
/** Every TSX file a key can be written in: the console's and the shipped plugins'. */
export const keyFiles = (exts: string[] = ['.tsx']): string[] => [...walk(WEB_SRC, exts), ...walk(PLUGIN_SRC, exts)];
/** A plugin's stylesheet is the template string a `styles.ts` exports: its text, from `= \`` to the last backtick. */
export function pluginCss(src: string): string {
  const at = src.indexOf('= `');
  const end = src.lastIndexOf('`');
  return at < 0 || end <= at + 3 ? '' : src.slice(at + 3, end);
}
/** The shipped plugins' stylesheets: [file, css text]. */
export const pluginStyles = (): [string, string][] =>
  walk(PLUGIN_SRC, ['styles.ts']).map((f) => [f, pluginCss(fs.readFileSync(f, 'utf8'))] as [string, string]).filter(([, css]) => css.length > 0);

/** The one home of the console's label (standard.md, "Status labels"). */
export const LABEL_HOME = 'styles/badge.css';
/** The label and its tones and forms: a compound made only of these is the label itself. */
export const BADGE_FAMILY = new Set(['badge', 'badge-accent', 'badge-warning', 'badge-error', 'badge-alert', 'badge-paused', 'badge-count', 'badge-corner', 'badge-clickable', 'badge-long']);

/**
 * The button family (web/src/styles/buttons.css): a compound made only of these classes is the
 * family itself. The last three are slots inside a key (a compound trigger's value and caret, a
 * label that keeps the key's width), not variants.
 */
export const FAMILY = new Set(['btn', 'btn-sm', 'btn-primary', 'btn-danger', 'btn-ghost', 'btn-icon', 'btn-link', 'btn-block', 'btn-value', 'btn-caret', 'btn-reserve', 'btn-tight', 'btn-round']);
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
  for (const file of keyFiles(['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=\{?\s*[`'"]([^`'"]*)[`'"]/g)) {
      const words = m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
      if (!words.includes('btn')) continue;
      for (const w of words) if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(w) && !FAMILY.has(w)) out.add(w);
    }
  }
  return out;
}

/**
 * A key's own behaviour, drawn beside the family's look and never instead of it; each entry says why
 * the family cannot carry it. The family has no countdown: a permission rule kept in a file, clicked
 * once, stays armed for 5 s, and a 2 px bar under its label runs out over those 5 s
 * (globals.css, `.is-armed::after`). The key itself is the family's: btn btn-sm, and while armed the
 * family's on look (data-on), 2026-11-23. The family has no busy ring either: a session card's
 * answer tapped on a phone hides its label and turns a ring in its place while the answer is sent
 * (phone-session.css, `.permission-request-btn.is-busy` and its `::after`).
 */
export const OWN_BEHAVIOUR: RegExp[] = [/\.is-armed::after$/, /\.permission-request-btn\.is-busy(::after)?$/];
export const ownBehaviour = (selector: string) => OWN_BEHAVIOUR.some((re) => re.test(selector.trim()));

/** `.scope .btn`, `.btn.my-card-btn`, `.my-card-btn` written beside `btn`: the shared button restyled for one place. */
export function restylesBtn(selector: string, companions: Set<string> = new Set()): boolean {
  const parts = compounds(selector);
  const at = parts.findIndex((c) => classesOf(c).includes('btn'));
  if (at < 0) return classesOf(parts[parts.length - 1] ?? '').some((c) => companions.has(c));
  if (at > 0) return true; // an ancestor scope
  return classesOf(parts[at]).some((c) => !FAMILY.has(c)) || parts.length > 1;
}

/**
 * `.my-thing-btn { background; border-radius }`: a button, pill or chip with a look of its own. A class
 * written on a `<button>` outside the family (`bareKeys`, from bareKeyClasses) is one whatever its name:
 * `.nfc-card-action` drew the notice cards' keys and no suffix gave it away (2026-11-23).
 */
export function isOwnControl(selector: string, bareKeys: Set<string> = new Set()): boolean {
  const parts = compounds(selector);
  const last = parts[parts.length - 1] ?? '';
  const cls = classesOf(last);
  if (cls.includes('btn')) return false; // counted by restylesBtn
  return cls.some((c) => /(-btn|-button|-pill|-chip)$/.test(c) || bareKeys.has(c));
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

/** A cut that is right (one-line chrome: a tab, a path bar, a breadcrumb) says why on its own line:
 *  `text-overflow: ellipsis; /* meta: <why, 10+ characters> *\/`. The ratchet skips only those. */
export const META_MARK = /\/\*\s*meta:\s*[^*]{10,}\*\//;
const CUTS = (prop: string, value: string) => (prop === 'text-overflow' && /ellipsis/.test(value)) || (/(^|-)line-clamp$/.test(prop) && !/^(none|unset|initial)$/.test(value.trim()));
/**
 * `.my-thing-badge { color; border-radius }`: a badge, pill, chip or tag that draws a label of its own
 * instead of the one `.badge` (styles/badge.css). 2026-11-21: task rows read as "a list of tags" in
 * blue, violet and grey pills and dashed boxes, 229 such rules in 155 looks. Fill, words colour,
 * edge colour or corner count; layout (margin, max-width, order) and custom properties do not.
 */
export function isOwnLabel(selector: string): boolean {
  const parts = compounds(selector);
  const cls = classesOf(parts[parts.length - 1] ?? '');
  // `.scope .badge`, `.badge.my-pill`: the shared label restyled for one place.
  if (cls.includes('badge')) return parts.length > 1 || cls.some((c) => !BADGE_FAMILY.has(c));
  return cls.some((c) => /-(badge|pill|chip|tag)$/.test(c));
}

/**
 * A count, state, role, kind, type or "new" mark drawn as a box of its own (`.team-card-count`,
 * `.oc-role`, `.mail-mailbox-new`, `.session-diff-tree-repokind`, `.hib-type`): a label under another name. Counted only when the rule draws
 * a box (a fill or an edge, and a corner short of a circle), so plain text and dots stay free.
 */
export function isBoxedLabelName(selector: string): boolean {
  const parts = compounds(selector);
  return classesOf(parts[parts.length - 1] ?? '').some((c) => /(-count|-state|-role|kind|-new|-status|-type)$/.test(c));
}

/** The rule draws a label box: a fill or an edge, and a corner that is not a circle. */
export function drawsBox(decls: { prop: string; value: string }[]): boolean {
  const v = (re: RegExp) => decls.filter((d) => re.test(d.prop)).map((d) => d.value.replace(/\s*!important$/, '').trim());
  const fill = v(/^background(-color)?$/).some((x) => !NO_PAINT.test(x));
  const edge = v(/^border(-(top|right|bottom|left))?$/).some((x) => !/^(none|0|0px)$/.test(x) && !/\btransparent\b/.test(x));
  const corner = v(/^border-radius$/).some((x) => !/^0(px)?$/.test(x) && !/^50%$/.test(x));
  return (fill || edge) && corner;
}

const NO_PAINT = /^(none|transparent|inherit|initial|unset|0|currentColor)$/i;

/**
 * The round family (standard.md, "Shapes"; 2026-11-22, the user: "我想变成圆形"): every key, chip,
 * segment, tab and label is round, a capsule (`--radius-full`) or a circle (50%). A pressable is a
 * class written on a `<button>`, on an element with `role="button"` or `"tab"`, beside
 * `btn`, or named like a control. Rows, cards, rails, bars and menus that a person presses keep the
 * soft corner of their container, so a name ending in one of those is not a key.
 */
const KEY_NAME = /-(btn|button|pill|chip|toggle|tab|badge|tag|count)$/;
const MENU_KEY = /-menu$/;
const NOT_A_KEY = /(-(row|rows|card|block|rail|bar|head|header|item|cell|aside|drop|panel|menu|list|option|opt|seg|segs|entry|tile|line|section|preview|thumb|frame|daynum|title|result|link|caption|value|marker|text|checkbox|dir|file)|^wn-(field|notice|overlay|dialog|input))$/;
/** A corner that is round, flat or the parent's: everything else on a key is a square key. */
const ROUND_CORNER = /^(var\(--radius-full\)|50%|inherit|0|0px|none|initial|unset)$/; // a literal 999px is the token's job (pillRadius)
/** `border-radius: 8px; /* shape: <why, 10+ characters> *\/`: a class named like a key that is not one (a row's highlight). */
export const SHAPE_MARK = /\/\*\s*shape:\s*[^*]{10,}\*\//;
/** A font size off the type scale that a measurement needs, said on its own line (a `size: <why>` comment):
 *  not counted as fontSizeOffScale. Each one is listed in ui-standard-ratchet.test.ts (SIZE_MARKS). */
export const SIZE_MARK = /\/\*\s*size:\s*[^*]{10,}\*\//;
export function pressableClasses(): Set<string> {
  const out = new Set<string>(btnCompanions());
  for (const file of walk(WEB_SRC, ['.tsx'])) {
    const src = fs.readFileSync(file, 'utf8');
    for (const name of ['button', 'a', 'div', 'span', 'label', 'li']) {
      for (const tag of openingTags(src, name)) {
        if (name !== 'button' && !/\brole=["'{`]*(button|tab)\b/.test(tag)) continue;
        const at = tag.search(/\bclassName=/);
        if (at < 0) continue;
        const start = at + 'className='.length;
        // Every quoted piece of the value: a static string, a template's parts, a ternary's branches.
        const value = tag.slice(start, valueEnd(tag, start)).replace(/\$\{/g, ' ');
        for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+|\bbtn\b/g)) out.add(m[0]);
      }
    }
  }
  return out;
}
/**
 * The classes of a selector's last compound, those listed in its `:is()` / `:where()` too
 * (`.pr-card :is(.pr-card-refresh, .pr-card-complete)` names two keys), never those under `:not()`.
 */
export function lastCompoundClasses(selector: string): string[] {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1;
  }
  const last = selector.slice(start).replace(/\[[^\]]*\]/g, '').replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').replace(/::?[A-Za-z-]+(?!\()/g, '');
  return [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}
/** `.my-key { border-radius: 6px }`: a key, chip, tab or label drawn with a corner short of round. */
export function isSquareKey(selector: string, radius: string, pressables: Set<string>): boolean {
  const v = radius.replace(/\s*!important$/, '').trim();
  const label = /^var\(--label-radius\)$/.test(v);
  if (!label && v.split(/\s+/).every((x) => ROUND_CORNER.test(x))) return false;
  if (/(input-key|input-radius|choice-radius-box)/.test(v)) return false; // the input box's own keys and the tab's focus ring
  if (/\[aria-orientation=['"]?vertical/.test(selector)) return false; // a vertical tab list is a list of rows
  if (selector.includes('::')) return false; // a mark drawn inside the key (a tick, a ring), not the key
  const cls = lastCompoundClasses(selector);
  // A class on a pressable named like a menu is the key that opens it (`todo-section-tabs-menu`,
  // 2026-11-24: a 22 px square trigger the name kept out of this count), not the menu.
  if (cls.some((c) => NOT_A_KEY.test(c) && !(MENU_KEY.test(c) && pressables.has(c)))) return false;
  const isKey = cls.some((c) => c === 'btn' || c === 'badge' || pressables.has(c) || KEY_NAME.test(c));
  // The label corner is a label's: a key that writes it is a square key in a label's name.
  if (label) return isKey && !cls.some((c) => c === 'badge' || /-(badge|tag|pill|chip)$/.test(c));
  return isKey;
}

/**
 * A row drawn round (2026-11-22 review: menu rows, tree rows and option rows that became
 * stadiums): one rule gives `--radius-full` to something laid out as a row, its words at the left
 * or spread to both ends. A key centres its label; a row keeps its container's corner.
 */
export function isRoundRow(decls: { prop: string; value: string }[]): boolean {
  const has = (p: string, re: RegExp) => decls.some((d) => d.prop === p && re.test(d.value.replace(/\s*!important$/, '').trim()));
  return has('border-radius', /var\(--radius-full\)/) && (has('text-align', /^(left|start)$/) || has('justify-content', /^(flex-start|start|space-between)$/));
}

/**
 * A card whose fill is the page's (`--bg`) or a floating layer's (`--bg-elevated`) instead of the
 * one card fill, `--card-bg` (standard.md, "Cards"). 2026-11-21: in the dark theme the cards of one
 * list drifted between black, #1C1C1E and #2C2C2E, so the question card, the thread card and the
 * approval card beside each other read as three kinds. A card is a `*-card` class with a corner, in
 * the flow: one placed `fixed` or `absolute` floats over the page and keeps the layer's fill.
 */
export function isCard(selector: string): boolean {
  const parts = compounds(selector);
  return classesOf(parts[parts.length - 1] ?? '').some((c) => /(^|-)card$/.test(c));
}
export function offCardFill(decls: { prop: string; value: string }[]): boolean {
  const v = (re: RegExp) => decls.filter((d) => re.test(d.prop)).map((d) => d.value.replace(/\s*!important$/, '').trim());
  if (v(/^position$/).some((x) => /^(fixed|absolute)$/.test(x))) return false;
  if (!v(/^border-radius$/).some((x) => !/^0(px)?$/.test(x))) return false;
  return v(/^background(-color)?$/).some((x) => /^var\(--(bg|bg-elevated)\s*[,)]/.test(x));
}
/** A declaration that paints a label: its fill, its words, its edge's colour, or its corner. */
export function paintsLabel(prop: string, value: string): boolean {
  const v = value.replace(/\s*!important$/, '').trim();
  if (prop === 'border-radius') return !/^0(px)?$/.test(v);
  if (/^(background|background-color|color|border-color)$/.test(prop)) return !NO_PAINT.test(v);
  if (/^border(-(top|right|bottom|left))?$/.test(prop)) return !/^(none|0|0px)$/.test(v) && !/\btransparent\b/.test(v);
  return false;
}

/** The words of a JSX attribute's value in a tag: a plain string or a template's fixed words. */
function attrWords(tag: string, attr: string): string[] {
  const out: string[] = [];
  for (const m of tag.matchAll(new RegExp(`\\b${attr}=\\{?\\s*(?:\`((?:[^\`$]|\\$\\{[^}]*\\})*)\`|'([^']*)'|"([^"]*)")`, 'g'))) {
    const fixed = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    out.push(...fixed.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(w)));
  }
  return out;
}

/** Inputs that are not a field a person types in. */
const NOT_A_FIELD = /\btype=["'{`]*(checkbox|radio|range|color|file|hidden|button|submit|reset|image)\b/;
const FIELD_STATE = /^(is-|has-|wn-)/;

/**
 * Every field's classes (styles/input-box.css, "Fields"): the classes the TSX writes on an
 * `<input>`, `<textarea>` or `<select>` (or a MicInput's or SearchField's own input), and the
 * classes written beside `wn-field` (a field box, its wrapper drawn as the field).
 * 2026-11-21 UI audit: nine searches and plain fields, nine looks.
 */
export function fieldClasses(): FieldClasses {
  const out: FieldClasses = new Set<string>();
  const lines = new Set<string>();
  const add = (words: string[], oneLine = true) => {
    for (const w of words) if (!FIELD_STATE.test(w)) { out.add(w); if (oneLine) lines.add(w); }
  };
  for (const file of walk(WEB_SRC, ['.tsx'])) {
    const src = fs.readFileSync(file, 'utf8');
    for (const name of ['input', 'textarea', 'select', 'MicInput', 'SearchField']) {
      for (const tag of openingTags(src, name)) {
        if (NOT_A_FIELD.test(tag)) continue;
        add(attrWords(tag, 'className'), name !== 'textarea');
        const wrapper = attrWords(tag, 'fieldClassName');
        if (name === 'SearchField' || wrapper.includes('wn-field')) add(wrapper);
      }
    }
    for (const m of src.matchAll(/className=\{?\s*(?:`((?:[^`$]|\$\{[^}]*\})*)`|'([^']*)'|"([^"]*)")/g)) {
      const words = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/);
      if (words.includes('wn-field')) add(words.filter((w) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(w)));
    }
  }
  out.areas = new Set([...out].filter((c) => !lines.has(c)));
  return out;
}

/** Field classes, and those written only on a `<textarea>` (`areas`). */
export type FieldClasses = Set<string> & { areas?: Set<string> };

/** What draws a field: its fill, edge, corner, shadow, outline or height, or a re-pointed `--input-*`. */
const FIELD_LOOK = /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-(color|width|style))?|border(-(top|bottom)-(left|right))?-radius|box-shadow|outline(-(color|width|style))?|height|min-height|--input-[a-z-]+)$/;
/** A value that takes a field's own look away (a bare field inside a box), not a second look. */
const RESET = /^(none|0|0px|transparent|inherit|initial|unset|auto|100%|0 0 0 0|0 solid transparent)(\s*!important)?$/;

/** The last compound of a selector, top-level combinators only (`:is(a, b)` stays whole). */
function lastCompound(selector: string): string {
  let depth = 0;
  let at = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) at = i + 1;
  }
  return selector.slice(at);
}

/** A rule outside styles/input-box.css that gives a field a look of its own. */
export function restylesField(selector: string, decls: { prop: string; value?: string }[], fields: FieldClasses): boolean {
  const last = lastCompound(selector.trim());
  if (/\[type=["']?(checkbox|radio|range|color|file|hidden|button|submit)/.test(last)) return false;
  // A text selection's wash is not the field's look; what a `:not()` or `:has()` names is not the field.
  if (/::selection/.test(last)) return false;
  const named = last.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
  const elements = [...named.matchAll(/(?:^|[^\w.-])(input|textarea|select)(?![\w-])/g)].map((m) => m[1]);
  const classes = [...named.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]).filter((c) => fields.has(c));
  if (!elements.length && !classes.length) return false;
  if (/::placeholder/.test(last)) return decls.some((d) => /^(color|opacity)$/.test(d.prop));
  // A text area's starting height is how many lines it shows before it grows, not a look: the
  // height rule is for one-line fields (34 px, 28 px, 46 px on the phone).
  const area = elements.length ? elements.every((e) => e === 'textarea') : classes.some((c) => fields.areas?.has(c));
  return decls.some((d) => FIELD_LOOK.test(d.prop) && !RESET.test((d.value ?? '').trim()) && !(area && d.prop === 'min-height'));
}

export type Counts = {
  restyledBtn: Record<string, number>;
  ownControl: Record<string, number>;
  rawAccent: Record<string, number>;
  bareButton: Record<string, number>;
  restyledInput: Record<string, number>;
  cutTitle: Record<string, number>;
  restyledField: Record<string, number>;
  ownLabel: Record<string, number>;
  cardBg: Record<string, number>;
  squareKey: Record<string, number>;
  roundRow: Record<string, number>;
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

/** The opening tags of every `<name` element in a TSX source (strings and `{...}` values skipped whole). */
export function openingTags(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let i = m.index! + name.length + 1;
    while (i < src.length && src[i] !== '>') {
      i = src[i] === '"' || src[i] === "'" || src[i] === '{' ? valueEnd(src, i) : i + 1;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

/** The opening tags of every `<button` in a TSX source. */
export const buttonTags = (src: string): string[] => openingTags(src, 'button');

/** Every class written on a `<button>` drawn outside the family (isBareButton), in any quoted piece of its className. */
export function bareKeyClasses(): Set<string> {
  const out = new Set<string>();
  for (const file of keyFiles()) {
    for (const tag of buttonTags(fs.readFileSync(file, 'utf8'))) {
      if (!isBareButton(tag)) continue;
      const at = tag.search(/\bclassName=/);
      if (at < 0) continue;
      const start = at + 'className='.length;
      const value = tag.slice(start, valueEnd(tag, start)).replace(/\$\{/g, ' ');
      for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+/g)) out.add(m[0]);
    }
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
  // The input box's send key and a field's keys are their own controls (styles/input-box.css,
  // standard.md "Inputs").
  if (/(^|[\s"'`{(])(wn-input-send|wn-field-key)(?=$|[\s"'`}$])/.test(value)) return false;
  return !/(^|[\s"'`{(])btn(?=$|[\s"'`}$])/.test(value);
}

/** Rules (one per file and selector list) in each file that break each rule of the standard. */
export function countAll(): Counts {
  const out =  { restyledBtn: {}, ownControl: {}, rawAccent: {}, ...Object.fromEntries(TOKEN_KINDS.map((k) => [k, {}])), bareButton: {}, restyledInput: {}, cutTitle: {}, restyledField: {}, ownLabel: {}, cardBg: {}, squareKey: {}, roundRow: {} } as Counts;
  const bump = (m: Record<string, number>, f: string) => { m[f] = (m[f] ?? 0) + 1; };
  const companions = btnCompanions();
  const parts = inputParts();
  const fields = fieldClasses();
  const pressables = pressableClasses();
  const bareKeys = bareKeyClasses();
  const sheets: [string, string][] = [...walk(WEB_SRC, ['.css']).sort().map((f) => [f, fs.readFileSync(f, 'utf8')] as [string, string]), ...pluginStyles()];
  for (const [file, text] of sheets) {
    const rel = path.relative(WEB_SRC, file);
    const rules = new Map<string, Decl[]>();
    const lines = text.split('\n');
    for (const d of scanCss(rel, text)) {
      const key = d.selectors.join(', ');
      rules.set(key, [...(rules.get(key) ?? []), d]);
      for (const kind of tokenBreaks(d)) if (kind !== 'fontSizeOffScale' || !SIZE_MARK.test(lines[d.line - 1] ?? '')) bump(out[kind], rel);
      if (d.prop === 'border-radius' && !SHAPE_MARK.test(lines[d.line - 1] ?? '') && d.selectors.some((x) => isSquareKey(x, d.value, pressables))) bump(out.squareKey, rel);
    }
    for (const [, decls] of rules) {
      const sels = decls[0].selectors;
      const sets = (re: RegExp) => decls.some((d) => re.test(d.prop));
      if (decls.some((d) => LOOK.test(d.prop)) && !fingerSize(decls) && sels.some((x) => restylesBtn(x, companions) && !ownBehaviour(x))) bump(out.restyledBtn, rel);
      else if (sets(/^background(-color)?$/) && sets(/^border-radius$/) && sels.some((x) => isOwnControl(x, bareKeys))) bump(out.ownControl, rel);
      if (rel !== INPUT_HOME && sels.some((x) => restylesInput(x, decls, parts))) bump(out.restyledInput, rel);
      if (rel !== 'styles/text-fit.css' && decls.some((d) => CUTS(d.prop, d.value) && !META_MARK.test(lines[d.line - 1] ?? '')) && sels.some(cutsTitle)) bump(out.cutTitle, rel);
      if (rel !== INPUT_HOME && sels.some((x) => restylesField(x, decls, fields))) bump(out.restyledField, rel);
      if (sels.some(isCard) && offCardFill(decls)) bump(out.cardBg, rel);
      if (isRoundRow(decls) && !decls.some((d) => d.prop === 'border-radius' && SHAPE_MARK.test(lines[d.line - 1] ?? ''))) bump(out.roundRow, rel);
      if (rel !== LABEL_HOME && ((decls.some((d) => paintsLabel(d.prop, d.value)) && sels.some(isOwnLabel)) || (sels.some(isBoxedLabelName) && drawsBox(decls)))) bump(out.ownLabel, rel);
    }
  }
  for (const file of walk(WEB_SRC, ['.css', '.ts', '.tsx']).sort()) {
    const n = (fs.readFileSync(file, 'utf8').match(/#(?:007aff|0a84ff)\b/gi) ?? []).length;
    if (n) out.rawAccent[path.relative(WEB_SRC, file)] = n;
  }
  for (const file of keyFiles().sort()) {
    // The choice controls' own buttons (a chip, a disclosure) are their family, not the button one
    // (standard.md, "Choice controls").
    if (path.relative(WEB_SRC, file).startsWith('components/controls/')) continue;
    const n = buttonTags(fs.readFileSync(file, 'utf8')).filter(isBareButton).length;
    if (n) out.bareButton[path.relative(WEB_SRC, file)] = n;
  }
  return out;
}
