/**
 * A topic member's avatar and a topic's stacked avatars. A task or an Org node is drawn by the Org
 * page's own NodeAvatar (its character with "Org avatars" on, else its letters), from the task the
 * member is now (an Org node's VP may change), so a VP looks the same in its row and in a topic.
 * Off, the tile is the Org list's (`.org-avatar`, its colour from the name); the CEO keeps its
 * gradient; a person outside Walnut is always a round tile, and a bot wears a small mark.
 */
import type { MemberRef, TopicMember } from '@/api/topics';
import type { Task } from '@open-walnut/core';
import { pickLead, pickMain } from '@open-walnut/org-tree';
import { avatarColor, initials } from '@/components/org/org-channels-model';
import { NodeAvatar } from '@/components/org/OrgAvatar';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { stackedAvatars } from './topic-model';
import '@/styles/topics.css';

type Who = { name: string; ref?: MemberRef } | 'human' | 'walnut';

export function nameColor(name: string): string {
  return avatarColor(name);
}

/** Pure: the task a task or Org member is now (undefined for a person, or a node with no task). */
export function memberTaskId(ref: MemberRef | undefined, tasks: readonly Task[]): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === 'task') return ref.taskId;
  if (ref.kind !== 'org') return undefined;
  if (ref.node === 'main') return pickMain(tasks)?.id;
  const key = ref.node.replace(/^project:/, '');
  return key ? pickLead(tasks, key)?.id : undefined;
}

export function MemberAvatar({ who, size = 30 }: { who: Who; size?: number }) {
  const ref = typeof who === 'string' ? undefined : who.ref;
  // A string from the selector: one row's write elsewhere never draws this avatar again.
  const taskId = useTaskListSelect(({ tasks }) => memberTaskId(ref, tasks)) ?? (ref?.kind === 'task' ? ref.taskId : undefined);
  if (typeof who !== 'string' && (ref?.kind === 'task' || ref?.kind === 'org')) {
    const main = ref.kind === 'org' && ref.node === 'main';
    return <NodeAvatar taskId={taskId} name={who.name} size={size} main={main} color={avatarColor(who.name)} className="topic-avatar" />;
  }
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

/**
 * A topic's own picture in a list row, the size of a node's avatar there: the host's avatar up and
 * to the left, the next member's down and to the right over it (the way a group chat's row is drawn).
 */
export function GroupAvatar({ members, size = 34, testId = 'topic-group-avatar' }: {
  members: ReadonlyArray<Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>>;
  size?: number;
  testId?: string;
}) {
  const { shown } = stackedAvatars(members, 2);
  const inner = Math.round(size * 0.68);
  return (
    <span className="topic-group-avatar" data-testid={testId} data-count={shown.length} style={{ width: size, height: size }}
      title={members.filter((m) => m.status !== 'left').map((m) => m.name).join(', ')}>
      {shown.map((m, i) => (
        <span key={m.id} className={`topic-group-avatar-slot is-${i === 0 ? 'back' : 'front'}`}>
          <MemberAvatar who={{ name: m.name, ref: m.ref }} size={shown.length === 1 ? size : inner} />
        </span>
      ))}
    </span>
  );
}

/** Up to four members, overlapping, the host first; "+N" for the rest unless `noMore` (a count is beside it). */
export function StackedAvatars({ members, size = 22, max = 4, testId = 'topic-stack', noMore = false }: {
  members: ReadonlyArray<Pick<TopicMember, 'id' | 'name' | 'ref' | 'role' | 'status'>>;
  size?: number;
  max?: number;
  testId?: string;
  noMore?: boolean;
}) {
  const { shown, more: extra } = stackedAvatars(members, max);
  const more = noMore ? 0 : extra;
  return (
    <span className="topic-stack" data-testid={testId} data-count={shown.length + more} title={members.filter((m) => m.status !== 'left').map((m) => m.name).join(', ')}>
      {shown.map((m) => <MemberAvatar key={m.id} who={{ name: m.name, ref: m.ref }} size={size} />)}
      {more > 0 && <span className="topic-stack-more" style={{ height: size, minWidth: size }}>+{more}</span>}
    </span>
  );
}
