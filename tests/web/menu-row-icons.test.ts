/**
 * A menu row is one drawn icon and one line of words, never a typed character in the icon slot.
 *
 * 2026-11-23, the user on the composer + menu (its @, / and three dots drawn as outlined key caps, the
 * other rows plain icons): one icon and one text on every row, no box. The same class held twenty
 * rows across ten files: a check box, a circle, arrows and a fork sign in the task menu, plus,
 * minus, a square and a return arrow in Team, quote marks, #, an arrow, a star, a dot, a circle
 * arrow, a cross, a pencil and a bin elsewhere, and the + menu's @, / and up arrow (that one
 * written as an escape, so the scan reads escapes too).
 *
 * Found from the source, so a new menu row with a typed glyph fails here:
 *   1. every icon slot of a menu row (a class like task-kebab-icon, chat-plus-menu-key,
 *      wn-context-menu-icon: "kebab" or "menu" in it, ending -icon or -key) holds a drawn icon:
 *      JSX (an <svg>, a component) or an expression, never bare text or a string literal;
 *   2. no component is handed an icon as a string (icon="x", icon={'x'}), and a list's row
 *      helper is not called with one (row('x', ...));
 *   3. a ContextMenu item builder gives no item a string icon.
 * The rows drawn from data (icon={x.icon}) are checked as drawn by
 * tests/e2e/browser/big-menu-shape.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}
const files = walk(WEB_SRC).map((f) => ({ rel: path.relative(WEB_SRC, f), src: fs.readFileSync(f, 'utf8') }));
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

/** A JSX child that is text, or an expression that is only a string literal. */
const isTyped = (content: string) => {
  const c = content.trim();
  if (!c) return false;
  if (c.startsWith('<')) return false;
  const expr = /^\{\s*([\s\S]*?)\s*\}$/.exec(c);
  if (!expr) return true;
  // A string literal alone, or a typed mark anywhere in it (cond ? '\u2606' : '\u2605').
  return /^(['"`])[\s\S]*\1$/.test(expr[1]) || /(['"`])(?:[^\w\s'"`]|\\u[0-9a-fA-F]{4}){1,3}\1/.test(expr[1]);
};

describe('menu rows: one drawn icon and one line of words', () => {
  it('every menu row icon slot holds a drawn icon, never a typed character', () => {
    // The icon slot, and a row's caret (a typed \u25BE where the shared MenuCaret goes).
    // A header button's icon slot too: put away, it becomes a row of the header's More menu.
    const SLOT = /className=["'`][^"'`]*?\b([\w-]*(?:kebab|menu)[\w-]*-(?:icon|key|caret)|header-fit-icon|tp-chip-icon)\b[^"'`]*["'`][^>]*>([\s\S]*?)<\/span>/g;
    const typed: string[] = [];
    let slots = 0;
    for (const { rel, src } of files) {
      if (!rel.endsWith('.tsx')) continue;
      for (const m of src.matchAll(SLOT)) {
        slots++;
        if (isTyped(m[2])) typed.push(`${rel}:${lineOf(src, m.index!)} ${m[1]}: ${m[2].trim()}`);
      }
    }
    expect(slots, 'the scan finds the menus it guards').toBeGreaterThan(40);
    expect(typed, 'A menu row shows a drawn icon (web/src/components/common/Icons.tsx, "Menu row icons"), not a typed character').toEqual([]);
  });

  // Not a menu row: a notice banner's own mark (PanelNotice), outside this rule.
  const NOT_MENU_ROWS: Record<string, string> = {
    'components/sessions/SessionHostErrorBar.tsx': 'PanelNotice banner mark, not a menu row',
  };

  it('no icon is handed over as a string', () => {
    const PROP = /(?<![\w-])icon=(?:"[^"]*"|'[^']*'|\{\s*(['"`])[^}]*?\1\s*\})/g;
    const ROW = /\brow\(\s*(['"`])[^'"`]{1,4}\1\s*,/g;
    const found: string[] = [];
    for (const { rel, src } of files) {
      if (!rel.endsWith('.tsx') || rel in NOT_MENU_ROWS) continue;
      for (const m of src.matchAll(PROP)) found.push(`${rel}:${lineOf(src, m.index!)} ${m[0]}`);
      for (const m of src.matchAll(ROW)) found.push(`${rel}:${lineOf(src, m.index!)} ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  it('a ContextMenu item builder gives no item a string icon', () => {
    const found: string[] = [];
    for (const { rel, src } of files) {
      if (!/\bContextMenuItem\b/.test(src)) continue;
      for (const m of src.matchAll(/\bicon:\s*(['"`])[^'"`]*\1/g)) found.push(`${rel}:${lineOf(src, m.index!)} ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  // 2026-11-26: the phone's session rows, a narrow header's "..." rows, the sync rows and the board
  // card menu drew their words with no icon at all, beside rows that had one. Every action row of a
  // menu (a task-kebab-item, chat-plus-menu-item or task-pin-opt element) holds a drawn icon; the Pin
  // flyout's Customize and Done rows once stood bare under tier rows that drew one. Not action rows: an
  // info line, a pick list's option (its check mark is its sign), a row led by its switch, a group.
  const NOT_ACTION_ROW = /\btask-kebab-info\b|\bwn-pick-row\b|role="(?:option|menuitemradio|group)"|<ToggleSwitch\b/;
  const DRAWS_ICON = /task-kebab-icon|chat-plus-menu-key|wn-context-menu-icon|<svg\b|<Icon\b|\bICON_\w+|\b[A-Z][A-Z_]*_ICON\b|\w+Icon\b|\.icon\b|data-fit-icon/;

  it('every menu action row draws an icon', () => {
    const ROW = /<(button|a|div|label|Link)\b[^>]*?className=\{?["'`][^"'`]*\b(?:task-kebab-item|chat-plus-menu-item)\b[^"'`]*["'`]/g;
    const iconless: string[] = [];
    let rows = 0;
    for (const { rel, src } of files) {
      if (!rel.endsWith('.tsx')) continue;
      for (const m of src.matchAll(ROW)) {
        const close = src.indexOf(`</${m[1]}>`, m.index!);
        const el = src.slice(m.index!, close > 0 ? close : m.index! + 800);
        rows++;
        if (NOT_ACTION_ROW.test(el) || DRAWS_ICON.test(el)) continue;
        iconless.push(`${rel}:${lineOf(src, m.index!)}`);
      }
    }
    expect(rows, 'the scan finds the menu rows it guards').toBeGreaterThan(40);
    expect(iconless, 'A menu row draws one icon and its words (standard.md, Big menus)').toEqual([]);
  });

  it('a menu row that stands in for a header button shows that button\'s icon', () => {
    // HeaderFitMore (a header's put-away buttons) and SessionHeaderMore (a narrow session header's
    // chips) copy the real button's icon into their rows.
    const fit = files.find((f) => f.rel === 'components/common/HeaderFit.tsx')!.src;
    expect(fit).toMatch(/icon:\s*<MirroredIcon from=\{it\.el\}/);
    const more = files.find((f) => f.rel === 'components/sessions/SessionHeaderMore.tsx')!.src;
    expect(more.match(/<MirroredIcon\b[^>]*\bfallback=/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // A narrow session header's chips draw only their words, so copying finds nothing: every chip
    // and window item names its own icon (2026-11-26: Terminal and Board drew an empty slot).
    const fitSrc = files.find((f) => f.rel === 'components/sessions/useSessionHeaderFit.ts')!.src;
    const items = [...fitSrc.matchAll(/^\s*(\w+): \{ kind: '(chip|window)'/gm)].map((m) => m[1]);
    expect(items.length, 'the scan finds the header items').toBeGreaterThanOrEqual(8);
    const map = /const HEADER_ITEM_ICONS[^=]*=\s*\{([\s\S]*?)\};/.exec(more)?.[1] ?? '';
    const named = new Set([...map.matchAll(/(\w+):/g)].map((m) => m[1]));
    expect(items.filter((id) => !named.has(id)), 'header items without an icon in the "..." menu (HEADER_ITEM_ICONS)').toEqual([]);
    // So every button a header can put away draws one: FitButton takes an icon, and a hand-made
    // one (data-fit-button) holds its own.
    const bare: string[] = [];
    for (const { rel, src } of files) {
      if (!rel.endsWith('.tsx') || rel === 'components/common/HeaderFit.tsx') continue;
      for (const m of src.matchAll(/data-fit-button[=:]/g)) {
        const near = src.slice(Math.max(0, m.index! - 600), m.index! + 600);
        if (!/data-fit-keep/.test(src.slice(m.index!, m.index! + 200)) && !DRAWS_ICON.test(near)) bare.push(`${rel}:${lineOf(src, m.index!)}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('the check catches what it guards', () => {
    expect(isTyped('@')).toBe(true);
    expect(isTyped("{'\\u2191'}")).toBe(true);
    expect(isTyped('{ICON_AT}')).toBe(false);
    expect(isTyped('<svg width="14" />')).toBe(false);
    expect(isTyped('{x.icon}')).toBe(false);
    expect(isTyped("{on ? '\u2606' : '\u2605'}")).toBe(true);
    expect(isTyped("{on ? ICON_STAR_EMPTY : ICON_STAR_FILLED}")).toBe(false);
  });
});
