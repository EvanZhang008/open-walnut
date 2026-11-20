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
import './ask-card.css';

export function AskCardFrame({ title, question, detail, status, answer, tools, className = '', testId, data }: {
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
}) {
  return (
    <div className={`ask-card ${className}`.trim()} data-testid={testId} data-peek-row="" {...data}>
      {title ? <div className="ask-card-title">{title}</div> : null}
      {question ? <div className="ask-card-question">{question}</div> : null}
      {detail ? <div className="ask-card-detail">{detail}</div> : null}
      {status}
      <div className="ask-card-answer">{answer}{tools ? <span className="ask-card-tools">{tools}</span> : null}</div>
    </div>
  );
}
