/**
 * The tree drawer's header button (spec 6.1): list icon + `<n> open`,
 * `<n> open · <m> look answered` (narrow: `<n> open`), or `All done` on a green
 * count pill. It sits in a FIXED slot of the session header, the same at root
 * and at depth, so it never moves when the page changes.
 *
 * No jitter (C75): its min-width is fixed per width tier to the longest label
 * that tier can show, so `1 open` becoming `All done` moves neither the title
 * nor the controls after it. A changed count bumps the pill once (200ms scale),
 * never under reduced motion (C48, the CSS drops the animation there).
 */
import { useEffect, useRef, useState } from 'react';
import type { ThreadDrawerToggleProps } from '@/components/sessions/thread-ui-contract';
import { ThreadListIcon } from '@/components/sessions/ThreadIcons';
import { openChipCount, toggleLabel, toggleTitle } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

const BUMP_MS = 200;

function isMac(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent);
}

/** Width tier: `base` fits `All done` and `<n> open`; `answered` fits the long
 *  `<n> open · <m> look answered`; `narrow-answered` fits `<n> to check`. */
export function toggleTier(c: ThreadDrawerToggleProps['counts'], narrow: boolean): 'base' | 'answered' | 'narrow-answered' {
  if (c.suggested === 0 || openChipCount(c) === 0) return 'base';
  // Narrow shows `<n> open` while any is open: the base width fits it, and the
  // session title keeps the rest of a 360px header (N47). Only `<n> to check`
  // needs the wider narrow slot.
  if (narrow) return c.open > 0 ? 'base' : 'narrow-answered';
  return 'answered';
}

export function ThreadDrawerToggle({ counts, expanded, narrow, onToggle }: ThreadDrawerToggleProps) {
  const label = toggleLabel(counts, { narrow });
  const allDone = openChipCount(counts) === 0;
  const [bump, setBump] = useState(0);
  const prevLabel = useRef(label);

  useEffect(() => {
    if (prevLabel.current === label) return;
    prevLabel.current = label;
    setBump((n) => n + 1);
    const t = setTimeout(() => setBump(0), BUMP_MS + 40);
    return () => clearTimeout(t);
  }, [label]);

  return (
    <button
      type="button"
      className="thread-drawer-toggle"
      data-tier={toggleTier(counts, narrow)}
      data-all-done={allDone ? 'true' : undefined}
      aria-expanded={expanded}
      aria-haspopup="tree"
      title={toggleTitle(counts, { mac: isMac(), narrow })}
      onClick={onToggle}
    >
      <ThreadListIcon size={14} />
      <span
        key={bump}
        className={bump ? 'thread-drawer-toggle-count thread-drawer-toggle-count--bump' : 'thread-drawer-toggle-count'}
      >
        {label}
      </span>
    </button>
  );
}
