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
 * card showed the new summary and the older answer under it), each folded to a few lines with a Show
 * more / Show less toggle on the answer itself ("I have to click the corner text ... outrageous"). What he
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
 *   its ask    a thread holding its task's own ask (core/org/thread-report-ask.ts) reads Needs you
 *              and its card is that ask (the one ask card, actions/AskCard.tsx, answered on the
 *              thread), its own summary under it
 *   Watching   the ones he (or the node) watches, a group of their own at the top (OrgThreadsWatching),
 *              each one ALSO in its own group, wearing the eye there (2026-11-23, the user: a watch is
 *              "its own category ... at the same time it is in Watching", like a task's watch); he
 *              drags them into his order, and a watch moves nothing else
 *   Snoozed    the ones he put aside (Snooze on a card, OrgThreadSnooze), each saying when it comes
 *              back; collapsed by default. A thread leaves the list and the tab's dot while snoozed
 *              and comes back on its date, or earlier on news (core/org/thread-view.ts snoozedNow)
 *   In progress  open but nothing for him (new, working, pending, or held since his Acknowledge,
 *              core/org/thread-ack-outcome.ts, its card saying what holds it): one quiet line at the bottom opens them;
 *              a thread whose decision a task already asks him reads pending with that task (askedIn,
 *              core/org/thread-task-ask.ts) and waits here too, its card naming the task: one decision, asked once
 *   Closed     the ones closed this week (kept a week, then deleted) open from one quiet line at
 *              the bottom, Reopen on each
 */
import { useMemo, useRef, useState } from 'react';
import { OrgThreadsWatching, type WatchingCopy } from './OrgThreadsWatching';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { Task } from '@open-walnut/core';
import { cardView, exchangesOf, listedForHim, orderedForHim, overdueLine, threadDeadline, sharedAnswers, snoozedNow, watchedNow, watchingOf, type SummaryLine, type ThreadExchange } from '@open-walnut/thread-view';
import { ICON_EYE, ICON_EYE_FILLED } from '@/components/common/Icons';
import { DisclosureButton } from '@/components/controls';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { AgentText } from '@/components/common/AgentText';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import { THREAD_LIST_SOURCE, threadAnswerSource, threadOpenerSource, threadStandInSource, threadSummarySource } from './thread-text-source';
import { timeAgo } from '@/utils/time';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { useExperimental } from '@/hooks/useExperimental';
import type { OrgThread, OrgThreadMessage } from '@/api/org-threads';
import type { OrgThreadsState } from './useOrgThreads';
import { SnoozedUntil } from './OrgThreadSnooze';
import { threadBadge } from './thread-badge';
import { ThreadState } from './ThreadState';
import { PoppedThreadCard } from './PoppedThreadCard';
import { TopicThreadBadge } from '@/components/topics/TopicThreadBadge';
import { ThreadLetterAnswer, answersLetter } from './ThreadLetterAnswer';
import { ThreadChoiceAnswer, answersChoice } from './ThreadChoiceAnswer';
import { askThreadFocus, useFocusedThread } from './thread-focus';
import { AskCard } from '@/components/actions/ActionNeeded';
import { AskCardFrame } from '@/components/actions/AskCard';
import { Answer, CardWords, Words } from './thread-card-text';
import { AskedIn, FollowUp, NeedsAnswer, ThreadTools, type OnFollowUp } from './thread-card-answer';
import { FOLDED_GROUPS, THREAD_GROUPS, THREAD_GROUP_LABELS, ackCardLine, backFromKnown, groupThreads, inAcknowledged, isKnown, type ThreadGroup } from '@open-walnut/thread-groups';
import { TaskChips } from './ThreadTaskChips';
import { KnownBlock } from './ThreadKnown';
import { OrgThreadsByState, ThreadsEmpty } from './OrgThreadsByState';
import '@/styles/org-threads.css';
import '@/styles/notice-card.css';

/** No fold opened: how every node's Threads come up. */
const NO_FOLDS: ReadonlySet<ThreadGroup> = new Set();

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
   * session that wrote it (./thread-text-source.ts), never on the node's current one. A Follow up
   * goes to its session, so the box lists that session's / commands and sends files to its host.
   */
  owner?: Task;
  state: OrgThreadsState;
  tasks: readonly Task[];
  /** Send a message filed under this thread; null when the node has no chat yet. */
  onFollowUp: OnFollowUp;
  now: number;
  /** The Brief is off (experiment brief_off): every thread in its state's group (OrgThreadsByState). */
  byState?: boolean;
}

