import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { ActionNeeded } from '@/components/actions/ActionNeeded';
import { AgentText } from '../common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';

/**
 * What a search hit asks of the user, folded to its question until opened: a "Needs you" mark, the
 * question in full (a card's summary is a title, `.wn-title`: it wraps, never cuts), and an Answer
 * button with the tool look that opens the full ask card under it (2026-11-21, the UI audit: a full
 * card between two results broke the scan of the list). Only the search list folds it; every other
 * row shows the card in full.
 *
 * Opened, the card shows the question itself, so the line keeps only its mark and the Fold button.
 * The card stays mounted once opened and is only hidden when folded: what the user did in it and has
 * not sent yet (a multiple choice's ticks, a typed answer, a send that failed) survives a fold.
 */
export function SearchAskLine({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const items = task.user_status?.actions ?? [];
  const first = items[0];
  if (!first) return null;
  const more = items.length - 1;
  const toggle = () => { setEverOpened(true); setOpen((v) => !v); };
  return (
    <div className={`search-ask-line${open ? ' is-open' : ''}`} data-testid="search-ask-line">
      <div className="search-ask-head">
        <span className="search-ask-mark wn-fixed">Needs you</span>
        {open ? null : (
          // The question is agent text whose links open on their own: it sits beside the button, never inside one.
          <AgentText compact inline {...taskTextSource(task, 'needs')} className="search-ask-summary wn-title" text={first.summary} testId="search-ask-summary" />
        )}
        <span className="search-ask-fill" aria-hidden="true" />
        {more > 0 && !open ? <span className="search-ask-more wn-fixed">+{more}</span> : null}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="search-ask-toggle"
          aria-expanded={open}
          title={open ? 'Fold the question' : 'Show the question and its answers'}
          // The row above opens its task on a press; this button only folds.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggle(); }}
        >
          {open ? 'Fold' : 'Answer'} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>
      {everOpened ? <div hidden={!open} className="search-ask-actions-below" data-asks-for={task.id}><ActionNeeded task={task} /></div> : null}
    </div>
  );
}
