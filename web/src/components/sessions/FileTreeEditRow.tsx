/**
 * FileTreeEditRow — the inline name input the file tree shows while creating or
 * renaming an entry, VS Code style: the row keeps its normal chrome (arrow slot,
 * icon, indent) so the pending entry sits exactly where the real one will.
 *
 * Commit semantics are VS Code's, and deliberately so: Enter commits, Escape
 * cancels, and BLUR COMMITS a non-empty name (clicking away is not "throw my
 * typing out"). A rejected commit (bad name / server error) keeps the row so the
 * name can be fixed in place, which is why `error` is a prop and not a toast.
 */
import { useEffect, useRef } from 'react';

interface Props {
  kind: 'create-file' | 'create-dir' | 'rename';
  /** Tree depth of the row — same arithmetic as the real rows. */
  depth: number;
  /** Pre-filled name (rename); creates start empty. */
  initialValue?: string;
  /** Type of the entry being renamed — picks the icon (creates get it from `kind`). */
  entryType?: 'dir' | 'file';
  /** Select only the part before the extension, so typing replaces the stem. */
  stemLength?: number;
  error?: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

const ARIA_LABEL: Record<Props['kind'], string> = {
  'create-file': 'New file name',
  'create-dir': 'New folder name',
  rename: 'New name',
};

export function FileTreeEditRow({
  kind, depth, initialValue = '', entryType, stemLength, error, onCommit, onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter/Escape already decided this row's fate; the blur they cause must not
  // fire a SECOND commit (which would re-POST the same name and 409).
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (initialValue) {
      const end = stemLength && stemLength > 0 ? stemLength : initialValue.length;
      el.setSelectionRange(0, end);
    }
    // Mount-only: re-running on prop changes would yank the caret mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A rejected commit leaves the row up — put the caret back so the fix is one
  // keystroke away instead of one click plus one keystroke.
  useEffect(() => {
    if (error) { settledRef.current = false; inputRef.current?.focus(); }
  }, [error]);

  const indent = `${8 + depth * 14}px`;
  const isDir = kind === 'create-dir' || (kind === 'rename' && entryType === 'dir');

  return (
    <div>
      <div
        className="session-file-explorer-node sfe-edit-row"
        style={{ paddingLeft: indent }}
      >
        <span className="sfe-arrow" />
        <span className="sfe-icon">{isDir ? '📁' : '📄'}</span>
        <input
          ref={inputRef}
          className="sfe-edit-input"
          aria-label={ARIA_LABEL[kind]}
          defaultValue={initialValue}
          spellCheck={false}
          autoComplete="off"
          // Typing RE-ARMS the row: after a rejected commit the name changed, so
          // a later blur must be allowed to try again.
          onChange={() => { settledRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              settledRef.current = true;
              onCommit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              settledRef.current = true;
              onCancel();
            }
          }}
          onBlur={(e) => {
            if (settledRef.current) return;
            settledRef.current = true;
            const value = e.target.value.trim();
            if (value) onCommit(e.target.value);
            else onCancel();
          }}
        />
      </div>
      {error && (
        <div className="sfe-edit-error" role="alert" style={{ paddingLeft: indent }}>{error}</div>
      )}
    </div>
  );
}
