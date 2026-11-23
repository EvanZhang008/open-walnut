/**
 * The Org list's Routers: one row per router node (a task whose org_role is 'router', or a task that
 * routes by itself, Task.self_router: core/router/self-router.ts), drawn after
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
import type React from 'react';
import type { ChannelRow } from './org-channels-model';
import { OrgAvatar } from './OrgAvatar';
import { OrgListRow, rowDot, rowHover } from './OrgListRow';
import { ICON_PLUS } from '@/components/common/Icons';

export const ROUTERS_SECTION_LABEL = 'Routers';

/** The section heading: "Routers · N". */
export function routersHeading(count: number): string {
  return `${ROUTERS_SECTION_LABEL} · ${count}`;
}

/** A right-click on a router row: the list's row menu (org-row-menu.ts). */
type RouterMenu = (e: React.MouseEvent, target: { row: ChannelRow }) => void;

/** The list's one plain row (OrgListRow); its area, Paused or Active and its VPs (buildChannels'
 *  line) are in its hover. */
function RouterRow({ row, selected, now, onSelect, onMenu }: { row: ChannelRow; selected: boolean; now: number; onSelect: (key: string) => void; onMenu?: RouterMenu }) {
  return (
    <OrgListRow
      avatar={<OrgAvatar row={row} plain />}
      name={row.name}
      dot={rowDot(row)}
      selected={selected}
      className="is-router"
      data-testid="org-channel-router"
      data-key={row.key}
      data-kind="router"
      data-state={row.state}
      title={rowHover(row, now)}
      onClick={() => onSelect(row.key)}
      onContextMenu={onMenu ? (e) => onMenu(e, { row }) : undefined}
    />
  );
}

export function OrgRouterSection({ rows, selectedKey, now, onSelect, onMenu, onNewRouter }: {
  rows: readonly ChannelRow[];
  selectedKey: string | null;
  now: number;
  onSelect: (key: string) => void;
  onMenu?: RouterMenu;
  /** New router, a + on this heading (2026-11-21, the user: "no new router,put it sin the router
   *  section"). It is no option: the list's Up and Down walk option rows only, so they skip it. */
  onNewRouter?: () => void;
}) {
  return (
    <div className="org-routers" role="group" aria-label={ROUTERS_SECTION_LABEL} data-testid="org-routers" data-count={rows.length}>
      <div className="org-list-section org-routers-head" role="presentation" data-testid="org-routers-head">
        <span>{routersHeading(rows.length)}</span>
        {onNewRouter && (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            data-testid="org-new-router"
            aria-label="New router"
            title="New router: a router sits beside the VPs; it starts paused"
            onClick={onNewRouter}
          >{ICON_PLUS}</button>
        )}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="org-channel-wrap" role="presentation">
          <RouterRow row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} onMenu={onMenu} />
        </div>
      ))}
    </div>
  );
}
