import { memo } from 'react';
import type { SessionViewMode } from '@/hooks/useSessionThreads';

/**
 * The node view's chrome: the view toggle, the breadcrumb, the collapsed-ancestor
 * lines and the child-thread cards.
 *
 * Presentational on purpose — every one of these renders a thread the
 * `SessionThreadsContext` tree already computed, and clicking one only ever
 * navigates. The TURNS themselves are rendered by the timeline's own row renderer
 * (SessionChatHistory), because "tree mode" is a filter over the one timeline, not
 * a second transcript renderer: merged tool runs, thinking rows, envelopes,
 * optimistic bubbles and the live stream all have to keep working unchanged.
 *
 * Colour comes from `--thread-hue` set inline by the caller, the same variable the
 * gutter bars and the composer chip use.
 */

interface SessionViewToggleProps {
  mode: SessionViewMode;
  onChange: (mode: SessionViewMode) => void;
}

/** `Linear | Tree`, in the panel header's meta cluster. Per session, remembered. */
export const SessionViewToggle = memo(function SessionViewToggle({ mode, onChange }: SessionViewToggleProps) {
  return (
    <div className="session-view-toggle" role="group" aria-label="Conversation view">
      <button
        type="button"
        className={`session-view-toggle-btn${mode === 'linear' ? ' is-active' : ''}`}
        data-view="linear"
        aria-pressed={mode === 'linear'}
        title="Read the conversation as one timeline"
        onClick={() => onChange('linear')}
      >
        Linear
      </button>
      <button
        type="button"
        className={`session-view-toggle-btn${mode === 'tree' ? ' is-active' : ''}`}
        data-view="tree"
        aria-pressed={mode === 'tree'}
        title="Read one thread at a time"
        onClick={() => onChange('tree')}
      >
        Tree
      </button>
    </div>
  );
});

export interface ThreadCrumb {
  key: string;
  label: string;
  /** hsl hue of the branch; absent for the top level, which has no colour. */
  hue?: number;
}

interface ThreadBreadcrumbProps {
  crumbs: ThreadCrumb[];
  onNavigate: (key: string) => void;
}

/** `Top level › the deploy question › this passage`. Every crumb navigates —
 *  including the LAST one: navigating also points the composer at that thread, so
 *  clicking where you already are is how you say "ask here" without a selection. */
export const ThreadBreadcrumb = memo(function ThreadBreadcrumb({ crumbs, onNavigate }: ThreadBreadcrumbProps) {
  return (
    <nav className="thread-breadcrumb" aria-label="Thread path">
      {crumbs.map((crumb, i) => {
        const isCurrent = i === crumbs.length - 1;
        return (
          <span className="thread-crumb-slot" key={`${crumb.key}:${i}`}>
            {i > 0 && <span className="thread-crumb-sep" aria-hidden="true">›</span>}
            <button
              type="button"
              className={`thread-crumb${isCurrent ? ' is-current' : ''}`}
              data-thread-key={crumb.key}
              {...(isCurrent ? { 'aria-current': 'true' as const } : {})}
              style={crumb.hue === undefined
                ? undefined
                : ({ ['--thread-hue' as string]: crumb.hue } as React.CSSProperties)}
              title={isCurrent ? `${crumb.label}: click to ask in this thread` : crumb.label}
              onClick={() => onNavigate(crumb.key)}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
});

interface ThreadAncestorTurnProps {
  /** First line of the question. */
  question: string;
  /** First line of the reply, when the turn has one. */
  reply?: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * ONE line for a turn the current thread hangs off: question, then reply, muted.
 * Clicking expands the real rows underneath (the caller renders them), so the
 * context is one click away instead of a mode switch away.
 */
export const ThreadAncestorTurn = memo(function ThreadAncestorTurn({
  question, reply, expanded, onToggle,
}: ThreadAncestorTurnProps) {
  return (
    <button
      type="button"
      className={`thread-ancestor-turn${expanded ? ' is-expanded' : ''}`}
      aria-expanded={expanded}
      title={expanded ? 'Collapse this turn' : 'Show this turn'}
      onClick={onToggle}
    >
      <span className="thread-ancestor-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="thread-ancestor-q">{question}</span>
      {reply && <span className="thread-ancestor-a">{reply}</span>}
    </button>
  );
});

interface ThreadChildCardProps {
  label: string;
  /** Turns in that thread — its size, in the unit the transcript is made of. */
  turns: number;
  hue: number;
  /** Rows landed in it since it was last looked at. */
  isNew?: boolean;
  onClick: () => void;
}

/** A branch leaving the current thread. */
export const ThreadChildCard = memo(function ThreadChildCard({
  label, turns, hue, isNew, onClick,
}: ThreadChildCardProps) {
  return (
    <button
      type="button"
      className={`thread-child-card${isNew ? ' has-new' : ''}`}
      style={{ ['--thread-hue' as string]: hue } as React.CSSProperties}
      title={label}
      onClick={onClick}
    >
      <span className="thread-child-card-bar" aria-hidden="true" />
      <span className="thread-child-card-body">
        <span className="thread-child-card-label">{label}</span>
        <span className="thread-child-card-meta">
          {turns} {turns === 1 ? 'turn' : 'turns'}
        </span>
      </span>
      {isNew && (
        <span
          className="thread-child-card-new"
          role="img"
          aria-label="new replies"
          title="New replies since you were last here"
        >
          ●
        </span>
      )}
    </button>
  );
});

/** Shown where the child cards would be when a thread has no branches yet: it
 *  names the gesture that makes one, and deliberately does nothing on click (the
 *  Ask pill on a selection is the action). */
export const ThreadChildHint = memo(function ThreadChildHint() {
  return (
    <div className="thread-child-hint" role="note">
      + Ask about a passage above
    </div>
  );
});
