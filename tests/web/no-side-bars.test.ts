/**
 * No card, row or box in the web app carries a thick COLOURED bar down one side (2026-11-20, the
 * user, translated: "that highlight where only one side is bright, one side dark, like a label,
 * is ugly; it isn't needed"). An element keeps the same hairline on all four sides (or none), and
 * what the colour meant (unread, an error, needs you, selected, a calendar's colour) is a small
 * status dot before its title (`wn-dot` in a `data-tone` parent, web/src/styles/notice-card.css),
 * a background tint, or the colour of its text.
 *
 * This fails on a NEW one-sided coloured bar of 2px or more in web/src or plugin-store:
 *  - `border-left|right|inline-start|inline-end` (shorthand, `-color`, `-width`) in a colour that
 *    is not neutral (transparent, var(--border|--border-strong|--border-subtle), a grey literal,
 *    currentColor in a blockquote);
 *  - a `box-shadow: inset Npx 0 0 <colour>` strip;
 *  - a ::before/::after strip 2 to 5px wide running the element's height with a coloured fill;
 *  - the same in TSX inline styles (`borderLeft: '3px solid ...'`, `boxShadow: 'inset 3px 0 0 ...'`)
 *    and in CSS written inside TS strings.
 * Neutral structural lines (quotes, thread and tree guides, a splitter's grip) stay, and those the
 * colour rule cannot tell apart are listed in ALLOWED with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listed = (globs: string[]) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...globs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));

/** Selector (a whole comma part, or its last class) -> why its side line is not a coloured label. */
const ALLOWED: Record<string, string> = {
  '.session-msg--threaded[data-thread-current="true"]': 'the thread guide of a question\'s turn, a grey rule one step darker on the current turn',
  '.task-grouped::before': 'the folder rail: a faint tree guide joining the tasks of one folder',
  '.todo-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.session-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.memory-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.notes-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.session-col-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.cal-side-resize-handle::after': 'a splitter grip, shown only while hovered or dragged',
  '.session-panel-chat-resize::after': 'a splitter grip, shown only while hovered or dragged',
  '.side-bar-pane-resize::after': 'a splitter grip, shown only while hovered or dragged',
  '.mail-pane-splitter::after': 'a splitter grip, shown only while hovered or dragged',
  '.sheet-width-edge::after': 'the drag grip on a full-screen sheet\'s side, shown only while hovered or dragged',
  '.session-browser-replay-tick::before': 'a tick mark on the replay timeline, not an edge of a box',
  '.session-browser-replay-tick.is-on::before': 'a tick mark on the replay timeline, not an edge of a box',
};

interface Rule { file: string; line: number; selector: string; body: string }

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function rulesOf(file: string, text: string): Rule[] {
  const src = stripComments(text);
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + (m[1]!.length - m[1]!.trimStart().length);
    out.push({ file, line: src.slice(0, start).split('\n').length, selector: m[1]!.trim().replace(/\s+/g, ' '), body: m[2]! });
  }
  return out;
}

const NEUTRAL_VARS = /^var\(\s*--(border|border-strong|border-subtle)\s*(,[^]*)?\)$/;
const NEUTRAL_WORDS = /^(transparent|none|inherit|initial|unset|white|black|gr[ae]y|silver)$/i;

/** Grey literals: #rgb/#rrggbb/rgb()/rgba()/hsl() with no real hue. */
function isGreyLiteral(c: string): boolean {
  let rgb: number[] | null = null;
  const hex = c.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const h = hex.length <= 4 ? [...hex.slice(0, 3)].map((x) => x + x) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    rgb = h.map((x) => parseInt(x, 16));
  }
  const fn = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (fn) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  if (rgb) return Math.max(...rgb) - Math.min(...rgb) <= 12;
  const hsl = c.match(/^hsla?\(\s*[\d.]+(deg)?[\s,]+([\d.]+)%/i);
  return !!hsl && Number(hsl[2]) <= 8;
}

function isNeutral(colour: string, selector: string): boolean {
  const c = colour.replace(/!important/, '').trim();
  if (!c) return true;
  if (NEUTRAL_WORDS.test(c) || NEUTRAL_VARS.test(c) || isGreyLiteral(c)) return true;
  if (/^currentcolor$/i.test(c)) return /blockquote/i.test(selector);
  return false;
}

/** The colour part of a border shorthand (`3px solid var(--accent)` -> `var(--accent)`). */
const colourOf = (value: string) =>
  value.replace(/!important/, '').replace(/(^|\s)-?\d*\.?\d+(px|em|rem)?(?=\s|$)/g, ' ')
    .replace(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset|thin|medium|thick)\b/g, ' ').trim();

