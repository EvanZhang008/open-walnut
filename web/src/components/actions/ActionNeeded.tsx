/**
 * Action needed on a task's row (2026-11-19, the user: "会在这个 task 的 panel 上面……显示一个
 * approval, action needed……我就可以直接在那里面 approve, make decision", and "这个东西本身
 * snooze……check again later……snooze until"). One block under the row, one line per thing the task
 * asks of the user (user_status.actions, core/action-needed.ts): what it asks, a line of why, a box
 * to type the answer in (always shown), its buttons and its own Snooze.
 *
 * Every answer is the one that thing already has, never a new one: an approval's Approve / Deny
 * (ApprovalButtons, Touch ID and Passwords included), a session prompt's own controls
 * (KanbanCardPrompt), a letter's actions, a Board choice, or the ask's form sent to its session
 * (OrgInlineAnswer, the Org page's). ANSWERS below names the surface of each kind;
 * tests/core/action-needed-ratchet.test.ts fails on a kind with none.
 *
 * One ask at a time (ask-pages.ts; 2026-11-20, the user: "max shoudl 1 decision, and can left and
 * right"): each ask is its own page, with its own words, options and box, and "‹ 1/3 ›" pages
 * through them. An answered page stays, marked with what was said, and opens again with the reason
 * when the server says no; a snoozed page greys out with its time and an Unsnooze, and comes back
 * by itself then.
 *
 * The same block is drawn in two places, from the one list, so an item answered or snoozed in one
 * goes from both (2026-11-19, the user: "我点进去之后，如果它有 needs you，它直接就能显示在……
 * title bar，或者在下面"): a task's row, the strip under a session's
 * title bar (`variant="strip"`, experiment action_needed_everywhere).
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { ACTION_KIND_LABELS, type ActionItem, type ActionKind } from '@open-walnut/user-status';
import { apiPut } from '@/api/client';
import { ApprovalButtons } from '@/components/approvals/ApprovalPrompts';
import { openApproval, useApprovals } from '@/components/approvals/approvals-store';
import { ApprovalReply, OrgInlineAnswer, type AnswerFailure, type AnswerSettle } from '@/components/org/OrgInlineAnswer';
import { resolveTaskSessionId } from '@/utils/session-status';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import { keepKeysInside } from '@/utils/keep-keys-inside';
import type { OrgAlertView } from '@/components/org/org-channels-model';
import { SnoozeDateFlyout, SnoozeFlyout } from '@/components/tasks/SnoozeChoices';
import { snoozeUntilText } from '@/components/tasks/quick-sort-model';
import { log } from '@/utils/log';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { AskCardFrame } from './AskCard';
import { AskPager, usePageGestures } from './AskPager';
import { anyOpen, useAskPages, type AnsweredAsk } from './ask-pages';
import './action-needed.css';

/** How each kind is answered on a row: the surface it reuses (the ratchet reads this). */
export const ANSWERS: Record<ActionKind, 'approval' | 'prompt' | 'letter' | 'choice' | 'ask'> = {
  approval: 'approval', question: 'prompt', permission: 'prompt', letter: 'letter', choice: 'choice', ask: 'ask',
};

/** The Org page's alert shape for one item, so OrgInlineAnswer answers that item and no other. */
export function alertOfItem(task: Pick<Task, 'id' | 'title' | 'user_status'>, item: ActionItem): OrgAlertView {
  const base = { taskId: task.id, title: task.title, itemId: item.id, ask: item.summary };
  if (item.kind === 'question' || item.kind === 'permission') return { ...base, kind: item.kind, tool: item.kind === 'question' ? 'AskUserQuestion' : undefined };
  const source = item.kind === 'letter' ? 'letter' : item.kind === 'choice' ? 'choice' : 'session';
  return { ...base, kind: 'needs', source, ...(item.form ? { form: item.form } : {}) };
}

function snoozeItem(taskId: string, itemId: string, until: string | null): Promise<unknown> {
  return apiPut(`/api/v1/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(itemId)}/snooze`, { until });
}

