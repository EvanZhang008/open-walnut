/**
 * Threads: the user's own requests to an Org node (Main, a VP, a lead), one thread per subject,
 * beside the Task and Brief views (2026-11-01, the user: "every user request becomes a thread ...
 * I can acknowledge, or do follow up actions"; "if my multiple ask is about the same thread, add
 * it below that thread"). Walnut files every message he sends the node and puts the node's chat
 * reply under it (src/core/org/thread-answers.ts); the node keeps each thread's title and state.
 *
 * A card is kept short (2026-11-01, the user: "the purpose is to keep the thread extremely
 * concise ... I replied from the first one to the ninth, so why still show the first to the
 * eighth?"): its title, the node's summary (latest first, a sentence or two of background; Walnut's
 * own line from the latest answer until the node writes one, 2026-11-08: "no summary at all ... I
 * should not need to open it"), and
 * only the node's answers he has not reacted to that the summary did not supersede (2026-11-07: a
 * card showed the new summary and the older answer under it), each folded to a few lines with an Expand /
 * Collapse toggle on the answer itself ("I have to click the corner text ... outrageous"). What he
 * already knew (src/core/org/thread-view.ts) is gone from the card; the whole conversation opens
 * from a toggle in the card body, numbered, with Split out on each message.
 *
 * A thread with nothing for him is out of sight (2026-11-01, the user: "if it is just assigned no
 * need to tell me, or doing, unless there are some update ... thread pending, which is auto hide
 * like closed"; then "if i reply to a thread, it shoud go out of the thread immediately instead of
 * just show working"): only needs and answered show (src/core/org/thread-view.ts shownToHim); his
 * reply makes a thread working, so it leaves at once, and a working thread stays out even with the
 * node's chat answer on it (2026-11-07, the user: the real reply comes about 20 s later, "before it
 * replies, what is the use?"). One the node let sit too long comes back with a line saying so
 * (thread-view.ts threadOverdue; Walnut wakes the node first, thread-recheck.ts). A summary already naming a task keeps no
 * second chip for it, and one reply that covered several threads stays off every card.
 *
 *   a card     state, title, time; the summary; its tasks the summary does not name; the answers
 *              still news folded behind "N new answers"; Conversation (N messages); Acknowledge, Follow up (a message filed
 *              under it). His own messages still waiting for an answer are not echoed back on the
 *              card (2026-11-01, the user, after a Follow up showed "Not answered yet: <his words>":
 *              "you definitely haven't answered ... you don't need to put it in this thread");
 *              they read in the conversation.
 *   Pinned     the ones he (or the node) pinned lead the list, whatever their state, with a pin mark,
 *              until he unpins or acknowledges them (2026-11-03, the user: "have a pin thread feature,
 *              like this thread I need to make it pinned"); unpinned, a thread goes back to its place
 *   Snoozed    the ones he put aside (Snooze on a card, OrgThreadSnooze), each saying when it comes
 *              back; collapsed by default. A thread leaves the list and the tab's dot while snoozed
 *              and comes back on its date, or earlier on news (core/org/thread-view.ts snoozedNow)
 *   In progress  open but nothing for him (new, working, pending): one quiet line at the bottom opens them
 *   Closed     the ones closed this week (kept a week, then deleted) open from one quiet line at
 *              the bottom, Reopen on each
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { USER_STATE_LABELS, shownState } from '@open-walnut/user-status';
import { cardView, exchangesOf, overdueLine, threadDeadline, pinnedFirst, pinnedNow, sharedAnswers, shownToHim, snoozedNow, type SummaryLine, type ThreadExchange } from '@open-walnut/thread-view';
import { ThreadPinIcon } from '@/components/sessions/ThreadIcons';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useImageAttachments } from '@/components/common/image-attachments';
import type { ImageAttachment } from '@/api/chat';
import type { BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { AgentText } from '@/components/common/AgentText';
import { MessageAbout, rowAbout } from '@/components/sessions/message-about';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import { stripQuestionTag } from '@/utils/question-tag';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import type { AgentTextSource } from '@/utils/agent-text-source';
import { THREAD_LIST_SOURCE, THREAD_WORDS_SOURCE, threadAnswerSource, threadOpenerSource, threadStandInSource, threadSummarySource } from './thread-text-source';
import { timeAgo } from '@/utils/time';
import { isBoolean, usePageView } from '@/utils/view-memory';
import type { OrgThread, OrgThreadMessage, OrgThreadState } from '@/api/org-threads';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgThreadSnooze } from './OrgThreadSnooze';
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
/** What Walnut's stand-in summary line says it is (core/org/thread-view.ts SummaryLine). */
const STAND_IN_NOTE: Record<Exclude<NonNullable<SummaryLine['from']>, 'none'>, (name: string) => string> = {
  answer: (name) => `From ${name}'s latest answer; ${name} has not written a summary yet`,
  opener: (name) => `From ${name}'s post; ${name} has not written a summary yet`,
  ask: (name) => `What you asked, in ${name}'s words; ${name} has not written a summary yet`,
};
/** The folded line of a card's news: "1 new answer", "2 new answers", "1 new post", "3 new". */
function newLine(xs: readonly ThreadExchange<OrgThreadMessage>[]): string {
  const posts = xs.filter((x) => x.opener).length;
  const n = xs.length;
  if (!posts) return `${n} new ${n === 1 ? 'answer' : 'answers'}`;
  if (posts === n) return `${n} new ${n === 1 ? 'post' : 'posts'}`;
  return `${n} new`;
}
/** How much of his words the line above an answer quotes. */
const QUOTE_WORDS = 72;
/** Where a thread the node opened itself came from (src/core/org/threads-model.ts THREAD_SOURCES). */
const FROM_LABEL: Record<string, string> = { mail: 'Mail', task: 'A task', letter: 'A letter', trigger: 'A trigger', node: 'Its own finding' };

