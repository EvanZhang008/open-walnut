/**
 * NewLauncherButton — compact "+" icon button in the TODO panel toolbar.
 *
 * ONE verb: it grows an empty DRAFT SESSION column (no popover, no tabs, no
 * network). It used to open a Session|Task launcher popover, which is why the
 * tooltip said "New session or task"; task creation now lives INSIDE the draft
 * ("◌ Create task for later"), so advertising a task branch here points at a
 * chooser that no longer exists.
 *
 * Styled as a twin of the View (sliders) button so the toolbar reads as one
 * control family.
 */

const ICON_PLUS = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M8 3v10M3 8h10" />
  </svg>
);

interface NewLauncherButtonProps {
  onOpen: () => void;
}

export function NewLauncherButton({ onOpen }: NewLauncherButtonProps) {
  return (
    <button
      className="new-launcher-btn"
      onClick={onOpen}
      title="New session"
      aria-label="New session"
    >
      {ICON_PLUS}
    </button>
  );
}
