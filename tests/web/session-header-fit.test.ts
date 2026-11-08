/**
 * The session header's fit rules (web/src/components/sessions/session-header-fit.ts).
 *
 * A narrow column used to wrap the tool row one chip per line and run the title
 * row's pills over the phase circle (2026-10-02). The tool row keeps one line;
 * what leaves, and in what order, is decided here. The properties that matter:
 * the same width always gives the same answer (no flicker on resize), the view
 * chips leave in priority order and never come back as the row narrows, the
 * window buttons fill whatever room the chips leave (no button-sized hole beside
 * the "..." menu), and Lock, Expand and Close never leave. The title row has no
 * fit: its labels are one folded control (session-header-labels-guard.test.ts).
 */
import fs from 'node:fs';

import { describe, it, expect, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act, useRef } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import { SLOT_ID_PREFIX, TOOL_ITEMS, toolItemSpec, useToolRowFit } from '../../web/src/components/sessions/useSessionHeaderFit';
import {
  fitToolRow, toolRowWidth,
  ASSUMED_TOOL_WIDTH, ASSUMED_WINDOW_WIDTH,
  type ToolRowItem,
} from '../../web/src/components/sessions/session-header-fit';

const OPTS = { chipGap: 6, windowGap: 3, groupGap: 6, moreWidth: 22 };

/** The real row, widths as Chromium lays them out at 10px / 22px buttons. */
const ROW: ToolRowItem[] = [
  { id: 'fork', kind: 'chip', priority: 2, width: 42 },
  { id: 'changed', kind: 'chip', priority: 3, width: 58 },
  { id: 'files', kind: 'chip', priority: 4, width: 44 },
  { id: 'board', kind: 'chip', priority: 5, width: 46 },
  { id: 'terminal', kind: 'chip', priority: 6, width: 58 },
  { id: 'time', kind: 'info', priority: 7, width: 22 },
  { id: 'minimize', kind: 'window', priority: 9, width: 22 },
  { id: 'popout', kind: 'window', priority: 10, width: 22 },
  { id: 'lock', kind: 'fixed', priority: 0, width: 22 },
  { id: 'expand', kind: 'fixed', priority: 0, width: 22 },
  { id: 'close', kind: 'fixed', priority: 0, width: 22 },
];
// Chips 248 + time 22 + 5 gaps 30 = 300; buttons 110 + 4 gaps 12 = 122; group gap 6.
const ROW_WIDTH = 428;

