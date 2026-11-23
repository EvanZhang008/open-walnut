/**
 * The Org page's left column, like a chat app's channel list: Main pinned on top, then one row per
 * project (org-channels-model.ts orders them). Every row is the one plain row (OrgListRow): its
 * avatar, its name and a red dot when something there waits on the user; the rest is in its hover
 * (2026-11-22, the user: "We need to be super simple"). Up and Down move the selection. While the
 * pointer is over the list the rows keep their order, so a click lands on the row aimed at.
 * After the VPs, the Routers (OrgRouterSection): router nodes, which are neither VPs nor tasks under one
 * (2026-11-10, the person: "router should be placed below all VPs"); then, with the `topics`
 * experiment on, the open topics (OrgTopicsSection), which Up and Down reach too.
 * A project another VP took over has no row of its own: it sits in "Archived" at
 * the bottom (folded); its hover says which VP has it now and a click opens that VP. A right-click on any
 * row opens Walnut's own menu of what that row can do (the page builds it: OrgPage rowMenu).
 * Nothing hangs under a row (2026-11-22): the tasks the user watches are in the node's own Watching
 * (OrgTaskRail) and Home's, a locked panel stands beside the node it was locked at, and the Directors
 * under a VP are on the Org chart (OrgChartSheet). With the "sections" Directors layout (Settings → Org)
 * they are also one DIRECTORS section after the VPs (OrgDirectorSection).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { DisclosureButton } from '@/components/controls';
import '@/styles/org-rail.css';
import { readOrgPlace, writeOrgPlace } from './org-place';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { type ChannelRow, type MovedRow, shownName } from './org-channels-model';
import { usePointerHold } from './hold-order';
import { OrgEditableName } from './OrgEditableName';
import { NodeAvatar, OrgAvatar } from './OrgAvatar';
import { OrgListRow, rowDot, rowHover } from './OrgListRow';
import { OrgRouterSection } from './OrgRouterSection';
import { OrgTopicsSection, useOrgTopicRows } from '@/components/topics/OrgTopicsSection';
import { topicKey } from '@/components/topics/topic-model';
import { OrgReorgReminder } from './OrgReorgReminder';
import { OrgSettingsMenu } from './OrgSettingsMenu';
import { FitButton } from '@/components/common/HeaderFit';
import { ICON_ORG_CHART } from '@/components/common/Icons';
import { useOrgSettings } from './useOrgSettings';
import { SearchField } from '@/components/common/SearchField';
import { OrgDirectorSection } from './OrgDirectorSection';
import type { OrgDirectorsView } from './useOrgLeaders';

/** What a right-click is on: a row of the list, or a project under "Archived". */
export type ChannelMenuTarget = { row: ChannelRow } | { moved: MovedRow };
type OnMenu = (e: MouseEvent, target: ChannelMenuTarget) => void;

function Row({ row, selected, now, onSelect, onMenu }: { row: ChannelRow; selected: boolean; now: number; onSelect: (key: string) => void; onMenu?: OnMenu }) {
  return (
    <OrgListRow
      avatar={<OrgAvatar row={row} plain />}
      // A VP the user named goes by that name, as on the org chart.
      name={shownName(row)}
      dot={rowDot(row)}
      selected={selected}
      data-testid={row.kind === 'main' ? 'org-channel-main' : 'org-channel'}
      data-key={row.key}
      data-state={row.state}
      title={rowHover(row, now)}
      onClick={() => onSelect(row.key)}
      onContextMenu={onMenu ? (e) => onMenu(e, { row }) : undefined}
    />
  );
}

