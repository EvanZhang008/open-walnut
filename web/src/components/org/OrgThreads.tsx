/**
 * Threads: the user's own requests to an Org node (Main, a VP, a lead), one thread per subject,
 * beside the Task and Brief views (2026-11-01, the user: "every user request becomes a thread ...
 * I can acknowledge, or do follow up actions"; "if my multiple ask is about the same thread, add
 * it below that thread"). Walnut files every message he sends the node and puts the node's chat
 * reply under it (src/core/org/thread-answers.ts); the node keeps each thread's title and state.
 *
 * A card is kept short (2026-11-01, the user: "the purpose is to keep the thread extremely
 * concise ... I replied from the first one to the ninth, so why still show the first to the
 * eighth?"): its title, the node's summary (latest first, a sentence or two of background), and
 * only the node's answers he has not reacted to, each folded to a few lines with an Expand /
 * Collapse toggle on the answer itself ("I have to click the corner text ... outrageous"). What he
 * already knew (src/core/org/thread-view.ts) is gone from the card; the whole conversation opens
 * from a toggle in the card body, numbered, with Split out on each message.
 *
 * A thread with nothing new for him is out of sight (2026-11-01, the user: "if it is just assigned
 * no need to tell me, or doing, unless there are some update ... thread pending, which is auto
 * hide like closed"): the node sets it pending, and it comes back when he writes in it or the node
 * writes a new summary (src/core/org/threads-model.ts). A summary already naming a task keeps no
 * second chip for it, and one reply that covered several threads stays off every card.
 *
 *   a card     state, title, time; the summary; its tasks the summary does not name; the answers
 *              still news; one line per message still waiting for an answer; Conversation
 *              (N messages); Acknowledge, Follow up (a message filed under it)
 *   Pending    open but nothing new for him: one quiet line at the bottom opens them
 *   Closed     the ones closed this week (kept a week, then deleted) open from one quiet line at
 *              the bottom, Reopen on each
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { cardView, exchangesOf, sharedAnswers, type ThreadExchange } from '@open-walnut/thread-view';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { AnswerBox } from '@/components/common/AnswerBox';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { MessageAbout, rowAbout } from '@/components/sessions/message-about';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import { stripQuestionTag } from '@/utils/question-tag';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { timeAgo } from '@/utils/time';
import { isBoolean, usePageView } from '@/utils/view-memory';
import type { OrgThread, OrgThreadMessage, OrgThreadState } from '@/api/org-threads';
import type { OrgThreadsState } from './useOrgThreads';
import '@/styles/org-threads.css';

/** A task's live status dot, the colours of the Task view's tabs (OrgTaskRail TAB_DOT). */
const TASK_DOT: Record<string, string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};
/** A thread's state in words: the task-state names where they mean the same (USER_STATE_LABELS). */
const STATE_LABEL: Record<OrgThreadState, string> = {
  new: 'New', working: USER_STATE_LABELS.working, needs: USER_STATE_LABELS.needs, answered: 'Answered', pending: 'Pending',
};
const STATE_DOT: Record<OrgThreadState, string> = {
  new: 'var(--accent, #0A84FF)', working: 'var(--success, #34C759)', needs: 'var(--error, #FF3B30)', answered: 'var(--fg-muted, #86868B)',
  pending: 'var(--fg-muted, #86868B)',
};
/** How much of his words the line above an answer quotes. */
const QUOTE_WORDS = 72;
/** Where a thread the node opened itself came from (src/core/org/threads-model.ts THREAD_SOURCES). */
const FROM_LABEL: Record<string, string> = { mail: 'Mail', task: 'A task', letter: 'A letter', trigger: 'A trigger', node: 'Its own finding' };

interface Props {
  name: string;
  state: OrgThreadsState;
  tasks: readonly Task[];
  onOpenTask: (id: string) => void;
  /** Send a message filed under this thread; null when the node has no chat yet. */
  onFollowUp: ((threadId: string, text: string) => Promise<boolean>) | null;
  now: number;
}

