/**
 * The Org page's left column, like a chat app's channel list: Main pinned on top,
 * then one row per project (org-channels-model.ts orders them). A row says who it
 * is, its state dot, when its work last moved, one line of what is happening and,
 * when something waits on the user, how many. Up and Down move the selection. While the
 * pointer is over the list the rows keep their order, so a click lands on the row aimed at.
 * A project another VP took over has no row of its own: it sits in "Archived" at
 * the bottom (folded), saying which VP has it now; a click opens that VP. A right-click on any
 * row opens Walnut's own menu of what that row can do (the page builds it: OrgPage rowMenu).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { readOrgPlace, writeOrgPlace } from './org-place';
import { timeAgo } from '@/utils/time';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { avatarColor, initials, type ChannelRow, type ChannelState, type MovedRow } from './org-channels-model';
import { holdOrder } from './hold-order';
import { OrgEditableName } from './OrgEditableName';
import { useOrgSettings } from './useOrgSettings';

const STATE_LABEL: Record<ChannelState, string> = {
  alert: 'Needs you', working: 'Working', quiet: 'Waiting', parked: 'Waiting',
};

export function OrgAvatar({ row, size = 34 }: { row: ChannelRow; size?: number }) {
  const main = row.kind === 'main';
  return (
    <span
      className={`org-avatar${main ? ' is-main' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37), ...(main ? {} : { background: avatarColor(row.name) }) }}
      aria-hidden="true"
    >
      {main ? 'C' : initials(row.name)}
      <span className={`org-state-dot org-state-${row.state}`} />
    </span>
  );
}

/** "5m", "3h", "2d": the list's short clock. */
export function shortAgo(ms: number, now: number): string {
  if (!ms) return '';
  const mins = Math.max(0, Math.floor((now - ms) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** What a right-click is on: a row of the list, or a project under "Archived". */
export type ChannelMenuTarget = { row: ChannelRow } | { moved: MovedRow };
type OnMenu = (e: MouseEvent, target: ChannelMenuTarget) => void;

function Row({ row, selected, now, onSelect, onMenu }: { row: ChannelRow; selected: boolean; now: number; onSelect: (key: string) => void; onMenu?: OnMenu }) {
  // What opening this row lets the user answer: on Main its own asks, not every team's again.
  const own = row.alerts.length;
  const badge = own > 0
    ? <span className="org-badge is-alert" data-testid="org-channel-badge" title={`${own} ${own === 1 ? 'needs' : 'need'} you`}>{own}</span>
    : row.kind === 'project' && row.counts.running > 0
      ? <span className="org-badge is-working" data-testid="org-channel-badge" title={`${row.counts.running} working`}>{row.counts.running}</span>
      : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`org-channel${selected ? ' is-selected' : ''}${row.kind === 'main' ? ' is-main' : ''}${row.unread ? ' is-unread' : ''}`}
      data-testid={row.kind === 'main' ? 'org-channel-main' : 'org-channel'}
      data-key={row.key}
      data-state={row.state}
      title={`${row.vpName ?? row.name}: ${STATE_LABEL[row.state]}${row.lastAt ? `, moved ${timeAgo(new Date(row.lastAt).toISOString(), { now })}` : ''}`}
      onClick={() => onSelect(row.key)}
      onContextMenu={onMenu ? (e) => onMenu(e, { row }) : undefined}
    >
      <OrgAvatar row={row} />
      <span className="org-channel-mid">
        <span className="org-channel-top">
          {/* A VP the user named goes by that name, as on the org chart. */}
          <span className="org-channel-name">{row.vpName ?? row.name}</span>
          {!!row.led?.length && (
            <span className="org-channel-led" data-testid="org-channel-led" title={`Also leads ${row.led.map((l) => l.name).join(', ')}`}>+{row.led.length}</span>
          )}
          {/* The time of the line under it (when that news was written), else of the last move. */}
          <span className="org-channel-time">{shortAgo(row.latestAt || row.lastAt, now)}</span>
        </span>
        <span className={`org-channel-latest${row.state === 'alert' ? ' is-alert' : ''}`} data-testid="org-channel-latest" title={row.latestTask ? `${row.latestTask}: ${row.latest}` : row.latest}>{row.latest}</span>
      </span>
      {badge}
    </button>
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
      <button
        type="button"
        className="org-list-section org-moved-toggle"
        aria-expanded={expanded}
        data-testid="org-moved-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="org-moved-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        Archived · {shown.length}
      </button>
      {expanded && shown.map((m) => (
        <button
          key={m.key}
          type="button"
          className="org-moved-row"
          data-testid="org-moved-row"
          data-key={m.key}
          data-vp={m.vpKey}
          title={`${m.project} is led by the ${m.vpName} VP now${m.from ? ` (before: ${m.from.title})` : ''}`}
          onClick={() => onSelect(m.vpKey)}
          onContextMenu={onMenu ? (e) => onMenu(e, { moved: m }) : undefined}
        >
          <span className="org-avatar is-moved" style={{ width: 26, height: 26, fontSize: 10, background: avatarColor(m.project) }} aria-hidden="true">{initials(m.project)}</span>
          <span className="org-channel-mid">
            <span className="org-channel-name">{m.project}</span>
            <span className="org-channel-latest" data-testid="org-moved-line">
              Moved to the {m.vpName} VP{m.from ? (m.from.open ? ' · handing over' : ' · closed') : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

interface Props {
  main: ChannelRow;
  rows: readonly ChannelRow[];
  /** Projects another VP took over (movedProjects). */
  moved?: readonly MovedRow[];
  /** What a right-click on a row offers; no menu without it. `point` is where the click landed:
   *  a picker one of its rows opens anchors there. */
  /** `origin`: the row right-clicked, for a picker the menu opens (focus goes back to it). */
  rowMenu?: (target: ChannelMenuTarget, point: { x: number; y: number }, origin: HTMLElement | null) => ContextMenuItem[];
  total: number;
  selectedKey: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (key: string) => void;
  onOpenChart: () => void;
  now: number;
}

export function OrgChannelList({ main, rows, moved = [], rowMenu, total, selectedKey, query, onQuery, onSelect, onOpenChart, now }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const orgName = useOrgSettings();
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
  const [held, setHeld] = useState<string[] | null>(null);
  const shown = holdOrder(rows, held);
  const keys = [main.key, ...shown.map((r) => r.key)];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = selectedKey ? keys.indexOf(selectedKey) : -1;
    const next = keys[Math.min(keys.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    onSelect(next);
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
  };
  return (
    <aside className="org-list" aria-label={orgName.settings.name}>
      <header className="org-list-head">
        <h1 className="org-list-title">
          <OrgEditableName value={orgName.settings.name} label="the org" onSave={(v) => orgName.save({ name: v })} testId="org-name" />
        </h1>
        <button type="button" className="btn btn-sm" data-testid="org-open-chart" onClick={onOpenChart} title="The CEO and every project's VP on one sheet; drag a project onto another VP to put it under that VP">Org chart</button>
      </header>
      <input data-no-draft="search"
        className="org-search"
        type="search"
        value={query}
        placeholder="Search VPs…"
        aria-label="Search VPs"
        data-testid="org-search"
        onChange={(e) => onQuery(e.target.value)}
      />
      <div
        ref={listRef}
        className="org-list-scroll"
        role="listbox"
        aria-label="The CEO and the VPs"
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onPointerEnter={() => setHeld(rows.map((r) => r.key))}
        onPointerLeave={() => setHeld(null)}
      >
        <Row row={main} selected={selectedKey === main.key} now={now} onSelect={onSelect} onMenu={onMenu} />
        <div className="org-list-section" role="presentation">VPs · {total}</div>
        {shown.map((r) => <Row key={r.key} row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} onMenu={onMenu} />)}
        <MovedSection moved={moved} query={query} onSelect={onSelect} onMenu={onMenu} />
      </div>
      {total === 0 && <p className="org-empty-note" data-testid="org-empty">No open work yet. Ask the CEO to start something.</p>}
      {total > 0 && rows.length === 0 && <p className="org-empty-note" data-testid="org-no-match">No VP matches “{query}”.</p>}
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
