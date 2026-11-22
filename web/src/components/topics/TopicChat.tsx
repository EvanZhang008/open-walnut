/**
 * A topic's chat, in the Org page's detail pane (experiment `topics`), drawn like a group chat:
 *
 *   ┌ header: stacked avatars · title · "topic · N members · host X" · Members · Close ┐
 *   │ messages: a member's on the left (avatar, its name coloured above);   │ side:   │
 *   │ the user's own on the right; Walnut's lines small and centred; under  │ host's  │
 *   │ each, who it woke, who reads it next time, who it was mailed to       │ summary,│
 *   │ composer (TopicComposer: @ lists the members, then tasks)             │ members │
 *   └────────────────────────────────────────────────────────────────────────┴─────────┘
 *
 * The side panel's shown/hidden is kept (usePageView). A window too narrow for it beside the chat
 * (TOPIC_SHEET_QUERY) shows it only when Members is pressed, as a sheet laid over the conversation
 * inside the chat (a scrim under it, the conversation inert); Members again, its ×, Esc or a click on
 * the scrim closes it, and focus goes back to Members. That sheet is a passing look, never kept.
 * Live through useTopic (topic:updated).
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Topic, TopicMessage } from '@/api/topics';
import { ICON_CHEVRON_LEFT } from '@/components/common/Icons';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { AgentText } from '@/components/common/AgentText';
import { useStoreTask } from '@/contexts/TasksContext';
import { useConfirm } from '@/hooks/useConfirm';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { hasOpenOverlayLayer } from '@/hooks/useOverlayLayer';
import { isImeKey } from '@/utils/ime-key';
import { usePageView, isBoolean } from '@/utils/view-memory';
import { authorOf, continuesBlock, nameContext, reachSummary, shortName, topicSubtitle } from './topic-model';
import { MemberAvatar, StackedAvatars } from './TopicAvatars';
import { MentionChips, useMentionSlots } from './TopicMention';
import { TopicComposer } from './TopicComposer';
import { TopicSidePanel } from './TopicSidePanel';
import { useTopicsOn } from './topics-flag';
import { useTopic, type LocalMessage } from './useTopics';

/** A time line between messages more than this apart. */
const GAP_MS = 30 * 60_000;

/** Too narrow for the side panel beside the conversation: Members lays it over as a sheet. */
export const TOPIC_SHEET_QUERY = '(max-width: 900px)';

/**
 * The sheet's keyboard: focus moves to its × on open, Esc closes it (unless something above it, a
 * menu or a confirm, took the key, or an input method did), and focus goes back to Members on close
 * when it was in the sheet or lost.
 */
function useSheetKeys(open: boolean, close: () => void, closeRef: RefObject<HTMLButtonElement | null>, returnRef: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    const sheet = closeRef.current?.closest('.topic-side') ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isImeKey(e) || hasActiveModalOverlay() || hasOpenOverlayLayer()) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected || (sheet && sheet.contains(at))) returnRef.current?.focus({ preventScroll: true });
    };
  }, [open, close, closeRef, returnRef]);
}

