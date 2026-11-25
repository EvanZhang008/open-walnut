import type { ReactNode } from 'react';
import { ICON_EYE_OFF, ICON_LOCK } from '@/components/common/Icons';
import type { NoteListItem } from '@/api/notes-v2';
import type { NoteProtection } from './locked-note';

/**
 * The quiet mark after a protected note's name in the tree, Recent, Bookmarks and search rows
 * (docs/reference/locked-notes.md): a lock for a locked note, an eye-off for a hidden one.
 */
const MARK: Record<NoteProtection, { icon: ReactNode; label: string; title: string; testId: string }> = {
  locked: { icon: ICON_LOCK, label: 'Locked', title: 'Locked note', testId: 'tree-note-locked' },
  hidden: { icon: ICON_EYE_OFF, label: 'Hidden from AI', title: 'Hidden from AI', testId: 'tree-note-hidden' },
};

export function LockedMark({ kind = 'locked' }: { kind?: NoteProtection }) {
  const m = MARK[kind];
  return <span className="notes-tree-lock" role="img" aria-label={m.label} title={m.title} data-testid={m.testId}>{m.icon}</span>;
}

/** Every protected note of the list by path, for the rows' marks (the lock wins over hidden). */
export function protectedNotes(notes: NoteListItem[]): Map<string, NoteProtection> {
  const out = new Map<string, NoteProtection>();
  for (const n of notes) {
    if (n.locked) out.set(n.path, 'locked');
    else if (n.hidden) out.set(n.path, 'hidden');
  }
  return out;
}

/** The mark of `path`, or nothing for a plain note. */
export function markOf(marks: Map<string, NoteProtection> | undefined, path: string) {
  const kind = marks?.get(path);
  return kind ? <LockedMark kind={kind} /> : null;
}
