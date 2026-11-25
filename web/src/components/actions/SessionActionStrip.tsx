/**
 * The strip under a session's title bar (experiment action_needed_everywhere; 2026-11-19, the user:
 * asking that a task's needs-you show right in its title bar or under it): its task's Action
 * needed items, the same ones as its row, answered and snoozed in place. This session's own live
 * prompt only points at its card in the chat below (ActionNeeded variant="strip").
 *
 * Experiment top_thread: a task that keeps Threads (Main, a lead, a task with Threads on) shows its
 * first thread there instead (org/TopThread.tsx), under the items that are not threads yet (a live
 * prompt, an approval), which still lead as they do today and are not counted in its "1 / N".
 */
import { memo, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Task } from '@open-walnut/core';
import type { ActionItem } from '@open-walnut/user-status';
import { keepsThreads } from '@open-walnut/keeps-threads';
import { useExperimental } from '@/hooks/useExperimental';
import { useOrgThreads } from '@/components/org/useOrgThreads';
import { TopThread, useTopCursor, useTopThreads } from '@/components/org/TopThread';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import { TOP_HIDDEN_VIEW, awakeAt, stripItems } from '@/components/org/top-thread-model';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { useNow } from '@/components/approvals/ApprovalPrompts';
import { ActionNeeded } from './ActionNeeded';

/**
 * `threadsOpen`: the task's Threads view is open beside this chat. It shows every thread, so the top
 * draws none of them again, neither a card nor its line (2026-11-23, the user, on the same question in
 * the Threads view and above the chat: the same question card drawn twice); what no thread holds still shows.
 */
/** `float`: the panel's chat_glass_edges switch (on, never on a phone layer): alone above the
 *  timeline, the top floats on glass over it (useTopFloat). */
export const SessionActionStrip = memo(function SessionActionStrip({ task, sessionId, threadsOpen = false, float = false }: { task: Task | null | undefined; sessionId: string; threadsOpen?: boolean; float?: boolean }) {
  const on = useExperimental('action_needed_everywhere');
  const top = useExperimental('top_thread');
  const everyTask = useExperimental('task_threads');
  if (top && task && keepsThreads(task, everyTask)) return <SessionTop task={task} sessionId={sessionId} actions={on} threadsOpen={threadsOpen} float={float} />;
  if (!on || !task?.user_status?.actions?.length) return null;
  return <PlainStrip task={task} sessionId={sessionId} />;
});

/**
 * Hide folds everything above the chat to one line each, the strip's and the top thread's, kept in the
 * view memory for every chat (TOP_HIDDEN_VIEW), so a question that comes later stays folded too, its
 * words in the line (2026-11-23, the user, on a question card that took half his small screen:
 * asking for a way to collapse it).
 */
function useTopHidden(): [boolean, (v: boolean) => void] {
  return usePageView(TOP_HIDDEN_VIEW.page, TOP_HIDDEN_VIEW.name, false, isBoolean);
}

/**
 * The strip folded: one line that names its first item and how many more, and Show. The question is
 * the agent's words, drawn by the shared renderer beside the Show button, never inside a button (its
 * links open on their own); a click elsewhere on the line shows the card too.
 */
function StripLine({ task, items, onShow }: { task: Task; items: readonly ActionItem[]; onShow: () => void }) {
  const first = items[0];
  if (!first) return null;
  const more = items.length - 1;
  return (
    <div className="top-thread is-hidden action-strip-line" data-testid="action-strip-line" data-count={items.length}>
      <div className="top-thread-line" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) onShow(); }}>
        <i className="top-thread-dot is-needs" aria-hidden="true" />
        <AgentText compact inline {...taskTextSource(task, 'needs')} className="top-thread-line-title" text={first.summary} testId="action-strip-line-title" />
        {more > 0 && <><span aria-hidden="true">{' · '}</span><span className="top-thread-line-count">{more} more</span></>}
        <button type="button" className="btn btn-link btn-sm action-strip-show" data-testid="action-strip-show" aria-expanded={false}
          onClick={(e) => { e.stopPropagation(); onShow(); }} title="Show what it asks above the chat">Show</button>
      </div>
    </div>
  );
}

