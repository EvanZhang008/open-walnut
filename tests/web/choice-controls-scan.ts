/**
 * Controls that pick a value (tabs, segmented controls, switches, chips with an on state,
 * checkboxes and radios, disclosure toggles) built by hand instead of from the shared components in
 * web/src/components/controls/ (standard.md, "Choice controls"). Used by
 * choice-controls-ratchet.test.ts.
 *
 * 2026-11-21 audit: 14 segmented controls, 14 tab bars with 5 active-state hooks, 9 switches in 6
 * sizes, and 49 native checkboxes with 16 separate accent-color rules, each written by its view.
 * The user: "why the ui still not consistent ... come on".
 *
 * A member is a lowercase JSX element (a DOM element, so not one of the shared components) that:
 *   tab      has role="tab" / "tablist", or a class ending -tab / -tabs (/ -tab-bar-item, -tab-btn)
 *   segment  has role="radio" / "radiogroup", or a class ending -seg / -segment / -segmented
 *   switch   has role="switch", or a class ending -switch
 *   check    is <input type="checkbox|radio">
 *   chip     has a class ending -chip and an on state (aria-pressed, or an active/on/selected class)
 *   pressed  has aria-pressed beside an on-class of its own (`.active`, `.is-on`, `-active`): an on
 *            state drawn by its own class (a Chip, a segment, or the button family's Tool role)
 *   disclose has aria-expanded and a class ending -toggle / -fold / -disclosure / -chevron / -caret /
 *            -expand / -collapse / -collapser
 *   pick     is a <button> that turns an on-class of its own on and off (`${on ? ' is-active' : ''}`)
 *            with no role and no ARIA state: a pick nobody can hear, drawn by its class (the Time
 *            page's Day / 7 days, 2026-11-27)
 * An element that only looks like one to this scan says so with data-choice-exempt="<why>".
 * And, in the stylesheets, `ownLook` counts rules that give a -tab / -tabs / -seg / -segment /
 * -segmented / -switch class its own fill, border or corner, plus every `accent-color` (a native box
 * tinted by hand) outside styles/choice-controls.css.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss, type Decl } from './css-scan';
import { PLUGIN_SRCS, pluginStyles } from './ui-standard-scan';

export const WEB_SRC = path.join(__dirname, '../../web/src');

/** The shared components and the stylesheet that draws them: the one home of each kind. */
export const HOMES = [
  'components/controls/',
  'components/settings/inputs/SegmentedControl.tsx',
  'components/settings/inputs/ToggleSwitch.tsx',
  'components/settings/inputs/SettingsCheckbox.tsx',
  'styles/choice-controls.css',
];

export type Kind = 'tab' | 'segment' | 'switch' | 'check' | 'chip' | 'pressed' | 'disclose' | 'pick';
export const KINDS: Kind[] = ['tab', 'segment', 'switch', 'check', 'chip', 'pressed', 'disclose', 'pick'];

export interface Member { file: string; line: number; kind: Kind; tag: string; what: string }

/**
 * Every JSX opening tag of a file: its name, its attribute text and where it starts. A hand-written
 * walk (a regex with nested braces backtracks for minutes on the 6,000-line files): from `<` and a
 * letter, read to the `>` that is outside braces and quotes.
 */
