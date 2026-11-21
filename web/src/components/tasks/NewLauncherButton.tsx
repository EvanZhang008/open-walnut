/**
 * NewLauncherButton: the "New task" action in the task-panel toolbar, the family's quiet key.
 *
 * A task may remain sessionless ("Save as todo") or start with a
 * session. Both paths begin in the same draft column, so the toolbar presents
 * one task-first verb instead of exposing that implementation detail.
 */
import { ShortcutHint } from '@/keyboard/ShortcutHint';

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
      className="new-launcher-btn btn btn-ghost btn-sm"
      onClick={onOpen}
      title="New task"
      aria-label="New task"
      data-fit-button="2"
    >
      {ICON_PLUS}
      <span className="new-launcher-label" aria-hidden="true" data-fit-label="">New task</span>
      <ShortcutHint command="task.new" />
    </button>
  );
}
