/**
 * Overlay layer stack (web/src/hooks/useOverlayLayer.ts, spec G36 / C69):
 * Escape closes only the topmost layer and stops the event before any page
 * handler, an outside press closes from the top down until a layer contains
 * the target, and the click after a closing press is swallowed exactly once.
 * Fake nodes and events: the logic is duck-typed so it runs without a DOM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  hasOpenOverlayLayer, overlayLayerDepth, overlayLayerHandlers, registerOverlayLayer,
  type OverlayLayerOptions,
} from '../../web/src/hooks/useOverlayLayer';

/** A minimal node: `contains` walks parents, `closest` matches a class name. */
function node(cls: string, parent: FakeNode | null = null): FakeNode {
  const n: FakeNode = {
    nodeType: 1, cls, parent, parentElement: parent,
    contains: (other) => { for (let c: FakeNode | null = other; c; c = c.parent) if (c === n) return true; return false; },
    closest: (sel) => { for (let c: FakeNode | null = n; c; c = c.parent) if (sel === `.${c.cls}`) return c; return null; },
  };
  return n;
}
interface FakeNode {
  nodeType: number; cls: string; parent: FakeNode | null; parentElement: FakeNode | null;
  contains(o: FakeNode): boolean; closest(sel: string): FakeNode | null;
}
function ev(extra: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), stopPropagation: vi.fn(), ...extra };
}
const removers: (() => void)[] = [];
function layer(o: Partial<OverlayLayerOptions> & { el: FakeNode }) {
  const onClose = vi.fn();
  const opts = { current: { open: true, onClose, refs: [{ current: o.el as unknown as HTMLElement }], ...o } as OverlayLayerOptions };
  removers.push(registerOverlayLayer(opts));
  return onClose;
}
afterEach(() => { while (removers.length) removers.pop()!(); });

describe('useOverlayLayer stack', () => {
  const body = node('body');
  const menu = node('fb-menu', body);
  const flyout = node('fb-values-flyout', body);
  const row = node('todo-panel-item', body);

  it('Escape closes only the topmost layer and stops the event first', () => {
    const closeMenu = layer({ el: menu, exemptSelectors: ['.fb-values-flyout'] });
    const closeFly = layer({ el: flyout });
    expect(overlayLayerDepth()).toBe(2);
    const e = ev({ key: 'Escape' });
    overlayLayerHandlers.keydown(e as unknown as KeyboardEvent);
    expect(closeFly).toHaveBeenCalledWith('escape');
    expect(closeMenu).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(e.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(e.stopImmediatePropagation.mock.invocationCallOrder[0]);
  });
  it('other keys and an empty stack pass through untouched', () => {
    const e = ev({ key: 'Escape' });
    expect(hasOpenOverlayLayer()).toBe(false);
    overlayLayerHandlers.keydown(e as unknown as KeyboardEvent);
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    layer({ el: menu });
    const k = ev({ key: 'a' });
    overlayLayerHandlers.keydown(k as unknown as KeyboardEvent);
    expect(k.preventDefault).not.toHaveBeenCalled();
  });
  it('onEscape can consume the key without closing (clear search first)', () => {
    const close = layer({ el: menu, onEscape: () => true });
    const e = ev({ key: 'Escape' });
    overlayLayerHandlers.keydown(e as unknown as KeyboardEvent);
    expect(close).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });
  it('a press in an exempt child portal keeps the parent open', () => {
    const closeMenu = layer({ el: menu, exemptSelectors: ['.fb-values-flyout'] });
    overlayLayerHandlers.pointerdown(ev({ target: node('x', flyout) }) as unknown as PointerEvent);
    expect(closeMenu).not.toHaveBeenCalled();
  });
  it('an outside press closes every layer above the one that contains it, then swallows one click', () => {
    const closeMenu = layer({ el: menu, exemptSelectors: ['.fb-values-flyout'] });
    const closeFly = layer({ el: flyout });
    overlayLayerHandlers.pointerdown(ev({ target: node('x', menu) }) as unknown as PointerEvent);
    expect(closeFly).toHaveBeenCalledWith('outside');
    expect(closeMenu).not.toHaveBeenCalled();
    const click = ev();
    overlayLayerHandlers.click(click as unknown as MouseEvent);
    expect(click.stopImmediatePropagation).toHaveBeenCalled();
    const second = ev();
    overlayLayerHandlers.click(second as unknown as MouseEvent);
    expect(second.stopImmediatePropagation).not.toHaveBeenCalled();
  });
  it('a press on a task row closes the popover and the row click does not open the task', () => {
    const closeMenu = layer({ el: menu });
    overlayLayerHandlers.pointerdown(ev({ target: row }) as unknown as PointerEvent);
    expect(closeMenu).toHaveBeenCalledWith('outside');
    const click = ev();
    overlayLayerHandlers.click(click as unknown as MouseEvent);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(click.stopImmediatePropagation).toHaveBeenCalled();
  });
  it('a press that closes nothing never swallows a click', () => {
    layer({ el: menu });
    overlayLayerHandlers.pointerdown(ev({ target: node('x', menu) }) as unknown as PointerEvent);
    const click = ev();
    overlayLayerHandlers.click(click as unknown as MouseEvent);
    expect(click.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
