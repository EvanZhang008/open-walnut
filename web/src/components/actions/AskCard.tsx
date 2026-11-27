/**
 * The one card for a thing a task asks of the user, wherever it shows (2026-11-20, the user: "显示一个
 * title，title 显示一个 description，然后再显示它那个 question，然后在下面一行就显示那个 input box……最后一行
 * 就显示……snooze……尽可能极简", and "it is jsut thread"): a task's row and its session's strip
 * (ActionNeeded), a node's Needs you list (OrgTaskRail), and a task's ask threads.
 *
 * Top to bottom: its title (the task, where the list mixes tasks), what it asks, a line of why, then
 * the box to type in, always shown, with its buttons and Snooze last (beside the box when the width
 * allows, under it when not). No state word, no kind, no age.
 */
import type { ReactNode } from 'react';
import { FoldToggle, useTextFold } from '@/components/common/TextFold';
import { useExperimental } from '@/hooks/useExperimental';
import { NoticeClose } from '@/components/common/NoticeClose';
import './ask-card.css';

/**
 * A part that answers (a Board card's live prompt) in the one card, with threads_one_card on
 * (core/org/one-card.ts); off, the part alone, as before it. With `onClose` either way has the ×
 * at its top right (off, over the part's first line), which folds it, never answers it.
 */
export function OneCardFrame({ testId, children, onClose, closeLabel, closeTestId }: {
  testId: string; children: ReactNode; onClose?: () => void; closeLabel?: string; closeTestId?: string;
}) {
  const close = onClose ? { onClose, closeLabel, closeTestId } : {};
  const on = useExperimental('threads_one_card');
  if (on) return <AskCardFrame testId={testId} answer={children} {...close} />;
  if (!onClose) return <>{children}</>;
  return (
    <div className="one-card-plain has-close">
      <NoticeClose onClose={onClose} label={closeLabel ?? CLOSE_LABEL} testId={closeTestId} className="ask-card-close" />
      {children}
    </div>
  );
}

const CLOSE_LABEL = 'Hide this card: it stays the task\'s question';

export function AskCardFrame({ title, question, detail, status, answer, tools, className = '', testId, data, onClose, closeLabel, closeTestId }: {
  /** The task it is from, where the list holds several tasks' asks (a link to open it). */
  title?: ReactNode;
  /** What it asks; absent when its own card below says it (a live prompt). */
  question?: ReactNode;
  /** A line or two of why. */
  detail?: ReactNode;
  /** A line about its state the user acts on (snoozed until, a refused snooze). */
  status?: ReactNode;
  /** Its answer: the words box and its own buttons. */
  answer?: ReactNode;
  /** The card's own buttons after the answer's (Snooze last). */
  tools?: ReactNode;
  className?: string;
  testId: string;
  data?: Record<`data-${string}`, string | undefined>;
  /** The card's × at its top right (every card can be closed: NoticeClose). Closing an ask never
   *  answers it: the caller folds it to one line or hides it here, and it stays the task's ask. */
  onClose?: () => void;
  closeLabel?: string;
  closeTestId?: string;
}) {
  // Its question and why are cut to a few lines; when they are, Show more under them shows them
  // whole in the card (2026-11-21, UI audit: a Yes / No card's why ended in an ellipsis with no way
  // to read the rest before answering). The one fold of every card (common/TextFold.tsx).
  const text = useTextFold({ parts: ':scope > .ask-card-question, :scope > .ask-card-detail' });
  return (
    // A card with a box to type in (utils/truncation-peek-row.ts growsDown): hovering opens nothing,
    // its cut text shows as a tooltip and Show more shows it whole (2026-11-24, the user: only a
    // task's title in the task panel widens; truncation-peek-find.ts peekAllowed).
    <div className={`ask-card${text.whole ? ' is-whole' : ''}${onClose ? ' has-close' : ''} ${className}`.trim()} ref={text.ref} data-testid={testId} data-peek-row="" data-peek-grow="down" {...data}>
      {onClose && <NoticeClose onClose={onClose} label={closeLabel ?? CLOSE_LABEL} testId={closeTestId} className="ask-card-close" />}
      {title ? <div className="ask-card-title">{title}</div> : null}
      {question ? <div className="ask-card-question">{question}</div> : null}
      {detail ? <div className="ask-card-detail">{detail}</div> : null}
      <FoldToggle fold={text} className="ask-card-more" testId="ask-card-more" />
      {status}
      <div className="ask-card-answer">{answer}{tools ? <span className="ask-card-tools">{tools}</span> : null}</div>
    </div>
  );
}

