/**
 * The one question control in the session header: a pill that names the view
 * you can switch TO. `Tree Mode` while the conversation is shown in order
 * (every turn, each question's turns labelled), `Conversation Mode` while the
 * tree of question pages is on. It replaced the `N open` count pill and the
 * `More` menu: the sidebar carries the counts and the list, and this row holds
 * nothing else about questions.
 *
 * Styled like its neighbours (the status and cron pills), icon plus label; a
 * narrow column keeps the icon and hands the label to the tooltip.
 */
import { memo } from 'react';
import type { SessionViewMode } from '@/hooks/useSessionThreads';
import '@/styles/thread-stack.css';

export const TREE_MODE_LABEL = 'Tree Mode';
export const CONVERSATION_MODE_LABEL = 'Conversation Mode';

/** What the pill says: the view a click switches to. */
export function modePillLabel(viewMode: SessionViewMode): string {
  return viewMode === 'linear' ? TREE_MODE_LABEL : CONVERSATION_MODE_LABEL;
}

const TREE_ICON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3" />
  </svg>
);
const CONVERSATION_ICON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M8 9h8M8 13h5" />
  </svg>
);

export interface ThreadModePillProps {
  viewMode: SessionViewMode;
  /** Icon only (the label is the tooltip). */
  narrow?: boolean;
  onToggle: () => void;
}

export const ThreadModePill = memo(function ThreadModePill({ viewMode, narrow, onToggle }: ThreadModePillProps) {
  const label = modePillLabel(viewMode);
  const title = `Switch to ${label}`;
  return (
    <button
      type="button"
      className="thread-mode-pill"
      data-view-mode={viewMode}
      data-narrow={narrow ? 'true' : undefined}
      title={title}
      aria-label={title}
      onClick={onToggle}
    >
      {viewMode === 'linear' ? TREE_ICON : CONVERSATION_ICON}
      {!narrow && <span className="thread-mode-pill-label">{label}</span>}
    </button>
  );
});
