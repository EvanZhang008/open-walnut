/**
 * Escape must not beep in the Mac app, WITHOUT poisoning `defaultPrevented`.
 *
 * The bug: the desktop app is a WKWebView, so an Escape keydown that nobody
 * preventDefault()s is handed to the AppKit responder chain as
 * `cancelOperation:`, nothing handles it, and NSBeep fires. Walnut's ~90 Escape
 * handlers mostly stopPropagation without preventing, and with nothing open at
 * all (the Files tab) nothing handles the key — so every Escape beeped.
 *
 * The regression that shaped this file: preventing in the CAPTURE phase fixed the
 * beep but disabled Escape inside CodeMirror and ProseMirror, which both treat
 * `event.defaultPrevented` as "another owner already took this event" and skip
 * their own dispatch. So the MECHANISM is what gets pinned here, not just the
 * outcome: nothing may be prevented until the page is finished with the key,
 * which happens either at the end of propagation or at the instant a handler
 * stops propagation. The node test tier has no DOM (no jsdom in the repo), so the
 * propagation order is modelled explicitly below — which is the part worth
 * asserting anyway.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  installEscapeBeepGuard, escapeWasConsumedByOthers,
} from '../../web/src/utils/escape-beep-guard';

type Listener = (e: FakeKeyEvent) => void;

class FakeKeyEvent {
  defaultPrevented = false;
  propagationStopped = false;
  constructor(public key: string, public isComposing = false) {}
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; }
}

/** window stand-in that keeps the capture and bubble registrations apart. */
class FakeWindow {
  capture: Listener[] = [];
  bubble: Listener[] = [];
  addEventListener(type: string, l: Listener, capture?: boolean) {
    if (type !== 'keydown') return;
    (capture ? this.capture : this.bubble).push(l);
  }
  removeEventListener(type: string, l: Listener, capture?: boolean) {
    if (type !== 'keydown') return;
    const list = capture ? this.capture : this.bubble;
    const i = list.indexOf(l);
    if (i >= 0) list.splice(i, 1);
  }
}

/**
 * Browser dispatch order for a key pressed on a deep element: window's CAPTURE
 * listeners, then the handlers between (the app's editors and overlays), then
 * window's BUBBLE listeners. Each `betweenHandlers` entry stands for a separate
 * node, so stopping propagation abandons the rest of the walk.
 */
function dispatchKeydown(win: FakeWindow, e: FakeKeyEvent, betweenHandlers: Listener[] = []): FakeKeyEvent {
  for (const phase of [win.capture, betweenHandlers, win.bubble]) {
    for (const l of phase) {
      l(e);
      if (e.propagationStopped) return e;
    }
  }
  return e;
}

/**
 * How @codemirror/view (`eventBelongsToEditor`, `runHandlers`) and
 * prosemirror-view (`eventBelongsToView`, `runCustomHandler`) gate their own key
 * dispatch. If the guard prevents before this runs, every Escape binding in both
 * editors is dead — that is the regression this shape exists to catch.
 */
function editorShapedHandler(onEscape: () => void): Listener {
  return (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') onEscape();
  };
}

let win: FakeWindow;
let uninstall: () => void;

const asTarget = (w: FakeWindow) => w as unknown as Window;
const asKeyEvent = (e: FakeKeyEvent) => e as unknown as KeyboardEvent;

beforeEach(() => {
  win = new FakeWindow();
  uninstall = installEscapeBeepGuard(asTarget(win));
});

