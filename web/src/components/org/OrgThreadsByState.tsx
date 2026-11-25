/**
 * A node's Threads in their groups (experiment brief_off, core/org/thread-groups.ts): the view that
 * replaces the Brief. Needs you and Done come first and are always open (FOR_HIM_GROUPS); Working,
 * Waiting / Snoozed, Acknowledged, Closed and Archived follow, each folded to one line with its
 * count until he opens it (FOLDED_GROUPS). No row of chips by state (2026-11-21, the user: "the default is
 * the view you need: Needs you first, then Done, and the rest auto collapsed"; a filter row whose
 * default was All showed every group's cards). The chips by where a thread came from, above these
 * groups once a task below has a thread here, are another filter (ThreadOriginFilter.tsx). What he opens is plain state of the view, never
 * remembered: leaving the view and coming back shows every fold folded again (`opened`, kept by
 * OrgThreads so a thread line or Show can open a fold). A group with no card draws nothing. Each
 * thread is drawn by the same card every Threads surface uses (OrgThreads ThreadItem), passed in.
 *
 * The folded groups come after Done in the list and scroll with it: they show only once he scrolls
 * down to them (2026-11-23, the user: "只有我当 scroll 到下面的时候，它才会显示 ... 它其实没有那么
 * 重要"; they had been pinned along the pane's bottom since 2026-11-22).
 *
 * A card that leaves a group on screen leaves a line in its place for a few seconds (thread-moves.ts).
 */
import { focusUnlessTyping, isTypingField } from '@/utils/focus-unless-typing';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { DisclosureButton } from '@/components/controls';
import type { Task } from '@open-walnut/core';
import type { OrgThread } from '@/api/org-threads';
import { FOLDED_GROUPS, FOR_HIM_GROUPS, THREAD_GROUPS, THREAD_GROUP_LABELS, type ThreadGroup } from '@open-walnut/thread-groups';
import { MOVE_NOTE_MS, shownGroups, useThreadMoves, type ThreadMove } from './thread-moves';
import { EmptyState } from '@/components/common/EmptyState';

/** What an empty threads list says it is for (both list layouts). */
/** Where this is and why it is empty, in one line that never carries the node's long title. */
export const THREADS_EMPTY_HINT = 'Each request you send becomes a thread here, one per subject.';

/** One move of one card: a rename keeps it, a new move from another place is another line. */
const moveKey = (m: ThreadMove) => `moved-${m.id}-${m.from}-${m.index}`;

/** A group's head: a heading (open groups take a focus handed to them, never a Tab stop). */
const headOf = (root: Element | null | undefined, g: ThreadGroup) =>
  root?.querySelector<HTMLElement>(`[data-testid="org-thread-group"][data-group="${g}"] [data-testid="org-thread-group-head"]`) ?? null;

/** A card's head, to give it the focus. Unquoted: this file draws no card, and the card-file guards (thread-origin, thread-badge) read the quoted test id as one that does. */
const CARD_HEAD = '[data-testid=org-thread-head]';

/** The card the focus is in: its id, and its group and place there (null in Watching or a portalled menu). */
interface FocusPlace { id: string; group: ThreadGroup; index: number }
function placeOf(el: Element, groups: Record<ThreadGroup, OrgThread[]>): FocusPlace | null {
  const card = el.closest<HTMLElement>('[data-testid="org-thread"]:not([data-copy])');
  const group = card?.closest<HTMLElement>('[data-testid="org-thread-group"]')?.dataset.group as ThreadGroup | undefined;
  const id = card?.dataset.threadId;
  if (!id || !group || !groups[group]) return null;
  return { id, group, index: Math.max(0, groups[group].findIndex((t) => t.id === id)) };
}

/**
 * The focus dropped to the page because the card it was in left (a move, his Acknowledge, a read
 * from another screen): the line the card left takes it (its Show; its group's head when he was
 * typing), and with no line (his own Acknowledge leaves none, thread-moves.ts) the card that took its
 * place, or the one before it, or its group's head; never the page (2026-11-25).
 */