const widthOf = (value: string) => {
  const w = value.match(/(^|\s)(\d*\.?\d+)px\b/);
  if (w) return Number(w[2]);
  if (/\b(medium|thick)\b/.test(value)) return 3;
  return 0;
};

const decls = (body: string) =>
  body.split(';').map((d) => d.match(/^\s*([\w-]+)\s*:\s*([^]*?)\s*$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ prop: m[1]!.toLowerCase(), value: m[2]! }));

const SIDE = /^border-(left|right|inline-start|inline-end)(-color|-width)?$/;

/** A rule that also draws the top or bottom edge is a chevron, a check or a frame, not a side bar. */
const drawsOtherEdge = (body: string) =>
  decls(body).some((d) => /^border-(top|bottom)(-width)?$/.test(d.prop) && widthOf(d.value) > 0);

/** The one-sided coloured bars a rule paints, as short descriptions. */
function barsOf(rule: Rule): string[] {
  const out: string[] = [];
  const ds = decls(rule.body);
  const other = drawsOtherEdge(rule.body);
  for (const { prop, value } of ds) {
    const side = prop.match(SIDE);
    if (side && !other) {
      if (!side[2]) {
        if (widthOf(value) >= 2 && !isNeutral(colourOf(value), rule.selector)) out.push(`${prop}: ${value}`);
      } else if (side[2] === '-color') {
        if (!isNeutral(value, rule.selector)) out.push(`${prop}: ${value}`);
      } else if (widthOf(value) >= 2) {
        // A width alone: coloured unless the same rule names a neutral colour for it.
        const colour = ds.find((d) => d.prop === `border-${side[1]}-color` || d.prop === 'border-color')?.value;
        if (!colour || !isNeutral(colour, rule.selector)) out.push(`${prop}: ${value}`);
      }
    }
    if (prop === 'box-shadow') {
      for (const part of value.split(/,(?![^()]*\))/)) {
        const m = part.trim().match(/^inset\s+(-?\d*\.?\d+)px\s+0(px)?\s+0(px)?(\s+0(px)?)?\s+(.+)$/);
        if (m && Math.abs(Number(m[1])) >= 2 && !isNeutral(m[6]!, rule.selector)) out.push(`box-shadow: ${part.trim()}`);
      }
    }
  }
  if (/::?(before|after)\b/.test(rule.selector)) {
    const width = ds.find((d) => d.prop === 'width');
    const w = width ? widthOf(width.value) : 0;
    const tall = (ds.some((d) => d.prop === 'top') && ds.some((d) => d.prop === 'bottom'))
      || ds.some((d) => d.prop === 'height' && /100%/.test(d.value)) || ds.some((d) => d.prop === 'inset');
    const fill = ds.find((d) => d.prop === 'background' || d.prop === 'background-color')?.value;
    if (w >= 2 && w <= 5 && tall && fill && !isNeutral(fill, rule.selector)) out.push(`${rule.selector} strip: ${fill}`);
  }
  return out;
}

const subject = (part: string) => part.match(/\.[\w-]+(?:\.[\w-]+)*(?:\[[^\]]*\])*(?:::?[\w-]+)?$/)?.[0] ?? part;
const lastClass = (part: string) => {
  const pseudo = part.match(/::?(before|after)$/)?.[0] ?? '';
  return (part.match(/\.[\w-]+/g)?.at(-1) ?? part) + pseudo;
};
const allowed = (selector: string) =>
  selector.split(',').map((p) => p.trim()).every((p) => p in ALLOWED || subject(p) in ALLOWED || lastClass(p) in ALLOWED);

const violations = (rules: Rule[]) =>
  rules.flatMap((r) => (allowed(r.selector) ? [] : barsOf(r).map((b) => `${r.file}:${r.line} ${r.selector} { ${b} }`)));

