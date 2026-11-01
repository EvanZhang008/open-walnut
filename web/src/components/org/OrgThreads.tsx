/**
 * Threads: the user's own requests to an Org node (Main, a VP, a lead), one thread per subject,
 * beside the Task and Brief views (2026-11-01, the user: "every user request becomes a thread ...
 * I can acknowledge, or do follow up actions"; "if my multiple ask is about the same thread, add
 * it below that thread"). Walnut files every message he sends the node and puts the node's chat
 * reply under it (src/core/org/thread-answers.ts); the node keeps each thread's title and state.
 *
 * A thread reads as its conversation, like a Slack thread ("make it clear what is the
 * conversation in this thread"): each of his messages, numbered, with the node's answer under
 * it. What he already knows (he reacted after it) folds to one line of context, and the rest
 * shows in full (src/core/org/thread-view.ts): "only show the last one and some kind of context
 * for before, unless the user doesn't know".
 *
 *   a card     state, title, where it stands; Earlier (his asks he already had answered, one
 *              line); then the exchanges still news, his words and the answer folded to a few
 *              lines; Acknowledge closes it, Follow up sends a message filed under it
 *   opened     every exchange, Split out on each message when it holds more than one (a merge
 *              the node got wrong)
 *   Closed     only open threads show; the ones closed this week (kept a week, then deleted)
 *              open from one quiet line at the bottom, Reopen on each
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { threadView, type ThreadExchange } from '@open-walnut/thread-view';
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
  new: 'New', working: USER_STATE_LABELS.working, needs: USER_STATE_LABELS.needs, answered: 'Answered',
};
const STATE_DOT: Record<OrgThreadState, string> = {
  new: 'var(--accent, #0A84FF)', working: 'var(--success, #34C759)', needs: 'var(--error, #FF3B30)', answered: 'var(--fg-muted, #86868B)',
};
/** How much of his words the Earlier line quotes per message. */
const EARLIER_WORDS = 48;
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

