import { EmptyState } from '@/components/common/EmptyState';

/**
 * A note that is not there (deleted while this page was closed or since it was open, or never
 * written) and that the person did not set out to make: said plainly, never an empty editor,
 * which the next keystroke would save as the note again (2026-11-16, CI: a deleted note came
 * back that way). Writing it is still one click, on purpose, and create-only: a note someone
 * wrote meanwhile opens instead of being replaced (useNoteGone.ts).
 */
export function NoteMissingState({ path, onCreate, onClose, closeLabel = 'Close tab' }: {
  path: string;
  onCreate: () => void;
  onClose: () => void;
  closeLabel?: string;
}) {
  const name = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  return (
    <EmptyState
      size="pane"
      title="This note is not here"
      hint={<>“{name}” was deleted, or was never written.</>}
      action={{ label: 'Write it', onClick: onCreate }}
      testId="notes-missing-state"
    >
      <button type="button" className="btn btn-sm" onClick={onClose}>{closeLabel}</button>
    </EmptyState>
  );
}