function MovedSection({ moved, query, onSelect, onMenu }: { moved: readonly MovedRow[]; query: string; onSelect: (key: string) => void; onMenu?: OnMenu }) {
  const [open, setOpen] = useState(false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? moved.filter((m) => words.every((w) => `${m.project}\n${m.vpName}`.toLowerCase().includes(w)))
    : moved;
  if (!shown.length) return null;
  // A search that finds one shows it.
  const expanded = open || words.length > 0;
  return (
    <div className="org-moved" data-testid="org-moved">
      <DisclosureButton block expanded={expanded} className="org-moved-toggle" data-testid="org-moved-toggle" onClick={() => setOpen((v) => !v)}>
        Archived · {shown.length}
      </DisclosureButton>
      {expanded && shown.map((m) => (
        <OrgListRow
          key={m.key}
          avatar={<NodeAvatar taskId={undefined} name={m.project} size={26} className="is-moved" />}
          name={m.project}
          className="is-moved"
          data-testid="org-moved-row"
          data-key={m.key}
          data-vp={m.vpKey}
          title={`${m.project} is led by the ${m.vpName} VP now${m.from ? ` (before: ${m.from.title}, ${m.from.open ? 'handing over' : 'closed'})` : ''}`}
          onClick={() => onSelect(m.vpKey)}
          onContextMenu={onMenu ? (e) => onMenu(e, { moved: m }) : undefined}
        />
      ))}
    </div>
  );
}

interface Props {
  main: ChannelRow;
  rows: readonly ChannelRow[];
  /** The router nodes (buildChannels' `routers`), already filtered by the search. */
  routers?: readonly ChannelRow[];
  /** Projects another VP took over (movedProjects). */
  moved?: readonly MovedRow[];
  /** What a right-click on a row offers; no menu without it. `point` is where the click landed:
   *  a picker one of its rows opens anchors there. */
  /** `origin`: the row right-clicked, for a picker the menu opens (focus goes back to it). */
  rowMenu?: (target: ChannelMenuTarget, point: { x: number; y: number }, origin: HTMLElement | null) => ContextMenuItem[];
  total: number;
  /** The header's VP count (vpCount): every project row. */
  vps: number;
  selectedKey: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (key: string) => void;
  onOpenChart: () => void;
  onNewRouter?: () => void;
  /** The tasks open beside the page: a Director's row among them wears a light tint. */
  openTaskIds?: ReadonlySet<string>;
  /** The Directors of each VP (org-leaders.ts) and its projects, for the DIRECTORS section; absent while the experiment is off. */
  directors?: OrgDirectorsView;
  now: number;
}

export function OrgChannelList({ main, rows, routers = [], moved = [], rowMenu, total, vps, selectedKey, query, onQuery, onSelect, onOpenChart, onNewRouter, openTaskIds, directors, now }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const orgName = useOrgSettings();
  const sections = orgName.settings.directorsLayout === 'sections';
  // A right-click selects a word in WebKit before the menu opens: that selection is the
  // gesture's, not the user's, so it neither keeps the browser's menu nor stays lit.
  const menu = useContextMenu<ChannelMenuTarget>({ ignorePressSelection: true });
  const onMenu: OnMenu | undefined = rowMenu ? (e, target) => { menu.open(e, target); } : undefined;
  // Back on the page, the list is where it was scrolled to (org-place.ts), once its rows are in.
  const scrollRestored = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (scrollRestored.current || !el || rows.length === 0) return;
    scrollRestored.current = true;
    const top = readOrgPlace().listTop;
    if (top) el.scrollTop = top;
  }, [rows.length]);
  const scrollSave = useRef<number | null>(null);
  const onScroll = () => {
    if (scrollSave.current !== null) return;
    scrollSave.current = window.setTimeout(() => {
      scrollSave.current = null;
      if (listRef.current) writeOrgPlace({ listTop: Math.round(listRef.current.scrollTop) });
    }, 200);
  };
  // Live work re-sorts the rows all the time; one that moved under the pointer would take a
  // click meant for another. The new order shows once the pointer leaves.
  const hold = usePointerHold(rows);
  const shown = hold.shown;
  // Up and Down walk the CEO, the VPs, the routers, then the open topics, in the order they are drawn.
  const topics = useOrgTopicRows(query);
  const keys = [main.key, ...shown.map((r) => r.key), ...routers.map((r) => r.key), ...topics.rows.map((t) => topicKey(t.id))];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // Among the Directors, Up and Down walk every option in the order drawn, so they lead out again.
    if ((e.target as HTMLElement).closest('.org-directors')) {
      const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
      const at = all.indexOf(e.target as HTMLElement);
      all[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return;
    }
    const at = selectedKey ? keys.indexOf(selectedKey) : -1;
    const next = keys[Math.min(keys.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    onSelect(next);
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
  };
  return (
    <aside className="org-list" aria-label={orgName.settings.name}>
      <header className="org-list-head" data-fit-header="">
        <h1 className="org-list-title" data-fit-title="">
          <OrgEditableName value={orgName.settings.name} label="the org" onSave={(v) => orgName.save({ name: v })} testId="org-name" />
        </h1>
        <span className="org-list-actions" data-fit-actions="">
          {/* Org chart is an icon with its name on hover (2026-11-21, the user: "org chart need to
              be an icon with hover over"); New router lives in the Routers heading ("no new
              router,put it sin the router section"). Two icons and the title fit the narrowest
              list the divider allows, so this header needs no More (header-fit.css only). */}
          <FitButton icon={ICON_ORG_CHART} label="Org chart" iconOnly step={1} data-testid="org-open-chart" onClick={onOpenChart} title="Org chart: the CEO and every project's VP on one sheet; drag a project onto another VP to put it under that VP" />
          <OrgSettingsMenu />
        </span>
      </header>
      <SearchField data-no-draft="search"
        className="org-search"
        fieldClassName="org-search-field"
        type="search"
        value={query}
        placeholder="Search VPs and routers…"
        aria-label="Search VPs and routers"
        data-testid="org-search"
        setText={onQuery}
        onClear={() => onQuery('')}
      />
      <OrgReorgReminder vps={vps} onOpenChart={onOpenChart} />
      <div
        ref={listRef}
        className="org-list-scroll"
        role="listbox"
        aria-label="The CEO, the VPs and the routers"
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onPointerEnter={hold.onPointerEnter}
        onPointerLeave={hold.onPointerLeave}
      >
        <Row row={main} selected={selectedKey === main.key} now={now} onSelect={onSelect} onMenu={onMenu} />
        <div className="org-list-section" role="presentation" data-testid="org-vps-head">VPs · {vps}</div>
        {shown.map((r) => (
          <div key={r.key} className="org-channel-wrap" role="presentation">
            <Row row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} onMenu={onMenu} />
          </div>
        ))}
        {directors && sections && <OrgDirectorSection vps={shown} groupsOf={directors.groupsOf} projectsOf={directors.projectsOf} query={query} openTaskIds={openTaskIds} />}
        {/* Routers sit below every VP (2026-11-10, the person), above the folded Archived. */}
        <OrgRouterSection rows={routers} selectedKey={selectedKey} now={now} onSelect={onSelect} onMenu={onMenu} onNewRouter={onNewRouter} />
        <OrgTopicsSection topics={topics} selectedKey={selectedKey} now={now} onSelect={onSelect} />
        <MovedSection moved={moved} query={query} onSelect={onSelect} onMenu={onMenu} />
      </div>
      {total === 0 && <p className="org-empty-note" data-testid="org-empty">No open work yet. Ask the CEO to start something.</p>}
      {total > 0 && rows.length === 0 && routers.length === 0 && <p className="org-empty-note" data-testid="org-no-match">No VP or router matches “{query}”.</p>}
      {menu.state && rowMenu && (
        <ContextMenu
          point={menu.state.point}
          items={rowMenu(menu.state.payload, menu.state.point, menu.state.origin)}
          onClose={menu.close}
          returnFocus={menu.state.origin}
          ariaLabel="Org row actions"
          testId="org-channel-menu"
        />
      )}
    </aside>
  );
}
