/**
 * A card that waits on the user, folded by its × (NoticeClose) to one line (2026-11-23, the user, of
 * a question card that kept showing over his chat: asking for a way to collapse it). Closing never
 * answers: the line says what still waits and Show opens the card again where it was.
 *
 * One line for every such fold: the strip above a chat (SessionActionStrip), a task row's Action
 * needed, the Org page's Needs you rows and thread cards, a Board card's prompt. Its look is the top
 * thread's folded line (top-thread.css), so a folded ask reads the same everywhere.
 */
import { useEffect, type ReactNode } from 'react';
import { usePageViewOf } from '@/utils/view-memory';
import '@/styles/top-thread.css';
import './ask-fold.css';

const isText = (v: unknown): v is string => typeof v === 'string';
const SAME = (kept: string, now: string) => kept === now;

/**
 * Whether the user folded this card, kept per card id (a view choice, utils/view-memory.ts): the
 * same ask stays one line in every place that shows it and over a reload. `signature` is what it
 * asks now: a new ask on the same card (another question, a new state) opens again by itself, and
 * the fold kept for the old one is dropped then, so the card coming back later to the words it had
 * when folded (a thread back in Needs you with a new question) never arrives folded. `signature` ''
 * is not known now (its live status still loading): the fold is kept, as over a reload. `id` '' is
 * a place with no card: nothing to fold or drop. `same(kept, now)`: whether what it asks now is
 * still what was folded (default: the same words); a card of several asks folds while it asks
 * nothing it did not ask then (one answered keeps it folded, a new one opens it).
 */
export function useAskFold(place: string, id: string, signature: string, same: (kept: string, now: string) => boolean = SAME): { folded: boolean; fold: () => void; show: () => void } {
  const [at, setAt] = usePageViewOf('ask-fold', place, id, '', isText);
  const kept = !!id && at !== '' && !!signature;
  const folded = kept && same(at, signature);
  // A new ask drops the fold; a folded card whose asks narrowed (one answered) keeps only the rest,
  // so one of them asked again later is new to it.
  const next = !kept || at === signature ? null : folded ? signature : '';
  useEffect(() => { if (next !== null) setAt(next); }, [next, setAt]);
  return { folded, fold: () => { if (signature) setAt(signature); }, show: () => setAt('') };
}

/** `same` for a card of several asks whose signature is their ids, one per line (foldIds). */
export const foldIds = (ids: readonly string[]): string => ids.join('\n');
export const asksNothingNew = (kept: string, now: string): boolean => {
  const was = new Set(kept.split('\n'));
  return now.split('\n').every((x) => was.has(x));
};

/** The class a fold line's words take, so a long one ends in an ellipsis and Show stays whole. */
export const FOLD_WORDS = 'top-thread-line-title';

/**
 * One folded ask: its dot (red: it waits on him) or its own `mark` (a thread's state), `lead`
 * ("Waits on you"), its words, `extra` (a count, a pager) and Show. The words are the agent's,
 * drawn beside the Show button, never inside a button (their links open on their own); a click
 * elsewhere on the line shows the card too.
 */
export function AskFoldLine({ testId, showTestId, words, mark, lead, extra, title = 'Show it again', onShow, className = '' }: {
  testId: string;
  showTestId: string;
  /** What it asks, in a span or AgentText with the FOLD_WORDS class. */
  words: ReactNode;
  /** In place of the red dot: what the card says it is (a thread's group dot and word). */
  mark?: ReactNode;
  lead?: string;
  extra?: ReactNode;
  title?: string;
  onShow: () => void;
  className?: string;
}) {
  return (
    <div className={`top-thread-line ask-fold-line ${className}`.trim()} data-testid={testId}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) onShow(); }}>
      {mark ?? <i className="top-thread-dot is-needs" aria-hidden="true" />}
      {lead && <><span className="ask-fold-lead">{lead}</span><span aria-hidden="true">{' · '}</span></>}
      {words}
      {extra}
      <button type="button" className="btn btn-link btn-sm ask-fold-show" data-testid={showTestId} aria-expanded={false}
        onClick={(e) => { e.stopPropagation(); onShow(); }} title={title}>Show</button>
    </div>
  );
}