/** Snooze ▾: the presets ("In 1 hour" first), then a date and time of the user's own. */
function SnoozeButton({ label, onPick }: { label: string; onPick: (until: string) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<null | 'presets' | 'date'>(null);
  // One open menu at a time: a press outside it or Escape closes it (web/src/AGENTS.md, Menus & overlays).
  useOverlayLayer({
    open: menu !== null, refs: [btn], exemptSelectors: ['.task-kebab-project-flyout'], trapFocus: false,
    onClose: (reason) => { setMenu(null); if (reason === 'escape') btn.current?.focus({ preventScroll: true }); },
  });
  const point = () => { const r = btn.current?.getBoundingClientRect(); return { x: r ? r.left : 0, y: r ? r.bottom + 2 : 0 }; };
  return (
    <>
      <button ref={btn} type="button" className="btn btn-sm action-needed-snooze" data-testid="action-snooze"
        aria-haspopup="dialog" aria-expanded={menu !== null} aria-label={`Snooze this ${label.toLowerCase()}`}
        onClick={() => setMenu(menu ? null : 'presets')}>Snooze <span aria-hidden="true">▾</span></button>
      {menu === 'presets' && (
        <SnoozeFlyout soon point={point()} anchorRef={btn} onSnooze={onPick} onPickDate={() => setMenu('date')} onClose={() => setMenu((m) => (m === 'presets' ? null : m))} />
      )}
      {menu === 'date' && (
        <SnoozeDateFlyout point={point()} anchorRef={btn} onPick={(d) => { if (d) onPick(d.includes('T') ? new Date(d).toISOString() : new Date(`${d}T09:00:00`).toISOString()); }} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

function ApprovalAnswer({ item, task, onDone }: { item: ActionItem; task: Task; onDone?: (said: string) => void }) {
  const s = useApprovals();
  // A decided approval leaves `items` for `done` (approvals-store.ts settle): read both, or the
  // decision is never seen here and its page goes unmarked with the next status push.
  const a = s.items.get(item.id) ?? s.done[item.id];
  // Approved or denied while shown here: its page stays, marked with that word.
  const was = useRef(a?.status);
  useEffect(() => {
    const now = a?.status;
    if (was.current === 'pending' && (now === 'approved' || now === 'denied')) onDone?.(now === 'approved' ? 'Approved' : 'Denied');
    was.current = now;
  }, [a?.status, onDone]);
  const words = <ApprovalReply sessionId={item.sessionId ?? resolveTaskSessionId(task)} summary={item.summary} />;
  // The store has not read it yet (or it just ended): its dialog has it.
  if (!a || a.status !== 'pending') {
    return (<>
      <button type="button" className="btn btn-sm" data-testid="action-approval-open" onClick={() => openApproval(item.id)}>Open</button>
      {words}
    </>);
  }
  return (
    <div className="action-needed-approval" data-testid="action-approval">
      <ApprovalButtons a={a} s={s} />
      <button type="button" className="btn btn-sm action-needed-details" data-testid="action-approval-details" onClick={() => openApproval(item.id)}>Details</button>
      {words}
    </div>
  );
}

/** Scroll this session's own prompt card into view: the strip points at it, never answers it twice.
 *  False when the chat has not drawn that card (still loading, or out of its window). */
function showPromptBelow(from: HTMLElement | null): boolean {
  const card = from?.closest('.session-panel')?.querySelector<HTMLElement>('[data-prompt-pending="true"]');
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return !!card;
}

const settled: AnswerSettle = () => {};

/** One thing a task asks of the user, as the one ask card (AskCard.tsx): what it asks, a line of
 *  why, the box to type in and its buttons, Snooze last. `onAnswer` marks it answered the moment an
 *  answer goes (the block's own pages); alone it waits for the status to drop it. */
export const AskCard = memo(function AskCard({ task, item, onAnswer = () => settled, failure, below, threadId, answered, pager }: {
  task: Task; item: ActionItem; onAnswer?: (id: string, said?: string) => AnswerSettle; failure?: AnswerFailure;
  /** Answered from here: its words stay, its answer is the line that says what was said. */
  answered?: AnsweredAsk;
  /** The block's "‹ 1/3 ›", beside Snooze. */
  pager?: ReactNode;
  /** Its own card is in the chat below (a session's strip, its own live prompt): point at it. */
  below?: boolean;
  /** Drawn on the thread that holds this ask (core/org/thread-report-ask.ts): the answer is filed under it. */
  threadId?: string;
}) {
  // A snooze written here reads at once, until the server's value moves (here, or from another
  // place showing the same item): then the server's wins.
  const [snoozing, setSnoozing] = useState<{ until: string | null; from: string | null } | null>(null);
  const [note, setNote] = useState('');
  // Its card is not in the chat: the strip answers it after all (one answer still, the card's twin).
  const [answerHere, setAnswerHere] = useState(false);
  const server = item.snoozedUntil ?? null;
  // Once the server's value moved, it holds from then on (a later move back, an unsnooze made in
  // another place, must not bring this place's own write back).
  useEffect(() => { setSnoozing((s) => (s && s.from !== server ? null : s)); }, [server]);
  const own = snoozing && snoozing.from === server ? snoozing.until : server;
  const until = own && Date.parse(own) > Date.now() ? own : null;
  const label = ACTION_KIND_LABELS[item.kind];
  const write = (next: string | null) => {
    setSnoozing({ until: next, from: server });
    setNote('');
    snoozeItem(task.id, item.id, next).then(() => {
      log.info('action-needed', next ? 'item snoozed' : 'item unsnoozed', { taskId: task.id, itemId: item.id, kind: item.kind, until: next ?? '' });
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('action-needed', 'item snooze failed', { taskId: task.id, itemId: item.id, error: message });
      setSnoozing(null);
      setNote(`${next ? 'Snooze' : 'Unsnooze'} failed: ${message}`);
    });
  };
  let answer: ReactNode = null;
  const snooze = answered ? null : until
    ? <button type="button" className="btn btn-sm action-needed-snooze" data-testid="action-unsnooze" onClick={() => write(null)}>Unsnooze</button>
    : <SnoozeButton label={label} onPick={write} />;
  if (answered) {
    answer = (
      <div className="ask-card-answered" role="status" tabIndex={-1} data-testid="action-answered">
        <span className="ask-card-answered-mark" aria-hidden="true">✓</span>
        {answered.said ? <>Answered: <span className="ask-card-answered-said">{answered.said}</span></> : 'Answered'}
      </div>
    );
  } else if (!until && below && !answerHere) {
    answer = (
      <button type="button" className="btn btn-sm action-needed-below" data-testid="action-answer-below"
        onClick={(e) => { if (!showPromptBelow(e.currentTarget)) setAnswerHere(true); }}>Answer below <span aria-hidden="true">↓</span></button>
    );
  } else if (!until) {
    answer = ANSWERS[item.kind] === 'approval' ? <ApprovalAnswer item={item} task={task} onDone={(said) => { onAnswer(item.id, said); }} /> : (
      <OrgInlineAnswer alert={alertOfItem(task, item)} task={task} summary={item.summary} onAnswer={(_task, said) => onAnswer(item.id, said)} failure={failure} {...(item.sessionId ? { sessionId: item.sessionId } : {})} {...(threadId ? { threadId } : {})} />
    );
  }
  // A live prompt's own card says its question: the card would say it twice.
  const says = !!answered || !!until || (below && !answerHere) || ANSWERS[item.kind] !== 'prompt';
  const source = taskTextSource(task, 'needs');
  return (
    <AskCardFrame
      testId="action-item"
      className={`action-needed-item${answered ? ' is-answered' : until ? ' is-snoozed' : ''}`}
      data={{ 'data-kind': item.kind, 'data-item-id': item.id, 'data-answered': answered ? 'true' : undefined }}
      question={says ? <AgentText compact inline {...source} text={item.summary} testId="action-summary" /> : undefined}
      detail={says && item.detail ? <AgentText compact inline {...source} text={item.detail} testId="action-detail" /> : undefined}
      status={<>
        {until ? (
          <div className="ask-card-status" data-testid="action-snoozed-until">
            Snoozed until {snoozeUntilText(until)}{item.blocking ? ' · its session waits on it' : ''}
          </div>
        ) : null}
        {note ? <div className="org-answer-error" role="alert" data-testid="action-snooze-note">{note}</div> : null}
      </>}
      answer={answer}
      tools={snooze || pager ? <>{pager}{snooze}</> : undefined}
    />
  );
});

/** The block under a row; nothing when the task asks nothing. `variant`: 'row' (a task row, whose
 *  click opens the task: a click inside never reaches it), 'card' (a Threads card) or 'strip' (under
 *  a session's title bar, where that session's own live prompt points at its card below). Every
 *  variant shows one ask at a time, the same pages. */
export const ActionNeeded = memo(function ActionNeeded({ task, variant = 'row', sessionId, accepts }: {
  task: Task; variant?: 'row' | 'strip' | 'card'; sessionId?: string;
  /** Only the task's items this place shows (the strip above a top thread leaves out the ones that
   *  are threads); answered pages kept from another place obey it too. */
  accepts?: (item: ActionItem) => boolean;
}) {
  const book = useAskPages(task.id, task.user_status?.actions ?? [], accepts);
  const [failures, setFailures] = useState<Record<string, AnswerFailure>>({});
  // The focus never falls out of the block with a card that goes (a page turned, an answer that
  // turns its button into the "Answered" line, a page the status dropped): it lands on an arrow,
  // the one that was pressed when there is one.
  const refocus = useRef<'prev' | 'next' | null>(null);
  const focusInside = useRef(false);
  const holder = useRef<HTMLDivElement>(null);
  const onAnswer = useLeanCallback((id: string, said?: string): AnswerSettle => {
    const item = book.pages.find((p) => p.id === id);
    // Its button or box goes with the answer: the focus moves on to an arrow, if it was here.
    if (holder.current?.contains(document.activeElement)) refocus.current = 'next';
    if (item) book.answer(item, said);
    setFailures((f) => { const { [id]: _gone, ...rest } = f; return rest; });
    return (failure) => {
      if (!failure) return;
      book.reopen(id);
      setFailures((f) => ({ ...f, [id]: failure }));
    };
  }, []);
  const { pages, index } = book;
  const count = pages.length;
  const go = (delta: number, from?: 'prev' | 'next') => { if (book.go(delta) && from) refocus.current = from; };
  const gestures = usePageGestures(count, (delta) => go(delta, delta < 0 ? 'prev' : 'next'));
  useLayoutEffect(() => {
    const from = refocus.current;
    refocus.current = null;
    const el = holder.current;
    if (!el) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!from && !(focusInside.current && lost)) return;
    const want = (from ? el.querySelector<HTMLElement>(`[data-testid="action-page-${from}"]:not(:disabled)`) : null)
      ?? el.querySelector<HTMLElement>('.ask-pager-btn:not(:disabled)')
      ?? el.querySelector<HTMLElement>('[data-testid="action-answered"]')
      ?? el.querySelector<HTMLElement>('button:not(:disabled), textarea');
    want?.focus({ preventScroll: true });
  });
  if (!count || !anyOpen(pages, book.answered) || task.phase === 'COMPLETE') return null;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const strip = variant === 'strip';
  const item = pages[index]!;
  // A send that failed on a page he left: the place says so until he goes back to it.
  const unsent = pages.filter((p) => p.id !== item.id && failures[p.id] && !book.answered[p.id]).length;
  const pager = count > 1 ? <AskPager index={index} count={count} unsent={unsent} onGo={go} /> : undefined;
  return (
    // On a row a click, a key or a drag inside answers here: it never opens or drags the row.
    // Escape still goes on, to the file viewer a path in its words opened (keepKeysInside).
    <div className={`action-needed${strip ? ' is-strip' : ''}${count > 1 ? ' is-paged' : ''}`} data-testid={strip ? 'session-action-needed' : 'action-needed'} data-action-task={task.id}
      data-pages={count} data-page={index + 1}
      {...(variant === 'row' ? { onClick: stop, onKeyDown: keepKeysInside, onPointerDown: stop } : {})}>
      {/* Its card says what it is; the words stay for a screen reader, with the page it is on. */}
      <div className="action-needed-title" aria-live="polite" data-testid="action-needed-place">
        {count > 1 ? `Decision ${index + 1} of ${count}${unsent ? `, ${unsent} not sent` : ''}` : 'Action needed'}
      </div>
      <div ref={holder} className="ask-pages" data-testid="action-pages" {...gestures}
        onFocus={() => { focusInside.current = true; }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInside.current = false; }}>
        <AskCard key={item.id} task={task} item={item} onAnswer={onAnswer} failure={failures[item.id]} pager={pager}
          {...(book.answered[item.id] ? { answered: book.answered[item.id] } : {})}
          below={strip && !!sessionId && item.sessionId === sessionId && ANSWERS[item.kind] === 'prompt'} />
      </div>
    </div>
  );
});
