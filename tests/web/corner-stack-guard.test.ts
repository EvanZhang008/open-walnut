/**
 * Every notice Walnut pops up by itself shows in ONE place: the notice stack at the top of the
 * window, centered, one fixed width (web/src/components/common/corner-stack.tsx). 2026-11-04, the
 * user: "can we be consistent all notificaiton is bottom left" made it one stack; 2026-11-16,
 * the user: "the notificaiton pill will adopt the width based on other pannel on the right, I
 * think not need, just show like noticiaton overlap on the top nice unified, just like IOS
 * noticficaiton pelase" moved it to the top and took away every width that followed a panel.
 *
 * This fails when a NEW notice places itself instead of going through <CornerSlot>:
 *  - any CSS rule in web/src or plugin-store that pins an element to a corner of the window (position: fixed
 *    with both a top/bottom and a left/right offset) and is not listed below with why;
 *  - any CSS rule for a toast, toaster, snackbar, notice, undo bar or approval stack that
 *    positions itself (fixed or absolute) and is not listed below with why;
 *  - inline styles in web/src TS/TSX that pin `position: fixed` with a literal corner offset;
 * and when one of the known notices stops rendering through the stack.
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

/** Fixed to a window corner, and why that is not a notice (or is the stack itself). */
const CORNER_ALLOWED: Record<string, string> = {
  '.corner-stack': 'the stack itself',
  '.notification-panel': 'the notification center: a full-height panel the person opens beside the sidebar',
  '.sidebar-toggle': 'a control of the layout, not a notice',
  '.open-walnut-fullscreen': 'a full-screen sheet the person opens',
  '.sidebar': 'the phone drawer',
  '.model-picker-popout': 'a picker the person opens, placed by its trigger',
  '.session-search-panel': 'a search panel the person opens',
  '.ask-walnut-drawer-layer': 'the phone chat drawer, a full-screen layer',
  '.phone-topbar': 'the phone top bar',
  '.main-page-chat:not(.collapsed)': 'the phone chat sheet',
  '.phone-search-layer': 'the phone search layer',
  '.phone-plan-layer': 'the phone plan layer',
  '.task-board-dock': 'the phone board dock inside a session layer',
  '[data-peek-expanded][popover]': 'a hovered row widened in the top layer at its own measured place in the list, not a notice',
  '.stale-build-pill': 'the update notice: docked in the sidebar bottom row (or the pop-out dock) on desktop, floats only on the phone, which has no dock',
};

/** Toast-like names that position themselves, and why they stay where they are. */
const NAMED_ALLOWED: Record<string, string> = {
  '.thread-toast': 'a one-line answer to an action inside a session panel, drawn above that panel composer',
  '.session-servers-notice': 'a one-line answer to a Stop inside a session Web view, drawn over the bottom of that view',
  '.unpaired-notice': 'the full-screen sign-in page (inset: 0), not a corner notice',
  '.sfe-reveal-error': 'a line inside the file explorer about the reveal the person just asked for',
  '.notification-toast-swipe': 'the swipe wrapper inside a toast',
  '.notification-toast-timer': 'the time-left bar along the bottom edge inside an Undo toast',
};

const NOTICE_NAME = /(toast|toaster|snackbar|notice|undo-bar|approval-stack|reminder|alert-card)/i;

interface Rule { file: string; line: number; selector: string; body: string }

function cssRules(file: string): Rule[] {
  const src = read(file).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ file, line: src.slice(0, m.index).split('\n').length, selector: m[1]!.trim().replace(/\s+/g, ' '), body: m[2]! });
  }
  return out;
}

const has = (body: string, prop: string) => new RegExp(`(^|[;\\s])${prop}\\s*:\\s*(?!auto\\b)[^\\s;][^;]*`).test(body);

/** The last class in each comma part of a selector (`html body .a .b` -> `.b`). */
const subjects = (selector: string) =>
  selector.split(',').map((part) => part.match(/\.[\w-]+(:not\([^)]*\))?/g)?.at(-1) ?? part.trim());

const allowed = (selector: string, table: Record<string, string>) => subjects(selector).every((s) => s in table);

/** Rules pinned to a window corner that are not listed. */
const pinnedToCorner = (body: string) => {
  // `inset: 0` fills the window (a layer); an `inset` with an `auto` side pins a corner.
  const inset = body.match(/(^|[;\s])inset\s*:\s*([^;]+)/)?.[2];
  if (inset) return /\bauto\b/.test(inset);
  const v = has(body, 'top') || has(body, 'bottom') || has(body, 'inset-block-start') || has(body, 'inset-block-end');
  const h = has(body, 'left') || has(body, 'right') || has(body, 'inset-inline-start') || has(body, 'inset-inline-end');
  return v && h;
};

const cornerViolations = (rules: Rule[]) => rules.filter((r) =>
  /position\s*:\s*fixed/.test(r.body) && pinnedToCorner(r.body) && !allowed(r.selector, CORNER_ALLOWED));

