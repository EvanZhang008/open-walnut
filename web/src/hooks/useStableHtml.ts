import { useRef } from 'react';

/**
 * A `dangerouslySetInnerHTML` prop whose OBJECT IDENTITY is stable while the html
 * string is unchanged.
 *
 * ⚠️ Why this exists (and why an inline `{{ __html }}` literal is a bug in any
 * element that re-renders while the user might be selecting inside it):
 *
 * React 19's `setProp` writes `domElement.innerHTML = value.__html`
 * UNCONDITIONALLY — there is no string comparison in that branch (read in
 * `react-dom/cjs/react-dom-client.development.js`, `case
 * "dangerouslySetInnerHTML"`). The only thing that can stop the write is the
 * caller: `updateProperties` skips a prop entirely when `nextProp === lastProp`.
 * An inline `{{ __html: html }}` allocates a NEW object every render, so the
 * comparison can never hold and every re-render re-parses the html and REPLACES
 * every child node — even when the html is byte-identical.
 *
 * React 18 did compare the strings, which is why `useSelectionFrozen`
 * (`utils/selection-guard.ts`) was written as "freeze the html string and React
 * skips the write". That contract silently died with the React 19 upgrade: a
 * text selection inside a streaming reply was destroyed by the next delta even
 * though the freeze had correctly held the string, and with it went the Copy /
 * Ask pill ("I select text while it is still generating and it gets cancelled",
 * reported 2026-09-08). Measured then: `innerHTML len=159 identical=true` and
 * the selection collapsed in the same frame.
 *
 * So: every markdown/html body that can re-render under a live selection takes
 * its prop from here. Keep the string memoized upstream too — this hook can only
 * hold identity for a string that is itself stable.
 *
 * A ref rather than `useMemo` on purpose: `useMemo` is documented as a
 * performance hint React may drop, and a dropped cache here is not a slower
 * render, it is a destroyed selection. A ref is a guarantee at the same cost.
 */
export function useStableHtml(html: string): { __html: string } {
  const ref = useRef<{ __html: string }>({ __html: html });
  if (ref.current.__html !== html) ref.current = { __html: html };
  return ref.current;
}

/**
 * The same guarantee where a hook cannot go (inside a `.map`, a JSX branch): one
 * prop object per html STRING, from a small recently-used cache. An evicted
 * string costs one extra innerHTML write, never a wrong one.
 *
 * 2026-10-29: the provenance card's plain segment passed an inline literal, so
 * every status push to the Org page's CEO chat (dozens a minute) rewrote the
 * user's message under the card and reloaded its screenshot: the image went to
 * 0px, the timeline shrank by ~400px and the image-load corrector pinned it
 * back, which read as the chat flashing (WKWebView, the Mac app).
 */
const STABLE_MAX_ENTRIES = 1000;
const STABLE_MAX_CHARS = 4_000_000;
const stableCache = new Map<string, { __html: string }>();
let stableChars = 0;

export function stableHtml(html: string): { __html: string } {
  const hit = stableCache.get(html);
  if (hit) {
    // Most recently used goes last; eviction takes from the front.
    stableCache.delete(html);
    stableCache.set(html, hit);
    return hit;
  }
  const prop = { __html: html };
  stableCache.set(html, prop);
  stableChars += html.length;
  while (stableCache.size > STABLE_MAX_ENTRIES || stableChars > STABLE_MAX_CHARS) {
    const oldest = stableCache.keys().next().value as string;
    if (oldest === html) break;
    stableCache.delete(oldest);
    stableChars -= oldest.length;
  }
  return prop;
}
