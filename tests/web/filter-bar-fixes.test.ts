/**
 * Fix round for the home Filter bar (nitpicks F11, F27, F09, F33): popovers keep
 * their left edge on the task panel, the Filter search knows old and view words,
 * Tab cycles inside the topmost overlay, and the create toast has a stable id.
 * Pure logic with fake nodes: runs without a DOM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { clampToPanelLeft } from '../../web/src/components/tasks/panel-menu-clamp';
import { searchFilterDims, viewHintFor } from '../../web/src/components/tasks/filter-bar-search';
import { DEFAULT_FILTER_STATE as S0, type FilterLists } from '../../web/src/components/tasks/filter-bar-types';
import { createdToastId } from '../../web/src/components/tasks/filter-bar-persist';
import { overlayLayerHandlers, registerOverlayLayer, type OverlayLayerOptions } from '../../web/src/hooks/useOverlayLayer';

const lists: FilterLists = {
  loading: false, projects: ['', 'Garden'], sources: [{ id: 'local', label: 'Local' }],
  tags: [], sprints: [], showPriority: false, tagLabel: (t) => t,
};

describe('clampToPanelLeft (F11)', () => {
  const placement = { top: 100, right: 1280 - 284, maxHeight: 400 };
  it('keeps a menu that fits right-aligned to its button', () => {
    // Panel 56..561, button right 284 would put a 200px menu at 84..284: inside the panel.
    expect(clampToPanelLeft({ placement, menuWidth: 200, panelLeft: 56, viewportWidth: 1280 })).toEqual(placement);
  });
  it('slides a menu that would cover the nav rail right to the panel edge', () => {
    const out = clampToPanelLeft({ placement, menuWidth: 380, panelLeft: 56, viewportWidth: 1280 });
    expect(1280 - out!.right - 380).toBe(56);
  });
  it('leaves an unmeasured menu alone', () => {
    expect(clampToPanelLeft({ placement: null, menuWidth: 380, panelLeft: 56, viewportWidth: 1280 })).toBeNull();
    expect(clampToPanelLeft({ placement, menuWidth: 380, panelLeft: null, viewportWidth: 1280 })).toEqual(placement);
  });
});

describe('Filter search words (F27)', () => {
  it('"week" finds the date the old quick filter called This week', () => {
    const hits = searchFilterDims('week', S0, lists).hits.map((h) => `${h.dimLabel}  ${h.valueLabel}`);
    expect(hits).toContain('Date  Starting within 7 days');
  });
  it('view words get the open-Display hint instead of "no filter matches"', () => {
    for (const [q, view] of [['focus', 'Focus'], ['tier', 'Focus'], ['pin', 'Pinned'], ['parked', 'Parked']] as const) {
      const r = searchFilterDims(q, S0, lists);
      expect(r.viewHint, q).toBe(view);
    }
    expect(searchFilterDims('pinned', S0, lists).pinHint).toBe(true);
    expect(viewHintFor('fo')).toBeNull();
    expect(viewHintFor('garden')).toBeNull();
  });
});

describe('createdToastId (F33)', () => {
  it('is stable per task, so the hidden-by-filters toast can replace "Task created"', () => {
    expect(createdToastId('t1')).toBe(createdToastId('t1'));
    expect(createdToastId('t1')).not.toBe(createdToastId('t2'));
  });
});

/** A focusable fake: tabIndex, a layout box, focus() records itself as active. */
interface FakeEl { name: string; tabIndex: number; disabled?: boolean; focus(): void; scrollIntoView(): void; getClientRects(): unknown[]; closest(): null }
const doc = { activeElement: null as FakeEl | null };
function el(name: string, tabIndex = 0): FakeEl {
  const e: FakeEl = {
    name, tabIndex,
    focus: () => { doc.activeElement = e; },
    scrollIntoView: () => {},
    getClientRects: () => [{}],
    closest: () => null,
  };
  return e;
}
function tab(shiftKey = false) {
  const e = { key: 'Tab', shiftKey, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  overlayLayerHandlers.keydown(e as unknown as KeyboardEvent);
  return e;
}

describe('Tab stays inside the topmost overlay (F09)', () => {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; g.document = saved; doc.activeElement = null; });

  it('cycles forward and back through the popover stops, skipping tabIndex -1', () => {
    g.document = doc;
    const stops = [el('search'), el('add square', -1), el('Inbox'), el('Garden')];
    const root = { querySelectorAll: () => stops };
    const opts = { current: { open: true, onClose: () => {}, refs: [{ current: root as unknown as HTMLElement }] } as OverlayLayerOptions };
    off = registerOverlayLayer(opts);
    stops[0].focus();
    expect(tab().prevented).toBe(true);
    expect(doc.activeElement?.name).toBe('Inbox');
    tab();
    expect(doc.activeElement?.name).toBe('Garden');
    tab(); // wraps instead of leaving for the page behind
    expect(doc.activeElement?.name).toBe('search');
    tab(true);
    expect(doc.activeElement?.name).toBe('Garden');
  });

  it('moves focus from outside the layer (its trigger) to the first stop', () => {
    g.document = doc;
    const stops = [el('All'), el('Pinned')];
    const root = { querySelectorAll: () => stops };
    off = registerOverlayLayer({ current: { open: true, onClose: () => {}, refs: [{ current: root as unknown as HTMLElement }] } });
    doc.activeElement = el('Display button');
    tab();
    expect(doc.activeElement?.name).toBe('All');
  });

  it('leaves Tab alone with no layer open, or when the layer opts out', () => {
    g.document = doc;
    expect(tab().prevented).toBe(false);
    const root = { querySelectorAll: () => [el('a')] };
    off = registerOverlayLayer({ current: { open: true, onClose: () => {}, trapFocus: false, refs: [{ current: root as unknown as HTMLElement }] } });
    expect(tab().prevented).toBe(false);
  });
});