/** Toast-like rules that position themselves and are not listed. */
const namedViolations = (rules: Rule[]) => rules.filter((r) =>
  /position\s*:\s*(fixed|absolute)/.test(r.body)
  // A ::before/::after inside a notice is part of its drawing, not where the notice goes.
  && !/::?(before|after)\b/.test(r.selector)
  && subjects(r.selector).some((s) => NOTICE_NAME.test(s))
  && !allowed(r.selector, { ...NAMED_ALLOWED, ...CORNER_ALLOWED }));

// The web app and the plugins this repository ships (a plugin's notice goes through
// walnut.notifications into the same corner, never a box of its own).
const CSS = listed(['web/src/**/*.css', 'plugin-store/**/*.css']);

describe('one corner for every notice', () => {
  it('no CSS rule pins something else to a corner of the window', () => {
    const bad = cornerViolations(CSS.flatMap(cssRules)).map((r) => `${r.file}:${r.line} ${r.selector}`);
    expect(bad, 'Put the notice in <CornerSlot> (common/corner-stack.tsx), or list it here with why it is not a notice').toEqual([]);
  });

  it('no toast, notice or approval rule positions itself', () => {
    const bad = namedViolations(CSS.flatMap(cssRules)).map((r) => `${r.file}:${r.line} ${r.selector}`);
    expect(bad, 'A notice goes through <CornerSlot>; it never places itself').toEqual([]);
  });

  it('the checks catch a new notice that places itself', () => {
    const rule = (selector: string, body: string): Rule => ({ file: 'x.css', line: 1, selector, body });
    expect(cornerViolations([rule('.new-banner', 'position: fixed; right: 16px; bottom: 16px;')])).toHaveLength(1);
    expect(cornerViolations([rule('.menu', 'position: fixed; top: auto; left: auto;')])).toHaveLength(0);
    expect(namedViolations([rule('.board .save-toast', 'position: absolute; right: 8px; bottom: 8px;')])).toHaveLength(1);
    expect(namedViolations([rule('.save-toast-close', 'position: relative;')])).toHaveLength(0);
    expect(cornerViolations([rule('html body .corner-stack', 'position: fixed; top: 8px; left: 8px;')])).toHaveLength(0);
    expect(cornerViolations([rule('.new-card', 'position: fixed; inset: auto 16px 16px auto;')])).toHaveLength(1);
    expect(cornerViolations([rule('.new-card', 'position: fixed; inset-block-end: 16px; inset-inline-end: 16px;')])).toHaveLength(1);
    expect(cornerViolations([rule('.layer', 'position: fixed; inset: 0;')])).toHaveLength(0);
    expect(namedViolations([rule('.focus-reminder', 'position: fixed; bottom: 12px;')])).toHaveLength(1);
  });

  it('no inline style pins position: fixed to a literal corner', () => {
    // `:(glob)` so `**/` also matches no directory at all (web/src/App.tsx, main.tsx).
    const files = listed([':(glob)web/src/**/*.ts', ':(glob)web/src/**/*.tsx', ':(glob)plugin-store/**/*.ts', ':(glob)plugin-store/**/*.tsx']);
    expect(files).toContain('web/src/App.tsx');
    const bad: string[] = [];
    for (const f of files) {
      const src = read(f);
      const cssText = /position:\s*fixed;[^'"`]*\b(top|bottom|left|right):\s*[1-9]/g;
      const object = /position:\s*['"]fixed['"][^}]{0,200}\b(top|bottom|left|right):\s*['"]?[1-9]/g;
      // The same object with its offset written first ({ bottom: 16, position: 'fixed' }).
      const offsetFirst = /\b(top|bottom|left|right):\s*['"]?[1-9][^{};]{0,200}position:\s*['"]fixed['"]/g;
      // Assigned one property at a time (el.style.position = 'fixed'; el.style.bottom = '16px').
      const assigned = /\.style\.position\s*=\s*['"]fixed['"][\s\S]{0,300}?\.style\.(top|bottom|left|right)\s*=\s*['"`][1-9]/g;
      for (const re of [cssText, object, offsetFirst, assigned]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) bad.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad, 'Use appendToCornerStack / <CornerSlot> for a notice; menus take their place from useMenuPlacement').toEqual([]);
  });

  it('the known notices render through the stack', () => {
    for (const f of [
      'web/src/components/common/NotificationToaster.tsx',
      'web/src/components/approvals/ApprovalPrompts.tsx',
      'web/src/components/board/kanban/KanbanToasts.tsx',
      // Why an Ask here opened no card, in Files and in Changed.
      'web/src/components/common/FileAskNotice.tsx',
      // A host's first connect running in the background.
      'web/src/components/hosts/HostConnectCard.tsx',
    ]) expect(read(f), f).toMatch(/<CornerSlot order=\{CORNER_ORDER\.\w+\}[ >]/);
    expect(read('web/src/popout/openPopout.ts')).toMatch(/appendToCornerStack\(el, CORNER_ORDER\.flash\)/);
  });

  it('approvals sit nearest the top edge: a script waits on them', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    const order = (k: string) => Number(src.match(new RegExp(`\\b${k}: (\\d+)`))?.[1]);
    expect(order('approvals')).toBeGreaterThan(Math.max(order('toasts'), order('board'), order('flash'), order('hostConnect')));
    // The background connect card stays for minutes: nearer the edge than the passing toasts, so they never move it.
    expect(order('hostConnect')).toBeGreaterThan(Math.max(order('toasts'), order('board'), order('flash')));
    // A higher order nearer the top: the stack lays its slots out bottom to top.
    const stack = cssRules('web/src/styles/corner-stack.css').find((r) => r.selector === '.corner-stack')!;
    expect(stack.body).toMatch(/flex-direction:\s*column-reverse/);
  });

  it('only crowding takes the short forms; only the open notification center hides the stack', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    expect(src).toMatch(/const crowded = kinds >= 3 \|\| \(kinds >= 2 && window\.innerHeight < SHORT_WINDOW_PX\);/);
    expect(src).toMatch(/const compact = !phone && crowded;/);
    expect(src).not.toMatch(/coversWork|workCovered/);
    // Never hidden for want of room, except beside the open notification center, which lists the
    // same news (an 800px window hid every toast: engine-matrix.spec.ts).
    expect(src).toMatch(/toggle\('is-tucked', centerOpen && /);
    // The short form keeps one line of why a toast is there (it is clamped, never hidden).
    const css = read('web/src/styles/corner-stack.css');
    expect(css).not.toMatch(/\.is-compact[^{]*notification-toast-body\s*\{\s*display:\s*none/);
    expect(css).toMatch(/:is\(\.is-compact, \.has-approval\)[^{]*notification-toast-body\s*\{[^}]*-webkit-line-clamp:\s*1/);
  });

  it('the stack reads no panel, composer, column or sheet geometry, and reserves no room in the page', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    // 2026-11-16, the user: "the notificaiton pill will adopt the width based on other pannel on
    // the right, I think not need". What it measured to follow them, and what it wrote back.
    for (const gone of [
      '.chat-input-container', '.scroll-to-bottom-btn', '.draft-composer-bar', '.app-shell > .sidebar',
      '--corner-stack-width', '--corner-stack-left', '--corner-stack-bottom', 'elementsFromPoint',
      'corner-sheet-inset', 'cornerRoom', 'cornerFit', '--corner-room', '--corner-fit', 'dataset.over',
      'leftColumnRight', 'syncRoom', 'syncSheetInset',
    ]) expect(src, gone).not.toContain(gone);
    // Its one look at the page's layout is the open notification center's right edge (the rest:
    // shown/inSight, and keepClearOfCorner's own rect and its target's).
    expect(src.match(/getBoundingClientRect\(\)/g)?.length).toBeLessThanOrEqual(5);
    expect(src).toMatch(/center!\.getBoundingClientRect\(\)\.right/);
    // Nothing in the page makes room for it or reads the room it took.
    const bad = listed(['web/src/**/*.ts', 'web/src/**/*.tsx', 'web/src/**/*.css'])
      .filter((f) => /data-corner-room|data-corner-fit|--corner-room|--corner-fit|--corner-sheet-inset|corner-sheet-inset|modeBesideCorner/.test(read(f)));
    expect(bad).toEqual([]);
    const layer = (file: string, sel: string) => Number(/z-index:\s*(\d+)/.exec(cssRules(file).find((r) => r.selector === sel)!.body)![1]);
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen'));
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen-backdrop'));
    // "N more" rides the top toast's title row instead of standing as a card of its own.
    const toaster = read('web/src/components/common/NotificationToaster.tsx');
    expect(toaster).toMatch(/className="notification-toast-more"/);
    expect(toaster).toMatch(/older > 0 && !moreHost &&/);
  });

  it('the stack sits at the top, centered, one width on desktop, and across the top under the safe area on the phone', () => {
    const stack = cssRules('web/src/styles/corner-stack.css').find((r) => r.selector === '.corner-stack')!;
    expect(stack.body).toMatch(/top:\s*12px/);
    expect(has(stack.body, 'bottom')).toBe(false);
    expect(stack.body).toMatch(/width:\s*min\(380px, calc\(100vw - 32px\)\)/);
    // Centered between its left edge (the window's, or the open notification center's right) and the window's right.
    expect(stack.body).toMatch(/left:\s*var\(--corner-stack-from, 0px\)/);
    expect(stack.body).toMatch(/right:\s*0/);
    expect(stack.body).toMatch(/margin:\s*0 auto/);
    const phone = cssRules('web/src/styles/phone-layout.css').find((r) => r.selector === 'html body .corner-stack');
    expect(phone?.body).toMatch(/top:\s*calc\(var\(--wn-safe-top\) \+ 8px\)/);
    expect(phone?.body ?? '').not.toMatch(/top:\s*auto/);
    expect(has(phone?.body ?? '', 'bottom')).toBe(false);
    // Nothing takes room under the bar for it: the page never jumps when a notice comes or goes.
    expect(read('web/src/styles/phone-layout.css')).not.toMatch(/--phone-topbar-h:[^;]*corner/);
    // A toast leaves the way it came: a swipe up on the phone.
    expect(read('web/src/components/common/NotificationToaster.tsx')).toMatch(/s0\.y - e\.clientY >= SWIPE_DISMISS_PX/);
  });
});