/** The strip of a task with no Threads on top: its items, none he snoozed until its time (the clock brings it back). */
function PlainStrip({ task, sessionId }: { task: Task; sessionId: string }) {
  const now = useNow(30_000);
  const [hidden, setHidden] = useTopHidden();
  const awake = (task.user_status?.actions ?? []).filter((it) => awakeAt(it, now));
  if (!awake.length) return null;
  // The same room as the top of a chat with Threads (top-thread.css .session-top): at most a third of
  // the body, its card scrolling inside it, never half the window.
  return (
    <div className="session-top is-strip-only" data-testid="session-top">
      {hidden
        ? <StripLine task={task} items={awake} onShow={() => setHidden(false)} />
        : <ActionNeeded task={task} variant="strip" sessionId={sessionId} accepts={(it) => awakeAt(it, now)} onHide={() => setHidden(true)} />}
    </div>
  );
}

/**
 * How much of the top still shows, tried in order until it fits: everything in a third of the
 * body, then in a half (2026-11-20, the user: "at most a third or a half"), the card's words (its
 * summary, its unread answers, its open conversation) each keeping a floor of WORDS_FLOOR_LINES
 * lines and scrolling inside it: the text he must read is never the part that folds to nothing
 * while the rest of the card shows (2026-11-20, a 1280 x 800 window read a needs card with no
 * summary at all). Then, in a half, the strip folds away (its letters still in Needs you and the
inbox) and each block keeps two lines (snug: an open conversation beside the summary, at 800 px
tall). Then the card keeps only its title line, its choices and its box (lean); then
 * only that title line and the box (min); then the box alone (a phone with its keyboard up leaves a
 * body of a few lines: the box he is typing in stays in sight, the chat keeps the rest). Read by
 * top-thread.css as data-room.
 */
const ROOM_LEVELS = [
  { room: 'full', share: 3, floor: 3 }, { room: 'full', share: 2, floor: 3 }, { room: 'snug', share: 2, floor: 2 },
  { room: 'lean', share: 2, floor: 0 }, { room: 'min', share: 3, floor: 0 }, { room: 'box', share: 3, floor: 0 },
] as const;
/** The most a level with no cap (min) may take of the body before the next one is tried. */
const MIN_SHARE = 0.6;
/** The card's words that give way, each down to its level's floor of lines (top-thread.css scrolls them). */
const WORDS = '.top-thread-list :is(.org-thread-summary, .org-thread-unread, .org-thread-conversation)';

/** Each block of the card's words keeps `lines` lines, or all of it when shorter (0: no floor, the level hides them). */
function floorWords(top: HTMLElement, lines: number): void {
  for (const w of top.querySelectorAll<HTMLElement>(WORDS)) {
    w.style.minHeight = '';
    if (!lines) continue;
    const cs = getComputedStyle(w);
    const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.45;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    w.style.minHeight = `${Math.ceil(Math.min(w.scrollHeight, lines * line + pad))}px`;
  }
}

function useTopRoom(shown: boolean, float: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const body = el?.parentElement;
    if (!el || !body) return;
    const fit = () => {
      // The body runs on under the composer's glass (a negative bottom margin, session-scroll-glass.css):
      // its share is of the part above the composer.
      const h = body.clientHeight + Math.min(0, parseFloat(getComputedStyle(body).marginBottom) || 0);
      for (const [i, level] of ROOM_LEVELS.entries()) {
        el.style.setProperty('--session-top-room', `${Math.floor(h / level.share)}px`);
        el.dataset.room = level.room;
        // Measured while the level shows them (full and snug show every block).
        floorWords(el, level.floor);
        el.dataset.share = String(level.share);
        if (i === ROOM_LEVELS.length - 1) break;
        if (level.room === 'min' ? el.offsetHeight <= h * MIN_SHARE : el.scrollHeight <= el.clientHeight + 1) break;
      }
    };
    fit();
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    const resized = new ResizeObserver(later);
    resized.observe(body);
    const changed = new MutationObserver(later);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { resized.disconnect(); changed.disconnect(); cancelAnimationFrame(frame); };
  }, [shown]);
  useTopFloat(ref, shown && float);
  return ref;
}

