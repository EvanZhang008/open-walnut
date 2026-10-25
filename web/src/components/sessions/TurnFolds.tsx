/**
 * The two folds the session timeline draws around finished work:
 *  · ProcessFoldRow: consecutive finished steps of a turn (tool runs, messages
 *    sent to other tasks) as one "Read 2 files, edited 2 files, sent a message ›"
 *    row (process-fold.ts decides which rows);
 *  · NoActionFold: a finished turn's last answer that said it needs nothing from
 *    the person, as one "No action needed ›" row (turn-end-marker.ts decides).
 * Both start folded and remember an open state for the page, so a fold the
 * reader opened stays open when its rows remount: when the turn ends, when
 * history is fetched again, after a reconnect.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import '@/styles/turn-folds.css';

// Open folds, for the page (a remount keeps a fold the reader opened open), and
// openable from outside: a jump to a pinned row inside a closed fold opens it
// first, since a folded row is not rendered and could not be landed on.
const opened = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const notify = () => { for (const fn of listeners) fn(); };

/** Open one fold (no-op when it is open). */
export function openTurnFold(key: string): void {
  if (opened.has(key)) return;
  opened.add(key);
  notify();
}

/** Test seam. */
export function _clearTurnFolds(): void {
  opened.clear();
  notify();
}

/** The fold keys the timeline uses, so it can name the fold a row sits in. */
export const processFoldKey = (foldId: string) => `process:${foldId}`;
export const noActionFoldKey = (foldId: string) => `no-action:${foldId}`;

function useTurnFold(key: string): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => opened.has(key));
  const toggle = useCallback(() => {
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    notify();
  }, [key]);
  return [open, toggle];
}

export function ProcessFoldRow({ foldId, phrase, children }: { foldId: string; phrase: string; children: ReactNode }) {
  const [open, toggle] = useTurnFold(processFoldKey(foldId));
  return (
    <div className="tool-run-row process-fold" data-testid="process-fold" data-open={open ? 'true' : 'false'}>
      <button type="button" className="tool-run-toggle" aria-expanded={open} onClick={toggle}>
        <span className="tool-run-label">{phrase}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && <div className="process-fold-body">{children}</div>}
    </div>
  );
}

/**
 * A turn that ended with the no-action line and nothing else (a notice or a
 * peer's message that needed nothing): the line itself, small. Nothing is
 * hidden behind it, so there is nothing to open.
 */
export function NoActionMark() {
  return (
    <div className="tool-run-row no-action-mark" data-testid="no-action-mark">
      <span className="tool-run-label">No action needed</span>
    </div>
  );
}

/** `preview`: the answer's first sentence, so the folded row still says what it was. */
export function NoActionFold({ foldId, preview, children }: { foldId: string; preview?: string; children: ReactNode }) {
  const [open, toggle] = useTurnFold(noActionFoldKey(foldId));
  return (
    <div className="tool-run-row no-action-fold" data-testid="no-action-fold" data-open={open ? 'true' : 'false'}>
      <button type="button" className="tool-run-toggle" aria-expanded={open} onClick={toggle}>
        <span className="tool-run-label">No action needed</span>
        {preview && <span className="no-action-fold-preview">{preview}</span>}
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && <div className="no-action-fold-body">{children}</div>}
    </div>
  );
}