describe('escape beep guard', () => {
  it('registers one capture listener and one bubble listener', () => {
    expect(win.capture).toHaveLength(1);
    expect(win.bubble).toHaveLength(1);
  });

  it('does not prevent the default before in-page handlers run', () => {
    // THE regression: an editor that sees defaultPrevented skips its own Escape
    // bindings (CodeMirror's simplifySelection, tabFocusMode).
    let editorRan = false;
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [
      editorShapedHandler(() => { editorRan = true; }),
    ]);

    expect(editorRan).toBe(true);
    // ...and the beep is still suppressed, at the end of propagation.
    expect(e.defaultPrevented).toBe(true);
  });

  it('prevents the default when nothing else handles Escape at all', () => {
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'));
    expect(e.defaultPrevented).toBe(true);
  });

  it('prevents the default at the instant a handler stops propagation', () => {
    // FileContentView's fullscreen exit, useFullscreen and ContextMenu all stop
    // Escape without preventing it. The bubble listener can never see such an
    // event, so the suppression has to ride stopPropagation itself.
    let bubbleRan = false;
    win.bubble.push(() => { bubbleRan = true; });

    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [(ev) => ev.stopPropagation()]);

    expect(e.defaultPrevented).toBe(true);
    expect(bubbleRan).toBe(false);
  });

  it('prevents the default at the instant a handler stops immediate propagation', () => {
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [(ev) => ev.stopImmediatePropagation()]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('an editor ahead of a stopping handler still sees an unprevented Escape', () => {
    // Order matters: the editor sits below the overlay that stops, so it must get
    // a clean event even though the overlay's stop will prevent a moment later.
    let editorRan = false;
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [
      editorShapedHandler(() => { editorRan = true; }),
      (ev) => ev.stopPropagation(),
    ]);

    expect(editorRan).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('guard-only prevention does NOT read as consumed by others', () => {
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'));
    expect(escapeWasConsumedByOthers(asKeyEvent(e))).toBe(false);
  });

  it('a page handler preventing it DOES read as consumed by others', () => {
    // Impossible under the old capture-phase guard (it always got there first, so
    // the flag was permanently false). MainPage's task-unfocus depends on this
    // telling a real claim apart from beep suppression.
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [(ev) => ev.preventDefault()]);

    expect(e.defaultPrevented).toBe(true);
    expect(escapeWasConsumedByOthers(asKeyEvent(e))).toBe(true);
  });

  it('an overlay that prevents before stopping reads as consumed by others', () => {
    // useModalOverlay's order. Stopping first would credit the GUARD with the key.
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [
      (ev) => { ev.preventDefault(); ev.stopPropagation(); },
    ]);

    expect(escapeWasConsumedByOthers(asKeyEvent(e))).toBe(true);
  });

  it('an earlier window-capture handler preventing it reads as consumed by others', () => {
    win.capture.unshift((ev) => ev.preventDefault());

    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'));
    expect(escapeWasConsumedByOthers(asKeyEvent(e))).toBe(true);
  });

  it('a window-bubble handler registered after the guard sees the guard prevention', () => {
    // Why MainPage's Escape handler cannot read defaultPrevented directly: the
    // guard's bubble listener is installed before the app mounts, so it runs first.
    let sawPrevented: boolean | null = null;
    let sawConsumedByOthers: boolean | null = null;
    win.bubble.push((ev) => {
      sawPrevented = ev.defaultPrevented;
      sawConsumedByOthers = escapeWasConsumedByOthers(asKeyEvent(ev));
    });

    dispatchKeydown(win, new FakeKeyEvent('Escape'));

    expect(sawPrevented).toBe(true);
    expect(sawConsumedByOthers).toBe(false);
  });

  it('leaves other keys alone, stopped or not', () => {
    for (const key of ['Enter', 'Tab', 'a', 'ArrowDown', 'Meta']) {
      expect(dispatchKeydown(win, new FakeKeyEvent(key)).defaultPrevented, key).toBe(false);
      const stopped = dispatchKeydown(win, new FakeKeyEvent(key), [(ev) => ev.stopPropagation()]);
      expect(stopped.defaultPrevented, `${key} stopped`).toBe(false);
    }
  });

  it('leaves a composing Escape to the IME, stopped or not', () => {
    const e = dispatchKeydown(win, new FakeKeyEvent('Escape', true));
    expect(e.defaultPrevented).toBe(false);
    expect(escapeWasConsumedByOthers(asKeyEvent(e))).toBe(false);

    const stopped = dispatchKeydown(win, new FakeKeyEvent('Escape', true), [(ev) => ev.stopPropagation()]);
    expect(stopped.defaultPrevented).toBe(false);
  });

  it('uninstall removes both listeners', () => {
    uninstall();
    expect(win.capture).toHaveLength(0);
    expect(win.bubble).toHaveLength(0);

    const e = dispatchKeydown(win, new FakeKeyEvent('Escape'), [(ev) => ev.stopPropagation()]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('installs into nothing (no crash) when there is no DOM', () => {
    // Server-side / node import path: no window, no target.
    expect(() => installEscapeBeepGuard()()).not.toThrow();
  });
});
