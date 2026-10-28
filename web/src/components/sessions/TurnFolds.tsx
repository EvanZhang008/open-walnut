/**
 * The fold the session timeline draws around finished work: ProcessFoldRow, one
 * "Received a message from X, ran 2 commands ›" row for every stretch of quiet
 * steps between two things the person reads (finished steps, messages sent and
 * received, a turn's work before its answer, whole turns that needed nothing;
 * turn-shape.ts), its line saying what the steps did, in order (fold-steps.ts).
 * It starts folded and remembers an open state for the page, so a fold the
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
export const turnFoldKey = (foldId: string) => `turn:${foldId}`;

function useTurnFold(key: string): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => opened.has(key));
  const toggle = useCallback(() => {
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    notify();
  }, [key]);
  return [open, toggle];
}

/**
 * `foldKey` defaults to the process fold's; a whole turn's steps before its
 * answer use the same row under turnFoldKey. `failed` puts the count of failed
 * steps in the header, so a folded failure is never silent.
 */
export function ProcessFoldRow({ foldId, phrase, children, foldKey, failed = 0, testId = 'process-fold', running = false }: {
  foldId: string; phrase: string; children: ReactNode; foldKey?: string; failed?: number; testId?: string;
  /** A step inside is still running (the live turn): the row breathes like a running tool run. */
  running?: boolean;
}) {
  const [open, toggle] = useTurnFold(foldKey ?? processFoldKey(foldId));
  return (
    <div className="tool-run-row process-fold" data-testid={testId} data-open={open ? 'true' : 'false'}>
      <button type="button" className="tool-run-toggle" aria-expanded={open} onClick={toggle}>
        <span className="tool-run-label" title={phrase}>{phrase}</span>
        {failed > 0 && <span className="tool-run-fail">{failed} failed</span>}
        {running && <span className="tool-run-live-dot" />}
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && <div className="process-fold-body">{children}</div>}
    </div>
  );
}

/**
 * Inside an opened fold: where a turn ended with the acknowledgement line
 * alone (turn-end-marker.ts), the line itself, small. Nothing is behind it.
 */
export function NoActionMark() {
  return (
    <div className="tool-run-row no-action-mark" data-testid="no-action-mark">
      <span className="tool-run-label">Acknowledged</span>
    </div>
  );
}
