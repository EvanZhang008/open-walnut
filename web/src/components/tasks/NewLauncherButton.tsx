/**
 * NewLauncherButton — compact "+" icon button in the TODO panel toolbar.
 * Opens the todo-anchored launcher popover (Session / Task tabs, Session
 * default). Styled as a twin of the View (sliders) button so the toolbar
 * reads as one control family.
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
      title="New session or task"
      aria-label="New session or task"
    >
      {ICON_PLUS}
    </button>
  );
}
