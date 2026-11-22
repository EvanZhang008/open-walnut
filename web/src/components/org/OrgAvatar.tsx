/**
 * The one avatar of an Org node, everywhere the page draws one (the list, the node's head, the
 * chart, the routers, a moved project, the leaders and the task rows): its character
 * (useOrgAvatars), the default one or the one picked for it.
 */
import type { ChannelRow, ChannelState } from './org-channels-model';
import { rowTaskId } from './org-channels-model';
import { useOrgAvatars } from './useOrgAvatars';
import { TaskStateIcon } from '@/components/common/TaskStateIcon';
import type { TaskIconState } from '@/utils/task-icon-state';

interface NodeAvatarProps {
  taskId: string | undefined;
  name: string;
  size: number;
  state?: ChannelState;
  className?: string;
}

/** A node's state as its status icon on the avatar's corner: the one status mark of its row.
 *  Parked is not a snooze: it holds tasks set aside in WAITING as well as snoozed ones (a paused
 *  router too, org-channels-model.ts isParkedTask), so it wears the wait's clock, as quiet does. */
const CHANNEL_ICON: Record<ChannelState, TaskIconState> = { alert: 'needs', working: 'working', quiet: 'waiting', parked: 'waiting' };

export function NodeAvatar({ taskId, name, size, state, className = '' }: NodeAvatarProps) {
  const pick = useOrgAvatars().of(taskId, name);
  return (
    <span className={`org-avatar is-picture ${className}`} style={{ width: size, height: size }} aria-hidden="true"
      data-testid="org-avatar-picture" data-preset={pick.preset} data-custom={pick.custom ? '1' : undefined}>
      <img src={pick.src} width={size} height={size} alt="" draggable={false} style={{ borderRadius: Math.round(size * 0.26) }} />
      {state ? <TaskStateIcon state={CHANNEL_ICON[state]} size={12} className="org-state-dot" decorative /> : null}
    </span>
  );
}

export function OrgAvatar({ row, size = 34 }: { row: ChannelRow; size?: number }) {
  return (
    <NodeAvatar taskId={rowTaskId(row)} name={row.name} size={size} state={row.state} />
  );
}
