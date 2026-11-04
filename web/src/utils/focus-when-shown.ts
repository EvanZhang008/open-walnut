/**
 * Focus a box once it can take focus. A box in a hidden page (Home stays mounted, hidden, while
 * another route shows: App.tsx `visible`) or a collapsed column silently swallows focus(), so the
 * caret stayed on <body> and what the person typed next went nowhere (2026-11-03: New task from a
 * mail opened its draft while Home was still hidden, and the caret was not in the prompt). Tries
 * every frame until the box is shown and focused, for at most `maxMs` of wall time (frames are slow
 * on a loaded machine, so a frame count is no budget); at the end it focuses the box anyway, as
 * before this waited. The first try is at once, so a box already on screen has the caret in the
 * frame it first paints. Returns the cancel.
 */
export function focusWhenShown(
  get: () => HTMLTextAreaElement | HTMLInputElement | null,
  onFocused?: (el: HTMLTextAreaElement | HTMLInputElement) => void,
  maxMs = 3000,
): () => void {
  const until = Date.now() + maxMs;
  let raf = 0;
  const attempt = (first = false) => {
    const el = get();
    const last = Date.now() >= until;
    if (el && (el.offsetParent !== null || last)) {
      el.focus();
      if (document.activeElement === el || last) {
        onFocused?.(el);
        // The first try runs inside the commit, before the rest of its effects: one of them may
        // still take focus (the old first try ran a frame later, after all of them), so look once
        // more on the next frame and keep trying if the box lost it.
        if (first && !last) raf = requestAnimationFrame(() => { if (document.activeElement !== get()) attempt(); });
        return;
      }
    }
    if (!last) raf = requestAnimationFrame(() => attempt());
  };
  attempt(true);
  return () => cancelAnimationFrame(raf);
}
