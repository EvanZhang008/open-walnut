/**
 * A hidden note on the Notes page and in its pop-out (docs/reference/locked-notes.md, "Hidden
 * notes"): plain text no agent tool reads, covered until Show, which needs no password. The cover
 * is a locked note's (LockedNotePanel) with the eye-off icon in place of the lock. Show holds for
 * this open only, in page memory: a note switch, closing and reopening the note, or a reload
 * covers it again. While shown the editor hands nothing to a model: no dictation, and the Notes
 * page's chat is not told which note is open (NotesPage).
 */
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/common/EmptyState';
import { ICON_EYE_OFF } from '@/components/common/Icons';
import { HIDDEN_NOTE_LINE, noteName } from './locked-note';

export function HiddenNoteCover({ notePath, onShow }: { notePath: string; onShow: () => void }) {
  return (
    <EmptyState
      size="pane"
      icon={ICON_EYE_OFF}
      title={noteName(notePath)}
      hint={HIDDEN_NOTE_LINE}
      action={{ label: 'Show', onClick: onShow, primary: true, testId: 'hidden-note-show' }}
      testId="hidden-note-cover"
      role="status"
    />
  );
}

/** The header's Hide: covers a shown note again (a hidden note's, and a locked note's in its panel). */
export function CoverButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <button type="button" className="btn btn-icon notes-cover-btn" onClick={onClick} aria-label="Hide the text" title="Hide" data-testid={testId}>
      {ICON_EYE_OFF}
    </button>
  );
}

/**
 * Whether the hidden note open under `openKey` (its editor's remount key: new for every open, kept
 * by a rename in place) is shown. Show is for that open only, so any other key reads covered, and
 * so is the same open once the note stops being hidden: hidden again (Unhide, then Hide from AI),
 * it is covered again.
 */
export function useHiddenNoteShown(openKey: string | null, hidden: boolean) {
  const [uncoveredFor, setUncoveredFor] = useState<string | null>(null);
  useEffect(() => { if (!hidden) setUncoveredFor(null); }, [hidden]);
  return {
    shown: openKey !== null && uncoveredFor === openKey,
    show: () => setUncoveredFor(openKey),
    cover: () => setUncoveredFor(null),
  };
}