/** Long words fold to a few lines, the rest one click away (his voice notes, the node's long replies). */
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
  return (
    <>
      <div ref={box} className={`org-thread-fold ${className}${whole ? ' is-whole' : ''}${long && !whole ? ' is-folded' : ''}`} data-testid={testId}>
        {children}
      </div>
      {(long || whole) && (
        <button type="button" className="org-thread-link org-thread-more" data-testid={`${testId}-more`} onClick={() => setWhole(!whole)}>
          {whole ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

/** The node's answer as its chat shows it, folded to a few lines with the rest one click away. */
function Answer({ text, about, at, by, known, now, testId = 'org-thread-answer' }: {
  text: string; about?: string[]; at: string; by: string; known: boolean; now: number; testId?: string;
}) {
  const body = useMemo(() => stripTurnMarker(stripQuestionTag(text)), [text]);
  const ids = useMemo(() => rowAbout(about, text), [about, text]);
  return (
    <div className={`org-thread-answer${known ? '' : ' is-news'}`} data-testid={testId} data-known={known ? 'true' : 'false'}>
      <div className="org-thread-answer-by">{by} · {clock(at, now)}</div>
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

function Exchange({ x, t, name, state, now }: { x: ThreadExchange<OrgThreadMessage>; t: OrgThread; name: string; state: OrgThreadsState; now: number }) {
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
        <Answer text={x.answer.text} about={x.answer.about} at={x.answer.at} by={name} known={x.known} now={now} />
      ) : (
        <div className="org-thread-answer is-waiting" data-testid="org-thread-unanswered">
          {closed ? 'No answer' : `${name} has not answered yet`}
        </div>
      )}
    </li>
  );
}

function ThreadCard({ t, all, tasks, onOpenTask, state, onFollowUp, name, now }: {
  t: OrgThread; all: readonly OrgThread[]; tasks: readonly Task[]; onOpenTask: (id: string) => void;
  state: OrgThreadsState; onFollowUp: Props['onFollowUp']; name: string; now: number;
}) {
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  const closed = !!t.closed;
  const view = useMemo(() => threadView(t), [t]);
  const follows = t.follows ? all.find((x) => x.id === t.follows) : undefined;
  const last = t.messages[t.messages.length - 1] ?? t.opener;
  const earlier = view.exchanges.slice(0, view.folded);
  const shown = open ? view.exchanges : view.exchanges.slice(view.folded);
  const earlierWords = earlier.flatMap((x) => (x.opener
    ? [`Opened: ${oneLine(x.opener.text, EARLIER_WORDS)}`]
    : x.messages.map((m, i) => `${x.n + i} ${oneLine(m.text || 'A picture', EARLIER_WORDS)}`))).join('  ·  ');
  return (
    <li className={`org-thread${closed ? ' is-closed' : ''}${open ? ' is-open' : ''}`} data-testid="org-thread" data-thread-id={t.id} data-state={closed ? 'closed' : t.state}>
      <button type="button" className="org-thread-head" aria-expanded={open} data-testid="org-thread-head" onClick={() => setOpen(!open)}>
        <span className="org-thread-state" data-testid="org-thread-state">
          <i style={{ background: closed ? 'var(--fg-muted, #86868B)' : STATE_DOT[t.state] }} />
          {closed ? (t.closed!.how === 'acked' ? 'Done' : 'Dropped') : STATE_LABEL[t.state]}
        </span>
        <span className="org-thread-meta">
          {t.opener && <span data-testid="org-thread-from">Opened by {name} · </span>}
          {t.messages.length > 1 && <span data-testid="org-thread-count">{t.messages.length} messages · </span>}
          {timeAgo(last?.at ?? t.updatedAt, { now })}
          <span className="org-thread-chevron" aria-hidden="true">{open ? ' ▾' : ' ▸'}</span>
        </span>
        <span className="org-thread-title" data-testid="org-thread-title">{t.title}</span>
      </button>
      {follows && <p className="org-thread-follows">Asks again about “{follows.title}”</p>}
      {t.reply && <Markdown text={t.reply} className="org-thread-reply" testId="org-thread-reply" />}
      {!!t.tasks?.length && <TaskChips ids={t.tasks} tasks={tasks} onOpenTask={onOpenTask} />}
      {!open && earlier.length > 0 && (
        <button type="button" className="org-thread-earlier" data-testid="org-thread-earlier" title="Show the whole conversation" onClick={() => setOpen(true)}>
          <span className="org-thread-earlier-label">Earlier</span>
          <span className="org-thread-earlier-words">{earlierWords}</span>
        </button>
      )}
      <ol className="org-thread-conversation" data-testid="org-thread-messages">
        {shown.map((x) => <Exchange key={x.messages[0]?.id ?? 'opener'} x={x} t={t} name={name} state={state} now={now} />)}
      </ol>
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
  const all = state.threads;
  const open = useMemo(() => (all ?? []).filter((t) => !t.closed), [all]);
  const closed = useMemo(() => (all ?? []).filter((t) => !!t.closed), [all]);
  // Task pills in an answer open the task, as they do in the chat.
  const onEntityClick = useEntityClickHandler(onOpenTask);
  const card = (t: OrgThread) => <ThreadCard key={t.id} t={t} all={all ?? []} tasks={tasks} onOpenTask={onOpenTask} state={state} onFollowUp={onFollowUp} name={name} now={now} />;
  return (
    <div className="org-threads" data-testid="org-threads" onClick={onEntityClick}>
      {state.error && <p className="org-thread-error" data-testid="org-threads-error">{state.error}</p>}
      {all === null && !state.error && <p className="org-threads-empty" aria-busy="true">Loading…</p>}
      {all !== null && !open.length && (
        <p className="org-threads-empty" data-testid="org-threads-empty">
          {`Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
        </p>
      )}
      {!!open.length && <ul className="org-thread-list" data-testid="org-thread-list" data-show="open">{open.map(card)}</ul>}
      {closed.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-closed" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
          {closed.length} closed this week{showClosed ? ' ▾' : ' ▸'}
        </button>
      )}
      {showClosed && closed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-closed" data-show="closed">{closed.map(card)}</ul>}
    </div>
  );
}
