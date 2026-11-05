/**
 * Remote Hosts: the page's ONE "need a look" count, in the header beside Add host, so it stays in
 * reach in the sticky bar while the list scrolls (2026-11-04 review: it sat in the summary line,
 * which scrolled away under the bar after the first press; it always went to the first host; and
 * More settings showed a second count of its own). Each press shows the next host it counts
 * ("1 of 3", then 2, 3, back to 1); each of those rows carries a "Needs a look" tag.
 *
 * The header's controls move into the sticky bar once the pane scrolls, as new elements: which
 * host was shown is kept by the page (`look`), and the focus follows the button
 * (useFocusAcrossRemount), so the next press is right there.
 */
import { useEffect, useRef } from 'react';
import { useFocusAcrossRemount } from '@/utils/focus-across-remount';
import { useRowReports } from './host-list-store';
import { needsWords, nextLook } from './host-row-model';

/** Which counted host a press showed last, and its name (null before the first press). */
export interface LookAt { at: number | null; showing: string | null; count: number }

export function HostNeedsLook({ look, onLook, onShow }: {
  look: LookAt;
  onLook: (next: LookAt) => void;
  onShow: (index: number) => string | null;
}) {
  const rows = useRowReports();
  const count = rows.filter((r) => r.counted && r.needsLook).length;
  const ref = useRef<HTMLButtonElement>(null);
  useFocusAcrossRemount('rh-needs-look', ref);
  // A count that moved starts over: "2 of 3" would point at another host now.
  const at = look.count === count ? look.at : null;
  const showing = look.count === count ? look.showing : null;
  useEffect(() => { if (look.count !== count && look.at !== null) onLook({ at: null, showing: null, count }); }, [count, look, onLook]);
  if (count === 0) return null;
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={0}
      className="rh-needs-look"
      data-testid="rh-needs-look"
      title="Show the next host that needs a look"
      // The focus stays here (the next press is right here): the label says which host is shown.
      // WebKit focuses no button on a press: it would stay where it was, on the page at worst.
      aria-label={showing && at !== null ? `${needsWords(count, at)}: showing ${showing}` : undefined}
      onPointerDown={(e) => { e.currentTarget.focus({ preventScroll: true }); }}
      // WebKit's own mouse-down on a button that takes no mouse focus clears the focus again.
      onMouseDown={(e) => { e.preventDefault(); }}
      onClick={() => {
        const next = nextLook(count, at);
        onLook({ at: next, showing: onShow(next), count });
      }}
    >
      <span className="rh-needs-dot" aria-hidden="true" />
      {needsWords(count, at)}
    </button>
  );
}