interface Props {
  name: string;
  /**
   * The node's own task. Not where its threads' paths open: each block opens on the machine of the
   * session that wrote it (./thread-text-source.ts), never on the node's current one.
   */
  owner?: Task;
  state: OrgThreadsState;
  tasks: readonly Task[];
  onOpenTask: (id: string) => void;
  /** Send a message filed under this thread; null when the node has no chat yet. */
  onFollowUp: ((threadId: string, text: string, images?: ImageAttachment[]) => Promise<boolean>) | null;
  now: number;
}

function closedWords(t: OrgThread, now: number): string {
  const c = t.closed!;
  // It went to another node with its work (core/org/thread-follow.ts): open there.
  if (t.movedTo) return `Moved to ${t.movedTo.title} ${timeAgo(c.at, { now })}`;
  const who = c.by === 'human' ? '' : ' by the agent';
  return `${c.how === 'acked' ? 'Acknowledged' : 'Dropped'}${who} ${timeAgo(c.at, { now })}`;
}

/** A clock time today, a date and time before: when an answer came, the way a chat shows it. */
function clock(at: string, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** When a snoozed thread comes back, as a person says it: "Tomorrow, 9:00 AM", "Nov 9, 12:00 AM". */
function backAt(until: string, now: number): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now);
  if (day.toDateString() === d.toDateString()) return `today, ${time}`;
  day.setDate(day.getDate() + 1);
  if (day.toDateString() === d.toDateString()) return `tomorrow, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
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
        // A task with only something to read wears Needs you, where it is drawn (shownState).
        const state = t ? shownState(userStateOf(t)) : null;
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

function FollowUp({ title, onSend, onDone }: { title: string; onSend: (text: string, images?: ImageAttachment[]) => Promise<boolean>; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mic = useRef<BoxMicHandle | null>(null);
  const pictures = useImageAttachments();
  const goNow = async () => {
    const words = text.trim();
    const images = pictures.images;
    if ((!words && images.length === 0) || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSend(words, images.length > 0 ? images : undefined);
    setBusy(false);
    if (ok) { setText(''); pictures.clear(); onDone(); } else setFailed(true);
  };
  // Cmd+Enter and Send wait for a live dictation's words, then send.
  const gate = useSendAfterDictation([mic], () => { void goNow(); });
  const empty = !text.trim() && pictures.images.length === 0;
  return (
    <div className="org-thread-follow" data-testid="org-thread-follow">
      {/* The box names its thread, so a Follow up opened on the wrong card shows before Send
          (2026-11-10, the user: "I ask follow up of another thread ... not this blue title"). */}
      <span className="org-thread-follow-to" data-testid="org-thread-follow-to">Follow up on {'\u201c'}{title}{'\u201d'}</span>
      {/* Walnut's answer box (common/AnswerBox.tsx): grows with the words, no grip, the mic inside, pictures as in the chat. */}
      <AnswerBox
        autoFocus
        value={text}
        minRows={2}
        placeholder="Follow up on this request"
        testId="org-thread-follow-input"
        micRef={mic}
        pictures={pictures}
        onChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); gate.send(); }
          // One Esc closes one layer: the follow-up, not a full-screen side bar around it.
          if (e.key === 'Escape') { e.preventDefault(); onDone(); }
        }}
      />
      <div className="org-thread-follow-row">
        {failed && <span className="org-thread-error" data-testid="org-thread-follow-failed">Not sent. Your words and pictures are still here.</span>}
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-follow-send" disabled={(empty && !gate.micBusy && !gate.waiting) || busy} onClick={gate.send} {...dictationWaitProps(gate)}>
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

/**
 * The node's answer as its chat shows it, folded to a few lines with the rest one click away. A
 * path or a picture in it is its writer's (`source`): this block opens and loads from that machine
 * itself and keeps the click, so nothing around it opens the same link a second time.
 */
function Answer({ text, about, at, by, known, now, testId = 'org-thread-answer', re, source, onOpenTask }: {
  text: string; about?: string[]; at: string; by: string; known: boolean; now: number; testId?: string;
  /** His words it answers, one line, on a card (the conversation shows them in full instead). */
  re?: string;
  /** Who wrote these words (./thread-text-source.ts); unknownSource when Walnut did not record it. */
  source: AgentTextSource;
  onOpenTask: (id: string) => void;
}) {
  const body = useMemo(() => stripTurnMarker(stripQuestionTag(text)), [text]);
  const ids = useMemo(() => rowAbout(about, text), [about, text]);
  // Its own opener: the session record is read on a click, never on mount; a lookup still in
  // flight is dropped when the source changes or the block unmounts (useAgentFileOpener).
  const file = useAgentFileOpener(source);
  // An unknown writer refuses a relative path too, as AgentText does (never a search of every host).
  const onEntityClick = useEntityClickHandler(onOpenTask, undefined, file.onFileOpen, file.fileHost, file.fileSessionId, file.refusesAll);
  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    onEntityClick(e);
    // Handled here: the list around it must not handle the same link again.
    if ((e.target as HTMLElement).closest('a')) e.stopPropagation();
  }, [onEntityClick]);
  return (
    <div className={`org-thread-answer${known ? '' : ' is-news'}`} data-testid={testId} data-known={known ? 'true' : 'false'} data-text-source={sourceAttr(source)}>
      <div className="org-thread-answer-by">{by} · {clock(at, now)}</div>
      {re && <div className="org-thread-re" data-testid="org-thread-re">{re}</div>}
      <Fold className="org-thread-answer-body" testId="org-thread-answer-body">
        <RichMarkdown text={body} cwd={file.render.cwd} host={file.render.host} inlineImages={file.render.images} onClick={onClick} />
      </Fold>
      {ids.length > 0 && <MessageAbout ids={ids} />}
    </div>
  );
}

/** For tests and logs: which kind of writer a block names ('host', 'session' or 'unknown'). */
function sourceAttr(s: AgentTextSource): string {
  return s.unknownSource ? 'unknown' : s.host !== undefined ? 'host' : 'session';
}

function Words({ m, onOpenTask }: { m: OrgThreadMessage; onOpenTask: (id: string) => void }) {
  // Pictures render as the chat renders them: a path on its own line becomes the image. His words
  // and pictures are his own, on this machine (the primary), whatever host the node runs on.
  const text = [m.text, ...(m.images ?? [])].filter(Boolean).join('\n\n');
  return (
    <Fold className="org-thread-words-fold" testId="org-thread-words">
      <AgentText text={text} className="org-thread-words" onTaskClick={onOpenTask} {...THREAD_WORDS_SOURCE} />
    </Fold>
  );
}

function Exchange({ x, t, name, state, now, shared, onOpenTask }: { x: ThreadExchange<OrgThreadMessage>; t: OrgThread; name: string; state: OrgThreadsState; now: number; shared: boolean; onOpenTask: (id: string) => void }) {
  const closed = !!t.closed;
  if (x.opener && t.opener) {
    const from = `${FROM_LABEL[x.opener.from] ?? FROM_LABEL.node}${x.opener.ref ? `: ${x.opener.ref}` : ''}`;
    return (
      <li className="org-thread-exchange is-opener" data-testid="org-thread-exchange" data-n={0} data-known={x.known ? 'true' : 'false'}>
        <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this · ${from}`} known={x.known} now={now} testId="org-thread-opener" source={threadOpenerSource(t.opener)} onOpenTask={onOpenTask} />
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
            <Words m={m} onOpenTask={onOpenTask} />
          </div>
          {(t.messages.length > 1 || !!t.opener) && !closed && (
            <button type="button" className="org-thread-link org-thread-split" data-testid="org-thread-split" title="This message is about something else: make it its own thread" onClick={() => void state.split(t.id, m.id)}>
              Split out
            </button>
          )}
        </div>
      ))}
      {x.answer ? (
        <Answer text={x.answer.text} about={x.answer.about} at={x.answer.at} by={shared ? `${name} \u00b7 one reply to this and another thread` : name} known={x.known} now={now} source={threadAnswerSource(x.answer)} onOpenTask={onOpenTask} />
      ) : (
        <div className="org-thread-answer is-waiting" data-testid="org-thread-unanswered">
          {closed ? 'No answer' : `${name} has not answered yet`}
        </div>
      )}
    </li>
  );
}

