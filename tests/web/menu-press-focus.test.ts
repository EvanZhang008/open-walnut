/**
 * The rule behind "a press on a menu item never scrolls its menu" (web/src/utils/menu-press-focus.ts):
 * the engine's focus-on-press is prevented for every menu item, and the item is focused by script
 * with preventScroll afterwards unless the page claimed the press. The WebKit half, a real press on a
 * cut row of a capped menu, is tests/e2e/browser/menu-clipped-row-press.spec.ts, which also covers a
 * menu that stops the press (linkedom has no capture phase to show it here).
 */
import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { installMenuPressFocus, menuPressItem } from '../../web/src/utils/menu-press-focus';

function page() {
  const { document, window } = parseHTML(`<!doctype html><html><body>
    <div role="menu" id="m">
      <button role="menuitem" id="item"><span id="label">Rename</span></button>
      <button role="menuitemradio" id="radio">Sort</button>
      <button role="menuitemcheckbox" id="check">Show done</button>
      <div role="menuitem" id="stopper" tabindex="-1">Ancestor 7</div>
      <button role="menuitem" id="keeper">Quote</button>
      <div role="menuitem" id="with-field"><input id="field"></div>
      <div role="menuitem" id="drag" draggable="true"><span id="drag-label">Drag me</span></div>
      <div class="wn-context-menu-reason" id="reason">Why</div>
    </div>
    <button role="menuitem" id="stray">Not in a menu</button>
    <button id="plain">Plain</button>
  </body></html>`);
  return { document, window };
}

describe('menuPressItem', () => {
  const { document: doc } = page();
  const at = (id: string) => doc.getElementById(id);

  it('takes every kind of menu item, and a press on its label', () => {
    expect(menuPressItem(at('item'))).toBe(at('item'));
    expect(menuPressItem(at('label'))).toBe(at('item'));
    expect(menuPressItem(at('label')!.firstChild)).toBe(at('item'));
    for (const id of ['radio', 'check', 'stopper']) expect(menuPressItem(at(id)), id).toBe(at(id));
  });

  it('leaves a field inside an item, a drag source and anything outside an item alone', () => {
    for (const id of ['field', 'drag', 'drag-label', 'reason', 'm', 'stray', 'plain']) {
      expect(menuPressItem(at(id)), id).toBeNull();
    }
    expect(menuPressItem(null)).toBeNull();
  });
});

describe('installMenuPressFocus', () => {
  function setup() {
    const { document: doc, window: win } = page();
    vi.useFakeTimers();
    // linkedom has no timers of its own on its window: run them on the faked global clock.
    (win as unknown as { setTimeout: typeof setTimeout }).setTimeout = setTimeout;
    installMenuPressFocus(win as unknown as Window);
    const focused: string[] = [];
    for (const el of doc.querySelectorAll('[role="menuitem"], [role^="menuitem"], #plain')) {
      (el as HTMLElement).focus = (o?: FocusOptions) => { focused.push(`${el.id}:${JSON.stringify(o)}`); };
    }
    const press = (id: string) => {
      const e = new win.Event('mousedown', { bubbles: true, cancelable: true }) as Event & { button: number };
      Object.defineProperty(e, 'button', { value: 0 });
      doc.getElementById(id)!.dispatchEvent(e);
      vi.runAllTimers();
      return e.defaultPrevented;
    };
    return { doc, press, focused };
  }

  it('prevents the engine focus and focuses the item without a scroll', () => {
    const { press, focused } = setup();
    expect(press('label')).toBe(true);
    expect(focused).toEqual(['item:{"preventScroll":true}']);
    vi.useRealTimers();
  });

  it('moves no focus when the page claimed the press itself', () => {
    const { doc, press, focused } = setup();
    doc.getElementById('keeper')!.addEventListener('mousedown', (e: Event) => e.preventDefault());
    expect(press('keeper')).toBe(true);
    expect(focused).toEqual([]);
    vi.useRealTimers();
  });

  it('leaves fields and plain buttons to the engine', () => {
    const { press, focused } = setup();
    expect(press('field')).toBe(false);
    expect(press('plain')).toBe(false);
    expect(focused).toEqual([]);
    vi.useRealTimers();
  });
});