/**
 * Alone above the timeline (the body's first child) the top floats on glass over the timeline's
 * first rows, which scroll on under it (2026-11-23, the user: the text should pass behind the glass,
 * never a blank band around the threads line): the body learns its height as --sp-top-h, which the
 * timeline pads its top by (session-scroll-glass.css). Written in the ResizeObserver phase, before
 * paint, so a top that grows never covers the first line for a frame. Under another row it sits in
 * flow as before and the variable is gone. Only with the chat_glass_edges experiment on (`on`):
 * `data-float` is what session-scroll-glass.css and the glass header's offset rules key on.
 */
function useTopFloat(ref: RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    const body = el?.parentElement;
    if (!el || !body || !on) return;
    const apply = () => {
      if (body.firstElementChild !== el || el.getClientRects().length === 0) {
        delete el.dataset.float;
        body.style.removeProperty('--sp-top-h');
        return;
      }
      el.dataset.float = '';
      const next = `${el.offsetHeight}px`;
      if (body.style.getPropertyValue('--sp-top-h') !== next) body.style.setProperty('--sp-top-h', next);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const rows = new MutationObserver(apply);
    rows.observe(body, { childList: true });
    return () => { ro.disconnect(); rows.disconnect(); delete el.dataset.float; body.style.removeProperty('--sp-top-h'); };
  }, [ref, on]);
}

/** The top of a chat whose task keeps Threads: the items that are not threads (when the strip is on), then the first thread. */
function SessionTop({ task, sessionId, actions, threadsOpen, float }: { task: Task; sessionId: string; actions: boolean; threadsOpen: boolean; float: boolean }) {
  const threads = useOrgThreads(task.id, true);
  // One list and one clock for both: what the top shows and what the strip leaves to it.
  const { at, list, working } = useTopThreads(threads);
  const cursor = useTopCursor(list);
  // A decision a listed thread holds is drawn there, once (on another thread, the top's bar points to
  // it). Hidden, it stays its thread's: the one line names it (hiddenAsk), and the strip never draws it
  // again (2026-11-23, the user, on a hidden top under the same question in the strip, asking to merge
  // the two into one).
  const all = task.user_status?.actions ?? [];
  // What he snoozed leaves the top of his chat until its time (stripItems; its row keeps it greyed).
  const items = actions && task.phase !== 'COMPLETE' ? stripItems(all, list, at) : [];
  // Threads being worked on keep the top's one line even with none for him (threads_each_question).
  const topShown = (list.length > 0 || working.length > 0) && !threadsOpen;
  const shown = items.length > 0 || topShown;
  const [hidden, setHidden] = useTopHidden();
  const room = useTopRoom(shown, float);
  // Nothing to show draws nothing: an empty first child would still move the chat under the glass header.
  if (!shown) return null;
  return (
    <div className="session-top" data-testid="session-top" ref={room}>
      {items.length > 0 && (hidden
        ? <StripLine task={task} items={items} onShow={() => setHidden(false)} />
        : <ActionNeeded task={task} variant="strip" sessionId={sessionId} accepts={(it) => stripItems([it], list, at).length > 0} onHide={() => setHidden(true)} />)}
      {topShown && <TopThread task={task} sessionId={sessionId} threads={threads} list={list} at={at} cursor={cursor} working={working} decisions={actions && task.phase !== 'COMPLETE' ? all : []} />}
    </div>
  );
}
