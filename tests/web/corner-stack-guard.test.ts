/**
 * Every notice Walnut pops up by itself shows in ONE place: the notice stack at the bottom left of
 * the window, just right of the sidebar rail, one fixed width (web/src/components/common/corner-stack.tsx). 2026-11-04, the
 * user: "can we be consistent all notificaiton is bottom left" made it one stack; 2026-11-16,
 * the user: "the notificaiton pill will adopt the width based on other pannel on the right, I
 * think not need, just show like noticiaton overlap on the top nice unified, just like IOS
 * noticficaiton pelase" took away every width that followed a panel (it was put at the top by a
 * misreading; the user put it back: "I said this notification is bottom left, bottom left, and you put it on top again" (translated)).
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

  it('approvals sit nearest the corner: a script waits on them', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    const order = (k: string) => Number(src.match(new RegExp(`\\b${k}: (\\d+)`))?.[1]);
    expect(order('approvals')).toBeGreaterThan(Math.max(order('toasts'), order('board'), order('flash'), order('hostConnect')));
    // The background connect card stays for minutes: nearer the edge than the passing toasts, so they never move it.
    expect(order('hostConnect')).toBeGreaterThan(Math.max(order('toasts'), order('board'), order('flash')));
    // A higher order nearer the bottom corner: the stack lays its slots out top to bottom, held
    // at its bottom edge, so a new notice stacks upward.
    const stack = cssRules('web/src/styles/corner-stack.css').find((r) => r.selector === '.corner-stack')!;
    expect(stack.body).toMatch(/flex-direction:\s*column;/);
    expect(stack.body).toMatch(/justify-content:\s*flex-end/);
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

  it('the stack reads no panel, composer, column or sheet geometry, and publishes the room it covers from its own box', () => {
    const src = read('web/src/components/common/corner-stack.tsx');
    // 2026-11-16, the user: "the notificaiton pill will adopt the width based on other pannel on
    // the right, I think not need". What it measured to follow them, and what it wrote back.
    for (const gone of [
      '.chat-input-container', '.scroll-to-bottom-btn', '.draft-composer-bar', '.todo-panel', '.main-page-chat',
      '--corner-stack-width', '--corner-stack-left', '--corner-stack-bottom', 'elementsFromPoint',
      'corner-sheet-inset', 'cornerRoom', 'cornerFit', '--corner-room', '--corner-fit', 'dataset.over',
      'leftColumnRight', 'syncRoom', 'syncSheetInset',
    ]) expect(src, gone).not.toContain(gone);
    // Its looks at the page's layout are its left edge: the sidebar rail's right edge and the open
    // notification center's, and its bottom: Home's taskbar's top (the rest: shown/inSight,
    // keepClearOfCorner's own rect and its target's, and its own box for the room it publishes).
    expect(src.match(/getBoundingClientRect\(\)/g)?.length).toBeLessThanOrEqual(8);
    expect(src).toMatch(/document\.querySelector\('\.session-taskbar'\)/);
    expect(src).toMatch(/stack\.style\.setProperty\('--corner-stack-lift'/);
    expect(src).toMatch(/sidebar\.getBoundingClientRect\(\)\.right/);
    expect(src).toMatch(/center!\.getBoundingClientRect\(\)\.right/);
    // The room it covers (2026-11-16: the host connect card hid the task panel's found-computer
    // row): from the stack's own box, kept current by a ResizeObserver on the stack, 0 while it
    // covers nothing, so an empty stack leaves no gap; given to the rules that ask for it.
    expect(src).toMatch(/const box = stack\.getBoundingClientRect\(\);/);
    // The observer only asks for the next frame: publishRoom toggles is-overfull, which changes the
    // observed box, and a change inside the callback logs a ResizeObserver loop error (review r3).
    expect(src).toMatch(/new ResizeObserver\(publishRoomSoon\)/);
    expect(src).toMatch(/roomFrame = requestAnimationFrame\(\(\) => \{ roomFrame = 0; publishRoom\(\); \}\)/);
    expect(src).toMatch(/giveStackRoom\(room\);/);
    // Set only by corner-stack-room.ts, on the asking boxes: an inherited custom property changed
    // on <html> or a page restyles everything under it, and in WebKit any stylesheet change restyles
    // the whole document (2026-11-17, about 300ms and 1.3s per change on a 55,000-element page).
    const sets = listed(['web/src/**/*.ts', 'web/src/**/*.tsx']).filter((f) => /setProperty\(\s*(STACK_ROOM_VAR|STACK_SPACER_VAR|kind\.name|['"`]--corner-stack-(room|spacer))/.test(read(f)));
    expect(sets).toEqual(['web/src/components/common/corner-stack-room.ts']);
    const room = read('web/src/components/common/corner-stack-room.ts');
    expect(room).toMatch(/document\.getElementsByClassName\(/);
    expect(room).not.toMatch(/createElement\('style'\)|insertRule|replaceSync|documentElement/);
    // The old machinery that picked a panel under the stack and cut or padded it is gone for good.
    const bad = listed(['web/src/**/*.ts', 'web/src/**/*.tsx', 'web/src/**/*.css'])
      .filter((f) => /data-corner-room|data-corner-fit|--corner-room|--corner-fit|--corner-sheet-inset|corner-sheet-inset|modeBesideCorner/.test(read(f)));
    expect(bad).toEqual([]);
    // Only CSS reads them, always with a 0px fallback, so an empty stack leaves every page as it was.
    const code = listed(['web/src/**/*.ts', 'web/src/**/*.tsx'])
      .filter((f) => !/components\/common\/corner-stack-(width|room)\.ts$/.test(f) && /--corner-stack-(room|spacer)/.test(read(f)));
    expect(code).toEqual([]);
    const cssFiles = listed(['web/src/**/*.css']);
    const rules = cssFiles.flatMap(cssRules);
    const uses = rules.flatMap((r) => (r.body.match(/var\(--corner-stack-(room|spacer)[^)]*\)/g) ?? []).map((u) => ({ r, u })));
    // Registered as not inherited, so setting it on a box restyles that box alone.
    const css = read('web/src/styles/corner-stack.css');
    expect(css).toMatch(/@property --corner-stack-room \{\s*syntax: '<length>';\s*inherits: false;\s*initial-value: 0px;\s*\}/);
    // No rule sets either: only corner-stack-room.ts does, inline on the asking boxes.
    expect(rules.filter((r) => /(^|[;{\s])--corner-stack-(room|spacer)\s*:/.test(r.body)).map((r) => `${r.file}:${r.line}`)).toEqual([]);
    // A box reads the room, a spacer (::after) the spacer's variable (WebKit 26 gives a
    // pseudo-element nothing of a property that is not inherited, `inherit` included).
    expect(uses.filter(({ r, u }) => r.selector.endsWith('::after') !== u.startsWith('var(--corner-stack-spacer')).map(({ r }) => `${r.file}:${r.line} ${r.selector}`)).toEqual([]);
    // ROOM_BOXES and SPACER_BOXES name exactly the boxes whose rules read them: a new asking rule
    // missing there gets no room, a stale entry asks for nothing.
    const listOf = (name: string) => (JSON.parse(room.match(new RegExp(`${name} = (\\[[^\\]]*\\])`))![1]!.replace(/'/g, '"').replace(/,\s*\]/, ']')) as string[]).sort();
    const boxes = listOf('ROOM_BOXES');
    const spacers = listOf('SPACER_BOXES');
    expect([...new Set(uses.filter(({ u }) => u.startsWith('var(--corner-stack-room')).map(({ r }) => r.selector))].sort()).toEqual(boxes);
    expect([...new Set(uses.filter(({ u }) => u.startsWith('var(--corner-stack-spacer')).map(({ r }) => r.selector.replace(/::after$/, '')))].sort()).toEqual(spacers);
    // Each is found by the class it ends in (corner-stack-room.ts boxesOf).
    expect([...boxes, ...spacers].filter((b) => !/\.[\w-]+$/.test(b))).toEqual([]);
    // Room at a box's end only: its bottom padding, a spacer's height, its last grid row.
    const props = ['padding-bottom', 'height', 'grid-template-rows'];
    const decls = rules.flatMap((r) => r.body.split(';').filter((d) => /--corner-stack-(room|spacer)/.test(d)).map((d) => ({ r, prop: d.split(':')[0]!.trim() })));
    expect(decls.filter(({ prop }) => !props.includes(prop)).map(({ r, prop }) => `${r.file}:${r.line} ${prop}`)).toEqual([]);
    // A floor, not a count: the scrollers that take the room today (a new one only adds).
    expect(uses.length).toBeGreaterThanOrEqual(13);
    expect(uses.filter(({ u }) => u !== 'var(--corner-stack-room, 0px)' && u !== 'var(--corner-stack-spacer, 0px)').map(({ r, u }) => `${r.file}:${r.line} ${u}`)).toEqual([]);
    // Only a scroller takes it, as room at its end (2026-11-16: a notice overlaps the page like a
    // system notification, so nothing may move when one comes or goes): every rule that reads it is
    // for a box that scrolls (its bottom padding, a spacer after its last row, a last grid row),
    // never a column, a footer or a centred card. That nothing moves is measured in a real page by
    // tests/e2e/browser/corner-stack-room.spec.ts.
    const scrollers = new Set(rules.filter((r) => /(^|[;\s])overflow(-y)?\s*:\s*(auto|scroll)\b/.test(r.body)).flatMap((r) => subjects(r.selector)));
    // A document whose end is its scroller's end, and why (the box around it is the scroller's
    // height and a long document overflows it).
    const documents: Record<string, { scroller: string; why: string }> = {
      '.global-notes-body .global-notes-editor-inline .tiptap': { scroller: '.global-notes-body', why: "the scratchpad's note" },
      '.first-use-in-tasks .first-use-setup::after': { scroller: '.first-use-in-tasks', why: "the welcome card's end, out of flow so the card's own size never changes" },
    };
    expect(uses.filter(({ r }) => !(r.selector in documents) && !subjects(r.selector).every((sub) => scrollers.has(sub))).map(({ r }) => `${r.file}:${r.line} ${r.selector}`)).toEqual([]);
    // And keeps its scrollbar's gutter: a list that starts to scroll when the room comes would
    // otherwise gain a scrollbar that narrows it (WebKit with classic scrollbars, 2026-11-16).
    const gutters = new Set(rules.filter((r) => /scrollbar-gutter\s*:\s*stable/.test(r.body)).flatMap((r) => subjects(r.selector)));
    const scrollerOf = (selector: string) => documents[selector] ? [documents[selector]!.scroller] : subjects(selector);
    expect(uses.filter(({ r }) => !scrollerOf(r.selector).every((sub) => gutters.has(sub))).map(({ r }) => `${r.file}:${r.line} ${r.selector}`)).toEqual([]);
    // Settings lays its words out to its width, so its nav list and pane take the kept gutter out of
    // their own right padding (useSettingsGutter.ts measures it): on top of the padding it took 8px
    // from every row and wrapped six descriptions at 660px (2026-11-17).
    const settings = rules.filter((r) => r.file === 'web/src/styles/settings-nav.css' && /scrollbar-gutter\s*:\s*stable/.test(r.body));
    expect(settings.length).toBeGreaterThanOrEqual(3);
    expect(settings.filter((r) => !/padding-right:\s*(max\(0px, calc\(\d+px - var\(--settings-gutter, 0px\)\)\)|var\(--settings-pane-pad-right\))/.test(r.body)).map((r) => `${r.file}:${r.line} ${r.selector}`)).toEqual([]);
    expect(read('web/src/styles/settings-nav.css')).toMatch(/--settings-pane-pad-right: max\(0px, calc\(var\(--settings-pane-pad-x\) - var\(--settings-gutter, 0px\)\)\);/);
    // The sticky bar ends at the pane's padding edge, so it never scrolls the pane sideways.
    expect(read('web/src/styles/settings-shell.css')).toMatch(/right: calc\(-1 \* var\(--settings-pane-pad-right, var\(--settings-pane-pad-x, 0px\)\)\);/);
    expect(read('web/src/pages/SettingsPage.tsx')).toMatch(/useSettingsGutter\(containerRef\)/);
    // Which scrollers sit at the bottom left, under the stack, is a matter of layout, which no source
    // scan can tell: tests/e2e/browser/corner-stack-room.spec.ts walks every page and side bar of the
    // rail in a real page and names a new scroller that misses the room.
    const layer = (file: string, sel: string) => Number(/z-index:\s*(\d+)/.exec(cssRules(file).find((r) => r.selector === sel)!.body)![1]);
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen'));
    expect(layer('web/src/styles/corner-stack.css', '.corner-stack')).toBeGreaterThan(layer('web/src/styles/globals.css', '.open-walnut-fullscreen-backdrop'));
    // "N more" rides the top toast's title row instead of standing as a card of its own.
    const toaster = read('web/src/components/common/NotificationToaster.tsx');
    expect(toaster).toMatch(/className="notification-toast-more"/);
    expect(toaster).toMatch(/older > 0 && !moreHost &&/);
  });

  it("Settings' right edges read the pane's right padding, never the side padding", () => {
    // The pane's right padding is its side padding less the kept gutter (--settings-pane-pad-right,
    // settings-nav.css). A box that lines up with the pane's right edge from --settings-pane-pad-x
    // sits a gutter off it: the compact bar's actions stood 8px left of the page's own with classic
    // scrollbars (2026-11-17, settings-layout-fields F12 and the Remote Hosts wide window). The side
    // padding may set the left side only, or stand as the fallback of the right padding.
    const offRight = (r: Rule) => r.body.replace(/var\(--settings-pane-pad-right, var\(--settings-pane-pad-x, 0px\)\)/g, '')
      .split(';').map((d) => d.trim()).filter((d) => /--settings-pane-pad-x\b/.test(d)).filter((d) => {
        const prop = d.slice(0, d.indexOf(':')).trim();
        if (['--settings-pane-pad-x', '--settings-pane-pad-right', 'left', 'padding-left', 'margin-left', 'inset-inline-start'].includes(prop)) return false;
        // A padding or margin shorthand may name it in its fourth (left) value only.
        if (prop === 'padding' || prop === 'margin') {
          const values: string[] = [];
          let depth = 0, cur = '';
          for (const ch of d.slice(d.indexOf(':') + 1).trim()) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (/\s/.test(ch) && depth === 0) { if (cur) values.push(cur); cur = ''; } else cur += ch;
          }
          if (cur) values.push(cur);
          return !(values.length === 4 && values.slice(0, 3).every((v) => !/--settings-pane-pad-x\b/.test(v)));
        }
        return true;
      }).map((d) => `${r.file}:${r.line} ${r.selector} { ${d} }`);
    const rules = listed(['web/src/**/*.css']).flatMap(cssRules);
    expect(rules.flatMap(offRight)).toEqual([]);
    // The check catches the bar's old right padding, and the bar still reads the page's one column.
    const rule = (body: string): Rule => ({ file: 'x.css', line: 1, selector: '.x', body });
    expect(offRight(rule('padding: 0 max(var(--settings-pane-pad-x, 0px), calc(100% - 680px)) 0 var(--settings-pane-pad-x, 0px);'))).toHaveLength(1);
    expect(offRight(rule('left: calc(-1 * var(--settings-pane-pad-x, 0px)); right: calc(-1 * var(--settings-pane-pad-right, var(--settings-pane-pad-x, 0px)));'))).toHaveLength(0);
    const bar = cssRules('web/src/styles/settings-shell.css').find((r) => r.selector === '.settings-pane-stickybar-inner')!;
    expect(bar.body).toMatch(/var\(--settings-pane-column, 680px\)/);
    expect(read('web/src/styles/settings-nav.css')).toMatch(/max-width: var\(--settings-pane-column, 680px\);/);
  });

  it('every scroller and footer of a page names where it stands against the stack', () => {
    // The stack overlaps the bottom left of every page, so a page's own sheets are read here: each
    // box that scrolls, and each footer (a `-foot`/`-footer` class, a box pushed down by
    // `margin-top: auto`, a box stuck to a bottom edge), either takes the room (ROOM_BOXES,
    // SPACER_BOXES) or is listed below with why it is never under the stack. 2026-11-17, review: the
    // unlocked vault's Generator, Import and Lock sat in a footer under it, and Mail's two lists took
    // no room; the page walk (corner-stack-room.spec.ts) only finds what its fixtures mount.
    const PAGE_SHEETS: Record<string, string[]> = {
      home: ['web/src/styles/home-navigation.css', 'web/src/styles/first-use.css'],
      notes: ['web/src/components/notes/notes-editor.css'],
      calendar: ['web/src/components/calendar/grid-controls.css'],
      mail: ['web/src/apps/mail/mail.css', 'web/src/apps/mail/mail-groups.css'],
      tasks: ['web/src/styles/tasks-page.css'],
      routines: ['web/src/styles/routines-groups.css'],
      passwords: ['web/src/styles/passwords.css'],
      apps: ['web/src/styles/apps-page.css'],
      settings: ['web/src/styles/settings-nav.css', 'web/src/styles/settings-shell.css'],
      org: ['web/src/styles/org-page.css', 'web/src/styles/org-rail.css'],
    };
    // A new built-in app names its sheets here (core-app-list.ts), or this fails.
    const apps = [...read('web/src/apps/core-app-list.ts').matchAll(/\bid: '([\w-]+)'/g)].map((m) => m[1]!);
    expect(apps.length).toBeGreaterThanOrEqual(9);
    expect(apps.filter((id) => !(id in PAGE_SHEETS))).toEqual([]);
    const NOT_UNDER_STACK: Record<string, string> = {
      '.first-use-in-tasks': "the welcome card's own box: its spacer (.first-use-setup::after) takes the room",
      '.found-host-prompts': "Home's found computers, under the task toolbar at the top",
      '.todo-filter-footer': "the filter menu's last row, inside a menu the person opens and useMenuPlacement places",
      '.todo-filter-footer-sep': 'a separator inside that menu row',
      '.todo-filter-footer-chip': 'a chip inside that menu row',
      '.on': 'a state of that chip',
      '.notes-bubble-menu': 'a menu over the selected text, placed by the editor',
      '.notes-format-block-menu': 'a menu the person opens from the toolbar',
      '.notes-tag-panel': 'a panel the person opens from the toolbar',
      '.notes-cmdk-list': 'the command palette, a centred dialog',
      '.notes-cmdk-footer': "the command palette's key hints",
      '.lightbox-scroll': 'a full-window image view over everything, the stack included',
      '.mail-add-dialog': 'a centred dialog',
      '.mail-setup-options': 'a list inside that dialog',
      '.mail-group-foot': 'the end of one sender group, a row inside .mail-rows, which takes the room',
      '.mail-text-btn': 'a button in that row',
      '.mail-unsub-list': 'a list inside the unsubscribe dialog',
      '.tp-cols-popover': 'a popover the person opens, placed by its trigger',
      '.tp-proj-popover': 'a popover the person opens, placed by its trigger',
      '.routine-task-hits': "a field's suggestions under the field, inside the routine dialog",
      '.routine-form-footer': "the routine dialog's buttons, a centred modal",
      '.form-actions': 'the buttons in that footer',
      '.routine-instructions-box': 'a field inside the routine dialog',
      '.routine-instructions-footer': "that field's own hint row",
      '.pw-main': "the vault's third column, 480px or more right of the rail: past the stack's 456px reach",
      '.pw-detail-foot': "a line at the end of an item's details, in .pw-main",
      '.pw-editor-actions': "the item editor's Save and Cancel, in .pw-main",
      '.pw-gate-foot': "the lock screen card's last line, inside .pw-gate, which takes the room",
      '.pw-popover': 'a popover the person opens, placed by its trigger',
      '.pw-menu': 'a menu the person opens, placed by its trigger',
      '.pw-modal': 'a centred dialog',
      '.pw-import-skipped': 'a list inside the import dialog',
      '.pw-unlock-sheet': 'a centred sheet over the page',
      '.apps-card-foot': "one app card's buttons, a row inside .apps-page, which takes the room",
      '.org-router-setup': "the router setup form at the top of Org's detail column: as tall as its fields, it ends above the stack",
      '.org-composer-input': "the chat composer's text box in Org's detail column: a chat, which the stack overlaps by design as on Home (CHAT_SURFACES)",
      '.org-side-card-desc': "a card's text in Org's side panel, at the right",
      '.org-rail-body': "the node's task rail, beside the chat at the right (above it when narrow)",
      '.org-answer-menu': 'a menu the person opens, placed by its trigger',
    };
    const room = read('web/src/components/common/corner-stack-room.ts');
    const given = new Set([...room.matchAll(/'([^']+)',?\n/g)].map((m) => subjects(m[1]!)).flat());
    const asked: string[] = [];
    for (const file of Object.values(PAGE_SHEETS).flat()) {
      for (const r of cssRules(file)) {
        const scrolls = /(^|[;\s])overflow(-y)?\s*:\s*(auto|scroll)\b/.test(r.body);
        const footer = /-foot(er)?\b/.test(r.selector) || /(^|[;\s])margin-top\s*:\s*auto\b/.test(r.body)
          || (/position\s*:\s*sticky/.test(r.body) && has(r.body, 'bottom'));
        if (!scrolls && !footer) continue;
        for (const sub of subjects(r.selector)) if (!given.has(sub) && !(sub in NOT_UNDER_STACK)) asked.push(`${file}:${r.line} ${sub}`);
      }
    }
    expect(asked).toEqual([]);
    // The fix itself: the vault's tools follow its sections in the side, which scrolls with room, and
    // Mail's last-checked line and + Add account sit under its pane's head.
    expect(read('web/src/components/passwords/VaultBrowser.tsx')).not.toMatch(/pw-side-foot/);
    const pane = read('web/src/apps/mail/MailAccountsPane.tsx');
    expect(pane.indexOf('data-testid="mail-add-account"')).toBeLessThan(pane.indexOf('className="mail-accounts-scroll"'));
    expect(pane.indexOf('data-testid="mail-sync-line"')).toBeLessThan(pane.indexOf('className="mail-accounts-scroll"'));
    // A full-bleed page keeps no scrollbar gutter, in the main window and an app's own window alike:
    // one definition (content-area-style.ts), never an inline copy.
    expect(read('web/src/components/layout/content-area-style.ts')).toMatch(/scrollbarGutter: 'auto'/);
    for (const f of ['web/src/components/layout/AppShell.tsx', 'web/src/popout/PopoutAppView.tsx']) {
      expect(read(f), f).toMatch(/style=\{contentAreaStyle\(/);
      expect(read(f), f).not.toMatch(/padding: 0, overflow: 'hidden'/);
    }
  });

  it('the stack sits at the bottom left, right of the sidebar rail, one width on desktop, and across the top under the safe area on the phone', () => {
    // 2026-11-16, the user, after it was put at the top: "I said this notification is bottom left, bottom left, and you put it on top again" (translated).
    const stack = cssRules('web/src/styles/corner-stack.css').find((r) => r.selector === '.corner-stack')!;
    // 16px above the window's bottom, or above Home's taskbar while it shows (its chips sit at the
    // left, 2026-11-16 review): the stack's own bottom, never the taskbar's or a page's.
    expect(stack.body).toMatch(/bottom:\s*calc\(16px \+ var\(--corner-stack-lift, 0px\)\)/);
    expect(listed(['web/src/**/*.css']).filter((f) => read(f).includes('--corner-stack-lift') && !f.endsWith('styles/corner-stack.css'))).toEqual([]);
    expect(has(stack.body, 'top')).toBe(false);
    expect(stack.body).toMatch(/width:\s*min\(440px, calc\(100vw - 32px\)\)/);
    // 16px right of the rail (or of the open notification center), never centered.
    expect(stack.body).toMatch(/left:\s*calc\(var\(--corner-stack-rail, 0px\) \+ 16px\)/);
    expect(stack.body).not.toMatch(/margin:\s*0 auto/);
    expect(has(stack.body, 'right')).toBe(false);
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
