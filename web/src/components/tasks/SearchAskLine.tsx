import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { ActionNeeded } from '@/components/actions/ActionNeeded';
import { AgentText } from '../common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';

/**
 * What a search hit asks of the user, folded to one line: a "Needs you" mark and the question,
 * opening to the full ask card on a click (2026-11-21, the UI audit: a full card between two
 * results broke the scan of the list). Only the search list folds it; every other row shows the
 * card in full. The card itself is ActionNeeded's, mounted only while open.
 */
export function SearchAskLine({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const items = task.user_status?.actions ?? [];
  const first = items[0];
  if (!first) return null;
  const more = items.length - 1;
  const toggle = () => setOpen((v) => !v);
  return (
    <div className={`search-ask-line${open ? ' is-open' : ''}`} data-testid="search-ask-line">
      {/* A row-like toggle, not a <button>: the question is agent text whose links open on their own. */}
      <div
        data-peek-row=""
        role="button"
        tabIndex={0}
        className="search-ask-toggle"
        aria-expanded={open}
        title={open ? 'Fold the question' : 'Show the question and its answers'}
        // The row above opens its task on a press; this line only folds.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
      >
        <span className="search-ask-mark wn-fixed">Needs you</span>
        <AgentText compact inline {...taskTextSource(task, 'needs')} className="search-ask-summary wn-meta" text={first.summary} testId="search-ask-summary" />
        {more > 0 ? <span className="search-ask-more wn-fixed">+{more}</span> : null}
        <span className={`search-ask-chevron navigation-chevron wn-fixed${open ? ' expanded' : ''}`} aria-hidden="true">{'\u203A'}</span>
      </div>
      {open ? <ActionNeeded task={task} /> : null}
    </div>
  );
}