function Markdown({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const html = useMemo(() => ({ __html: renderMarkdownWithRefs(text) }), [text]);
  return <div className={`markdown-body ${className ?? ''}`} data-testid={testId} dangerouslySetInnerHTML={html} />;
}

function closedWords(t: OrgThread, now: number): string {
  const c = t.closed!;
  const who = c.by === 'human' ? '' : ' by the agent';
  return `${c.how === 'acked' ? 'Acknowledged' : 'Dropped'}${who} ${timeAgo(c.at, { now })}`;
}

/** A clock time today, a date and time before: when an answer came, the way a chat shows it. */
function clock(at: string, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function TaskChips({ ids, tasks, onOpenTask }: { ids: readonly string[]; tasks: readonly Task[]; onOpenTask: (id: string) => void }) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  return (
    <div className="org-thread-tasks" data-testid="org-thread-tasks">
      {ids.map((id) => {
        const t = byId.get(id);
        const state = t ? userStateOf(t) : null;
        return (
          <button key={id} type="button" className="org-thread-task" data-testid="org-thread-task" data-task-id={id} onClick={() => onOpenTask(id)} title={t?.title ?? id}>
            {state && <i style={{ background: TASK_DOT[state] }} />}
            <span>{t?.title ?? id}</span>
          </button>
        );
      })}
    </div>
  );
}

function FollowUp({ onSend, onDone }: { onSend: (text: string) => Promise<boolean>; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSend(words);
    setBusy(false);
    if (ok) { setText(''); onDone(); } else setFailed(true);
  };
  return (
    <div className="org-thread-follow" data-testid="org-thread-follow">
      {/* Walnut's answer box (common/AnswerBox.tsx): grows with the words, no grip, the mic inside. */}
      <AnswerBox
        autoFocus
        value={text}
        minRows={2}
        placeholder="Follow up on this request"
        testId="org-thread-follow-input"
        onChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); }
          if (e.key === 'Escape') onDone();
        }}
      />
      <div className="org-thread-follow-row">
        {failed && <span className="org-thread-error" data-testid="org-thread-follow-failed">Not sent. Your words are still here.</span>}
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-follow-send" disabled={!text.trim() || busy} onClick={() => void go()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * Long words fold to a few lines. The toggle sits on the text itself, at its left, and a click on
 * the folded text opens it too (a link or a pill inside still does its own thing).
 */
function Fold({ children, className, testId }: { children: React.ReactNode; className: string; testId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [whole, setWhole] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || whole) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 4);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [whole]);
  const folded = long && !whole;
  return (
    <>
      <div
        ref={box}
        className={`org-thread-fold ${className}${whole ? ' is-whole' : ''}${folded ? ' is-folded' : ''}`}
        data-testid={testId}
        onClick={folded ? (e) => {
          // A link, a picture, a pill, a disclosure or a selection keeps its own click.
          if ((e.target as HTMLElement).closest('a, button, img, summary, details, input, [data-source], [data-lightbox-src]')) return;
          if (window.getSelection()?.isCollapsed === false) return;
          setWhole(true);
        } : undefined}
      >
        {children}
      </div>
      {(long || whole) && (
        <button type="button" className="org-thread-toggle" data-testid={`${testId}-more`} aria-expanded={whole} onClick={() => setWhole(!whole)}>
          <span aria-hidden="true">{whole ? '▴' : '▾'}</span>{whole ? 'Collapse' : 'Expand'}
        </button>
      )}
    </>
  );
}

/** The node's answer as its chat shows it, folded to a few lines with the rest one click away. */
function Answer({ text, about, at, by, known, now, testId = 'org-thread-answer', re }: {
  text: string; about?: string[]; at: string; by: string; known: boolean; now: number; testId?: string;
  /** His words it answers, one line, on a card (the conversation shows them in full instead). */
  re?: string;
}) {
  const body = useMemo(() => stripTurnMarker(stripQuestionTag(text)), [text]);
  const ids = useMemo(() => rowAbout(about, text), [about, text]);
  return (
    <div className={`org-thread-answer${known ? '' : ' is-news'}`} data-testid={testId} data-known={known ? 'true' : 'false'}>
      <div className="org-thread-answer-by">{by} · {clock(at, now)}</div>
      {re && <div className="org-thread-re" data-testid="org-thread-re">{re}</div>}
      <Fold className="org-thread-answer-body" testId="org-thread-answer-body"><RichMarkdown text={body} /></Fold>
      {ids.length > 0 && <MessageAbout ids={ids} />}
    </div>
  );
}

function Words({ m }: { m: OrgThreadMessage }) {
  // Pictures render as the chat renders them: a path on its own line becomes the image.
  const text = [m.text, ...(m.images ?? [])].filter(Boolean).join('\n\n');
  return <Fold className="org-thread-words-fold" testId="org-thread-words"><Markdown text={text} className="org-thread-words" /></Fold>;
}