export function openingTags(text: string): Array<{ tag: string; attrs: string; index: number }> {
  const out: Array<{ tag: string; attrs: string; index: number }> = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    if (text[i] !== '<') continue;
    const m = /^<([A-Za-z][\w.]*)/.exec(text.slice(i, i + 64));
    if (!m) continue;
    let j = i + m[0].length;
    // A JSX tag's name is followed by space, `>` or `/`; `a<b` in an expression or a generic `<T,` is not one.
    if (j < n && !/[\s>/]/.test(text[j])) continue;
    let depth = 0;
    let quote = '';
    for (; j < n; j++) {
      const ch = text[j];
      if (quote) { if (ch === quote && text[j - 1] !== '\\') quote = ''; continue; }
      // A comment between the attributes (`// the popover's own ...`): its apostrophe is no quote.
      if (ch === '/' && text[j + 1] === '/') { const end = text.indexOf('\n', j); j = end < 0 ? n : end; continue; }
      if (ch === '/' && text[j + 1] === '*') { const end = text.indexOf('*/', j + 2); j = end < 0 ? n : end + 1; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth <= 0) break;
      else if (ch === '<' && depth <= 0 && /[A-Za-z]/.test(text[j + 1] ?? '')) { j = -1; break; }
    }
    if (j < 0 || j >= n) continue;
    out.push({ tag: m[1], attrs: text.slice(i + m[0].length, j), index: i });
  }
  return out;
}
/** A class that a condition turns on: `${on ? ' is-active' : ''}`, `on ? 'is-on' : ''`, `cx({ active: on })`. */
const ON_CLASS_SWITCHED = /\?\s*['"`]\s*(is-active|active|is-selected|selected|is-on|on|is-current|current)\s*['"`]\s*:/;
const CLASS_ATTR = /className=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g;

const isHome = (rel: string) => HOMES.some((h) => rel.startsWith(h));

/**
 * The class names a className writes, without the JS around them: `${on ? '' : ' btn-primary'}`
 * gives `btn-primary`, never the variable `on` (2026-11-27: Rhythm's Play key read as an on-class).
 */
function writtenClasses(cls: string): string {
  const parts: string[] = [];
  for (const m of cls.matchAll(/'([^']*)'|"([^"]*)"/g)) parts.push(m[1] ?? m[2] ?? '');
  for (const m of cls.matchAll(/`((?:[^`\\]|\\.)*)`/g)) parts.push(m[1].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' '));
  return parts.length ? parts.join(' ') : cls;
}

/** Kinds one element is a hand-built member of (empty for a shared component or anything else). */
export function kindsOf(tag: string, attrs: string): Array<{ kind: Kind; what: string }> {
  if (!/^[a-z]/.test(tag)) return [];
  // Not a choice control although it looks like one to this scan (a menu row, a hidden file input):
  // the element says why, in words a reviewer can check.
  if (/\bdata-choice-exempt=["'][^"']{8,}["']/.test(attrs)) return [];
  const cls = [...attrs.matchAll(CLASS_ATTR)].map((m) => m[1] ?? m[2] ?? '').join(' ');
  const words = new Set(cls.match(/[a-z][a-z0-9-]*/g) ?? []);
  // The shared Picked row (styles/pick-and-nav.css): a row of a list of options with its ARIA state
  // (role=radio and aria-checked among them) is that family, not a hand-built control.
  const role = attrs.match(/\brole=["']([a-z]+)["']/)?.[1];
  if (/(^|\s)wn-pick-row(?=\s|$)/.test(writtenClasses(cls)) && (role === 'radio' || role === 'option' || role === 'menuitemradio')) return [];
  const written = writtenClasses(cls);
  const out: Array<{ kind: Kind; what: string }> = [];
  const add = (kind: Kind, what: string) => { if (!out.some((o) => o.kind === kind)) out.push({ kind, what }); };
  if (role === 'tab' || role === 'tablist') add('tab', `role=${role}`);
  if (role === 'switch') add('switch', 'role=switch');
  if (role === 'radio' || role === 'radiogroup') add('segment', `role=${role}`);
  if (tag === 'input') {
    const type = attrs.match(/\btype=["'](checkbox|radio)["']/)?.[1];
    if (type) add('check', `input type=${type}`);
  }
  // A plain span or div that takes no input (no handler, role, tab stop or on-state) and is named
  // -switch is a wrapper around a switch, not one: `.apps-card-switch` holds a shared ToggleSwitch
  // and its label (2026-11-22). A clickable span or div still counts, and a -tabs strip counts
  // whatever it is (a hand-built tab bar's container).
  const inertWrapper = (tag === 'span' || tag === 'div') && !role &&
    !/\b(onClick|onKeyDown|onPointerDown|onMouseDown|tabIndex|aria-pressed|aria-checked|aria-selected)\b/.test(attrs);
  for (const w of words) {
    if (/-tabs?(-bar)?(-item|-btn|-button)?$/.test(w)) add('tab', `.${w}`);
    else if (/-(seg|segment|segmented)$/.test(w)) add('segment', `.${w}`);
    else if (/-switch$/.test(w) && !inertWrapper) add('switch', `.${w}`);
    else if (/-chip$/.test(w) && (/\baria-pressed\b/.test(attrs) || /(^|\s)(active|on|selected|is-on|is-active|is-selected)(?=\s|$)/.test(written))) add('chip', `.${w}`);
  }
  // A button that keeps its own on-class beside aria-pressed draws an on state of its own: a second
  // active-state name (the audit found five: .active, .on, .is-on, .is-active, .selected).
  if (/\baria-pressed\b/.test(attrs) && (/(^|\s)(active|on|is-on|is-active|selected|is-selected)(?=\s|$)/.test(written) || /[a-z0-9]--?(on|active|selected)(?=\s|$)/.test(written))) add('pressed', 'aria-pressed with its own on-class');
  if (tag === 'button' && !role && !out.length && !/\baria-(pressed|checked|selected|current)\b/.test(attrs) && ON_CLASS_SWITCHED.test(cls)) add('pick', 'an on-class of its own, no ARIA');
  if (/\baria-expanded\b/.test(attrs)) {
    const fold = [...words].find((w) => /-(toggle|fold|disclosure|chevron|caret|expand|collapse|collapser)$/.test(w));
    if (fold) add('disclose', `.${fold}`);
  }
  return out;
}

/**
 * Every hand-built member in web/src's TSX, outside the components' own home, and in the shipped
 * plugins' (plugin-store, examples/plugins), keyed from web/src as `../../plugin-store/...`: a
 * plugin's page is the console's too and takes the same components through `walnut.ui.views`
 * (2026-11-27 UI audit: the Time page drew its own tabs and three segmented tracks).
 */
export function members(): Member[] {
  const out: Member[] = [];
  for (const file of [...walk(WEB_SRC, ['.tsx']).sort(), ...PLUGIN_SRCS.flatMap((dir) => walk(dir, ['.tsx'])).sort()]) {
    const rel = path.relative(WEB_SRC, file);
    if (isHome(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (at: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };
    for (const t of openingTags(text)) {
      for (const k of kindsOf(t.tag, t.attrs)) out.push({ file: rel, line: lineOf(t.index), kind: k.kind, tag: t.tag, what: k.what });
    }
  }
  return out;
}

const LOOK = /^(background|background-color|border|border-color|border-bottom|border-bottom-color|border-radius|box-shadow)$/;
const CHOICE_CLASS = /\.[A-Za-z0-9_-]+-(tabs?|seg|segment|segmented|switch)(?![\w-])/;

/** Stylesheet rules that draw a choice control of their own, per file. */
export function ownLooks(): Record<string, number> {
  const out: Record<string, number> = {};
  const sheets: [string, string][] = [...walk(WEB_SRC, ['.css']).sort().map((f) => [f, fs.readFileSync(f, 'utf8')] as [string, string]), ...pluginStyles()];
  for (const [file, text] of sheets) {
    const rel = path.relative(WEB_SRC, file);
    if (isHome(rel)) continue;
    const rules = new Map<string, Decl[]>();
    for (const d of scanCss(rel, text)) {
      const key = d.selectors.join(', ');
      rules.set(key, [...(rules.get(key) ?? []), d]);
    }
    for (const [, decls] of rules) {
      const sels = decls[0].selectors;
      const accent = decls.filter((d) => d.prop === 'accent-color').length;
      const own = decls.some((d) => LOOK.test(d.prop)) && sels.some((s) => {
        const last = s.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? '';
        return CHOICE_CLASS.test(last);
      });
      const n = accent + (own ? 1 : 0);
      if (n) out[rel] = (out[rel] ?? 0) + n;
    }
  }
  return out;
}

export type Counts = Record<Kind | 'ownLook', Record<string, number>>;

export function countAll(): Counts {
  const c = Object.fromEntries([...KINDS, 'ownLook'].map((k) => [k, {}])) as Counts;
  for (const m of members()) c[m.kind][m.file] = (c[m.kind][m.file] ?? 0) + 1;
  c.ownLook = ownLooks();
  return c;
}
