/**
 * NewLauncherButton — primary "New task" action in the task-panel toolbar.
 *
 * A task may remain sessionless ("Create task for later") or start with a
 * session. Both paths begin in the same draft column, so the toolbar presents
 * one task-first verb instead of exposing that implementation detail.
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
      title="New task"
      aria-label="New task"
    >
      {ICON_PLUS}
      <span className="new-launcher-label" aria-hidden="true">New task</span>
    </button>
  );
}
