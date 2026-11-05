/**
 * Settings > Remote Hosts: the one way a removal asks first (2026-11-04 review: a host's Remove
 * asked inline, while "Removals to confirm" and a secret's Delete armed a button that turned back
 * by itself after 3 s, with no Cancel in sight). A row under what it removes says what goes,
 * "Remove <name>?", with Cancel and the action side by side; Cancel holds the focus, Escape is
 * Cancel, and nothing turns back on a timer. The red button is named by its word and described by
 * the question, so it never shares a name with the button that asked (a secret's "Delete
 * github-read" and this row's "Delete").
 */
import { useEffect, useId, type KeyboardEvent, type ReactNode } from 'react';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { focusLanded } from '@/utils/focus-landed';

export function RemoveConfirmRow({ question, note, action = 'Remove', busy, onCancel, onConfirm, testId = 'rh-row-confirm', indent = true }: {
  /** "Remove Alpha box?" */
  question: string;
  /** What happens, in one line. */
  note?: ReactNode;
  /** The red button's word (Remove, Delete). */
  action?: string;
  /** The removal runs: the action says so and keeps the focus. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId?: string;
  indent?: boolean;
}) {
  const cancelId = `rm-confirm-${useId().replace(/:/g, '')}`;
  const questionId = `${cancelId}-q`;
  useEffect(() => {
    const raf = requestAnimationFrame(() => focusLanded(document.getElementById(cancelId)));
    return () => cancelAnimationFrame(raf);
  }, [cancelId]);
  return (
    <SettingsRow
      indent={indent}
      className="rh-row-confirm"
      data-testid={testId}
      label={<span id={questionId}>{question}</span>}
      help={note}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
      control={
        <>
          <SettingsButton id={cancelId} variant="text" onClick={onCancel} aria-describedby={questionId} data-testid={`${testId}-cancel`}>Cancel</SettingsButton>
          <SettingsButton
            variant="danger"
            holdFocus
            busy={busy}
            busyLabel={action === 'Delete' ? 'Deleting...' : 'Removing...'}
            onClick={onConfirm}
            data-testid={`${testId}-remove`}
            aria-describedby={questionId}
          >
            {action}
          </SettingsButton>
        </>
      }
    />
  );
}
