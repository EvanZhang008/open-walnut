/**
 * Escape must never reach AppKit — the "beep" fix for the Mac app.
 *
 * The desktop app is a WKWebView. When a keydown finishes travelling through the
 * page and NOBODY called preventDefault(), WebKit hands the key to the AppKit
 * responder chain: Escape arrives as `cancelOperation:`, no responder handles it,
 * and NSBeep fires. Walnut has ~90 Escape handlers and most only close their own
 * overlay (`useModalOverlay` stops propagation), so every Escape beeped — and
 * with nothing open at all (the Files tab, an idle board) nothing handled the key
 * in the first place.
 *
 * The beep is the NATIVE default action taken AFTER the page is done with the
 * event, so the suppression belongs at the END of the page's involvement and
 * never at the start. Preventing up front poisons `event.defaultPrevented`, which
 * both editors in this app read as "some other owner already took this event" and
 * then skip their own dispatch entirely (@codemirror/view `eventBelongsToEditor` +
 * `runHandlers`, prosemirror-view `eventBelongsToView` + `runCustomHandler`). An
 * up-front guard therefore silently disabled CodeMirror's Escape bindings:
 * `simplifySelection` from `defaultKeymap` (collapse a multi-cursor/expanded
 * selection in the Files-panel source editor) and `tabFocusMode`, which is the
 * keyboard way out of an editor.
 *
 * So the guard is two listeners on `window`, each firing only once the page can no
 * longer act on the key:
 *  - BUBBLE, installed before the app mounts so it is the first window-bubble
 *    listener: an Escape that reached here travelled the whole tree unclaimed.
 *  - CAPTURE, which prevents nothing itself and instead folds the suppression into
 *    this one event's `stopPropagation`/`stopImmediatePropagation`. Stopping
 *    Escape IS claiming it (FileContentView's fullscreen exit, useFullscreen,
 *    ContextMenu all stop without preventing), and such an event never reaches the
 *    bubble listener, so without this hook the beep returns for exactly those
 *    handlers. React's synthetic `stopPropagation` delegates to the native event's,
 *    so React handlers go through the hook too.
 *
 * IME composition is exempt so Escape can still cancel a candidate window.
 */

/** Escapes prevented by the guard because the page never did — the tell that `defaultPrevented` is only ours. */
const guarded = new WeakSet<KeyboardEvent>();

type KeyTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Install the guard. Returns an uninstall function.
 * `target` exists for the node test tier (no DOM); production always uses `window`.
 */
export function installEscapeBeepGuard(target?: KeyTarget): () => void {
  const host = target ?? (typeof window === 'undefined' ? null : window);
  if (!host) return () => { /* no DOM */ };

  // Call sites must already be past the point where the page can claim the key.
  const suppressBeep = (e: KeyboardEvent) => {
    // A handler that prevented it itself owns the default; re-marking that event
    // would make escapeWasConsumedByOthers lie about who took the key.
    if (e.defaultPrevented) return;
    guarded.add(e);
    e.preventDefault();
  };

  const onCapture = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const stop = e.stopPropagation.bind(e);
    const stopImmediate = e.stopImmediatePropagation.bind(e);
    e.stopPropagation = () => { suppressBeep(e); stop(); };
    e.stopImmediatePropagation = () => { suppressBeep(e); stopImmediate(); };
  };

  const onBubble = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    suppressBeep(e);
  };

  host.addEventListener('keydown', onCapture as EventListener, true);
  host.addEventListener('keydown', onBubble as EventListener);
  return () => {
    host.removeEventListener('keydown', onCapture as EventListener, true);
    host.removeEventListener('keydown', onBubble as EventListener);
  };
}

/**
 * Did a real page handler take this Escape's default, rather than the beep guard?
 * A handler gated on this still runs when the guard was the only thing that
 * prevented the event. Handlers that claim Escape by stopping propagation instead
 * are recorded as guard-prevented, which is moot: nothing further up the tree is
 * reached at all, so there is nobody left to gate.
 */
export function escapeWasConsumedByOthers(e: KeyboardEvent): boolean {
  return e.defaultPrevented && !guarded.has(e);
}
