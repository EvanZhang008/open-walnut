/**
 * Why a task hangs under a row of the Org list, on the row's guide line like a tree's node: an eye
 * (watched), a lock (its session panel is locked), or the two in one glyph. A lock is a button
 * (2026-11-17, the user: "when I click this little lock in the sidebar, it can unlock"): it unlocks
 * the panel the way the panel's own lock button does, the row stays with an open lock, and a second
 * click locks it again (useKeptLockToggle).
 */
import type { MouseEvent, ReactElement } from 'react';
import { ICON_EYE, ICON_LOCK, ICON_UNLOCK } from '@/components/common/Icons';
import { keptWhyKind, type KeptWhyKind } from './org-task-tabs';

/** The eye with a small lock on its lower right (cut out of the eye); `open`: the shackle open. */
const eyeWithLock = (open: boolean) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 7S3.5 3 7 3s6 4 6 4-2.5 4-6 4-6-4-6-4z" />
    <circle cx="7" cy="7" r="1.8" />
    <rect x="8.6" y="7.6" width="7.4" height="8.4" rx="1.6" stroke="none" style={{ fill: 'var(--bg-secondary)' }} />
    <rect x="9.9" y="11.2" width="5.4" height="4" rx="0.9" stroke="none" fill="currentColor" />
    <path d={open ? 'M11.2 11.2v-1.1a1.4 1.4 0 012.6-.7' : 'M11.2 11.2v-1.1a1.4 1.4 0 012.8 0v1.1'} strokeWidth="1.3" />
  </svg>
);
const ICON_EYE_LOCK = eyeWithLock(false);
const ICON_EYE_UNLOCK = eyeWithLock(true);

const GLYPH: Record<KeptWhyKind, ReactElement> = {
  eye: ICON_EYE, lock: ICON_LOCK, both: ICON_EYE_LOCK, unlocked: ICON_UNLOCK, 'eye-unlocked': ICON_EYE_UNLOCK,
};

export function KeptWhy({ watched, locked, relock, onToggleLock }: {
  watched: boolean; locked: boolean; relock?: boolean; onToggleLock?: () => void;
}) {
  const kind = keptWhyKind(watched, locked, relock);
  const lockable = !!onToggleLock && (locked || !!relock);
  if (!lockable) {
    const why = [watched && 'Watched', locked && 'Its session panel is locked'].filter(Boolean).join(' · ');
    return <span className="org-watched-why" data-testid="org-watched-why" data-why={kind} title={why} aria-hidden="true">{GLYPH[kind]}</span>;
  }
  // Its own control, never a part of the row's option: a click here only locks or unlocks.
  const toggle = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggleLock!(); };
  return (
    <button
      type="button"
      className="org-watched-why is-lock"
      data-testid="org-watched-why"
      data-why={kind}
      aria-label={locked ? 'Unlock session panel' : 'Lock session panel'}
      title={locked ? 'Unlock' : 'Lock'}
      onClick={toggle}
      // The button's own Enter / Space click toggles; the list's keys never see them.
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
    >
      {GLYPH[kind]}
    </button>
  );
}
