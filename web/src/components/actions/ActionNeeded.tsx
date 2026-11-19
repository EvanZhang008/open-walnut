/**
 * Action needed on a task's row (2026-11-19, the user: "会在这个 task 的 panel 上面……显示一个
 * approval, action needed……我就可以直接在那里面 approve, make decision", and "这个东西本身
 * snooze……check again later……snooze until"). One block under the row, one line per thing the task
 * asks of the user (user_status.actions, core/action-needed.ts): its kind, what it asks, and its
 * answer right there, each with its own Snooze.
 *
 * Every answer is the one that thing already has, never a new one: an approval's Approve / Deny
 * (ApprovalButtons, Touch ID and Passwords included), a session prompt's own controls
 * (KanbanCardPrompt), a letter's actions, a Board choice, or the ask's form sent to its session
 * (OrgInlineAnswer, the Org page's). ANSWERS below names the surface of each kind;
 * tests/core/action-needed-ratchet.test.ts fails on a kind with none.
 *
 * An answered line goes the moment it is sent and comes back with the reason when the server says
 * no; a snoozed line greys out with its time and an Unsnooze, and comes back by itself then.
 *
 * The same block is drawn in three places, all from the one list, so an item answered or snoozed in
 * one goes from all (2026-11-19, the user: "我点进去之后，如果它有 needs you，它直接就能显示在……
 * title bar，或者在下面", and asks "放到 thread 里面"): a task's row, the strip under a session's
 * title bar (`variant="strip"`, experiment action_needed_everywhere) and a VP's Threads (TeamActions).
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { ACTION_KIND_LABELS, type ActionItem, type ActionKind } from '@open-walnut/user-status';
import { apiPut } from '@/api/client';
import { ApprovalButtons } from '@/components/approvals/ApprovalPrompts';
import { openApproval, useApprovals } from '@/components/approvals/approvals-store';
import { ApprovalReply, OrgInlineAnswer, type AnswerFailure, type AnswerSettle } from '@/components/org/OrgInlineAnswer';
import { resolveTaskSessionId } from '@/utils/session-status';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import type { OrgAlertView } from '@/components/org/org-channels-model';
import { SnoozeDateFlyout, SnoozeFlyout } from '@/components/tasks/SnoozeChoices';
import { snoozeUntilText } from '@/components/tasks/quick-sort-model';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
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
        aria-haspopup="dialog" aria-expanded={menu !== null} aria-label={`Snooze ${label}`}
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

function ApprovalAnswer({ item, task }: { item: ActionItem; task: Task }) {
  const s = useApprovals();
  const a = s.items.get(item.id);
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

const Line = memo(function Line({ task, item, onAnswer, failure, below }: {
  task: Task; item: ActionItem; onAnswer: (id: string) => AnswerSettle; failure?: AnswerFailure;
  /** Its own card is in the chat below (a session's strip, its own live prompt): point at it. */
  below?: boolean;
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
  if (!until && below && !answerHere) {
    answer = (
      <button type="button" className="btn btn-sm action-needed-below" data-testid="action-answer-below"
        onClick={(e) => { if (!showPromptBelow(e.currentTarget)) setAnswerHere(true); }}>Answer below <span aria-hidden="true">↓</span></button>
    );
  } else if (!until) {
    answer = ANSWERS[item.kind] === 'approval' ? <ApprovalAnswer item={item} task={task} /> : (
      <OrgInlineAnswer alert={alertOfItem(task, item)} task={task} summary={item.summary} onAnswer={() => onAnswer(item.id)} failure={failure} {...(item.sessionId ? { sessionId: item.sessionId } : {})} />
    );
  }
  return (
    <div className={`action-needed-item${until ? ' is-snoozed' : ''}`} data-testid="action-item" data-kind={item.kind} data-item-id={item.id} data-peek-row="">
      {/* Its kind and age, its Snooze at the end; what it asks on the lines below (a narrow panel
          keeps the words: they never share a line with the buttons). */}
      <div className="action-needed-head">
        <span className={`action-needed-kind action-kind-${item.kind}`} data-testid="action-kind">{label}</span>
        {item.at && !until ? <span className="action-needed-ago">{timeAgo(item.at)}</span> : null}
        <span className="action-needed-fill" />
        {until
          ? <button type="button" className="btn btn-sm" data-testid="action-unsnooze" onClick={() => write(null)}>Unsnooze</button>
          : <SnoozeButton label={label} onPick={write} />}
      </div>
      {/* A live prompt's own card says its question: the line would say it twice. */}
      {until || (below && !answerHere) || ANSWERS[item.kind] !== 'prompt'
        ? <div className="action-needed-summary"><AgentText compact inline {...taskTextSource(task, 'needs')} text={item.summary} testId="action-summary" /></div> : null}
      {until ? (
        <div className="action-needed-until" data-testid="action-snoozed-until">
          Snoozed until {snoozeUntilText(until)}{item.blocking ? ' · its session waits on it' : ''}
        </div>
      ) : null}
      {note ? <div className="org-answer-error" role="alert" data-testid="action-snooze-note">{note}</div> : null}
      {answer ? <div className="action-needed-answer">{answer}</div> : null}
    </div>
  );
});

