import { ICON_LOCK } from '@/components/common/Icons';

/** The lock beside a locked note's name, in every row that names one (docs/reference/locked-notes.md). */
export function LockedMark() {
  return <span className="notes-tree-lock" role="img" aria-label="Locked" title="Locked note" data-testid="tree-note-locked">{ICON_LOCK}</span>;
}
