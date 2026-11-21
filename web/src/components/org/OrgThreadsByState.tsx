/**
 * A node's Threads in their groups (experiment brief_off, core/org/thread-groups.ts): the view that
 * replaces the Brief. A row of chips over them is a filter (ThreadsFilterBar): a group's chip shows
 * only that group's cards, All shows every group under its head but Archived, which shows only when
 * its own chip is picked (2026-11-20, the user: clicking a group still listed the Needs you cards).
 * The pick is kept per node (utils/view-memory.ts). Each thread is drawn by the same card every
 * Threads surface uses (OrgThreads ThreadItem), passed in.
 *
 * The chips stay at the top of the pane while a long group scrolls (sticky, org-threads.css), and a
 * card that leaves the group on screen leaves a line in its place for a few seconds (thread-moves.ts).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { ALL_SHOWS, THREAD_GROUPS, THREAD_GROUP_LABELS, type ThreadGroup } from '@open-walnut/thread-groups';
import { ThreadsFilterBar, type ThreadFilter } from './ThreadsFilterBar';
import { MOVE_NOTE_MS, useThreadMoves, type ThreadMove } from './thread-moves';
import { useExperimental } from '@/hooks/useExperimental';

export const isThreadFilter = (v: unknown): v is ThreadFilter =>
  v === 'all' || (THREAD_GROUPS as readonly unknown[]).includes(v);

/** The line a card left in its place: where it went, Show to pick that chip. It goes by itself; one
 *  holding the focus hands it to the chip picked, never to the page. */
function MoveNote({ m, onShow, onDone }: { m: ThreadMove; onShow: (m: ThreadMove) => void; onDone: (id: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      const li = ref.current;
      if (li?.contains(document.activeElement)) {
        li.closest('[data-testid="org-thread-groups"]')?.querySelector<HTMLElement>('[data-testid="org-threads-chip"][aria-pressed="true"]')?.focus({ preventScroll: true });
      }
      onDone(m.id);
    }, MOVE_NOTE_MS);
    return () => window.clearTimeout(id);
  }, [m, onDone]);
  return (
    <li ref={ref} className="org-thread-move-note" data-testid="org-thread-move-note" data-moved-id={m.id} data-to={m.to} role="status">
      {/* Where it went first: a long title gives way, never the group. */}
      <span className="org-thread-move-to">{`Moved to ${THREAD_GROUP_LABELS[m.to]}`}</span>
      <span className="org-thread-move-words">{`\u201c${m.title}\u201d`}</span>
      <button type="button" className="org-thread-link" data-testid="org-thread-move-show" onClick={() => onShow(m)}>Show</button>
    </li>
  );
}

export function OrgThreadsByState({ groups, filter, onFilter, card, name, onShowThread, epoch = 0 }: {
  groups: Record<ThreadGroup, OrgThread[]>;
  /** The chip he picked: one group, or all of them. */
  filter: ThreadFilter;
  onFilter: (f: ThreadFilter) => void;
  card: (t: OrgThread) => ReactNode;
  name: string;
  /** Bring a card into view and mark it a moment (thread-focus.ts), after its chip is picked. */
  onShowThread?: (id: string) => void;
  /** Reads that caught the pane up (useOrgThreads catchUp): no move is drawn across one. */
  epoch?: number;
}) {
  // Acknowledged holds cards only while ack_means_known is on: off, its chip shows only for one left from before.
  const ackOn = useExperimental('ack_means_known');
  const { moves, dismiss } = useThreadMoves(groups, filter, epoch);
  const rootRef = useRef<HTMLDivElement>(null);
  // The focus was in these Threads (a card's button, its menu portalled out but still its child):
  // when the card it was on leaves, the focus would drop to the page; the line left there takes it.
  const hadFocus = useRef(false);
  // Typing in a card's box when the node moves the card: the next key must not press Show (a
  // review: a space would pick another chip), so a text field's focus goes to the chip on show.
  const wasTyping = useRef(false);
  const chipOnShow = () => rootRef.current?.querySelector<HTMLElement>('[data-testid="org-threads-chip"][aria-pressed="true"]');
  useEffect(() => {
    const last = moves[moves.length - 1];
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!last || !hadFocus.current || !lost) return;
    (wasTyping.current ? chipOnShow() : rootRef.current?.querySelector<HTMLElement>(`[data-moved-id="${CSS.escape(last.id)}"] button`))?.focus({ preventScroll: true });
  }, [moves]);
  const chips = THREAD_GROUPS.filter((g) => g !== 'known' || ackOn || groups.known.length > 0 || filter === 'known');
  if (!THREAD_GROUPS.some((g) => groups[g].length > 0)) {
    return (
      <p className="org-threads-empty" data-testid="org-threads-empty">
        {`Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
      </p>
    );
  }
  const shown = filter === 'all' ? ALL_SHOWS : [filter];
  // Show picks the card's chip and hands it the focus, so a keyboard keeps its place.
  const show = (m: ThreadMove) => {
    dismiss(m.id); onFilter(m.to); onShowThread?.(m.id);
    requestAnimationFrame(() => chipOnShow()?.focus({ preventScroll: true }));
  };
  return (
    <div
      ref={rootRef} className="org-thread-groups" data-testid="org-thread-groups" data-filter={filter}
      onFocus={(e) => { hadFocus.current = true; wasTyping.current = e.target instanceof HTMLElement && (e.target.matches('input, textarea') || e.target.isContentEditable); }}
      onBlur={(e) => { if (!e.relatedTarget || !(e.currentTarget.contains(e.relatedTarget as Node))) hadFocus.current = false; }}
    >
      <ThreadsFilterBar counts={chips.map((g) => ({ group: g, n: groups[g].length }))} all={ALL_SHOWS.reduce((n, g) => n + groups[g].length, 0)} at={filter} onPick={onFilter} />
      {filter === 'all' && !ALL_SHOWS.some((g) => groups[g].length > 0) && !moves.length && (
        <p className="org-threads-empty" data-testid="org-threads-empty">Nothing open. What you closed before is under Archived.</p>
      )}
      {shown.map((g) => {
        const list = groups[g];
        const notes = moves.filter((m) => m.from === g);
        // Each line stands where its card stood, among the cards still there.
        const items: ReactNode[] = list.map(card);
        for (const m of [...notes].sort((a, b) => b.index - a.index)) items.splice(Math.min(m.index, items.length), 0, <MoveNote key={`moved-${m.id}`} m={m} onShow={show} onDone={dismiss} />);
        // Under All an empty group has no head; picked alone, it says it is empty.
        if (!list.length && !notes.length) {
          return filter === 'all' ? null : (
            <p key={g} className="org-threads-empty" data-testid="org-thread-group-empty" data-group={g}>{`Nothing in ${THREAD_GROUP_LABELS[g]}.`}</p>
          );
        }
        return (
          <section key={g} className="org-thread-group" data-testid="org-thread-group" data-group={g}>
            <h3 className="org-thread-group-head" data-testid="org-thread-group-head">
              <span className="org-thread-group-label">{THREAD_GROUP_LABELS[g]}</span>
              <span className="org-thread-group-count" data-testid="org-thread-group-count">{list.length}</span>
            </h3>
            <ul className="org-thread-list" data-testid="org-thread-list" data-show={g}>{items}</ul>
          </section>
        );
      })}
    </div>
  );
}
