import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { openActions, type ActionItem } from '@open-walnut/user-status';
import { ActionNeeded } from '@/components/actions/ActionNeeded';
import { anyOpen, openPageFrom, useAskPages } from '@/components/actions/ask-pages';
import { AgentText } from '../common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';

/**
 * What a search hit asks of the user, folded to its question until opened: a "Needs you" mark, the
 * question in full (a card's summary is a title, `.wn-title`: it wraps, never cuts), and a Show
 * button with the tool look that opens the full ask card under it (2026-11-21, the UI audit: a full
 * card between two results broke the scan of the list). Only the search list folds it; every other
 * row shows the card in full.
 *
 * The line reads the same pages the card does (useAskPages, one record per task): it leads with the
 * page the card opens on, counts only the asks still open, and goes when the card has nothing left to
 * show, an answer sent from here included, before the status catches up (2026-11-22 review: it read
 * the first raw ask and stayed "Needs you" over an emptied card). A shown page answered since leads
 * with the next open one, and opening moves the card there, so what the line said is what opens.
 *
 * "Needs you" means waiting on the user now: the line leads with and counts only the asks the status
 * holds open (openActions, the same judgement the status's own Needs you makes, core/action-needed.ts),
 * never a snoozed one (2026-11-22, the UI audit: the preview and its "+N" counted snoozed asks). With
 * every ask snoozed the line says nothing; the card, once opened, stays until hidden, its snoozed pages
 * greyed with their time and an Unsnooze, so a snooze made in it never pulls it from under the user.
 *
 * Opened, the card shows the question itself, so the line keeps only its mark and the Hide button.
 * The card stays mounted once opened, also while the line is gone, and is only hidden: what the user
 * did in it and has not sent yet (a multiple choice's ticks, a typed answer, a send that failed and
 * the reason it gives) survives a fold and an answer whose send failed.
 */
export function SearchAskLine({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const book = useAskPages(task.id, task.user_status?.actions ?? []);
  const { pages, answered } = book;
  const pending = new Set(openActions(task.user_status).map((i) => i.id));
  const waits = (p: ActionItem) => pending.has(p.id);
  const done = task.phase === 'COMPLETE';
  const lead = done ? -1 : openPageFrom(pages, answered, book.index, waits);
  const shown = lead >= 0 ? pages[lead] : undefined;
  if (!shown && !everOpened) return null;
  // Open on asks that are all snoozed now: the card still has pages to show, so it stays.
  const visible = !!shown || (open && !done && anyOpen(pages, answered));
  const more = pages.filter((p) => p !== shown && !answered[p.id] && waits(p)).length;
  const toggle = () => {
    if (!open && shown && lead !== book.index) book.show(shown.id);
    setEverOpened(true);
    setOpen((v) => !v);
  };
  return (
    <div className={`search-ask-line${open ? ' is-open' : ''}`} data-testid="search-ask-line" hidden={!visible}>
      {visible ? (
        <div className="search-ask-head">
          {shown ? <span className="search-ask-mark wn-fixed">Needs you</span> : null}
          {open || !shown ? null : (
            // The question is agent text whose links open on their own: it sits beside the button, never inside one.
            <AgentText compact inline {...taskTextSource(task, 'needs')} className="search-ask-summary wn-title" text={shown.summary} testId="search-ask-summary" />
          )}
          <span className="search-ask-fill" aria-hidden="true" />
          {more > 0 && !open ? <span className="search-ask-more wn-fixed" title={`${more} more open`}>+{more}</span> : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="search-ask-toggle"
            aria-expanded={open}
            title={open ? 'Hide what it asks' : 'Show what it asks, to answer here'}
            // The row above opens its task on a press; this button only folds.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggle(); }}
          >
            {open ? 'Hide' : 'Show'} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        </div>
      ) : null}
      {everOpened ? <div hidden={!open} className="search-ask-actions-below" data-asks-for={task.id}><ActionNeeded task={task} /></div> : null}
    </div>
  );
}