/** The strip shows this many lines, then "N more": a session's chat keeps its room, and the first
 *  asks (blocking first, then oldest: markSnoozes) are always in sight. */
const STRIP_LINES = 2;

/** The block under a row; nothing when the task asks nothing. `variant`: 'row' (a task row, whose
 *  click opens the task: a click inside never reaches it), 'card' (a Threads card) or 'strip' (under
 *  a session's title bar, where that session's own live prompt points at its card below). */
export const ActionNeeded = memo(function ActionNeeded({ task, variant = 'row', sessionId }: { task: Task; variant?: 'row' | 'strip' | 'card'; sessionId?: string }) {
  const items = task.user_status?.actions ?? [];
  const [restShown, setRestShown] = useState(false);
  // Answered from here and not yet gone from the status: hidden; a failure brings it back.
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, AnswerFailure>>({});
  const onAnswer = useLeanCallback((id: string): AnswerSettle => {
    setSent((s) => new Set(s).add(id));
    setFailures((f) => { const { [id]: _gone, ...rest } = f; return rest; });
    return (failure) => {
      if (!failure) return;
      setSent((s) => { const n = new Set(s); n.delete(id); return n; });
      setFailures((f) => ({ ...f, [id]: failure }));
    };
  }, []);
  const shown = items.filter((i) => !sent.has(i.id));
  if (!shown.length || task.phase === 'COMPLETE') return null;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const strip = variant === 'strip';
  const lines = strip && !restShown ? shown.slice(0, STRIP_LINES) : shown;
  const rest = shown.length - lines.length;
  return (
    // On a row a click, a key or a drag inside answers here: it never opens or drags the row.
    <div className={`action-needed${strip ? ' is-strip' : ''}`} data-testid={strip ? 'session-action-needed' : 'action-needed'} data-action-task={task.id}
      {...(variant === 'row' ? { onClick: stop, onKeyDown: stop, onPointerDown: stop } : {})}>
      <div className="action-needed-title">Action needed{strip ? ` · ${shown.length}` : ''}</div>
      {lines.map((item) => (
        <Line key={item.id} task={task} item={item} onAnswer={onAnswer} failure={failures[item.id]}
          below={strip && !!sessionId && item.sessionId === sessionId && ANSWERS[item.kind] === 'prompt'} />
      ))}
      {strip && (rest > 0 || restShown) && shown.length > STRIP_LINES ? (
        <button type="button" className="action-needed-more" data-testid="action-needed-more" aria-expanded={restShown}
          onClick={() => setRestShown(!restShown)}>{restShown ? 'Show fewer' : `${rest} more`}</button>
      ) : null}
    </div>
  );
});
