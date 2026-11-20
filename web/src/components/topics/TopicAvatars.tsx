/**
 * A topic member's avatar and a topic's stacked avatars. The tile is the Org list's own
 * (`.org-avatar`, its colour from the name: org-channels-model avatarColor), so a VP looks the same
 * in its row and in a topic; the CEO keeps its gradient, a person outside Walnut is round, a bot
 * wears a small mark.
 */
import type { MemberRef, TopicMember } from '@/api/topics';
import { avatarColor, initials } from '@/components/org/org-channels-model';
import { stackedAvatars } from './topic-model';
import '@/styles/topics.css';

type Who = { name: string; ref?: MemberRef } | 'human' | 'walnut';

export function nameColor(name: string): string {
  return avatarColor(name);
}

export function MemberAvatar({ who, size = 30 }: { who: Who; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.37) };
  if (who === 'human') return <span className="org-avatar topic-avatar is-human" style={style} aria-hidden="true">You</span>;
  if (who === 'walnut') return <span className="org-avatar topic-avatar is-walnut" style={style} aria-hidden="true">W</span>;
  const main = who.ref?.kind === 'org' && who.ref.node === 'main';
  const person = who.ref?.kind === 'person';
  const bot = who.ref?.kind === 'person' && !!who.ref.bot;
  return (
    <span
      className={`org-avatar topic-avatar${main ? ' is-main' : ''}${person ? ' is-person' : ''}`}
      style={{ ...style, ...(main ? {} : { background: avatarColor(who.name) }) }}
      aria-hidden="true"
    >
      {main ? 'C' : initials(who.name)}
      {bot && <span className="topic-avatar-bot" title="A bot">⚙</span>}
    </span>
  );
}

/** Up to four members, overlapping, the host first; "+N" for the rest. */
export function StackedAvatars({ members, size = 22, max = 4, testId = 'topic-stack' }: {
  members: ReadonlyArray<Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>>;
  size?: number;
  max?: number;
  testId?: string;
}) {
  const { shown, more } = stackedAvatars(members, max);
  return (
    <span className="topic-stack" data-testid={testId} data-count={shown.length + more} title={members.filter((m) => m.status !== 'left').map((m) => m.name).join(', ')}>
      {shown.map((m) => <MemberAvatar key={m.id} who={{ name: m.name, ref: m.ref }} size={size} />)}
      {more > 0 && <span className="topic-stack-more" style={{ height: size, minWidth: size }}>+{more}</span>}
    </span>
  );
}