function Exchange({ x, t, name, state, now, shared }: { x: ThreadExchange<OrgThreadMessage>; t: OrgThread; name: string; state: OrgThreadsState; now: number; shared: boolean }) {
  const closed = !!t.closed;
  if (x.opener) {
    const from = `${FROM_LABEL[x.opener.from] ?? FROM_LABEL.node}${x.opener.ref ? `: ${x.opener.ref}` : ''}`;
    return (
      <li className="org-thread-exchange is-opener" data-testid="org-thread-exchange" data-n={0} data-known={x.known ? 'true' : 'false'}>
        <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this · ${from}`} known={x.known} now={now} testId="org-thread-opener" />
      </li>
    );
  }
  return (
    <li className="org-thread-exchange" data-testid="org-thread-exchange" data-n={x.n} data-known={x.known ? 'true' : 'false'}>
      {x.messages.map((m, i) => (
        <div key={m.id} className="org-thread-message" data-testid="org-thread-message" data-message-id={m.id}>
          <span className="org-thread-n" aria-hidden="true">{x.n + i}</span>
          <div className="org-thread-said">
            {(m.via === 'follow-up' || m.via === 'letter') && (
              <div className="org-thread-via">{m.via === 'follow-up' ? 'Follow up' : `Answering “${m.about ?? 'a letter'}”`}</div>
            )}
            <Words m={m} />
          </div>
          {(t.messages.length > 1 || !!t.opener) && !closed && (
            <button type="button" className="org-thread-link org-thread-split" data-testid="org-thread-split" title="This message is about something else: make it its own thread" onClick={() => void state.split(t.id, m.id)}>
              Split out
            </button>
          )}
        </div>
      ))}
      {x.answer ? (
        <Answer text={x.answer.text} about={x.answer.about} at={x.answer.at} by={shared ? `${name} \u00b7 one reply to this and another thread` : name} known={x.known} now={now} />
      ) : (
        <div className="org-thread-answer is-waiting" data-testid="org-thread-unanswered">
          {closed ? 'No answer' : `${name} has not answered yet`}
        </div>
      )}
    </li>
  );
}

function ThreadCard({ t, all, shared, tasks, onOpenTask, state, onFollowUp, name, now }: {
  t: OrgThread; all: readonly OrgThread[]; shared: ReadonlySet<string>; tasks: readonly Task[]; onOpenTask: (id: string) => void;
  state: OrgThreadsState; onFollowUp: Props['onFollowUp']; name: string; now: number;
}) {
  /** The whole conversation shown, in place of what the card keeps. */
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  const closed = !!t.closed;
  const card = useMemo(() => cardView(t, shared), [t, shared]);
  // The tasks the summary already shows as pills get no second chip (the renderer resolves them
  // from the task list, so it is read again once the tasks load).
  const chips = useMemo(() => {
    if (!t.tasks?.length) return [];
    const named = new Set([...renderMarkdownWithRefs(t.reply ?? '').matchAll(/data-task-id="([^"]+)"/g)].map((m) => m[1]));
    return t.tasks.filter((id) => !named.has(id));
  }, [t.tasks, t.reply, tasks]);
  const exchanges = useMemo(() => exchangesOf(t), [t]);
  const follows = t.follows ? all.find((x) => x.id === t.follows) : undefined;
  const last = t.messages[t.messages.length - 1] ?? t.opener;
  const count = t.messages.length + (t.opener ? 1 : 0);
  const quote = (x: ThreadExchange<OrgThreadMessage>) => `\u201c${oneLine(x.messages.map((m) => m.text || 'A picture').join(' / '), QUOTE_WORDS)}\u201d`;
  const from = (o: { from: string; ref?: string }) => `${FROM_LABEL[o.from] ?? FROM_LABEL.node}${o.ref ? `: ${o.ref}` : ''}`;
  return (
    <li className={`org-thread${closed ? ' is-closed' : ''}${open ? ' is-open' : ''}`} data-testid="org-thread" data-thread-id={t.id} data-state={closed ? 'closed' : t.state}>
      <button type="button" className="org-thread-head" aria-expanded={open} aria-controls={`${t.id}-conversation`} data-testid="org-thread-head" onClick={() => setOpen(!open)}>
        <span className="org-thread-state" data-testid="org-thread-state">
          <i style={{ background: closed ? 'var(--fg-muted, #86868B)' : STATE_DOT[t.state] }} />
          {closed ? (t.closed!.how === 'acked' ? 'Done' : 'Dropped') : STATE_LABEL[t.state]}
        </span>
        <span className="org-thread-meta">
          {t.opener && <span data-testid="org-thread-from">Opened by {name} · </span>}
          {timeAgo(last?.at ?? t.updatedAt, { now })}
        </span>
        <span className="org-thread-title" data-testid="org-thread-title">{t.title}</span>
      </button>
      {follows && <p className="org-thread-follows">Asks again about “{follows.title}”</p>}
      {t.reply && <Markdown text={t.reply} className="org-thread-summary" testId="org-thread-reply" />}
      {chips.length > 0 && <TaskChips ids={chips} tasks={tasks} onOpenTask={onOpenTask} />}
      {!open && card.unread.length > 0 && (
        <ol className="org-thread-unread" data-testid="org-thread-unread">
          {card.unread.map((x) => (
            <li key={x.messages[0]?.id ?? 'opener'} className="org-thread-exchange" data-testid="org-thread-exchange" data-n={x.n} data-known="false">
              {x.opener
                ? <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this \u00b7 ${from(x.opener)}`} known={false} now={now} testId="org-thread-opener" />
                : <Answer text={x.answer!.text} about={x.answer!.about} at={x.answer!.at} by={name} known={false} now={now} re={quote(x)} />}
            </li>
          ))}
        </ol>
      )}
      {!open && !closed && card.waiting.map((x) => (
        <p key={x.messages[0].id} className="org-thread-waiting" data-testid="org-thread-unanswered">Not answered yet: {quote(x)}</p>
      ))}
      {count > 0 && (
        <button type="button" className="org-thread-toggle org-thread-history" data-testid="org-thread-history" aria-expanded={open} aria-controls={`${t.id}-conversation`} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '\u25b4' : '\u25be'}</span>
          {open ? 'Hide the conversation' : 'Conversation'} · <span data-testid="org-thread-count">{count} {count === 1 ? 'message' : 'messages'}</span>
        </button>
      )}
      {open && (
        <ol id={`${t.id}-conversation`} className="org-thread-conversation" data-testid="org-thread-messages">
          {exchanges.map((x) => <Exchange key={x.messages[0]?.id ?? 'opener'} x={x} t={t} name={name} state={state} now={now} shared={x.messages.some((m) => shared.has(m.id))} />)}
        </ol>
      )}
      {following && onFollowUp ? (
        <FollowUp onSend={(text) => onFollowUp(t.id, text)} onDone={() => setFollowing(false)} />
      ) : (
        <div className="org-thread-actions">
          {closed ? (<>
            <span className="org-thread-closed" data-testid="org-thread-closed">{closedWords(t, now)}</span>
            <button type="button" className="btn btn-sm" data-testid="org-thread-reopen" onClick={() => void state.update(t.id, { reopen: true })}>Reopen</button>
          </>) : (<>
            <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-ack" onClick={() => void state.update(t.id, { close: 'acked' })}>Acknowledge</button>
            {onFollowUp && <button type="button" className="btn btn-sm" data-testid="org-thread-follow-open" onClick={() => setFollowing(true)}>Follow up</button>}
          </>)}
        </div>
      )}
    </li>
  );
}

