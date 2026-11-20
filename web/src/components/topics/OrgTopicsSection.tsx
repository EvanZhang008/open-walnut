/**
 * The Org list's Topics (experiment `topics`): a heading with "+ New topic", then one row per open
 * topic, newest first: its members' stacked avatars, its title, when it last moved, and its last
 * line ("Name: words"). A click selects it like a node (`topic:<id>`), and the page shows its chat
 * (TopicChat). Inside the list's listbox it is a group of options, like the Routers.
 */
import { shortAgo } from '@/components/org/OrgChannelList';
import type { TopicSummary } from '@/api/topics';
import { openTopics, topicKey } from './topic-model';
import { StackedAvatars } from './TopicAvatars';
import { NewTopicButton } from './topic-entry';
import { useTopicsOn } from './topics-flag';
import { useTopicList } from './useTopics';

function matches(t: TopicSummary, words: string[]): boolean {
  const hay = `${t.title}\n${t.members.map((m) => m.name).join('\n')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function OrgTopicsSection({ selectedKey, query, now, onSelect }: {
  selectedKey: string | null;
  query: string;
  now: number;
  onSelect: (key: string) => void;
}) {
  const on = useTopicsOn();
  const { list, error } = useTopicList(on);
  if (!on) return null;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = openTopics(list ?? []).filter((t) => matches(t, words));
  return (
    <div className="org-topics" role="group" aria-label="Topics" data-testid="org-topics" data-count={rows.length}>
      <div className="org-list-section org-topics-head" role="presentation" data-testid="org-topics-head">
        <span>Topics · {rows.length}</span>
        <NewTopicButton testId="org-topic-new" className="org-topics-new" />
      </div>
      {error && <p className="org-empty-note" data-testid="org-topics-error">{error}</p>}
      {rows.map((t) => {
        const key = topicKey(t.id);
        const selected = selectedKey === key;
        const at = Date.parse(t.last?.at ?? t.updatedAt) || 0;
        return (
          <div key={t.id} className="org-channel-wrap" role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className={`org-channel is-topic${selected ? ' is-selected' : ''}`}
              data-testid="org-topic"
              data-key={key}
              data-topic-id={t.id}
              title={t.title}
              onClick={() => onSelect(key)}
            >
              <StackedAvatars members={t.members} size={20} max={3} />
              <span className="org-channel-mid">
                <span className="org-channel-top">
                  <span className="org-channel-name">{t.title}</span>
                  <span className="org-channel-time">{shortAgo(at, now)}</span>
                </span>
                <span className="org-channel-latest" data-testid="org-topic-last">
                  {t.last ? `${t.last.author}: ${t.last.text}` : 'No messages yet'}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
