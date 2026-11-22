/**
 * The Org list's Topics (experiment `topics`): a heading with "+ New topic", then one row per open
 * topic, newest first, as the list's one plain row (OrgListRow): its members' stacked avatars and its
 * title; when it last moved and its last line ("Name: words") are in its hover. A click selects it like a node (`topic:<id>`), and the page shows its chat
 * (TopicChat). Inside the list's listbox it is a group of options, like the Routers. The rows come
 * from useOrgTopicRows, which the list also reads, so Up and Down walk them in the order drawn.
 */
import { OrgListRow } from '@/components/org/OrgListRow';
import { timeAgo } from '@/utils/time';
import type { TopicSummary } from '@/api/topics';
import { UnavailableState } from '@/components/common/EmptyState';
import { openTopics, shortName, topicKey } from './topic-model';
import { GroupAvatar } from './TopicAvatars';
import { NewTopicButton } from './topic-entry';
import { useTopicsOn } from './topics-flag';
import { useTopicList } from './useTopics';

function matches(t: TopicSummary, words: string[]): boolean {
  const hay = `${t.title}\n${t.members.map((m) => m.name).join('\n')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface OrgTopicRows { on: boolean; rows: TopicSummary[]; error: string | null; reload: () => void }

/** The open topics the Org list shows for `query`, newest first (none while the experiment is off). */
export function useOrgTopicRows(query: string): OrgTopicRows {
  const on = useTopicsOn();
  const { list, error, reload } = useTopicList(on);
  if (!on) return { on, rows: [], error: null, reload };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return { on, rows: openTopics(list ?? []).filter((t) => matches(t, words)), error, reload };
}

/** A topic row's hover: its title, when it last moved, and its last line. */
export function topicHover(t: TopicSummary, now: number): string {
  const at = t.last?.at ?? t.updatedAt;
  const moved = at ? timeAgo(at, { now }) : '';
  return [`${t.title}${moved ? `, moved ${moved}` : ''}`, t.last ? `${shortName(t.last.author)}: ${t.last.text}` : 'No messages yet'].join('\n');
}

export function OrgTopicsSection({ topics, selectedKey, now, onSelect }: {
  topics: OrgTopicRows;
  selectedKey: string | null;
  now: number;
  onSelect: (key: string) => void;
}) {
  const { on, rows, error, reload } = topics;
  if (!on) return null;
  return (
    <div className="org-topics" role="group" aria-label="Topics" data-testid="org-topics" data-count={rows.length}>
      <div className="org-list-section org-topics-head" role="presentation" data-testid="org-topics-head">
        <span>Topics · {rows.length}</span>
        <NewTopicButton testId="org-topic-new" iconOnly />
      </div>
      {/* In the Org list's listbox: no live region of its own, and its Retry keeps the arrow keys. */}
      {error && (
        <div role="presentation" onKeyDown={(e) => e.stopPropagation()}>
          <UnavailableState size="row" role="presentation" title="Couldn't load topics" detail={error} onRetry={reload} testId="org-topics-error" />
        </div>
      )}
      {rows.map((t) => {
        const key = topicKey(t.id);
        const selected = selectedKey === key;
        return (
          <div key={t.id} className="org-channel-wrap" role="presentation">
            <OrgListRow
              avatar={<GroupAvatar members={t.members} size={34} />}
              name={t.title}
              selected={selected}
              className="is-topic"
              data-testid="org-topic"
              data-peek-row=""
              data-key={key}
              data-topic-id={t.id}
              title={topicHover(t, now)}
              onClick={() => onSelect(key)}
            />
          </div>
        );
      })}
    </div>
  );
}