describe('tool row observer delivery', () => {
  // useObserved: nothing renders inside observer delivery (a flushSync there also commits every
  // other update waiting, Home's column count after a divider drag included: WebKit's
  // 'ResizeObserver loop' error, 2026-11-07 and 2026-11-10). A changed decision is painted onto
  // the row's own items inside the delivery, before paint, never a frame later, and React gets it
  // as an ordinary update.
  it('commits nothing inside delivery; a changed fit is painted on the items at once and rendered after', async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    const frames = new Map<number, FrameRequestCallback>();
    const callbacks: Array<() => void> = [];
    let nextFrame = 0;
    let delivery = false;
    let width = 500;
    let renders = 0;
    let rendersDuringDelivery = 0;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('MutationObserver', class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {}
      disconnect() {}
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    function Row() {
      renders++;
      if (delivery) rendersDuringDelivery++;
      const ref = useRef<HTMLDivElement | null>(null);
      const fit = useToolRowFit(ref);
      return createElement('div', {
        ref: (el: HTMLDivElement | null) => {
          ref.current = el;
          if (!el) return;
          el.getBoundingClientRect = () => ({ width } as DOMRect);
          for (const item of el.querySelectorAll<HTMLElement>('[data-header-id]')) {
            item.getBoundingClientRect = () => ({ width: item.dataset.headerId === 'fork' ? 42 : 58 } as DOMRect);
          }
        },
        'data-fit': fit.inMore.join(','),
      }, ...['fork', 'changed', 'files', 'terminal'].map(id => createElement('span', { key: id, 'data-header-id': id }, id)));
    }
    let hiddenInDelivery: string[] = [];
    const deliver = async () => {
      await act(async () => {
        delivery = true;
        for (const cb of [...callbacks, ...callbacks]) cb();
        hiddenInDelivery = [...host.querySelectorAll<HTMLElement>('[data-header-id][data-hidden="true"]')].map((e) => e.dataset.headerId!);
        delivery = false;
      });
    };
    try {
      await act(async () => { root.render(createElement(Row)); });
      const initialRenders = renders;
      // Same room: the observers fire, nothing renders.
      await deliver();
      expect(renders).toBe(initialRenders);
      expect(rendersDuringDelivery).toBe(0);
      // Less room: the items leave inside the delivery (no frame paints the old fit), and the
      // render (the "..." menu's list) comes after it, never inside it, and never a frame later.
      width = 100;
      await deliver();
      expect(hiddenInDelivery).toContain('changed');
      expect(rendersDuringDelivery).toBe(0);
      expect(host.firstElementChild?.getAttribute('data-fit')).toContain('changed');
      expect(renders).toBeGreaterThan(initialRenders);
      expect(frames.size).toBe(0);
      // Converged: the same room again renders nothing more.
      const settled = renders;
      await deliver();
      expect(renders).toBe(settled);
    } finally {
      await act(async () => { root.unmount(); });
      expect(frames.size).toBe(0);
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('fitToolRow', () => {
  it('owns synchronous fit state in the tool row, not in the full session panel', () => {
    const panel = fs.readFileSync(new URL('../../web/src/components/sessions/SessionPanel.tsx', import.meta.url), 'utf8');
    const row = fs.readFileSync(new URL('../../web/src/components/sessions/SessionHeaderMore.tsx', import.meta.url), 'utf8');
    expect(panel).not.toContain('useToolRowFit(');
    expect(panel).toContain('<SessionHeaderToolRow rowRef={toolRowRef}>');
    expect(panel).toContain('controls={planComposerControls}');
    expect(panel).not.toContain('controls={composerControls()}');
    expect(row).toContain('const fit = useToolRowFit(rowRef)');
    expect(row).toContain('className="session-meta-row-2"');
  });

  it('shows everything when the row fits', () => {
    const full = fitToolRow(ROW, ROW_WIDTH, OPTS);
    expect(full.visible).toEqual(ROW.map((i) => i.id));
    expect(full.inMore).toEqual([]);
    expect(full.dropped).toEqual([]);
  });

  it('treats no room as no room, not as unknown (the hooks skip rows with no width)', () => {
    expect(fitToolRow(ROW, 0, OPTS).visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(fitToolRow(ROW, -50, OPTS).visible).toEqual(['fork', 'lock', 'expand', 'close']);
  });

  it('never hides Lock, Expand or Close, whatever the width', () => {
    for (const w of [427, 380, 300, 200, 152, 60, 1]) {
      const r = fitToolRow(ROW, w, OPTS);
      for (const id of ['lock', 'expand', 'close']) expect(r.visible, `${id} at ${w}px`).toContain(id);
      expect(r.inMore, `${w}px`).not.toContain('lock');
    }
  });

  it('drops the time first, and the time goes nowhere', () => {
    // 427: 1px short of everything. Chips 248 + 5 gaps 30 + time... the time (22 + a gap) is the one
    // thing that does not fit: chips without it 248 + 4 gaps 24 = 272, five buttons 110 + 4 gaps 12 = 122,
    // group gap 6 → 400. No "..." button is needed, so none is paid for.
    const r = fitToolRow(ROW, ROW_WIDTH - 1, OPTS);
    expect(r.dropped).toEqual(['time']);
    expect(r.inMore).toEqual([]);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'minimize', 'popout', 'lock', 'expand', 'close']);
    expect(fitToolRow(ROW, 400, OPTS).inMore).toEqual([]);
  });

  it('sends the two movable window buttons to the "..." menu before any chip leaves', () => {
    // 399: the "..." button (22 + a gap) comes with the first hidden button, and then there is
    // room for neither: chips 248 + "..." 22 + 5 gaps 30 = 300; Lock, Expand, Close 66 + 2 gaps 6 = 72;
    // group gap 6 → 378. One more button (97 + 300 + 6 = 403) does not fit.
    const r = fitToolRow(ROW, 399, OPTS);
    expect(r.inMore).toEqual(['minimize', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'lock', 'expand', 'close']);
    expect(r.dropped).toEqual(['time']);
    expect(fitToolRow(ROW, 378, OPTS).inMore).toEqual(['minimize', 'popout']);
  });

  it('moves chips into the "..." menu lowest priority first, listed before the window buttons', () => {
    // 377: Terminal goes (chips with it need 378). The room it frees takes both window buttons back:
    // Fork..Board 190 + "..." 22 + 4 gaps 24 = 236; five buttons 122; group gap 6 → 364.
    const r = fitToolRow(ROW, 377, OPTS);
    expect(r.inMore).toEqual(['terminal']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'minimize', 'popout', 'lock', 'expand', 'close']);
    // 363 lets go of Open in new tab first (Minimize alone: 236 + 97 + 6 = 339), then of Minimize below that.
    expect(fitToolRow(ROW, 363, OPTS).inMore).toEqual(['terminal', 'popout']);
    expect(fitToolRow(ROW, 339, OPTS).inMore).toEqual(['terminal', 'popout']);
    expect(fitToolRow(ROW, 338, OPTS).inMore).toEqual(['terminal', 'minimize', 'popout']);
    // 313: Board goes; Files stays down to 262 (144 + 22 + 3 gaps 18 + 72 + 6).
    const r2 = fitToolRow(ROW, 285, OPTS);
    expect(r2.visible).toEqual(['fork', 'changed', 'files', 'lock', 'expand', 'close']);
    expect(r2.inMore).toEqual(['board', 'terminal', 'minimize', 'popout']);
    expect(fitToolRow(ROW, 262, OPTS).visible).toContain('files');
    // 152 (a 180px column): Fork + "..." + Lock, Expand, Close = 42 + 28 + 72 + 6 = 148; Changed (58 + 6) would need 212.
    const r3 = fitToolRow(ROW, 152, OPTS);
    expect(r3.visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(r3.inMore).toEqual(['changed', 'files', 'board', 'terminal', 'minimize', 'popout']);
  });

  it('stops the chips at the first that does not fit: the order is the contract', () => {
    // 150: Fork + "..." + Lock, Expand, Close = 42 + 28 + 72 + 6 = 148; Changed (58 + 6) does not fit.
    // The two window buttons do not fit either (one more button is 148 + 25 = 173).
    const r = fitToolRow(ROW, 150, OPTS);
    expect(r.visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(r.inMore).toEqual(['changed', 'files', 'board', 'terminal', 'minimize', 'popout']);
    expect(r.dropped).toEqual(['time']);
    // 200: Fork + "..." 70 + five buttons 122 + group gap 6 = 198: the buttons fill, the chips still stop at
    // Changed (Files, 44 wide, would need 198 + 64 + 50 and could not fit by skipping either).
    const r2 = fitToolRow(ROW, 200, OPTS);
    expect(r2.visible).toEqual(['fork', 'minimize', 'popout', 'lock', 'expand', 'close']);
    expect(r2.inMore).toEqual(['changed', 'files', 'board', 'terminal']);
  });

  it('never leaves room for a window button that is in the menu', () => {
    // The 2026-10-04 report: a gap beside the "..." menu big enough for the buttons it held. Whatever
    // the width, the room left after the visible items is smaller than one more button and its gap.
    let checked = 0;
    for (let w = 150; w <= ROW_WIDTH; w++) {
      const r = fitToolRow(ROW, w, OPTS);
      if (!r.inMore.some((id) => id === 'minimize' || id === 'popout')) continue;
      const spare = w - toolRowWidth(ROW.filter((i) => r.visible.includes(i.id)), true, OPTS);
      expect(spare, `${w}px: ${spare}px spare while a window button sits in the menu`).toBeLessThan(22 + OPTS.windowGap);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('fills the room a wide hidden chip leaves with the window buttons (the 2026-10-04 report)', () => {
    // A 90px chip after Terminal (the report's was the heavy pill, since removed). With all five chips on
    // the row it is the first item that does not fit; the old strict prefix stopped there and left Minimize,
    // Open in new tab and Lock in the menu beside 60px of empty row.
    const wide: ToolRowItem = { id: 'wide', kind: 'chip', priority: 8, width: 90 };
    const row = ROW.filter((i) => i.id !== 'time');
    const withWide = [...row.slice(0, 5), wide, ...row.slice(5)];
    // Five chips 248 + "..." 22 + 5 gaps 30 = 300; Lock, Expand, Close 72; group gap 6 → 378, plus Minimize 25 → 403.
    const r = fitToolRow(withWide, 403, OPTS);
    expect(r.inMore).toEqual(['wide', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'minimize', 'lock', 'expand', 'close']);
    expect(fitToolRow(withWide, 428, OPTS).visible).toContain('popout');
    // The chips stay in order: the wide chip never jumps the queue, and Terminal is not evicted for it.
    for (let w = 150; w <= 540; w++) {
      const v = fitToolRow(withWide, w, OPTS).visible;
      if (v.includes('wide')) expect(v, `${w}px`).toContain('terminal');
    }
  });

  it('never brings the time back as the row narrows', () => {
    const withWide = [...ROW.slice(0, 6), { id: 'wide', kind: 'chip', priority: 8, width: 90 } as ToolRowItem, ...ROW.slice(6)];
    let seenGone = false;
    for (let w = 700; w >= 100; w--) {
      const has = fitToolRow(withWide, w, OPTS).visible.includes('time');
      if (!has) seenGone = true;
      else expect(seenGone, `the time came back at ${w}px`).toBe(false);
    }
  });

  it('keeps Lock out of the window group: it is a fixed item, like Expand and Close', () => {
    expect(TOOL_ITEMS.lock!.kind).toBe('fixed');
    expect(TOOL_ITEMS.expand!.kind).toBe('fixed');
    expect(TOOL_ITEMS.close!.kind).toBe('fixed');
    expect(Object.entries(TOOL_ITEMS).filter(([, v]) => v.kind === 'window').map(([k]) => k).sort()).toEqual(['minimize', 'popout']);
  });

  it('keeps the top chip even where it does not fit', () => {
    const r = fitToolRow(ROW, 30, OPTS);
    expect(r.visible).toEqual(['fork', 'lock', 'expand', 'close']);
  });

  it('a late Plan never pushes a host chip into the menu, at any width', () => {
    // Plan is known only once the session record has loaded, so it joins a row already on screen
    // (2026-10-11: with the top priority it took Files' place under a click aimed at Files). It sits
    // after Terminal and leaves before every host chip, so the chips shown without it stay shown.
    expect(TOOL_ITEMS.plan!.priority).toBeGreaterThan(TOOL_ITEMS.terminal!.priority);
    const plan: ToolRowItem = { id: 'plan', kind: 'chip', priority: TOOL_ITEMS.plan!.priority, width: 40 };
    const withPlan = [...ROW.slice(0, 5), plan, ...ROW.slice(5)];
    const chipsOf = (ids: string[]) => ids.filter((id) => ROW.some((i) => i.id === id && i.kind === 'chip'));
    for (let width = 30; width <= ROW_WIDTH + 60; width += 1) {
      const before = chipsOf(fitToolRow(ROW, width, OPTS).visible);
      const after = fitToolRow(withPlan, width, OPTS);
      expect(chipsOf(after.visible), `${width}px`).toEqual(before);
      // Shown only where every host chip is shown too.
      if (after.visible.includes('plan')) expect(before, `${width}px`).toEqual(chipsOf(ROW.map((i) => i.id)));
    }
    // Where the row has no room for it, Plan waits in the menu, first in line after the host chips.
    const narrow = fitToolRow(withPlan, 285, OPTS);
    expect(narrow.inMore).toEqual(['board', 'terminal', 'plan', 'minimize', 'popout']);
  });

  it('assumes a 24px button, not a chip, for a window button that has never been on screen', () => {
    // A panel drawn narrow from its first frame never shows Minimize, Open in new tab, Lock, Expand or
    // Close to be measured. 2026-10-04 they were priced like chips (44 each), so a 70px gap sat beside
    // a "..." menu that held three of them. Fork..Board 190 + 3 gaps 18 = 208; 5 buttons 120 + 4 gaps
    // 12 = 132; group gap 6 → 346 (446 at 44px each).
    const unmeasured = ROW
      .filter((i) => i.id !== 'terminal' && i.id !== 'time')
      .map((i) => (i.kind === 'window' || i.kind === 'fixed' ? { ...i, width: undefined } : i));
    expect(ASSUMED_WINDOW_WIDTH).toBe(24);
    expect(fitToolRow(unmeasured, 346, OPTS).inMore).toEqual([]);
    expect(fitToolRow(unmeasured, 345, OPTS).visible).toContain('lock');
  });

  it('assumes a short chip for a width it has not measured', () => {
    const unmeasured = ROW.map((i) => (i.id === 'board' ? { ...i, width: undefined } : i));
    // Board priced at ASSUMED_TOOL_WIDTH (44) instead of 46: the full row is 2px narrower.
    expect(fitToolRow(unmeasured, ROW_WIDTH - 2, OPTS).inMore).toEqual([]);
    expect(ASSUMED_TOOL_WIDTH).toBe(44);
  });

  it('answers the same for the same width, however often it is asked', () => {
    for (const w of [430, 400, 350, 300, 250, 212, 180, 150, 100]) {
      const a = fitToolRow(ROW, w, OPTS);
      const b = fitToolRow(ROW, w, OPTS);
      expect(b).toEqual(a);
      // Every id is accounted for exactly once.
      const all = [...a.visible, ...a.inMore, ...a.dropped].sort();
      expect(all).toEqual(ROW.map((i) => i.id).sort());
    }
  });

  it('never gains a chip as the row narrows; a window button returns only where a chip left', () => {
    const chipIds = ROW.filter((i) => i.kind === 'chip' || i.kind === 'info').map((i) => i.id);
    const shownChips = (visible: string[]) => visible.filter((id) => chipIds.includes(id));
    let previous = fitToolRow(ROW, 500, OPTS).visible;
    for (let w = 499; w >= 60; w--) {
      const now = fitToolRow(ROW, w, OPTS).visible;
      for (const id of shownChips(now)) expect(previous.includes(id), `${id} came back at ${w}px`).toBe(true);
      for (const id of ['minimize', 'popout']) {
        if (now.includes(id) && !previous.includes(id)) {
          expect(shownChips(now).length, `${id} came back at ${w}px with no chip gone`).toBeLessThan(shownChips(previous).length);
        }
      }
      previous = now;
    }
  });
});

describe('a session fact the user pinned to the tool row', () => {
  it('is a chip named by its title that leaves before every chip of the host\'s own', () => {
    const el = { dataset: { headerName: 'Time' } } as unknown as HTMLElement;
    expect(toolItemSpec(`${SLOT_ID_PREFIX}walnut-time:session-time`, el)).toEqual({ kind: 'chip', priority: 6.5, name: 'Time' });
    expect(toolItemSpec(`${SLOT_ID_PREFIX}x:y`)).toMatchObject({ name: 'Plugin' });
    expect(toolItemSpec('terminal')).toBe(TOOL_ITEMS.terminal);
    // An id the row does not know is not an item at all, so a stray attribute measures nothing.
    expect(toolItemSpec('mystery')).toBeUndefined();

    const slot = { id: `${SLOT_ID_PREFIX}walnut-time:session-time`, kind: 'chip' as const, priority: 6.5, width: 70 };
    const row = [...ROW, slot];
    // Everything fits at the full width plus the slot's 70 and a gap.
    expect(fitToolRow(row, ROW_WIDTH + 76, OPTS).inMore).toEqual([]);
    // The first chip to go is the slot, ahead of Terminal; Terminal follows only after it.
    const order: string[] = [];
    for (let w = ROW_WIDTH + 76; w >= 100; w--) {
      for (const id of fitToolRow(row, w, OPTS).inMore) if (!order.includes(id) && id !== 'minimize' && id !== 'popout') order.push(id);
    }
    expect(order.slice(0, 2)).toEqual([slot.id, 'terminal']);
  });
});

describe('Watch and Locate are kebab rows, not header buttons (2026-11-09, the user: "this 2 put iot in the drop down")', () => {
  it('no header item, no header button, and the kebab draws both by name', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../web/src/components', f), 'utf8');
    expect(Object.keys(TOOL_ITEMS)).not.toContain('locate');
    expect(Object.keys(TOOL_ITEMS)).not.toContain('watch');
    const panel = src('sessions/SessionPanel.tsx');
    expect(panel).not.toMatch(/data-header-id="(locate|watch)"/);
    expect(panel).not.toContain('session-panel-locate');
    expect(panel).not.toContain('session-panel-watch');
    // Locate: a top-level row of the session kebab; Watch: the task's row of every task menu.
    expect(src('sessions/SessionMenuOpen.tsx')).toMatch(/\{p\.locate && <Row [^\n]*testId="session-menu-locate"/);
    expect(src('tasks/TaskMenuRows.tsx')).toContain('<WatchMenuItem task={task}');
  });
});
describe('guard: no ResizeObserver callback renders React synchronously', () => {
  // A flushSync reached from an observer callback commits every update waiting then, whatever
  // component it belongs to, and a box above the observed one changing inside the callback is
  // WebKit's 'ResizeObserver loop completed with undelivered notifications'. Every file that
  // creates a ResizeObserver and calls flushSync is listed with why its flushSync is never on an
  // observer's path.
  const ALLOWED: Record<string, string> = {
    'components/common/FileThreadLayer.tsx': 'flushSync runs from its MutationObserver and effect only; its ResizeObserver goes through requestAnimationFrame (later)',
  };
  it('every file with both is listed with why', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '../../web/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const both = files
      .filter((f) => { const src = readFileSync(f, 'utf8'); return /new ResizeObserver\(/.test(src) && /\bflushSync\(/.test(src); })
      .map((f) => relative(root, f));
    expect(both.filter((f) => !ALLOWED[f]), 'a ResizeObserver path may reach flushSync: render as an ordinary update, or list it with why').toEqual([]);
    expect(Object.keys(ALLOWED).filter((f) => !both.includes(f)), 'a listed file no longer has both: drop it').toEqual([]);
  });
});