function keepFocusHome(root: HTMLElement | null, at: FocusPlace | null, groups: Record<ThreadGroup, OrgThread[]>, typing: boolean, stillOurs: () => boolean): void {
  const active = document.activeElement;
  if (!root || !stillOurs() || (active && active !== document.body)) return;
  const line = at
    ? root.querySelector<HTMLElement>(`[data-testid="org-thread-move-note"][data-moved-id="${CSS.escape(at.id)}"]`)
    : [...root.querySelectorAll<HTMLElement>('[data-testid="org-thread-move-note"]')].at(-1) ?? null;
  if (line) {
    const from = at?.group ?? (line.closest<HTMLElement>('[data-testid="org-thread-group"]')?.dataset.group as ThreadGroup | undefined);
    (typing && from ? headOf(root, from) : line.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    return;
  }
  if (!at) return;
  const list = groups[at.group];
  const next = list[at.index] ?? list[at.index - 1];
  const card = !typing && next ? root.querySelector<HTMLElement>(`[data-testid="org-thread-group"][data-group="${at.group}"] [data-testid="org-thread"][data-thread-id="${CSS.escape(next.id)}"] ${CARD_HEAD}`) : null;
  (card ?? headOf(root, at.group) ?? root.querySelector<HTMLElement>('[data-testid="org-thread-group-head"]'))?.focus({ preventScroll: true });
}

/** The line a card left in its place: where it is now, Show to open that group and bring the card
 *  into view. It goes by itself MOVE_NOTE_MS after it showed: a read that moved the card on out of
 *  sight only renames it, a new move (another group left: moveKey) is a new line with its own
 *  clock. One holding the focus hands it to its group's head, never to the page. */
function MoveNote({ m, onShow, onDone }: { m: ThreadMove; onShow: (m: ThreadMove) => void; onDone: (id: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      const li = ref.current;
      if (li?.contains(document.activeElement)) focusUnlessTyping(headOf(li.closest('[data-testid="org-thread-groups"]'), m.from));
      onDone(m.id);
    }, MOVE_NOTE_MS);
    return () => window.clearTimeout(id);
  }, [m.id, m.from, onDone]);
  return (
    <li ref={ref} className="org-thread-move-note" data-testid="org-thread-move-note" data-moved-id={m.id} data-to={m.to} role="status">
      {/* Where it is now first: a long title gives way, never the group. */}
      <span className="org-thread-move-to">{`Moved to ${THREAD_GROUP_LABELS[m.to]}`}</span>
      <span className="org-thread-move-words">{`\u201c${m.title}\u201d`}</span>
      <button type="button" className="org-thread-link" data-testid="org-thread-move-show" onClick={() => onShow(m)}>Show</button>
    </li>
  );
}

/**
 * A node's Threads with nothing in them: what the view is and why it is empty, one short line under
 * the title (the site's empty rule, .claude/skills/walnut-ui-requirements/standard.md), and no
 * button: a new topic is not a thread (OrgThreads). The line stays on screen, never only in a hover
 * text (2026-11-23, UI audit: it had gone into a title attribute). The session pane narrows to it
 * (session-threads.css). Both views draw it (OrgThreads, and this one under brief_off).
 */
export function ThreadsEmpty() {
  return (
    <div className="org-threads-empty-row" data-testid="org-threads-empty-row">
      <EmptyState size="row" title="Nothing open yet" hint={THREADS_EMPTY_HINT} testId="org-threads-empty" />
    </div>
  );
}

