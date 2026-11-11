/**
 * The Home list's scroll boxes and WebKit's missing scroll anchoring (2026-11-10).
 *
 * The rows a person reads in an open project moved whenever another client added or removed a
 * task above them: in WebKit, which the Mac app runs and which has no CSS scroll anchoring, by the
 * height of each row. Every box that scrolls the list (the whole column in the stacked views; in
 * the others the list itself, the pinned region, a tier's or Recent's own list) is anchored by hand
 * with `useScrollAnchor` and turns the native anchoring off, so Chromium never corrects one move
 * twice. A new scroll box for the list in any stylesheet fails here until somebody decides how its
 * rows hold.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
const STYLES = path.join(WEB, 'styles');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const navCss = strip(fs.readFileSync(path.join(STYLES, 'home-navigation.css'), 'utf8'));
const panel = fs.readFileSync(path.join(WEB, 'components/tasks/TodoPanel.tsx'), 'utf8');

/** The class names of the Home list's own boxes (TodoPanel and home-navigation.css). */
const HOME_LIST = /home-navigation|todo-panel-list|todo-pinned|todo-tasks-section|todo-group-project|tier-/;

/** Keyed by the rule's selector, as it is written in the stylesheet that makes the box scroll. */
const SCROLL_BOXES: Record<string, { anchored: string }> = {
  '.home-navigation-scroll': { anchored: 'listScrollRef' },
  '.todo-panel-list': { anchored: 'panelListRef' },
  '.todo-pinned-wrapper': { anchored: 'pinnedWrapperRef' },
  '.todo-pinned-list-scroll': { anchored: 'listRef (each tier) and recentListRef (Recent)' },
  // Matched by `tier-` but no Home list: the task menu's "Pin to" choices (b0265a78a), a fixed
  // set of tier buttons that no live update adds rows to, so nothing lands above what is read.
  '.task-kebab-pin-choices .task-kebab-tier-options': { anchored: 'none: a menu of tier buttons, no live rows' },
};

/** The declarations of every rule whose selector list names `selector` exactly. */
function rulesFor(css: string, selector: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(match[2]!);
  }
  return out;
}

/** The ref a JSX `<div>` with a class list matching `className` is given in TodoPanel. */
function refOf(className: RegExp): string | null {
  for (const match of panel.matchAll(/<div\s+ref=\{(\w+)\}\s+className=(\{`([^`]*)`\}|"([^"]*)")/g)) {
    if (className.test(match[3] ?? match[4] ?? '')) return match[1]!;
  }
  return null;
}

/** Whether a rule's declarations let it scroll vertically: `overflow-y`, or `overflow`'s one value or its second. */
function scrollsVertically(body: string): boolean {
  for (const decl of body.matchAll(/(?:^|[;{\s])overflow(-y)?\s*:\s*([^;]+)/g)) {
    const values = decl[2]!.trim().split(/\s+/);
    const y = decl[1] ? values[0] : values[values.length - 1];
    if (y === 'auto' || y === 'scroll') return true;
  }
  return false;
}

describe('the Home list is anchored by hand in every box that scrolls it', () => {
  it('turns the native anchoring off on each', () => {
    for (const box of ['.home-navigation-scroll', '.home-navigation-scroll .todo-panel-list',
      '.home-navigation-scroll .todo-pinned-wrapper', '.home-navigation-scroll .todo-pinned-list-scroll']) {
      expect(rulesFor(navCss, box).some((body) => /overflow-anchor\s*:\s*none/.test(body)), box).toBe(true);
    }
  });

  it('holds the rows of each with useScrollAnchor', () => {
    expect(refOf(/^home-navigation-scroll\b/)).toBe('setListScrollEl');
    expect(panel).toMatch(/const setListScrollEl = useCallback\(\(el: HTMLDivElement \| null\) => \{\s*listScrollRef\.current = el;/);
    expect(refOf(/^todo-panel-list$/)).toBe('panelListRef');
    expect(refOf(/^todo-pinned-wrapper\b/)).toBe('pinnedWrapperRef');
    expect(refOf(/^todo-pinned-list-scroll$/)).toBe('listRef');
    expect(refOf(/\btodo-pinned-list-recent\b/)).toBe('recentListRef');
    for (const ref of ['listScrollRef', 'panelListRef', 'pinnedWrapperRef', 'recentListRef']) {
      expect(panel, ref).toContain(`useScrollAnchor(${ref}, HOME_LIST_ROWS, dragging)`);
    }
    // Each tier's list, paused by the same drag.
    expect(panel).toContain('useScrollAnchor(listRef, HOME_LIST_ROWS, !!anchorPaused)');
    expect(panel).toContain('anchorPaused={dragging}');
  });

  it('leaves a fold to the fold keeper, and takes the box back after it', () => {
    const fold = fs.readFileSync(path.join(WEB, 'hooks/useFoldAnchor.ts'), 'utf8');
    const hook = fs.readFileSync(path.join(WEB, 'hooks/useScrollAnchor.ts'), 'utf8');
    // The fold keeper marks the box for its hold and gives it back when it lets go.
    expect(fold).toMatch(/scroller\.setAttribute\(SCROLL_HELD_ATTR, ''\)/);
    expect(fold).toMatch(/removeAttribute\(SCROLL_HELD_ATTR\)[\s\S]{0,120}dispatchEvent\(new Event\(SCROLL_RELEASED_EVENT\)\)/);
    // The live-update keeper neither holds nor corrects a marked box, and picks again on release.
    expect(hook).toMatch(/box\.hasAttribute\(SCROLL_HELD_ATTR\)/);
    expect(hook).toMatch(/addEventListener\(SCROLL_RELEASED_EVENT, onScroll\)/);
  });

  it('lets go of a row that moved in the list instead of scrolling after it', () => {
    const hook = fs.readFileSync(path.join(WEB, 'hooks/useScrollAnchor.ts'), 'utf8');
    expect(hook).toMatch(/held\.el\.getClientRects\(\)\.length > 0 && stillInOrder\(held\)/);
  });

  it('holds task rows, never a sticky heading', () => {
    const rows = panel.match(/const HOME_LIST_ROWS = '([^']+)'/)?.[1] ?? '';
    expect(rows).toContain('.todo-panel-item[data-task-id]');
    expect(rows).not.toMatch(/header|heading/);
  });

  it('has a verdict for every scroll box of the list in every stylesheet', () => {
    const found = new Set<string>();
    for (const file of fs.readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
      const css = strip(fs.readFileSync(path.join(STYLES, file), 'utf8'));
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1]!.trim().replace(/\s+/g, ' ');
        if (HOME_LIST.test(selector) && scrollsVertically(match[2]!)) found.add(selector);
      }
    }
    // Anchored above. Any other box: anchor it the same way, or give it a verdict here saying why
    // nothing lands above the rows a person reads in it.
    expect([...found].sort()).toEqual(Object.keys(SCROLL_BOXES).sort());
  });
});
