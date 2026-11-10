/**
 * The Org list's Routers: one row per router node (a task whose org_role is 'router'), drawn after
 * the CEO and every VP, before the folded Archived (2026-11-10, the person: "router should be placed
 * below all VPs"). A router is its own node, not a VP and not a task under one, so it
 * has its own section and its own row kind; a click selects it like any node and the page opens its
 * chat (OrgNodeDetail). The rows come from the page (buildChannels' `routers`, already filtered by
 * the list's search); this section fetches nothing. It always shows its heading, "Routers · 0"
 * included, so the place a router will appear is visible before there is one.
 *
 * Inside the list's listbox it is a group of options (all a listbox may hold); Up and Down reach its
 * rows through the list's own key handler, which counts them after the VPs.
 */
import { timeAgo } from '@/utils/time';
import { stateCountLabel } from '@open-walnut/user-status';
import { ROUTER_AVATAR_COLOR, initials, type ChannelRow, type ChannelState } from './org-channels-model';

const STATE_LABEL: Record<ChannelState, string> = {
  alert: 'Needs you', working: 'Working', quiet: 'Waiting', parked: 'Paused',
};

export const ROUTERS_SECTION_LABEL = 'Routers';

/** The section heading: "Routers · N". */
export function routersHeading(count: number): string {
  return `${ROUTERS_SECTION_LABEL} · ${count}`;
}

/** "5m", "3h", "2d" (the list's short clock, kept here so this section imports no list code). */
function shortAgo(ms: number, now: number): string {
  if (!ms) return '';
  const mins = Math.max(0, Math.floor((now - ms) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function RouterRow({ row, selected, now, onSelect }: { row: ChannelRow; selected: boolean; now: number; onSelect: (key: string) => void }) {
  const own = row.alerts.length;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`org-channel is-router${selected ? ' is-selected' : ''}${row.unread ? ' is-unread' : ''}`}
      data-testid="org-channel-router"
      data-key={row.key}
      data-kind="router"
      data-state={row.state}
      title={`${row.name}: ${STATE_LABEL[row.state]}${row.lastAt ? `, moved ${timeAgo(new Date(row.lastAt).toISOString(), { now })}` : ''}`}
      onClick={() => onSelect(row.key)}
    >
      <span
        className="org-avatar"
        style={{ width: 34, height: 34, fontSize: 13, background: ROUTER_AVATAR_COLOR }}
        aria-hidden="true"
      >
        {initials(row.name)}
        <span className={`org-state-dot org-state-${row.state}`} />
      </span>
      <span className="org-channel-mid">
        <span className="org-channel-top">
          <span className="org-channel-name">{row.name}</span>
          <span className="org-channel-time">{shortAgo(row.latestAt || row.lastAt, now)}</span>
        </span>
        {/* Its area, Paused or Active, and how many VPs it links to (buildChannels writes the line). */}
        <span className={`org-channel-latest${row.state === 'alert' ? ' is-alert' : ''}`} data-testid="org-router-line" title={row.latest}>
          {row.latest}
        </span>
      </span>
      {own > 0 && <span className="org-badge is-alert" data-testid="org-channel-badge" title={stateCountLabel('needs', own)}>{own}</span>}
    </button>
  );
}

export function OrgRouterSection({ rows, selectedKey, now, onSelect }: {
  rows: readonly ChannelRow[];
  selectedKey: string | null;
  now: number;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="org-routers" role="group" aria-label={ROUTERS_SECTION_LABEL} data-testid="org-routers" data-count={rows.length}>
      <div className="org-list-section" role="presentation" data-testid="org-routers-head">{routersHeading(rows.length)}</div>
      {rows.map((r) => (
        <div key={r.key} className="org-channel-wrap" role="presentation">
          <RouterRow row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} />
        </div>
      ))}
    </div>
  );
}