/** Held since his Acknowledge (its card says what holds it): no ask of a task (askedIn) or a task's thread below. */
const knownHere = (t: OrgThread): boolean => !t.askedIn && !t.owner && isKnown(t);

function closedWords(t: OrgThread, now: number): string {
  const c = t.closed!;
  // It went to another node with its work (core/org/thread-follow.ts): open there.
  if (t.movedTo) return `Moved to ${t.movedTo.title} ${timeAgo(c.at, { now })}`;
  const who = c.by === 'human' ? '' : ' by the agent';
  return `${c.how === 'acked' ? THREAD_GROUP_LABELS.done : 'Dropped'}${who} ${timeAgo(c.at, { now })}`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function Exchange({ x, t, name, state, now, shared }: { x: ThreadExchange<OrgThreadMessage>; t: OrgThread; name: string; state: OrgThreadsState; now: number; shared: boolean }) {
  const closed = !!t.closed;
  if (x.opener && t.opener) {
    const from = `${FROM_LABEL[x.opener.from] ?? FROM_LABEL.node}${x.opener.ref ? `: ${x.opener.ref}` : ''}`;
    return (
      <li className="org-thread-exchange is-opener" data-testid="org-thread-exchange" data-n={0} data-known={x.known ? 'true' : 'false'}>
        <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this · ${from}`} known={x.known} now={now} testId="org-thread-opener" source={threadOpenerSource(t.opener)} />
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
        <Answer text={x.answer.text} about={x.answer.about} at={x.answer.at} by={shared ? `${name} \u00b7 one reply to this and another thread` : name} known={x.known} now={now} source={threadAnswerSource(x.answer)} />
      ) : (
        <div className="org-thread-answer is-waiting" data-testid="org-thread-unanswered">
          {closed ? 'No answer' : `${name} has not answered yet`}
        </div>
      )}
    </li>
  );
}

function ThreadCard({ t, all, shared, tasks, state, onFollowUp, name, now, snoozed, owner, focused, listed, onReadWhole, copy }: {
  t: OrgThread; all: readonly OrgThread[]; shared: ReadonlySet<string>; tasks: readonly Task[];
  owner: Task | undefined;
  state: OrgThreadsState; onFollowUp: Props['onFollowUp']; name: string; now: number;
  /** It is put aside now (the Snoozed section): it says when it comes back. */
  snoozed: boolean;
  /** A chat message's thread line just opened it (thread-focus.ts): marked a moment. */
  focused: boolean;
  /** His view lists it now (thread-view.ts listedForHim): its group, and so its word. */
  listed: boolean;
  /** Where the card is drawn in a bound room (the top of a chat): its title opens it whole elsewhere (its Conversation still unfolds in place). */
  onReadWhole?: () => void;
  /** Drawn in Watching, beside its own group's card. */
  copy?: WatchingCopy;
}) {
  /** The whole conversation shown, in place of what the card keeps. */
  const [open, setOpen] = useState(false);
  /** The answers he has not seen, unfolded under the summary (folded by default). */
  const [unfolded, setUnfolded] = useState(false);
  const closed = !!t.closed;
  const watched = watchedNow(t);
  const domId = `${t.id}${copy ? '-watching' : ''}`;
  // The one card (experiment threads_one_card, core/org/one-card.ts); off, the card as before it.
  const oneCard = useExperimental('threads_one_card');
  // Its decision is asked in a task (core/org/thread-task-ask.ts): the card says where, not Needs you.
  const asked = !closed && !!t.askedIn;
  const letter = answersLetter(t);
  // It holds a Board choice (experiment brief_off): the card IS that choice, answered on its Board.
  const choice = !closed && answersChoice(t);
  // It holds the task's own ask (core/org/thread-report-ask.ts): the card IS that ask, with its box.
  const held = oneCard && !closed && !asked ? t.heldAsk : undefined;
  // Any kind of item: the task's ask, a question or a prompt its session waits on (taskAskNow).
  const heldItem = held ? owner?.user_status?.actions?.find((i) => i.id === held.id && !i.snoozedUntil) : undefined;
  // It waits on him: the one ask card's answer row (its choices, the box, Snooze), never Acknowledge,
  // which is for a card that asks no choice (2026-11-20, the user: "Acknowledge is for when I do not
  // need to make any choice").
  const needs = oneCard && !closed && !asked && t.state === 'needs';
  // He acknowledged it (core/org/thread-known.ts): in Acknowledged the card says the AI is deciding;
  // placed, where it went and why, and what it waits on in place of its summary.
  const known = knownHere(t);
  const deciding = known && inAcknowledged(t);
  const ackSays = !asked && !t.owner ? ackCardLine(t) : null;
  const back = backFromKnown(t);
  // Its word and dot are its group's (core/org/thread-groups.ts), the one it is drawn in (thread-badge.ts).
  const badge = threadBadge(t, listed, now);
  // In a bound room a click on its title reads it whole elsewhere (onReadWhole); in a list, it unfolds in place.
  // In Watching, one line that opens the card in place, so a few watched threads never push Needs you down.
  const [copyOpen, setCopyOpen] = useState(false);
  const folded = !!copy && !copyOpen;
  const onHead = () => (copy ? setCopyOpen(!copyOpen) : onReadWhole ? onReadWhole() : setOpen(!open));
  const card = useMemo(() => cardView(t, shared), [t, shared]);
  // It sat too long with nothing from the node: the card says so (core/org/thread-view.ts threadOverdue).
  const overdue = closed || snoozed ? null : overdueLine(t, name, now, (iso) => timeAgo(iso, { now }), threadDeadline(t, tasks, now));
  // The tasks the summary already shows as pills get no second chip (the renderer resolves them
  // from the task labels, so it is read again when one arrives, with the summary itself).
  const labels = useEntityLabelsVersion();
  const chips = useMemo(() => {
    if (!t.tasks?.length) return [];
    const named = new Set([...renderMarkdownWithRefs(t.reply ?? '').matchAll(/data-task-id="([^"]+)"/g)].map((m) => m[1]));
    return t.tasks.filter((id) => !named.has(id) && id !== t.askedIn?.task);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `labels` is the renderer's own input
  }, [t.tasks, t.reply, t.askedIn?.task, labels]);
  const exchanges = useMemo(() => exchangesOf(t), [t]);
  const follows = t.follows ? all.find((x) => x.id === t.follows) : undefined;
  const last = t.messages[t.messages.length - 1] ?? t.opener;
  const count = t.messages.length + (t.opener ? 1 : 0);
  const quote = (x: ThreadExchange<OrgThreadMessage>) => `\u201c${oneLine(x.messages.map((m) => m.text || 'A picture').join(' / '), QUOTE_WORDS)}\u201d`;
  const from = (o: { from: string; ref?: string }) => `${FROM_LABEL[o.from] ?? FROM_LABEL.node}${o.ref ? `: ${o.ref}` : ''}`;
  return (
    <li ref={copy?.setNodeRef} style={copy?.style} className={`org-thread${closed ? ' is-closed' : ''}${open ? ' is-open' : ''}${snoozed ? ' is-snoozed' : ''}${watched ? ' is-watched' : ''}${copy?.dragging ? ' is-dragging' : ''}${focused ? ' is-focused' : ''}${known ? ' is-known' : ''}`} data-testid="org-thread" data-thread-id={t.id} data-focused={focused ? 'true' : undefined} data-state={closed ? 'closed' : t.state} data-group={badge.group} data-acked-at-work={known ? 'true' : undefined} data-back-from-known={back ? 'true' : undefined} data-snoozed={snoozed ? 'true' : undefined} data-watched={watched ? 'true' : undefined} data-copy={copy ? 'watching' : undefined} data-folded={folded ? 'true' : undefined} data-asked-in={asked ? t.askedIn!.task : undefined} data-held-ask={held ? held.id : undefined}>
      {copy && (
        // A handle, not a button of the family: dnd-kit gives it its role and keyboard focus.
        <span className="org-thread-grip" data-testid="org-thread-watch-grip" aria-label={`Drag "${t.title}" to reorder Watching`} title="Drag to reorder" {...copy.grip}>
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2" /><circle cx="7" cy="3" r="1.2" /><circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="3" cy="11" r="1.2" /><circle cx="7" cy="11" r="1.2" /></svg>
        </span>
      )}
      <button type="button" className="org-thread-head" data-peek-row="" aria-expanded={copy ? copyOpen : open} aria-controls={copy ? undefined : `${domId}-conversation`} data-testid="org-thread-head" onClick={onHead}>
        <ThreadState badge={badge} />
        <span className="org-thread-meta">
          {/* Its own group's copy says it is also in Watching; the Watching copy needs no word for it. */}
          {watched && !copy && (<>
            <span className="org-thread-watch" data-testid="org-thread-watched" title={t.watched!.by === 'human' ? 'You watch this thread: it is also in Watching' : `${name} watches this thread: it is also in Watching`}>
              {ICON_EYE_FILLED}<span className="org-thread-watch-who">{t.watched!.by === 'human' ? 'Watching' : `Watched by ${name}`}</span>
            </span>{' \u00b7 '}
          </>)}
          {t.opener && <span className="org-thread-from" data-testid="org-thread-from" title={`Opened by ${name}`}>Opened by {name}</span>}
          {t.opener && ' \u00b7 '}
          {back && <span className="org-thread-back" data-testid="org-thread-back-from-known" title="You acknowledged it while its work ran; it came back with something new">New since you acknowledged{' \u00b7 '}</span>}
          {known
            ? <span className="org-thread-time" data-testid="org-thread-time">You acknowledged {'\u00b7'} {timeAgo(t.ackedAt!, { now })}</span>
            : <span className="org-thread-time" data-testid="org-thread-time">{timeAgo(last?.at ?? t.updatedAt, { now })}</span>}
        </span>
        <span className="org-thread-title" data-testid="org-thread-title">{t.title}</span>
      </button>
      {/* In Watching a card is one line (its state, title and time) until a click opens it in place. */}
      {!folded && (<>
      <TopicThreadBadge threadId={t.id} />
      {snoozed && t.snoozed && <SnoozedUntil until={t.snoozed.until} now={now} />}
      {follows && <p className="org-thread-follows">Asks again about “{follows.title}”</p>}
      {/* It came here with its work from another node (core/org/thread-follow.ts), or left for one. */}
      {!closed && t.movedFrom && <p className="org-thread-follows" data-testid="org-thread-moved-from" title={t.movedFrom.why}>Moved here from {t.movedFrom.title}{t.movedFrom.why ? `: ${t.movedFrom.why}` : ''}</p>}
      {closed && t.movedTo && <p className="org-thread-follows" data-testid="org-thread-moved-to" title={t.movedTo.why}>Moved to {t.movedTo.title}{t.movedTo.why ? `: ${t.movedTo.why}` : ''}</p>}
      {ackSays && <p className="org-thread-follows org-thread-ack-line" data-testid="org-thread-ack-line" data-deciding={deciding ? 'true' : undefined}>{ackSays}</p>}
      {overdue && <p className="org-thread-overdue" data-testid="org-thread-overdue">{overdue}</p>}
      {asked && <AskedIn a={t.askedIn!} />}
      {held && (
        <div className="org-thread-held-ask" data-testid="org-thread-held-ask" data-ask-id={held.id}>
          {/* Its status a step behind (no item yet): the question in the agent's own rendering until it comes. */}
          {heldItem && owner
            ? <AskCard task={owner} item={heldItem} threadId={t.id} />
            : <CardWords testId="org-thread-held-question"><AgentText text={held.ask} compact shortLinks {...threadSummarySource(t)} /></CardWords>}
          {held.reply && <CardWords testId="org-thread-reply"><AgentText text={held.reply} compact shortLinks {...threadSummarySource(t)} /></CardWords>}
        </div>
      )}
      {known && !deciding && <KnownBlock t={t} tasks={tasks} name={name} />}
      {!asked && !held && !known && (card.summary.by === 'node'
        ? (<>
          {/* The summary opens on the machine of the session that last wrote it, never the node's current one. */}
          <CardWords testId="org-thread-reply"><AgentText text={card.summary.text} compact shortLinks {...threadSummarySource(t)} /></CardWords>
          {/* His message came after it: it says so until the node rewrites it (core/org/thread-view.ts summaryBehindHim). */}
          {card.summary.stale && <span className="org-thread-stand-in-note" data-testid="org-thread-summary-stale">Written before your latest message; {name} has not updated it yet</span>}
        </>)
        : (<>
          {/* No summary from the node yet: Walnut's own line, so the card never needs the conversation opened (2026-11-08). */}
          <CardWords testId="org-thread-reply" className="is-stand-in" data={{ 'data-by': 'walnut' }}>
            {card.summary.from === 'none'
              ? <p>{name} has not answered yet</p>
              : <AgentText text={card.summary.text} compact shortLinks {...threadStandInSource(t, card.summary)} />}
          </CardWords>
          {card.summary.from !== 'none' && <span className="org-thread-stand-in-note" data-testid="org-thread-stand-in">{STAND_IN_NOTE[card.summary.from ?? 'answer'](name)}</span>}
        </>))}
      {chips.length > 0 && !known && <TaskChips ids={chips} tasks={tasks} />}
      {/* The card is its title and summary: the new answers fold behind one line until a click
          (2026-11-08, the user: "the history should all be collapsed unless I click to expand"). */}
      {!open && card.unread.length > 0 && (
        <DisclosureButton expanded={unfolded} className="org-thread-toggle" data-testid="org-thread-unread-toggle" onClick={() => setUnfolded(!unfolded)}>
          {newLine(card.unread)}
        </DisclosureButton>
      )}
      {!open && unfolded && card.unread.length > 0 && (
        <ol className="org-thread-unread" data-testid="org-thread-unread">
          {card.unread.map((x) => (
            <li key={x.messages[0]?.id ?? 'opener'} className="org-thread-exchange" data-testid="org-thread-exchange" data-n={x.n} data-known="false">
              {x.opener && t.opener
                ? <Answer text={x.opener.text} at={x.opener.at} by={`${name} opened this \u00b7 ${from(x.opener)}`} known={false} now={now} testId="org-thread-opener" source={threadOpenerSource(t.opener)} />
                : <Answer text={x.answer!.text} about={x.answer!.about} at={x.answer!.at} by={name} known={false} now={now} re={quote(x)} source={threadAnswerSource(x.answer!)} />}
            </li>
          ))}
        </ol>
      )}
      {count > 0 && (
        <DisclosureButton expanded={open} className="org-thread-toggle" data-testid="org-thread-history" aria-controls={`${domId}-conversation`} onClick={() => setOpen(!open)}>
          {open ? 'Hide the conversation' : 'Conversation'} · <span data-testid="org-thread-count">{count} {count === 1 ? 'message' : 'messages'}</span>
        </DisclosureButton>
      )}
      {open && (
        <ol id={`${domId}-conversation`} className="org-thread-conversation" data-testid="org-thread-messages">
          {exchanges.map((x) => <Exchange key={x.messages[0]?.id ?? 'opener'} x={x} t={t} name={name} state={state} now={now} shared={x.messages.some((m) => shared.has(m.id))} />)}
        </ol>
      )}
      {/* Off (threads_one_card): the letter's buttons and box below the conversation, as before. */}
      {!oneCard && letter && <ThreadLetterAnswer t={t} />}
      {/* Its answer comes last, after its tasks and its conversation, as on every card (2026-11-21, the
          user's pick of ten whole-card designs: "2 is good").
          It holds a decision letter: the letter's buttons and box answer it, here and in the inbox at
          once, in the one ask card's row. */}
      {oneCard && letter && !heldItem && <AskCardFrame testId="org-thread-letter-card" className="org-thread-ask" answer={<ThreadLetterAnswer t={t} />} tools={<ThreadTools t={t} snoozed={snoozed} state={state} watched={watched} />} />}
      {choice && !letter && <AskCardFrame testId="org-thread-choice-card" className="org-thread-ask" answer={<ThreadChoiceAnswer t={t} />} tools={<ThreadTools t={t} snoozed={snoozed} state={state} watched={watched} />} />}
      {needs && !heldItem && !letter && !choice && <NeedsAnswer t={t} owner={owner} onFollowUp={onFollowUp} snoozed={snoozed} state={state} watched={watched} />}
      {/* A card waiting on him answers in the ask card's row just above (its own box and Snooze, or the
          held ask's): none of them twice, and no Acknowledge. */}
      {/* The ask card's own answer row (actions/ask-card.css), so every card's buttons, box, Snooze
          and Watch eye look and sit the same (2026-11-21, the user: "I lkike P1 button, not the stupid ugly
          current snooze or ack, also why they arenot even con sistent"): its buttons first, the box
          under them, Snooze and the Watch eye at the right of the box's line. */}
      {needs || choice ? null : (
        <div className="ask-card-answer org-thread-actions">
          {closed ? (<>
            <span className="org-thread-closed" data-testid="org-thread-closed">{closedWords(t, now)}</span>
            <button type="button" className="btn btn-sm" data-testid="org-thread-reopen" onClick={() => void state.update(t.id, { reopen: true })}>Reopen</button>
          </>) : (<>
            {/* Acknowledged already: the AI places it (core/org/thread-known.ts), no second button. */}
            {!letter && !known && <button type="button" className="btn btn-sm btn-primary" data-primary="" data-testid="org-thread-ack" onClick={() => void state.update(t.id, { close: 'acked' })}>Acknowledge</button>}
            {onFollowUp && !letter ? (
              <FollowUp threadId={t.id} title={t.title} owner={owner} onSend={(text, images) => onFollowUp(t.id, text, images)} />
            ) : null}
            <span className="ask-card-tools"><ThreadTools t={t} snoozed={snoozed} state={state} watched={watched} /></span>
          </>)}
        </div>
      )}
      </>)}
    </li>
  );
}

/** One thread of his list as every surface draws it: a thread of a task below is the ask card
 *  (PoppedThreadCard), the node's own the thread card. The Threads view and the top of the chat
 *  (TopThread) both draw through this, so one thread reads the same in both. */
export function ThreadItem({ t, all, shared, tasks, state, onFollowUp, name, now, snoozed, owner, focused = false, listed = true, onReadWhole, copy }: {
  t: OrgThread; all: readonly OrgThread[]; shared: ReadonlySet<string>; tasks: readonly Task[];
  owner: Task | undefined; state: OrgThreadsState; onFollowUp: Props['onFollowUp']; name: string; now: number; snoozed: boolean;
  /** A chat message's thread line just opened it (thread-focus.ts). */
  focused?: boolean;
  /** His view lists it now (listedForHim); the top of the chat shows only listed ones. */
  listed?: boolean;
  /** Drawn in a bound room (the top of a chat): read it whole in the Threads view. */
  onReadWhole?: () => void;
  /** Drawn again in Watching (OrgThreadsWatching). */
  copy?: WatchingCopy;
}) {
  return t.owner && owner
    ? <PoppedThreadCard node={owner.id} t={t} state={state} now={now} snoozed={snoozed} listed={listed} />
    : <ThreadCard t={t} all={all} shared={shared} tasks={tasks} state={state} onFollowUp={onFollowUp} name={name} now={now} snoozed={snoozed} owner={owner} focused={focused} listed={listed} {...(onReadWhole ? { onReadWhole } : {})} {...(copy ? { copy } : {})} />;
}

export function OrgThreads({ name, owner, state, tasks, onFollowUp, now, byState = false }: Props) {
  // Whether the week's closed threads are open stays as it was left (utils/view-memory.ts).
  const [showClosed, setShowClosed] = usePageView('org', 'threads.showClosed', false, isBoolean);
  const [showHidden, setShowHidden] = usePageView('org', 'threads.showInProgress', false, isBoolean);
  const [showSnoozed, setShowSnoozed] = usePageView('org', 'threads.showSnoozed', false, isBoolean);
  // The folds he opened (OrgThreadsByState): plain state of this view on this node, never kept, so
  // coming back (another node, the pane closed, a reload) shows them folded again.
  const foldNode = owner?.id ?? name;
  const [folds, setFolds] = useState<{ node: string; opened: ReadonlySet<ThreadGroup> }>({ node: foldNode, opened: NO_FOLDS });
  // Another node shown in this same view: its folds start folded (and A, B, A folds A again).
  if (folds.node !== foldNode) setFolds({ node: foldNode, opened: NO_FOLDS });
  const opened = folds.node === foldNode ? folds.opened : NO_FOLDS;
  const openFold = useLeanCallback((g: ThreadGroup, open: boolean) => setFolds((f) => {
    const was = f.node === foldNode ? f.opened : NO_FOLDS;
    if (f.node === foldNode && was.has(g) === open) return f;
    const next = new Set(was);
    if (open) next.add(g); else next.delete(g);
    return { node: foldNode, opened: next };
  }), [foldNode]);
  const all = state.threads;
  const needsFirst = useExperimental('top_thread');
  const shared = useMemo(() => sharedAnswers(all ?? []), [all]);
  const { open, listedIds, hidden, snoozed, clock } = useMemo(() => {
    // The page's clock ticks once a minute; the re-read at a snooze's end (useOrgThreads) must not wait for it.
    const at = Math.max(now, Date.now());
    const list = all ?? [];
    // The list the header and the tab count (thread-view.ts listedForHim), so they agree.
    const listed = listedForHim(list, at);
    const shownSet = new Set(listed);
    return {
      clock: at,
      // Newest change first (as the server sorts them); a watch moves nothing here. Under
      // top_thread the ones that need him lead the rest, the order the top of the chat steps in.
      open: orderedForHim(listed, { needsFirst }),
      listedIds: new Set(listed.map((t) => t.id)),
      hidden: list.filter((t) => !t.closed && !snoozedNow(t, at) && !shownSet.has(t)),
      snoozed: list.filter((t) => snoozedNow(t, at)).sort((a, b) => a.snoozed!.until.localeCompare(b.snoozed!.until)),
    };
  }, [all, now, needsFirst]);
  const closed = useMemo(() => (all ?? []).filter((t) => !!t.closed), [all]);
  // Task pills outside the text blocks (an answer's About line) open the task, as they do in the
  // chat. Every block of text opens its own paths from its own writer and keeps the click; a path
  // that still reached the list has no writer to name, so it is refused, never opened on a guess.
  const listFile = useAgentFileOpener(THREAD_LIST_SOURCE);
  const onEntityClick = useEntityClickHandler(undefined, listFile.onFileOpen, listFile.fileHost, listFile.fileSessionId, listFile.refusesAll);
  const snoozedIds = useMemo(() => new Set(snoozed.map((t) => t.id)), [snoozed]);
  // A chat message's thread line asked for one of these (thread-focus.ts): its section opens, and
  // it is brought into view and marked a moment.
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => (byState ? groupThreads(all ?? [], clock) : null), [byState, all, clock]);
  const focused = useFocusedThread(owner?.id, all, rootRef, (t) => {
    if (groups) {
      // In a folded group: it opens, so the card can be brought into view.
      const g = THREAD_GROUPS.find((x) => groups[x].some((y) => y.id === t.id));
      if (g && FOLDED_GROUPS.includes(g)) openFold(g, true);
      return;
    }
    if (t.closed) setShowClosed(true);
    else if (snoozedIds.has(t.id)) setShowSnoozed(true);
    else if (hidden.some((x) => x.id === t.id)) setShowHidden(true);
  });
  // Nothing in either view: one empty line (ThreadsEmpty). A new topic starts from the Org list's
  // Topics heading or a task's menu, never here: a topic is not a thread (2026-11-23, the user, on
  // "+ New topic" in the Threads view: "Topic is topic").
  const nothing = all !== null && !state.error && (groups ? !THREAD_GROUPS.some((g) => groups[g].length > 0) : !open.length && !hidden.length && !snoozed.length);
  const card = (t: OrgThread, copy?: WatchingCopy) => <ThreadItem key={t.id} t={t} all={all ?? []} shared={shared} tasks={tasks} state={state} onFollowUp={onFollowUp} name={name} now={clock} snoozed={snoozedIds.has(t.id)} owner={owner} focused={focused === t.id && !copy} listed={listedIds.has(t.id)} {...(copy ? { copy } : {})} />;
  // Watching: his watched threads, each also drawn in its own group below (a thread of a task
  // below is watched in that task's own Threads, never from here).
  const watching = useMemo(() => watchingOf((all ?? []).filter((t) => !t.owner)), [all]);
  const watchingList = all !== null && (
    <OrgThreadsWatching threads={watching} card={(t, copy) => card(t, copy)} onReorder={(writes) => { for (const w of writes) void state.update(w.id, { watch_at: w.watch_at }); }} />
  );
  return (
    <div ref={rootRef} className="org-threads" data-testid="org-threads" onClick={onEntityClick}>
      {state.error && <p className="org-thread-error" data-testid="org-threads-error">{state.error}</p>}
      {all === null && !state.error && <p className="org-threads-empty" aria-busy="true">Loading…</p>}
      {groups && all !== null && <OrgThreadsByState watching={watchingList} groups={groups} opened={opened} onOpen={openFold} card={(t) => card(t)} name={name} owner={owner} epoch={state.catchUp ?? 0} {...(owner ? { onShowThread: (id: string) => askThreadFocus(owner.id, id) } : {})} />}
      {!groups && (<>
      {watchingList}
      {all !== null && !open.length && (hidden.length || snoozed.length
        ? (
          <p className="org-threads-empty" data-testid="org-threads-empty">
            {`Nothing for you now. ${hidden.length ? `${name} is on the ones below; each` : 'Each snoozed one below'} comes back here when there is news.`}
          </p>
        )
        : <ThreadsEmpty name={name} />)}
      {!!open.length && <ul className="org-thread-list" data-testid="org-thread-list" data-show="open">{open.map((t) => card(t))}</ul>}
      {snoozed.length > 0 && (
        <DisclosureButton expanded={showSnoozed} className="org-threads-closed-toggle" data-testid="org-threads-snoozed" onClick={() => setShowSnoozed(!showSnoozed)}>
          {snoozed.length} snoozed
        </DisclosureButton>
      )}
      {showSnoozed && snoozed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-snoozed" data-show="snoozed">{snoozed.map((t) => card(t))}</ul>}
      {hidden.length > 0 && (
        <DisclosureButton expanded={showHidden} className="org-threads-closed-toggle" data-testid="org-threads-hidden" onClick={() => setShowHidden(!showHidden)}>
          {hidden.length} in progress, nothing for you
        </DisclosureButton>
      )}
      {showHidden && hidden.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-hidden" data-show="hidden">{hidden.map((t) => card(t))}</ul>}
      {closed.length > 0 && (
        <DisclosureButton expanded={showClosed} className="org-threads-closed-toggle" data-testid="org-threads-closed" onClick={() => setShowClosed(!showClosed)}>
          {closed.length} closed this week
        </DisclosureButton>
      )}
      {showClosed && closed.length > 0 && <ul className="org-thread-list" data-testid="org-thread-list-closed" data-show="closed">{closed.map((t) => card(t))}</ul>}
      </>)}
    </div>
  );
}
