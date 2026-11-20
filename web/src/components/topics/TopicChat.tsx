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
 * The side panel's shown/hidden is kept (usePageView). Live through useTopic (topic:updated).
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import type { Topic, TopicMessage } from '@/api/topics';
import { AgentText } from '@/components/common/AgentText';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageView, isBoolean } from '@/utils/view-memory';
import { authorOf, reachLine, topicSubtitle } from './topic-model';
import { MemberAvatar, StackedAvatars, nameColor } from './TopicAvatars';
import { TopicComposer } from './TopicComposer';
import { TopicSidePanel } from './TopicSidePanel';
import { useTopicsOn } from './topics-flag';
import { useTopic, type LocalMessage } from './useTopics';

/** A time line between messages more than this apart. */
const GAP_MS = 30 * 60_000;

function when(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Message({ m, topic, tasks }: { m: LocalMessage; topic: Topic; tasks: readonly Task[] }) {
  const who = authorOf(m, topic.members);
  const reach = reachLine(m, topic.members);
  if (who.kind === 'walnut') {
    return <li className="topic-msg is-walnut" data-testid="topic-message" data-author="walnut" data-message-id={m.id}>{m.text}</li>;
  }
  const human = who.kind === 'human';
  const ref = who.kind === 'member' ? who.member?.ref : undefined;
  const task = ref?.kind === 'task' ? tasks.find((t) => t.id === ref.taskId) ?? null : null;
  return (
    <li className={`topic-msg${human ? ' is-human' : ''}${m.local ? ' is-sending' : ''}`} data-testid="topic-message" data-author={m.author} data-message-id={m.id} data-via={m.via}>
      {!human && <MemberAvatar who={{ name: who.kind === 'member' ? who.name : '', ...(ref ? { ref } : {}) }} size={30} />}
      <div className="topic-msg-body">
        {!human && who.kind === 'member' && (
          <span className="topic-msg-name" style={{ color: nameColor(who.name) }} data-testid="topic-message-name">
            {who.name}{who.member?.role === 'host' ? ' · host' : ''}{m.via === 'mail' ? ' · by email' : ''}
          </span>
        )}
        <div className="topic-msg-bubble" data-testid="topic-message-text">
          {/* A task member's words open its paths on its own machine; anyone else's name none. */}
          <AgentText text={m.text} compact {...(task ? { task } : { unknownSource: true })} />
        </div>
        {(reach || m.local) && <span className="topic-msg-reach" data-testid="topic-message-reach">{m.local ? 'Sending…' : reach}</span>}
      </div>
    </li>
  );
}

export function TopicChat({ topicId, onBack }: { topicId: string; onBack?: () => void }) {
  const on = useTopicsOn();
  const { topic, error, ...actions } = useTopic(topicId, on);
  const tasks = useTasksContextSafe()?.tasks ?? [];
  const confirm = useConfirm();
  const [side, setSide] = usePageView('org', 'topics.side', true, isBoolean);
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
        {onBack && <button type="button" className="btn btn-sm" onClick={onBack}>Back</button>}
        <p className="topic-muted" aria-busy={!error}>{error ?? 'Loading the topic…'}</p>
      </div>
    );
  }
  const close = async () => {
    if (await confirm({ title: `Close “${topic.title}”?`, message: 'Each member is woken once to write down what the topic means for its own work. Nobody can post after that.', confirmLabel: 'Close topic' })) {
      await actions.close();
    }
  };
  let prevAt = 0;
  return (
    <div className={`topic-chat${side ? ' shows-side' : ''}`} data-testid="topic-chat" data-topic-id={topic.id} data-closed={topic.closed ? 'true' : undefined}>
      <header className="topic-head">
        {onBack && <button type="button" className="btn btn-sm" onClick={onBack} aria-label="Back to the list">‹</button>}
        <StackedAvatars members={topic.members} size={26} testId="topic-head-stack" />
        <span className="topic-head-mid">
          <span className="topic-head-title" data-testid="topic-title">{topic.title}</span>
          <span className="topic-muted" data-testid="topic-subtitle">{topicSubtitle(topic)}{topic.closed ? ' · closed' : ''}</span>
        </span>
        <button type="button" className="btn btn-sm" data-testid="topic-toggle-side" aria-pressed={side} onClick={() => setSide(!side)}>Members</button>
        {!topic.closed && <button type="button" className="btn btn-sm" data-testid="topic-close" onClick={() => void close()}>Close</button>}
      </header>
      {error && <p className="topic-error" data-testid="topic-error">{error}</p>}
      <div className="topic-main">
        <div className="topic-conversation">
          <ol ref={listRef} className="topic-messages" data-testid="topic-messages"
            onScroll={(e) => { const el = e.currentTarget; nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {!!topic.droppedMessages && <li className="topic-msg is-walnut">{topic.droppedMessages} older messages are no longer kept</li>}
            {topic.messages.length === 0 && <li className="topic-msg is-walnut">No messages yet. Say what this topic is for; @Name wakes only that member.</li>}
            {topic.messages.map((m: TopicMessage) => {
              const at = Date.parse(m.at) || 0;
              const gap = at - prevAt > GAP_MS;
              prevAt = at;
              return [
                gap ? <li key={`t-${m.id}`} className="topic-time" aria-hidden="true">{when(m.at)}</li> : null,
                <Message key={m.id} m={m} topic={topic} tasks={tasks} />,
              ];
            })}
          </ol>
          <TopicComposer topic={topic} actions={actions} />
        </div>
        {side && <TopicSidePanel topic={topic} actions={actions} />}
      </div>
    </div>
  );
}