export function OrgThreadsByState({ groups, opened, onOpen, card, name, owner, onShowThread, epoch = 0, watching }: {
  groups: Record<ThreadGroup, OrgThread[]>;
  /** The folded groups he opened while here. */
  opened: ReadonlySet<ThreadGroup>;
  onOpen: (g: ThreadGroup, open: boolean) => void;
  card: (t: OrgThread) => ReactNode;
  name: string;
  /** The node's own task: the empty view's New topic picks it. */
  owner?: Task | undefined;
  /** Bring a card into view and mark it a moment (thread-focus.ts), after its group opened. */
  onShowThread?: (id: string) => void;
  /** Reads that caught the pane up (useOrgThreads catchUp): no move is drawn across one. */
  epoch?: number;
  /** His Watching group (OrgThreadsWatching), drawn first: each of its threads is in its own group too. */
  watching?: ReactNode;
}) {
  const shown = useMemo(() => shownGroups(opened), [opened]);
  const { moves, dismiss } = useThreadMoves(groups, shown, epoch);
  const rootRef = useRef<HTMLDivElement>(null);
  // The focus was in these Threads (a card's button, its menu portalled out but still its child):
  // when the card it was on leaves, the focus would drop to the page (keepFocusHome).
  const hadFocus = useRef(false);
  // Typing in a card's box when the card goes: the next key must not press what takes the focus (a
  // review: a space would act on the line), so a text field's focus goes to the group's head.
  const wasTyping = useRef(false);
  // The card the focus is in and its place, kept current while it is there.
  const focusAt = useRef<FocusPlace | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active && root.contains(active)) { focusAt.current = placeOf(active, groups) ?? focusAt.current; return; }
    if (!hadFocus.current || (active && active !== document.body)) return;
    // Its line comes a commit later (useThreadMoves): decided once the frame has it.
    const id = requestAnimationFrame(() => keepFocusHome(rootRef.current, focusAt.current, groups, wasTyping.current, () => hadFocus.current));
    return () => cancelAnimationFrame(id);
  }, [moves, groups]);
  if (!THREAD_GROUPS.some((g) => groups[g].length > 0)) return <ThreadsEmpty />;
  // Show opens the card's group, brings the card's top into view and hands the focus to that
  // group's head, so a keyboard keeps its place.
  const show = (m: ThreadMove) => {
    dismiss(m.id);
    if (!shown.has(m.to)) onOpen(m.to, true);
    onShowThread?.(m.id);
    requestAnimationFrame(() => headOf(rootRef.current, m.to)?.focus({ preventScroll: true }));
  };
  return (
    <div
      ref={rootRef} className="org-thread-groups" data-testid="org-thread-groups"
      onFocus={(e) => { hadFocus.current = true; wasTyping.current = isTypingField(e.target); focusAt.current = placeOf(e.target, groups) ?? focusAt.current; }}
      onBlur={(e) => { if (!e.relatedTarget || !(e.currentTarget.contains(e.relatedTarget as Node))) hadFocus.current = false; }}
    >
      {watching}
      {[...FOR_HIM_GROUPS, ...FOLDED_GROUPS].map((g) => {
        const list = groups[g];
        const folds = FOLDED_GROUPS.includes(g);
        const open = shown.has(g);
        const notes = open ? moves.filter((m) => m.from === g) : [];
        if (!list.length && !notes.length) return null;
        // Each line stands where its card stood, among the cards still there.
        const items: ReactNode[] = open ? list.map(card) : [];
        for (const m of [...notes].sort((a, b) => b.index - a.index)) items.splice(Math.min(m.index, items.length), 0, <MoveNote key={moveKey(m)} m={m} onShow={show} onDone={dismiss} />);
        const label = <span className="org-thread-group-label">{THREAD_GROUP_LABELS[g]}</span>;
        const count = <span className="org-thread-group-count" data-testid="org-thread-group-count">{list.length}</span>;
        return (
          <section
            key={g} className="org-thread-group" data-testid="org-thread-group" data-group={g} data-open={open ? 'true' : 'false'}
          >
            {folds
              ? (
                <DisclosureButton block expanded={open} trailing={count} className="org-thread-group-fold" data-testid="org-thread-group-head" onClick={(e) => {
                  onOpen(g, !open);
                  // Opened below the fold of the pane, its cards would start off screen and the click look
                  // like nothing (2026-11-21 review): the head goes to the top, its cards under it.
                  const head = e.currentTarget;
                  if (!open) requestAnimationFrame(() => head.scrollIntoView({ block: 'start', behavior: 'smooth' }));
                }}>
                  {label}
                </DisclosureButton>
              )
              : <h3 className="org-thread-group-head" data-testid="org-thread-group-head" tabIndex={-1}>{label}{count}</h3>}
            {open && <ul className="org-thread-list" data-testid="org-thread-list" data-show={g}>{items}</ul>}
          </section>
        );
      })}
    </div>
  );
}