function when(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function clock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * One message as a chat bubble, the way a group chat app draws it (iMessage, WhatsApp groups): a
 * member's on the left, its avatar beside the first bubble of its block and its name, a small Host
 * or Email mark and the time above it; the user's own on the right in the accent colour, with no
 * avatar or name. Under a bubble, a quiet line of who it reached. A bubble that continues the
 * writer's block (`cont`) shows only its words, its time on hover in the avatar's column. Every
 * "@Name" in the words is the member's chip (TopicMention.tsx).
 */
function Message({ m, topic, cont }: { m: LocalMessage; topic: Topic; cont: boolean }) {
  const who = authorOf(m, topic.members);
  const reach = reachSummary(m, topic.members);
  const ref = who.kind === 'member' ? who.member?.ref : undefined;
  // The writer's own row only: a task write elsewhere never redraws the topic.
  const task = useStoreTask(ref?.kind === 'task' ? ref.taskId : null);
  const words = useRef<HTMLDivElement>(null);
  const slots = useMentionSlots(words, who.kind === 'walnut' ? '' : m.text, topic.members);
  if (who.kind === 'walnut') {
    return <li className="topic-msg is-walnut" data-testid="topic-message" data-author="walnut" data-message-id={m.id}><span>{m.text}</span></li>;
  }
  const human = who.kind === 'human';
  const name = human ? 'You' : who.name;
  const context = human ? '' : nameContext(name);
  return (
    <li className={`topic-msg${human ? ' is-human' : ''}${cont ? ' is-cont' : ''}${m.local ? ' is-sending' : ''}`} data-testid="topic-message" data-author={m.author} data-message-id={m.id} data-via={m.via}>
      {!human && (
        <span className="topic-msg-gutter">
          {cont
            ? <time className="topic-msg-clock" dateTime={m.at}>{clock(m.at)}</time>
            : <MemberAvatar who={{ name: who.kind === 'member' ? who.name : '', ...(ref ? { ref } : {}) }} size={32} />}
        </span>
      )}
      <div className="topic-msg-body">
        {/* A bubble that continues a block shows no name; a screen reader still hears who wrote it. */}
        {cont && <span className="topic-sr-only">{human ? name : shortName(name)}</span>}
        {!cont && (
          <span className="topic-msg-head">
            {human ? <span className="topic-sr-only">{name}</span> : <span className="topic-msg-name wn-title" data-testid="topic-message-name" title={name}>{shortName(name)}</span>}
            {context && <span className="topic-msg-context">{context}</span>}
            {!human && who.kind === 'member' && who.member?.role === 'host' && <span className="badge topic-msg-tag">Host</span>}
            {m.via === 'mail' && <span className="badge topic-msg-tag" data-testid="topic-message-mail">Email</span>}
            <time className="topic-msg-time" dateTime={m.at}>{clock(m.at)}</time>
          </span>
        )}
        <div ref={words} className="topic-msg-bubble" data-testid="topic-message-text">
          {/* A task member's words open its paths on its own machine; anyone else's name none. */}
          <AgentText text={m.text} compact {...(task ? { task } : { unknownSource: true })} />
        </div>
        <MentionChips slots={slots} topic={topic} />
        {(reach.line || m.local) && (
          <span className="topic-msg-reach" data-testid="topic-message-reach" title={m.local ? undefined : reach.full}>{m.local ? 'Sending…' : reach.line}</span>
        )}
      </div>
    </li>
  );
}

export function TopicChat({ topicId, onBack }: { topicId: string; onBack?: () => void }) {
  const on = useTopicsOn();
  const { topic, error, ...actions } = useTopic(topicId, on);
  const confirm = useConfirm();
  const [side, setSide] = usePageView('org', 'topics.side', true, isBoolean);
  const narrow = useMediaQuery(TOPIC_SHEET_QUERY);
  const [sheetOverlayOpen, setSheetOverlayOpen] = useState(false);
  useEffect(() => { if (!narrow) setSheetOverlayOpen(false); }, [narrow]);
  const shown = narrow ? sheetOverlayOpen : side;
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const membersRef = useRef<HTMLButtonElement>(null);
  const closeSheet = useLeanCallback(() => setSheetOverlayOpen(false), []);
  useSheetKeys(narrow && sheetOverlayOpen && !!topic, closeSheet, sheetCloseRef, membersRef);
  const listRef = useRef<HTMLOListElement>(null);
  const nearEnd = useRef(true);
  const count = topic?.messages.length ?? 0;
  // New lines scroll into view while the reader is at the end; one reading back stays put.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && nearEnd.current) el.scrollTop = el.scrollHeight;
  }, [count, topicId]);
  useEffect(() => { nearEnd.current = true; }, [topicId]);

  if (!on) return null;
  if (!topic) {
    return (
      <div className="topic-chat is-empty" data-testid="topic-chat" data-topic-id={topicId}>
        {onBack && <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>Back</button>}
        {error
          ? <UnavailableState size="pane" title="Couldn't load the topic" detail={error} />
          : <LoadingState size="pane" title="Loading the topic…" />}
      </div>
    );
  }
  const close = async () => {
    if (await confirm({ title: `Close “${topic.title}”?`, message: 'Each member is woken once to write down what the topic means for its own work. Nobody can post after that.', confirmLabel: 'Close topic' })) {
      await actions.close();
    }
  };
  let prevAt = 0;
  let prev: TopicMessage | undefined;
  const liveCount = topic.members.filter((mb) => mb.status !== 'left').length;
  return (
    <div className={`topic-chat${shown ? ' shows-side' : ''}`} data-testid="topic-chat" data-topic-id={topic.id} data-closed={topic.closed ? 'true' : undefined}>
      <header className="topic-head">
        {onBack && <button type="button" className="btn btn-icon" onClick={onBack} aria-label="Back to the list">{ICON_CHEVRON_LEFT}</button>}
        <span className="topic-head-mid">
          <span className="topic-head-title wn-title" data-testid="topic-title">{topic.title}</span>
          <span className="topic-head-sub" data-testid="topic-subtitle">{topicSubtitle(topic)}{topic.closed ? ' · closed' : ''}</span>
        </span>
        <button ref={membersRef} type="button" className="btn btn-sm btn-ghost topic-head-members" data-testid="topic-toggle-side" aria-pressed={shown}
          aria-label={`Members, ${liveCount}`} title={shown ? 'Hide members' : 'Show members'}
          onClick={() => (narrow ? setSheetOverlayOpen(!sheetOverlayOpen) : setSide(!side))}>
          <StackedAvatars members={topic.members} size={22} max={3} noMore noTitle testId="topic-head-stack" />
          <span className="topic-head-count">{liveCount}</span>
        </button>
        {!topic.closed && <button type="button" className="btn btn-sm btn-ghost" data-testid="topic-close" onClick={() => void close()}>Close</button>}
      </header>
      {error && <p className="topic-error" data-testid="topic-error">{error}</p>}
      <div className="topic-main">
        <div className="topic-conversation" inert={narrow && shown}>
          <ol ref={listRef} className="topic-messages" data-testid="topic-messages"
            onScroll={(e) => { const el = e.currentTarget; nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {!!topic.droppedMessages && <li className="topic-msg is-walnut">{topic.droppedMessages} older messages are no longer kept</li>}
            {topic.messages.length === 0 && <li><EmptyState size="pane" title="No messages yet" hint="Say what this topic is for; @Name wakes only that member." testId="topic-messages-empty" /></li>}
            {topic.messages.map((m: TopicMessage) => {
              const at = Date.parse(m.at) || 0;
              const gap = at - prevAt > GAP_MS;
              prevAt = at;
              const cont = !gap && continuesBlock(prev, m);
              prev = m;
              return [
                gap ? <li key={`t-${m.id}`} className="topic-time" aria-hidden="true"><span>{when(m.at)}</span></li> : null,
                <Message key={m.id} m={m} topic={topic} cont={cont} />,
              ];
            })}
          </ol>
          <TopicComposer topic={topic} actions={actions} />
        </div>
        {shown && narrow && <div className="topic-sheet-scrim" data-testid="topic-sheet-scrim" aria-hidden="true" onClick={closeSheet} />}
        {shown && <TopicSidePanel topic={topic} actions={actions} {...(narrow ? { sheet: { onClose: closeSheet, closeRef: sheetCloseRef } } : {})} />}
      </div>
    </div>
  );
}
