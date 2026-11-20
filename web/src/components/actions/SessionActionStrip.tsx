/**
 * The strip under a session's title bar (experiment action_needed_everywhere; 2026-11-19, the user:
 * "我点进去之后，如果它有 needs you，它直接就能显示在……title bar，或者在下面"): its task's Action
 * needed items, the same ones as its row, answered and snoozed in place. This session's own live
 * prompt only points at its card in the chat below (ActionNeeded variant="strip").
 *
 * Experiment top_thread: a task that keeps Threads (Main, a lead, a task with Threads on) shows its
 * first thread there instead (org/TopThread.tsx), under the items that are not threads yet (a live
 * prompt, an approval), which still lead as they do today and are not counted in its "1 / N".
 */
import { memo, useLayoutEffect, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { keepsThreads } from '@open-walnut/keeps-threads';
import { useExperimental } from '@/hooks/useExperimental';
import { useOrgThreads } from '@/components/org/useOrgThreads';
import { TopThread, useTopThreads } from '@/components/org/TopThread';
import { actionsNotThreads } from '@/components/org/top-thread-model';
import { ActionNeeded } from './ActionNeeded';

export const SessionActionStrip = memo(function SessionActionStrip({ task, sessionId }: { task: Task | null | undefined; sessionId: string }) {
  const on = useExperimental('action_needed_everywhere');
  const top = useExperimental('top_thread');
  const everyTask = useExperimental('task_threads');
  if (top && task && keepsThreads(task, everyTask)) return <SessionTop task={task} sessionId={sessionId} actions={on} />;
  if (!on || !task?.user_status?.actions?.length) return null;
  return <ActionNeeded task={task} variant="strip" sessionId={sessionId} />;
});

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

function useTopRoom(shown: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const body = el?.parentElement;
    if (!el || !body) return;
    const fit = () => {
      const h = body.clientHeight;
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
  return ref;
}

/** The top of a chat whose task keeps Threads: the items that are not threads (when the strip is on), then the first thread. */
function SessionTop({ task, sessionId, actions }: { task: Task; sessionId: string; actions: boolean }) {
  const threads = useOrgThreads(task.id, true);
  // One list and one clock for both: what the top shows and what the strip leaves to it.
  const { at, list } = useTopThreads(threads);
  const items = actions && task.phase !== 'COMPLETE' ? actionsNotThreads(task.user_status?.actions ?? [], list) : [];
  const shown = items.length > 0 || list.length > 0;
  const room = useTopRoom(shown);
  // Nothing to show draws nothing: an empty first child would still move the chat under the glass header.
  if (!shown) return null;
  return (
    <div className="session-top" data-testid="session-top" ref={room}>
      {items.length > 0 && <ActionNeeded task={task} variant="strip" sessionId={sessionId} accepts={(it) => actionsNotThreads([it], list).length > 0} />}
      {list.length > 0 && <TopThread task={task} sessionId={sessionId} threads={threads} list={list} at={at} />}
    </div>
  );
}