/** Inline styles in TS/TSX: a side border or an inset strip written as a style object. */
function inlineViolations(file: string, text: string): string[] {
  const out: string[] = [];
  // A template's `${...}` (its quotes would end the match early) reads as some colour.
  const src = text.replace(/\$\{[^{}]*\}/g, (m) => `var(--x)${m.replace(/[^\n]/g, '')}`);
  const at = (i: number) => `${file}:${src.slice(0, i).split('\n').length}`;
  const side = /\bborder(Left|Right|InlineStart|InlineEnd)\s*:\s*(['"`])([^'"`]*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = side.exec(src))) {
    const v = m[3]!;
    if (widthOf(v) >= 2 && !isNeutral(colourOf(v), '')) out.push(`${at(m.index)} ${m[0]}`);
  }
  const sideColour = /\bborder(Left|Right|InlineStart|InlineEnd)Color\s*:\s*(['"`])([^'"`]*)\2/g;
  while ((m = sideColour.exec(src))) {
    // CodeMirror's caret is drawn as a 1px left border in the text colour.
    if (!isNeutral(m[3]!, '') && !/var\(--fg\)/.test(m[3]!)) out.push(`${at(m.index)} ${m[0]}`);
  }
  const strip = /\bboxShadow\s*:\s*(['"`])inset\s+(-?\d*\.?\d+)px\s+0(px)?\s+0[^'"`]*\1/g;
  while ((m = strip.exec(src))) if (Math.abs(Number(m[2])) >= 2) out.push(`${at(m.index)} ${m[0]}`);
  return out;
}

// CSS written inside a TS string (plugin styles, the mail reader's frame). Read as CSS, a file's
// code yields only camelCase props (never a border-left declaration); `${...}` reads as a colour.
const cssInTs = (src: string) => src.replace(/\$\{[^{}]*\}/g, 'var(--x)');

const CSS = listed(['web/src/**/*.css', 'plugin-store/**/*.css']);
const TS = listed([':(glob)web/src/**/*.ts', ':(glob)web/src/**/*.tsx', ':(glob)plugin-store/**/*.ts', ':(glob)plugin-store/**/*.tsx'])
  .filter((f) => !f.includes('/node_modules/') && !f.includes('/dist/'));

describe('no coloured bar down one side of a card or row', () => {
  it('no CSS rule paints a one-sided coloured bar', () => {
    expect(CSS).toContain('web/src/styles/globals.css');
    const rules = CSS.flatMap((f) => rulesOf(f, read(f)));
    const bad = violations(rules);
    expect(bad, 'Keep the same hairline on all four sides; move the meaning to a wn-dot before the title, a tint or the text colour, or list a neutral structural line in ALLOWED with why').toEqual([]);
    // An ALLOWED entry whose rule is gone is dropped, so it cannot excuse a new bar later.
    const parts = rules.flatMap((r) => r.selector.split(',').map((p) => p.trim()));
    const stale = Object.keys(ALLOWED).filter((k) => !parts.some((p) => p === k || subject(p) === k || lastClass(p) === k));
    expect(stale, 'Remove these ALLOWED entries: no rule has them any more').toEqual([]);
  }, 60_000);

  it('no inline style or CSS in a TS string paints one', () => {
    expect(TS).toContain('web/src/App.tsx');
    const bad = TS.flatMap((f) => {
      const src = read(f);
      return [...inlineViolations(f, src), ...violations(rulesOf(f, cssInTs(src)))];
    });
    expect(bad, 'Use a wn-dot with an inline background colour instead of a coloured side border').toEqual([]);
  }, 60_000);

  it('the checks catch a new side bar and pass neutral lines', () => {
    const rule = (selector: string, body: string): Rule => ({ file: 'x.css', line: 1, selector, body });
    expect(violations([rule('.x', 'border-left: 3px solid var(--accent)')])).toHaveLength(1);
    expect(violations([rule('.x', 'box-shadow: inset 3px 0 0 var(--warning)')])).toHaveLength(1);
    expect(violations([rule('.x', 'box-shadow: 0 1px 2px rgba(0,0,0,.2), inset -2px 0 0 color-mix(in srgb, var(--accent) 40%, transparent)')])).toHaveLength(1);
    expect(violations([rule('.x.on', 'border-left-color: var(--error)')])).toHaveLength(1);
    expect(violations([rule('.x.on', 'border-left-width: 3px')])).toHaveLength(1);
    expect(violations([rule('.x::before', 'content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--accent)')])).toHaveLength(1);
    expect(violations([rule('.quote', 'border-left: 2px solid var(--border)')])).toHaveLength(0);
    expect(violations([rule('.quote', 'border-left: 2px solid var(--border-strong, #3a3d44)')])).toHaveLength(0);
    expect(violations([rule('.md blockquote', 'border-left: 3px solid currentColor')])).toHaveLength(0);
    expect(violations([rule('.x', 'border-left: 2px solid rgba(128, 128, 128, 0.3)')])).toHaveLength(0);
    expect(violations([rule('.x', 'border-left: 1px solid var(--accent)')])).toHaveLength(0);
    expect(violations([rule('.x', 'box-shadow: inset 0 0 0 1.5px var(--accent)')])).toHaveLength(0);
    // A chevron drawn with two borders is not a side bar.
    expect(violations([rule('.x::after', 'border-top: 2px solid var(--accent); border-right: 2px solid var(--accent)')])).toHaveLength(0);
    expect(inlineViolations('x.tsx', "style={{ borderLeft: `3px solid ${color}` }}")).toHaveLength(1);
    expect(inlineViolations('x.tsx', "style={{ boxShadow: 'inset 3px 0 0 var(--accent)' }}")).toHaveLength(1);
    expect(inlineViolations('x.tsx', "style={{ borderLeft: '2px solid rgba(128,128,128,0.3)' }}")).toHaveLength(0);
  });
});
