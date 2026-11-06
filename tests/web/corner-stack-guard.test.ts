/**
 * Every notice Walnut pops up by itself shows in ONE place: the bottom-left corner stack
 * (web/src/components/common/corner-stack.tsx), just right of the sidebar. 2026-11-04, the
 * user: "also the approval is on bot right, can we be consistent all notificaiton is bottom
 * left" (toasts sat top right, approval cards bottom right, a board's toasts at its pane's
 * bottom right).
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
  '.stale-build-pill': 'the update notice: docked in the sidebar bottom row (or the pop-out dock) on desktop, floats only on the phone, which has no dock',
};

/** Toast-like names that position themselves, and why they stay where they are. */
const NAMED_ALLOWED: Record<string, string> = {
  '.thread-toast': 'a one-line answer to an action inside a session panel, drawn above that panel composer',
  '.unpaired-notice': 'the full-screen sign-in page (inset: 0), not a corner notice',
  '.sfe-reveal-error': 'a line inside the file explorer about the reveal the person just asked for',
  '.notification-toast-swipe': 'the swipe wrapper inside a toast',
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
    ]) expect(read(f), f).toMatch(/<CornerSlot order=\{CORNER_ORDER\.\w+\}[ >]/);
    expect(read('web/src/popout/openPopout.ts')).toMatch(/appendToCornerStack\(el, CORNER_ORDER\.flash\)/);
  });

  it('approvals sit nearest the corner: a script waits on them', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    const order = (k: string) => Number(src.match(new RegExp(`\\b${k}: (\\d+)`))?.[1]);
    expect(order('approvals')).toBeGreaterThan(Math.max(order('toasts'), order('board'), order('flash')));
  });

  it('over what the person works in, or over a chat, the corner takes its short form and keeps to that column', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    expect(src).toMatch(/if \(!workCovered && coversWork\(/);
    expect(src).toMatch(/const compact = [^;]*workCovered/);
    // Never hidden for want of room, except beside the open notification center, which lists the
    // same news (an 800px window hid every toast: engine-matrix.spec.ts).
    expect(src).toMatch(/toggle\('is-tucked', centerOpen && /);
    // Lifted by the composer's own box (a tall note above it must not throw the stack to the top
    // of an 800x600 window), never out of the window, and over the jump-to-newest button too.
    expect(src).not.toMatch(/closest\('\.session-panel-input'\)/);
    expect(src).toMatch(/COMPOSER_CONTROLS = '\.chat-input-container, \.scroll-to-bottom-btn, \.draft-composer-bar'/);
    expect(src).toMatch(/bottom = Math\.min\(bottom, Math\.max\(floor \+ 16, Math\.round\(window\.innerHeight - tall - 8\)\)\)/);
    // Lifted over a composer, never wider than the column the composer is in.
    expect(src).toMatch(/if \(column >= MIN_BESIDE_PX - 40\) width = Math\.min\(width, column\)/);
    // The short form keeps one line of why a toast is there (it is clamped, never hidden).
    const css = read('web/src/styles/corner-stack.css');
    expect(css).not.toMatch(/\.is-compact[^{]*notification-toast-body\s*\{\s*display:\s*none/);
    expect(css).toMatch(/:is\(\.is-compact, \.has-approval\)[^{]*notification-toast-body\s*\{[^}]*-webkit-line-clamp:\s*1/);
  });

  it('the corner stays at the bottom left next to the sidebar, inside the page left column, and the count is a link', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    // 2026-11-05, the user: "the notification should be here not on the big right".
    expect(src).toMatch(/let left = sidebarRight \+ 16;/);
    expect(src).not.toMatch(/let left = columnRight \+ 16;/);
    expect(src).toMatch(/inside >= MIN_INSIDE_PX\) width = Math\.min\(width, inside\)/);
    // Over that column it keeps its whole form: the column's list makes room at its end.
    expect(src).toMatch(/if \(x < columnRight\) continue;/);
    expect(src).toMatch(/const MAX_COLUMNS_PX = 440;/);
    expect(src).toMatch(/if \(r\.right > sidebarRight \+ MAX_COLUMNS_PX\) continue;/);
    // 2026-11-06, the user: "no matter if its full screen or this, fix just here at left". A
    // full-screen sheet never moves the corner into it, never lifts it over the sheet's composer,
    // and the stack draws above the sheet.
    expect(src).not.toMatch(/left = Math\.round\(b\.left\) \+ 16/);
    expect(src).not.toMatch(/sheet\.contains\(el\)/);
    expect(src).toMatch(/if \(sheet \|\| !shown\(el\)\) continue;/);
    expect(src).toMatch(/let floor = 0;/);
    expect(src).not.toMatch(/floor = Math\.max\(0, Math\.round\(window\.innerHeight - b\.bottom\)\)/);
    // A narrow strip beside the sheet: the sheet's content makes room, the corner keeps a readable width.
    expect(src).toMatch(/width = Math\.min\(width, Math\.max\(MIN_BESIDE_SHEET_PX, strip\)\)/);
    // ...by moving the whole sheet's left edge, header included, measured from its edge with no inset.
    expect(read('web/src/styles/fullscreen-tab.css')).toMatch(/left: calc\(var\(--fullscreen-left, 0px\) \+ var\(--fullscreen-side\) \+ var\(--corner-sheet-inset, 0px\)\);/);
    expect(read('web/src/styles/corner-stack.css')).not.toMatch(/padding-left: var\(--corner-sheet-inset/);
    expect(src).not.toMatch(/sheet\.getBoundingClientRect\(\)\.left\) - left - 16/);
    const layer = (file: string, sel: string) => Number(/z-index:\s*(\d+)/.exec(cssRules(file).find((r) => r.selector === sel)!.body)![1]);
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen'));
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen-backdrop'));
    // "N more" rides the top toast's title row instead of standing as a card of its own.
    const toaster = read('web/src/components/common/NotificationToaster.tsx');
    expect(toaster).toMatch(/className="notification-toast-more"/);
    expect(toaster).toMatch(/older > 0 && !moreHost &&/);
  });

  it('the stack sits bottom left on desktop and at the bottom of the screen on the phone', () => {
    const stack = cssRules('web/src/styles/corner-stack.css').find((r) => r.selector === '.corner-stack')!;
    expect(stack.body).toMatch(/left:\s*var\(--corner-stack-left/);
    expect(stack.body).toMatch(/bottom:/);
    expect(has(stack.body, 'right')).toBe(false);
    expect(has(stack.body, 'top')).toBe(false);
    const phone = cssRules('web/src/styles/phone-layout.css').find((r) => r.selector === 'html body .corner-stack');
    // At the bottom, as on a computer: the phone's bar (its search and buttons) stays clear.
    expect(phone?.body).toMatch(/top:\s*auto/);
    expect(phone?.body ?? '').not.toMatch(/bottom:\s*auto/);
    expect(phone?.body ?? '').not.toMatch(/flex-direction:\s*column-reverse/);
    // Nothing takes room under the bar for it: the page never jumps when a notice comes or goes.
    expect(read('web/src/styles/phone-layout.css')).not.toMatch(/--phone-topbar-h:[^;]*corner/);
  });
});