export function OrgThreads({ name, state, tasks, onOpenTask, onFollowUp, now }: Props) {
  // Whether the week's closed threads are open stays as it was left (utils/view-memory.ts).
  const [showClosed, setShowClosed] = usePageView('org', 'threads.showClosed', false, isBoolean);
  const [showPending, setShowPending] = usePageView('org', 'threads.showPending', false, isBoolean);
  const all = state.threads;
  const open = useMemo(() => (all ?? []).filter((t) => !t.closed && t.state !== 'pending'), [all]);
  const pending = useMemo(() => (all ?? []).filter((t) => !t.closed && t.state === 'pending'), [all]);
  const closed = useMemo(() => (all ?? []).filter((t) => !!t.closed), [all]);
  const shared = useMemo(() => sharedAnswers(all ?? []), [all]);
  // Task pills in an answer open the task, as they do in the chat.
  const onEntityClick = useEntityClickHandler(onOpenTask);
  const card = (t: OrgThread) => <ThreadCard key={t.id} t={t} all={all ?? []} shared={shared} tasks={tasks} onOpenTask={onOpenTask} state={state} onFollowUp={onFollowUp} name={name} now={now} />;
  return (
    <div className="org-threads" data-testid="org-threads" onClick={onEntityClick}>
      {state.error && <p className="org-thread-error" data-testid="org-threads-error">{state.error}</p>}
      {all === null && !state.error && <p className="org-threads-empty" aria-busy="true">Loading…</p>}
      {all !== null && !open.length && (
        <p className="org-threads-empty" data-testid="org-threads-empty">
          {pending.length
            ? `Nothing new. ${name} is working on the pending ones below; each comes back here when there is news.`
            : `Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
        </p>
      )}
      {!!open.length && <ul className="org-thread-list" data-testid="org-thread-list" data-show="open">{open.map(card)}</ul>}
      {pending.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-pending" aria-expanded={showPending} onClick={() => setShowPending(!showPending)}>
          {pending.length} pending, nothing new{showPending ? ' ▾' : ' ▸'}
        </button>
      )}
      {showPending && pending.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-pending" data-show="pending">{pending.map(card)}</ul>}
      {closed.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-closed" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
          {closed.length} closed this week{showClosed ? ' ▾' : ' ▸'}
        </button>
      )}
      {showClosed && closed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-closed" data-show="closed">{closed.map(card)}</ul>}
    </div>
  );
}
