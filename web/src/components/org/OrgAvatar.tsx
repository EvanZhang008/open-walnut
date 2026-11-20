/**
 * The one avatar of an Org node, everywhere the page draws one (the list, the node's head, the
 * chart, the routers, a moved project, the leaders and the task rows): with the "Org avatars"
 * experiment on, its character (useOrgAvatars); off, its two letters on its colour, as before.
 */
import type { ChannelRow, ChannelState } from './org-channels-model';
import { initials, rowAvatarColor, rowTaskId } from './org-channels-model';
import { useOrgAvatars } from './useOrgAvatars';

interface NodeAvatarProps {
  taskId: string | undefined;
  name: string;
  size: number;
  /** The letters' colour while the experiment is off. */
  color?: string;
  /** Off: the CEO's own look (its letter on its gradient). */
  main?: boolean;
  state?: ChannelState;
  className?: string;
  /** Off: draw nothing (a row that had no avatar before). */
  onlyPicture?: boolean;
}

export function NodeAvatar({ taskId, name, size, color, main, state, className = '', onlyPicture }: NodeAvatarProps) {
  const avatars = useOrgAvatars();
  const dot = state ? <span className={`org-state-dot org-state-${state}`} /> : null;
  if (avatars.on) {
    const pick = avatars.of(taskId, name);
    return (
      <span className={`org-avatar is-picture ${className}`} style={{ width: size, height: size }} aria-hidden="true"
        data-testid="org-avatar-picture" data-preset={pick.preset} data-custom={pick.custom ? '1' : undefined}>
        <img src={pick.src} width={size} height={size} alt="" draggable={false} style={{ borderRadius: Math.round(size * 0.26) }} />
        {dot}
      </span>
    );
  }
  if (onlyPicture) return null;
  return (
    <span
      className={`org-avatar${main ? ' is-main' : ''} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37), ...(main ? {} : { background: color }) }}
      aria-hidden="true"
    >
      {main ? 'C' : initials(name)}
      {dot}
    </span>
  );
}

export function OrgAvatar({ row, size = 34 }: { row: ChannelRow; size?: number }) {
  return (
    <NodeAvatar taskId={rowTaskId(row)} name={row.name} size={size} color={rowAvatarColor(row)} main={row.kind === 'main'} state={row.state} />
  );
}
