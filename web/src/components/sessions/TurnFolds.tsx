/**
 * The fold the session timeline draws around finished work: ProcessFoldRow, one
 * "Received 3 messages · Ran 2 tools ›" row for every stretch of quiet
 * steps between two things the person reads (finished steps, messages sent and
 * received, a turn's work before its answer, whole turns that needed nothing;
 * turn-shape.ts), its line counting what came in, went out and ran (fold-steps.ts).
 * It starts folded and remembers an open state for the page, so a fold the
 * reader opened stays open when its rows remount: when the turn ends, when
 * history is fetched again, after a reconnect.
 */
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { InFoldBody } from './fold-body-context';
import { StepIcon } from './StepIcon';
import '@/styles/turn-folds.css';
import { foldFailureWords, type FoldFailures } from './fold-rows';
import { EMPTY_FOLD_PHRASE } from './fold-steps';
import '@/styles/step-rows.css';

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

/**
 * Folds one panel's timeline opened for its reader (fold-reader-hold.ts): open in
 * that panel only, so another panel on the same session, scrolled elsewhere,
 * never grows under its own reader. The timeline adds to it during its render,
 * before the fold's row renders, so nobody needs telling.
 */
export const ReaderOpenedFolds = createContext<Set<string> | null>(null);

/**
 * The running turn's row took another key (its first saved row came in after the stream,
 * say): it keeps the open state the reader gave it. Called during the timeline's render,
 * before the row renders, so nobody needs telling.
 */
export function carryTurnFold(from: string, to: string): void {
  if (from !== to && opened.has(from)) opened.add(to);
}

/** Test seam. */
export function _clearTurnFolds(): void {
  opened.clear();
  notify();
}

/** The fold keys the timeline uses, so it can name the fold a row sits in. */
export const processFoldKey = (foldId: string) => `process:${foldId}`;
export const turnFoldKey = (foldId: string) => `turn:${foldId}`;
/** A row of the session's words inside a fold (StepRows.tsx FoldedWordsRow), by its row id. */
export const wordsFoldKey = (rowId: string) => `words:${rowId}`;

export function useTurnFold(key: string): [boolean, () => void] {
  const forReader = useContext(ReaderOpenedFolds);
  const snapshot = () => opened.has(key) || !!forReader?.has(key);
  const open = useSyncExternalStore(subscribe, snapshot, snapshot);
  const toggle = useCallback(() => {
    if (opened.has(key) || forReader?.has(key)) { opened.delete(key); forReader?.delete(key); } else opened.add(key);
    notify();
  }, [key, forReader]);
  return [open, toggle];
}

/**
 * `foldKey` defaults to the process fold's; a whole turn's steps before its
 * answer use the same row under turnFoldKey. `failed` puts the count of failed calls (and,
 * apart, of the runtime's error lines) in the header, so a folded failure is never silent.
 */
export function ProcessFoldRow({ foldId, phrase, lead, children, foldKey, failed = 0, testId = 'process-fold', running = false, peek, findMembers }: {
  foldId: string; phrase: string;
  /** Before the steps: how long the turn worked ("Worked for 2m 16s"), or "Working" while it runs. */
  lead?: string; children: ReactNode; foldKey?: string; failed?: number | FoldFailures; testId?: string;
  /** A step inside is still running (the live turn): the row breathes like a running tool run. */
  running?: boolean;
  /** What the turn is doing now, drawn under the closed line while it runs (the latest
   *  thought, the current step), so a running turn shows one live line and nothing grows. */
  peek?: ReactNode;
  /** The saved rows it holds (space-separated ids), REQUIRED of every fold: the find bar
   *  counts them as drawn while the fold is shut, and opens it to land on them
   *  (PageFind openRunsOf). `undefined` only for a fold of no saved row. */
  findMembers: string | undefined;
}) {
  const [open, toggle] = useTurnFold(foldKey ?? processFoldKey(foldId));
  const failedWords = foldFailureWords(failed);
  // A turn's fold that holds only reasoning says how long it worked and nothing more:
  // "Thinking" is the thinking row's own word, never a second line's (thinking-once.spec).
  const label = lead && phrase === EMPTY_FOLD_PHRASE ? '' : phrase;
  return (
    <div className="tool-run-row process-fold" data-testid={testId} data-fold-id={foldId} data-open={open ? 'true' : 'false'} {...(running ? { 'data-running': 'true' } : {})} {...(findMembers ? { 'data-find-members': findMembers } : {})}>
      <button type="button" className="tool-run-toggle" aria-expanded={open} onClick={toggle}>
        <span className={`tool-run-chevron process-fold-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
        {lead && <span className="tool-run-lead" data-testid="turn-fold-lead">{lead}{label && <span className="tool-run-sep" aria-hidden="true"> · </span>}</span>}
        {label && <span className="tool-run-label" title={lead ? `${lead} · ${label}` : label}>{label}</span>}
        {failedWords && <span className="tool-run-fail">{failedWords}</span>}
        {running && <span className="tool-run-live-dot" />}
      </button>
      {!open && running && peek && <div className="process-fold-peek" data-testid="turn-fold-peek">{peek}</div>}
      {open && <div className="process-fold-body"><InFoldBody.Provider value>{children}</InFoldBody.Provider></div>}
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
