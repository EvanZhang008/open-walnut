/**
 * On a thread card whose thread is a topic's (the host's thread, `topic.thread.threadId`): the
 * topic's stacked member avatars and "Open topic". Nothing for any other thread, or with the
 * experiment off.
 */
import { topicOfThread } from './topic-model';
import { StackedAvatars } from './TopicAvatars';
import { useOpenTopic } from './topic-entry';
import { useTopicsOn } from './topics-flag';
import { useTopicList } from './useTopics';

export function TopicThreadBadge({ threadId }: { threadId: string }) {
  const on = useTopicsOn();
  const { list } = useTopicList(on);
  const openTopic = useOpenTopic();
  const topic = on ? topicOfThread(list ?? [], threadId) : undefined;
  if (!topic) return null;
  return (
    <div className="topic-thread-badge" data-testid="topic-thread-badge" data-topic-id={topic.id}>
      <button type="button" className="topic-thread-open" data-testid="topic-thread-open" onClick={(e) => { e.stopPropagation(); openTopic(topic.id); }}>
        <StackedAvatars members={topic.members} size={20} max={3} noMore />
        <span className="topic-thread-open-words">Open topic</span>
        <span className="topic-muted">{topic.members.filter((m) => m.status !== 'left').length} members</span>
      </button>
    </div>
  );
}
