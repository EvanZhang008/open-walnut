/**
 * The drawn icon of a real button, shown again in a menu row that stands in for it: a header's
 * buttons put away into its More menu (HeaderFitMore) or a narrow session header's chips in its
 * "..." menu (SessionHeaderMore). Those rows click the real button, which stays mounted, so the
 * icon is copied from it too: one icon per action, never a second copy to drift, and the row is one
 * drawn icon and one line of words like every menu row (standard.md, Big menus; 2026-11-26: the
 * rows of these menus drew only the words).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import '@/styles/header-fit.css';

/** The first drawn icon inside `el` (an `<svg>`, or a mark that stands as one: `data-fit-icon`, a
 *  priority's coloured dot), or null when it draws none. */
export function drawnIconOf(el: Element | null | undefined): Element | null {
  return el?.querySelector('svg, [data-fit-icon]') ?? null;
}

/** `fallback` is drawn when the real button draws no icon of its own (a chip of words only, a
 *  plugin's pinned fact), so the row never shows an empty icon slot. */
export function MirroredIcon({ from, fallback }: { from: Element | null | undefined; fallback?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [found, setFound] = useState(true);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const icon = drawnIconOf(from);
    host.replaceChildren(...(icon ? [icon.cloneNode(true)] : []));
    setFound(!!icon);
  }, [from]);
  return (
    <>
      <span ref={ref} className="mirrored-icon" aria-hidden="true" />
      {!found && fallback}
    </>
  );
}
