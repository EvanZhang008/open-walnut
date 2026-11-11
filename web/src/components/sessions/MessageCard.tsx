/**
 * The head every message card wears, sent or received (SessionOutboundCard,
 * SessionProvenanceCard): who, as a task pill when there is a task, then the
 * title, a summary of two lines at most, and "Details" folded below. 2026-11-09
 * the user drew it for a sent message ("To Who, Title, Summary, detail
 * collapse"); 2026-11-10 for every received one too: "make the message same as
 * the regular collapse, it itself only show to which, and title and summary".
 *
 * The whole title-and-summary block is one button; the who line stays clickable
 * apart (its pills open the task through the `.task-link` delegation).
 */
import type { ReactNode } from 'react';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import { taskPath } from '@/utils/task-path';
import { StepIcon, type StepIconName } from './StepIcon';
import '@/styles/provenance-fold.css';
import '@/styles/step-rows.css';

/** A task the message is to, from or about, as a pill (a click opens it). */
export function TaskPill({ taskId, tooltip }: { taskId: string; tooltip?: string }) {
  const label = useTaskLabel(taskId);
  return (
    <a
      className="provenance-chip provenance-chip-task task-link op-card-to-pill"
      data-task-id={taskId}
      href={taskPath(taskId)}
      title={tooltip ?? (label?.project ? `${label.project} / ${label.title}` : label?.title)}
    >{label?.title ?? taskId}</a>
  );
}

/** The who line: glyph, "To" / "From" / "About", the pills (else `fallback`), a place label. */
export function CardWho({ glyph, icon, direction, taskIds, fallback, label, tooltip }: {
  glyph: string;
  /** The step row's icon (StepIcon.tsx); the glyph is the text twin it replaces on screen. */
  icon?: StepIconName;
  direction: string;
  taskIds: readonly string[];
  fallback?: ReactNode;
  label?: string;
  /** The pill's hover text when one session's full title says more than its task's. */
  tooltip?: string;
}) {
  return (
    <div className="op-card-to">
      <span className="provenance-glyph" aria-hidden="true">{icon ? <StepIcon name={icon} /> : glyph}</span>
      <span className="op-card-dir">{direction}</span>
      {taskIds.length > 0 ? taskIds.map((id) => <TaskPill key={id} taskId={id} tooltip={taskIds.length === 1 ? tooltip : undefined} />) : fallback}
      {label && <span className="op-card-to-label">{label}</span>}
    </div>
  );
}

/**
 * Title, summary and the Details toggle: the part a click opens. A card is one
 * line, or two: the who and the title on the first, the summary alone on the
 * second, each cut with an ellipsis, open or not (2026-11-11, the user: "if 1 line
 * just 1 line, if 2 line just have the title in one and detail or summary in
 * next", "same for all the tools box"). So the summary is the card's own row, not
 * a column beside the title: it is drawn after the button, as the card's second
 * line (step-rows.css, the one-or-two-lines rule), and clicks the same toggle.
 */
export function CardMain({ title, titleCopy, summary, open, onToggle }: {
  title?: string;
  /** The title repeats words the open card shows anyway (a first sentence of
   *  its body or outcome): Cmd+F counts them there, not twice. */
  titleCopy?: boolean;
  /** Always a copy of the open card's words, so find skips it too. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="op-card-main"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        {/* The inner spans: WebKit paints no find highlight on text directly in a
            line-clamped box (utils/page-find.ts unpaintedHost). */}
        {title && <span className="op-card-title" {...(titleCopy ? { 'data-find-skip': '' } : {})}><span>{title}</span></span>}
        <span className="op-card-more">
          <span className="op-card-more-chevron" aria-hidden="true"><StepIcon name="chevron" /></span>
          <span className="op-card-more-text">{open ? 'Hide details' : 'Details'}</span>
        </span>
      </button>
      {/* The card's second line: what it says, the open card's words in short (find
          counts them there). Read by a screen reader after the button. */}
      {summary && (
        <span className="op-card-summary" data-find-skip=""
          onClick={(e) => { e.stopPropagation(); onToggle(); }}><span>{summary}</span></span>
      )}
    </>
  );
}