function ThreadCard({ t, all, shared, tasks, onOpenTask, state, onFollowUp, name, now, snoozed }: {
  t: OrgThread; all: readonly OrgThread[]; shared: ReadonlySet<string>; tasks: readonly Task[]; onOpenTask: (id: string) => void;
  state: OrgThreadsState; onFollowUp: Props['onFollowUp']; name: string; now: number;
  /** It is put aside now (the Snoozed section): it says when it comes back. */
  snoozed: boolean;
}) {
  /** The whole conversation shown, in place of what the card keeps. */
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  /** The answers he has not seen, unfolded under the summary (folded by default). */
  const [unfolded, setUnfolded] = useState(false);
  const closed = !!t.closed;
  const pinned = pinnedNow(t);
  const card = useMemo(() => cardView(t, shared), [t, shared]);
  // It sat too long with nothing from the node: the card says so (core/org/thread-view.ts threadOverdue).
  const overdue = closed || snoozed ? null : overdueLine(t, name, now, (iso) => timeAgo(iso, { now }), threadDeadline(t, tasks, now));
  // The tasks the summary already shows as pills get no second chip (the renderer resolves them
  // from the task labels, so it is read again when one arrives, with the summary itself).
  const labels = useEntityLabelsVersion();
  const chips = useMemo(() => {
    if (!t.tasks?.length) return [];
    const named = new Set([...renderMarkdownWithRefs(t.reply ?? '').matchAll(/data-task-id="([^"]+)"/g)].map((m) => m[1]));
    return t.tasks.filter((id) => !named.has(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `labels` is the renderer's own input
  }, [t.tasks, t.reply, labels]);
  const exchanges = useMemo(() => exchangesOf(t), [t]);
  const follows = t.follows ? all.find((x) => x.id === t.follows) : undefined;
  const last = t.messages[t.messages.length - 1] ?? t.opener;
  const count = t.messages.length + (t.opener ? 1 : 0);
  const quote = (x: ThreadExchange<OrgThreadMessage>) => `\u201c${oneLine(x.messages.map((m) => m.text || 'A picture').join(' / '), QUOTE_WORDS)}\u201d`;
  const from = (o: { from: string; ref?: string }) => `${FROM_LABEL[o.from] ?? FROM_LABEL.node}${o.ref ? `: ${o.ref}` : ''}`;
  return (
    <li className={`org-thread${closed ? ' is-closed' : ''}${open ? ' is-open' : ''}${snoozed ? ' is-snoozed' : ''}${pinned ? ' is-pinned' : ''}`} data-testid="org-thread" data-thread-id={t.id} data-state={closed ? 'closed' : t.state} data-snoozed={snoozed ? 'true' : undefined} data-pinned={pinned ? 'true' : undefined}>
      <button type="button" className="org-thread-head" aria-expanded={open} aria-controls={`${t.id}-conversation`} data-testid="org-thread-head" onClick={() => setOpen(!open)}>
        <span className="org-thread-state" data-testid="org-thread-state">
          <i style={{ background: closed ? 'var(--fg-muted, #86868B)' : STATE_DOT[t.state] }} />
          {closed ? (t.movedTo ? 'Moved' : t.closed!.how === 'acked' ? 'Done' : 'Dropped') : STATE_LABEL[t.state]}
        </span>
        <span className="org-thread-meta">
          {pinned && (<>
            <span className="org-thread-pin" data-testid="org-thread-pinned" title={t.pinned!.by === 'human' ? 'You pinned this thread' : `${name} pinned this thread`}>
              <ThreadPinIcon size={11} /><span className="org-thread-pin-who">{t.pinned!.by === 'human' ? 'Pinned' : `Pinned by ${name}`}</span>
            </span>{' \u00b7 '}
          </>)}
          {t.opener && <span className="org-thread-from" data-testid="org-thread-from" title={`Opened by ${name}`}>Opened by {name}</span>}
          {t.opener && ' \u00b7 '}
          <span className="org-thread-time" data-testid="org-thread-time">{timeAgo(last?.at ?? t.updatedAt, { now })}</span>
        </span>
        <span className="org-thread-title" data-testid="org-thread-title">{t.title}</span>
      </button>
      {snoozed && t.snoozed && <p className="org-thread-snoozed" data-testid="org-thread-snoozed-until">Snoozed until {backAt(t.snoozed.until, now)}</p>}
      {follows && <p className="org-thread-follows">Asks again about “{follows.title}”</p>}
      {/* It came here with its work from another node (core/org/thread-follow.ts), or left for one. */}
      {!closed && t.movedFrom && <p className="org-thread-follows" data-testid="org-thread-moved-from" title={t.movedFrom.why}>Moved here from {t.movedFrom.title}{t.movedFrom.why ? `: ${t.movedFrom.why}` : ''}</p>}
      {closed && t.movedTo && <p className="org-thread-follows" data-testid="org-thread-moved-to" title={t.movedTo.why}>Moved to {t.movedTo.title}{t.movedTo.why ? `: ${t.movedTo.why}` : ''}</p>}
      {overdue && <p className="org-thread-overdue" data-testid="org-thread-overdue">{overdue}</p>}
      {card.summary.by === 'node'
        ? (<>
          {/* The summary opens on the machine of the session that last wrote it, never the node's current one. */}
          <AgentText text={card.summary.text} compact className="org-thread-summary" testId="org-thread-reply" onTaskClick={onOpenTask} {...threadSummarySource(t)} />
          {/* His message came after it: it says so until the node rewrites it (core/org/thread-view.ts summaryBehindHim). */}
          {card.summary.stale && <span className="org-thread-stand-in-note" data-testid="org-thread-summary-stale">Written before your latest message; {name} has not updated it yet</span>}
        </>)
        : (
          // No summary from the node yet: Walnut's own line, so the card never needs the conversation opened (2026-11-08).
          <div className="org-thread-summary is-stand-in" data-testid="org-thread-reply" data-by="walnut">
            {card.summary.from === 'none'
              ? <p>{name} has not answered yet</p>
              : <AgentText text={card.summary.text} compact onTaskClick={onOpenTask} {...threadStandInSource(t, card.summary)} />}
            {card.summary.from !== 'none' && <span className="org-thread-stand-in-note" data-testid="org-thread-stand-in">{STAND_IN_NOTE[card.summary.from ?? 'answer'](name)}</span>}
          </div>
        )}
      {chips.length > 0 && <TaskChips ids={chips} tasks={tasks} onOpenTask={onOpenTask} />}
      {/* The card is its title and summary: the new answers fold behind one line until a click
          (2026-11-08, the user: "the history should all be collapsed unless I click to expand"). */}
      {!open && card.unread.length > 0 && (
        <button type="button" className="org-thread-toggle org-thread-unread-toggle" data-testid="org-thread-unread-toggle" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
          <span aria-hidden="true">{unfolded ? '\u25b4' : '\u25be'}</span>
          {newLine(card.unread)}
        </button>
      )}
      {!open && unfolded && card.unread.length > 0 && (
        <ol className="org-thread-unread" data-testid="org-thread-unread">
          {card.unread.map((x) => (
            <li key={x.messages[0]?.id ?? 'opener'} className="org-thread-exchange" data-testid="org-thread-exchange" data-n={x.n} data-known="false">
              {x.opener && t.opener
                ? <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this \u00b7 ${from(x.opener)}`} known={false} now={now} testId="org-thread-opener" source={threadOpenerSource(t.opener)} onOpenTask={onOpenTask} />
                : <Answer text={x.answer!.text} about={x.answer!.about} at={x.answer!.at} by={name} known={false} now={now} re={quote(x)} source={threadAnswerSource(x.answer!)} onOpenTask={onOpenTask} />}
            </li>
          ))}
        </ol>
      )}
      {count > 0 && (
        <button type="button" className="org-thread-toggle org-thread-history" data-testid="org-thread-history" aria-expanded={open} aria-controls={`${t.id}-conversation`} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '\u25b4' : '\u25be'}</span>
          {open ? 'Hide the conversation' : 'Conversation'} · <span data-testid="org-thread-count">{count} {count === 1 ? 'message' : 'messages'}</span>
        </button>
      )}
      {open && (
        <ol id={`${t.id}-conversation`} className="org-thread-conversation" data-testid="org-thread-messages">
          {exchanges.map((x) => <Exchange key={x.messages[0]?.id ?? 'opener'} x={x} t={t} name={name} state={state} now={now} shared={x.messages.some((m) => shared.has(m.id))} onOpenTask={onOpenTask} />)}
        </ol>
      )}
      {following && onFollowUp ? (
        <FollowUp title={t.title} onSend={(text, images) => onFollowUp(t.id, text, images)} onDone={() => setFollowing(false)} />
      ) : (
        <div className="org-thread-actions">
          {closed ? (<>
            <span className="org-thread-closed" data-testid="org-thread-closed">{closedWords(t, now)}</span>
            <button type="button" className="btn btn-sm" data-testid="org-thread-reopen" onClick={() => void state.update(t.id, { reopen: true })}>Reopen</button>
          </>) : (<>
            <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-ack" onClick={() => void state.update(t.id, { close: 'acked' })}>Acknowledge</button>
            {onFollowUp && <button type="button" className="btn btn-sm" data-testid="org-thread-follow-open" onClick={() => setFollowing(true)}>Follow up</button>}
            <OrgThreadSnooze
              title={t.title}
              label={snoozed ? 'Snoozed' : 'Snooze'}
              current={snoozed ? t.snoozed?.until : undefined}
              onSnooze={(until) => void state.update(t.id, { snooze: until })}
            />
            {snoozed && <button type="button" className="btn btn-sm" data-testid="org-thread-unsnooze" onClick={() => void state.update(t.id, { snooze: '' })}>Unsnooze</button>}
            {/* An icon: the row keeps one line in the side bar (the label is its name and tooltip). */}
            <button
              type="button" className="btn btn-sm org-thread-pin-btn" data-testid="org-thread-pin" aria-pressed={pinned}
              aria-label={pinned ? `Unpin "${t.title}"` : `Pin "${t.title}"`}
              title={pinned ? 'Unpin: it goes back to its place' : 'Pin: keep it at the top, whatever its state, until you unpin or acknowledge it'}
              onClick={() => void state.update(t.id, { pin: !pinned })}
            ><ThreadPinIcon size={14} /></button>
          </>)}
        </div>
      )}
    </li>
  );
}

export function OrgThreads({ name, state, tasks, onOpenTask, onFollowUp, now }: Props) {
  // Whether the week's closed threads are open stays as it was left (utils/view-memory.ts).
  const [showClosed, setShowClosed] = usePageView('org', 'threads.showClosed', false, isBoolean);
  const [showHidden, setShowHidden] = usePageView('org', 'threads.showInProgress', false, isBoolean);
  const [showSnoozed, setShowSnoozed] = usePageView('org', 'threads.showSnoozed', false, isBoolean);
  const all = state.threads;
  const shared = useMemo(() => sharedAnswers(all ?? []), [all]);
  const { open, hidden, snoozed, clock } = useMemo(() => {
    // The page's clock ticks once a minute; the re-read at a snooze's end (useOrgThreads) must not wait for it.
    const at = Math.max(now, Date.now());
    const list = all ?? [];
    return {
      clock: at,
      // Pinned ones lead, newest pin first; the rest newest change first (as the server sorts
      // them), so one just unpinned goes back to its place before the server answers.
      open: pinnedFirst(list.filter((t) => shownToHim(t, shared, at)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      hidden: list.filter((t) => !t.closed && !snoozedNow(t, at) && !shownToHim(t, shared, at)),
      snoozed: list.filter((t) => snoozedNow(t, at)).sort((a, b) => a.snoozed!.until.localeCompare(b.snoozed!.until)),
    };
  }, [all, shared, now]);
  const closed = useMemo(() => (all ?? []).filter((t) => !!t.closed), [all]);
  // Task pills outside the text blocks (an answer's About line) open the task, as they do in the
  // chat. Every block of text opens its own paths from its own writer and keeps the click; a path
  // that still reached the list has no writer to name, so it is refused, never opened on a guess.
  const listFile = useAgentFileOpener(THREAD_LIST_SOURCE);
  const onEntityClick = useEntityClickHandler(onOpenTask, undefined, listFile.onFileOpen, listFile.fileHost, listFile.fileSessionId, listFile.refusesAll);
  const snoozedIds = useMemo(() => new Set(snoozed.map((t) => t.id)), [snoozed]);
  const card = (t: OrgThread) => <ThreadCard key={t.id} t={t} all={all ?? []} shared={shared} tasks={tasks} onOpenTask={onOpenTask} state={state} onFollowUp={onFollowUp} name={name} now={clock} snoozed={snoozedIds.has(t.id)} />;
  return (
    <div className="org-threads" data-testid="org-threads" onClick={onEntityClick}>
      {state.error && <p className="org-thread-error" data-testid="org-threads-error">{state.error}</p>}
      {all === null && !state.error && <p className="org-threads-empty" aria-busy="true">Loading…</p>}
      {all !== null && !open.length && (
        <p className="org-threads-empty" data-testid="org-threads-empty">
          {hidden.length || snoozed.length
            ? `Nothing for you now. ${hidden.length ? `${name} is on the ones below; each` : 'Each snoozed one below'} comes back here when there is news.`
            : `Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
        </p>
      )}
      {!!open.length && <ul className="org-thread-list" data-testid="org-thread-list" data-show="open">{open.map(card)}</ul>}
      {snoozed.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-snoozed" aria-expanded={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)}>
          {snoozed.length} snoozed{showSnoozed ? ' ▾' : ' ▸'}
        </button>
      )}
      {showSnoozed && snoozed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-snoozed" data-show="snoozed">{snoozed.map(card)}</ul>}
      {hidden.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-hidden" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
          {hidden.length} in progress, nothing for you{showHidden ? ' ▾' : ' ▸'}
        </button>
      )}
      {showHidden && hidden.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-hidden" data-show="hidden">{hidden.map(card)}</ul>}
      {closed.length > 0 && (
        <button type="button" className="org-threads-closed-toggle" data-testid="org-threads-closed" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
          {closed.length} closed this week{showClosed ? ' ▾' : ' ▸'}
        </button>
      )}
      {showClosed && closed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-closed" data-show="closed">{closed.map(card)}</ul>}
    </div>
  );
}
