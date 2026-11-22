/**
 * The Org page's left column, like a chat app's channel list: Main pinned on top,
 * then one row per project (org-channels-model.ts orders them). A row says who it
 * is, its state dot, when its work last moved, one line of what is happening and,
 * when something waits on the user, how many. Up and Down move the selection. While the
 * pointer is over the list the rows keep their order, so a click lands on the row aimed at.
 * After the VPs, the Routers (OrgRouterSection): router nodes, which are neither VPs nor tasks under one
 * (2026-11-10, the person: "router should be placed below all VPs"); then, with the `topics`
 * experiment on, the open topics (OrgTopicsSection), which Up and Down reach too.
 * A project another VP took over has no row of its own: it sits in "Archived" at
 * the bottom (folded), saying which VP has it now; a click opens that VP. A right-click on any
 * row opens Walnut's own menu of what that row can do (the page builds it: OrgPage rowMenu).
 * Under a row, the tasks the user keeps in view of its work (2026-10-31, the user, translated: "under a
 * chat ... however many you pin, they all show in there ... you can unpin there too ... they are all its
 * children", then 2026-11-02: "rename this to watching ... same wathcing as regular home pannel" and "if
 * a taks is lock also show here, show icon of watch or lock"): the watched ones (Home's Watching,
 * org-pins.ts) and the ones whose session panel is locked, one short line each, a little indented, an
 * eye or a lock (or both) saying why, then its own state's dot; a click opens it on Home, ×
 * stops watching it.
 * Then, with the `org_leaders` experiment on, the Directors under a VP (OrgLeaders): one folded "N directors"
 * line; a watched Director keeps its row above as well. With the "sections" layout (Settings → Org) they
 * are one DIRECTORS section after the VPs instead (OrgDirectorSection).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { threadCountLabel } from '@open-walnut/thread-view';
import { ThreadPinIcon } from '@/components/sessions/ThreadIcons';
import '@/styles/org-rail.css';
import { readOrgPlace, writeOrgPlace } from './org-place';
import { timeAgo } from '@/utils/time';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { askCount, type ChannelRow, type ChannelState, type MovedRow, shownName } from './org-channels-model';
import { usePointerHold } from './hold-order';
import { useOpenTask } from '@/hooks/useOpenTask';
import { OrgEditableName } from './OrgEditableName';
import { NodeAvatar, OrgAvatar } from './OrgAvatar';
import { OrgRouterSection } from './OrgRouterSection';
import { OrgTopicsSection, useOrgTopicRows } from '@/components/topics/OrgTopicsSection';
import { topicKey } from '@/components/topics/topic-model';
import { OrgReorgReminder } from './OrgReorgReminder';
import { OrgSettingsMenu } from './OrgSettingsMenu';
import { useOrgSettings } from './useOrgSettings';
import { USER_STATE_LABELS, stateCountLabel } from '@open-walnut/user-status';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { TAB_DOT, stateTab, type KeptTask } from './org-task-tabs';
import { KeptWhy } from './OrgKeptWhy';
import { MicInput } from '@/components/common/BoxMic';
import { OrgLeaders } from './OrgLeaders';
import { OrgDirectorSection } from './OrgDirectorSection';
import type { OrgDirectorsView } from './useOrgLeaders';

const STATE_LABEL: Record<ChannelState, string> = {
  alert: 'Needs you', working: 'Working', quiet: 'Waiting', parked: 'Waiting',
};

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
  // The CEO's and a VP's own row: its threads his view shows, red, else "0" in grey (2026-11-03, the
  // user: "the little red should be thread instead of need u ... even if no thread, show 0 thread").
  // Any other row: what opening it lets the user answer.
  // Asks only: a card with only something to read is no ask (isAsk).
  const own = askCount(row.alerts);
  const badge = row.threadsBadge !== undefined
    ? <span className={`org-badge ${row.threadsBadge ? 'is-alert' : 'is-none'}`} data-testid="org-channel-badge" data-threads={row.threadsBadge} title={threadCountLabel(row.threadsBadge)}>{row.threadsBadge}</span>
    : own > 0
    ? <span className="org-badge is-alert" data-testid="org-channel-badge" title={stateCountLabel('needs', own)}>{own}</span>
    : row.kind === 'project' && row.counts.running > 0
      ? <span className="org-badge is-working" data-testid="org-channel-badge" title={stateCountLabel('working', row.counts.running)}>{row.counts.running}</span>
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
      title={`${shownName(row)}: ${STATE_LABEL[row.state]}${row.lastAt ? `, moved ${timeAgo(new Date(row.lastAt).toISOString(), { now })}` : ''}`}
      onClick={() => onSelect(row.key)}
      onContextMenu={onMenu ? (e) => onMenu(e, { row }) : undefined}
    >
      <OrgAvatar row={row} />
      <span className="org-channel-mid">
        <span className="org-channel-top">
          {/* A VP the user named goes by that name, as on the org chart. */}
          <span className="org-channel-name wn-title">{shownName(row)}</span>
          {/* +N, the time and the count: one group on the name's first line, under it when narrow. */}
          <span className="org-channel-tail wn-fixed">
            {!!row.led?.length && (
              <span className="org-channel-led" data-testid="org-channel-led" title={`Also leads ${row.led.map((l) => l.name).join(', ')}`}>+{row.led.length}</span>
            )}
            {/* The time of the line under it (when that news was written), else of the last move. */}
            <span className="org-channel-time">{shortAgo(row.latestAt || row.lastAt, now)}</span>
            {badge}
          </span>
        </span>
        <span className={`org-channel-latest wn-title${row.state === 'alert' ? ' is-alert' : ''}`} data-testid="org-channel-latest" title={row.latestTask ? `${row.latestTask}: ${row.latest}` : row.latest}>
          {/* A pinned thread named on the line wears the Threads card's pin. */}
          {row.latestPinned && <ThreadPinIcon size={11} className="org-channel-pin" />}{row.latest}
        </span>
      </span>
    </button>
  );
}

/** The tasks kept in view under one row (keptByRow), as its own children. Inside the list's listbox each
 *  is an option of a group (all a listbox may hold): Enter opens it (useOpenTask: beside the page); on a watched one Delete stops
 *  watching it, and the × is the pointer's way to the same. A task only locked goes once its panel is
 *  unlocked at the panel; unlocked with its lock here, it stays to be locked again (OrgKeptWhy). */
function KeptChildren({ row, kept, open, onUnwatch, onToggleLock }: { row: ChannelRow; kept: readonly KeptTask[]; open?: ReadonlySet<string>; onUnwatch: (taskId: string) => void; onToggleLock?: (taskId: string) => void }) {
  const openTask = useOpenTask();
  if (!kept.length) return null;
  return (
    <div className="org-watched" role="group" aria-label={`Kept in view, under ${shownName(row)}`} data-testid="org-watched" data-key={row.key}>
      {kept.map(({ task: t, watched, locked, relock }) => {
        const st = stateTab(t);
        const title = orgDisplayTitle(t);
        const why = [watched && 'watched', locked && 'locked'].filter(Boolean).join(' and ');
        return (
          <div key={t.id} className="org-watched-item" role="presentation" data-testid="org-watched-item" data-peek-row="" data-task-id={t.id} data-state={st} data-watched={watched || undefined} data-locked={locked || undefined} data-relock={relock || undefined} data-open={open?.has(t.id) || undefined}>
            <KeptWhy watched={watched} locked={locked} relock={!!relock} {...(onToggleLock ? { onToggleLock: () => onToggleLock(t.id) } : {})} />
            <button
              type="button"
              role="option"
              aria-selected={false}
              aria-current={open?.has(t.id) || undefined}
              aria-label={`${title}: ${USER_STATE_LABELS[st]}, ${why}${watched ? '. Delete stops watching it' : ''}`}
              aria-keyshortcuts={watched ? 'Delete' : undefined}
              className="org-watched-open"
              data-testid="org-watched-open"
              title={`${title}: ${USER_STATE_LABELS[st]}`}
              onClick={() => openTask(t.id)}
              onKeyDown={(e) => { if (watched && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); onUnwatch(t.id); } }}
            >
              <i style={{ background: TAB_DOT[st] }} aria-hidden="true" />
              <span className="org-watched-title wn-title">{title}</span>
            </button>
            {watched && <button type="button" className="org-watched-stop" data-testid="org-watched-stop" aria-hidden="true" tabIndex={-1} title="Stop watching" onClick={() => onUnwatch(t.id)}>×</button>}
          </div>
        );
      })}
    </div>
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
          <NodeAvatar taskId={undefined} name={m.project} size={26} className="is-moved" />
          <span className="org-channel-mid">
            <span className="org-channel-name wn-title">{m.project}</span>
            <span className="org-channel-latest wn-title" data-testid="org-moved-line">
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
  /** The tasks kept in view under a row (keptByRow: watched or locked), shown under it. */
  keptOf?: (row: ChannelRow) => readonly KeptTask[];
  /** The tasks open beside the page: their rows wear a light tint. */
  openTaskIds?: ReadonlySet<string>;
  onUnwatch?: (taskId: string) => void;
  /** A kept row's lock: unlock its session panel, or lock it again (useKeptLockToggle). */
  onToggleLock?: (taskId: string) => void;
  /** The Directors under a VP's row (org-leaders.ts) and its projects; absent while the experiment is off. */
  directors?: OrgDirectorsView;
  now: number;
}

export function OrgChannelList({ main, rows, routers = [], moved = [], rowMenu, total, vps, selectedKey, query, onQuery, onSelect, onOpenChart, onNewRouter, keptOf, openTaskIds, onUnwatch, onToggleLock, directors, now }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const orgName = useOrgSettings();
  const sections = orgName.settings.directorsLayout === 'sections';
  const showProjects = orgName.settings.directorsShowProjects !== false;
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
  const keptUnder = (r: ChannelRow) => (keptOf && onUnwatch
    ? <KeptChildren row={r} kept={keptOf(r)} open={openTaskIds} onUnwatch={onUnwatch} {...(onToggleLock ? { onToggleLock } : {})} />
    : null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    // Up and Down move between the chats; on a task kept under a row they are left alone.
    if ((e.target as HTMLElement).closest('.org-watched')) return;
    e.preventDefault();
    // Among the leaders, Up and Down walk every option in the order drawn, so they lead out again.
    if ((e.target as HTMLElement).closest('.org-leaders, .org-directors')) {
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
      <header className="org-list-head">
        <h1 className="org-list-title">
          <OrgEditableName value={orgName.settings.name} label="the org" onSave={(v) => orgName.save({ name: v })} testId="org-name" />
        </h1>
        <span className="org-list-actions">
          {/* Outside the listbox (which holds only options), so Up and Down never stop on it. */}
          {onNewRouter && <button type="button" className="btn btn-sm" data-testid="org-new-router" onClick={onNewRouter} title="A router sits beside the VPs; it starts paused">New router</button>}
          <button type="button" className="btn btn-sm" data-testid="org-open-chart" onClick={onOpenChart} title="The CEO and every project's VP on one sheet; drag a project onto another VP to put it under that VP">Org chart</button>
          <OrgSettingsMenu />
        </span>
      </header>
      <MicInput data-no-draft="search"
        className="org-search"
        fieldClassName="org-search-field"
        type="search"
        value={query}
        placeholder="Search VPs and routers…"
        aria-label="Search VPs and routers"
        data-testid="org-search"
        setText={onQuery}
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
        {keptUnder(main)}
        <div className="org-list-section" role="presentation" data-testid="org-vps-head">VPs · {vps}</div>
        {shown.map((r) => (
          <div key={r.key} className="org-channel-wrap" role="presentation">
            <Row row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} onMenu={onMenu} />
            {keptUnder(r)}
            {directors && !sections && (
              <OrgLeaders groups={directors.groupsOf(r)} projects={directors.projectsOf(r)} showProjects={showProjects} surface="list" vpKey={r.key} vpName={shownName(r)} query={query} {...(openTaskIds ? { openTaskIds } : {})} />
            )}
          </div>
        ))}
        {directors && sections && <OrgDirectorSection vps={shown} groupsOf={directors.groupsOf} projectsOf={directors.projectsOf} query={query} openTaskIds={openTaskIds} />}
        {/* Routers sit below every VP (2026-11-10, the person), above the folded Archived. */}
        <OrgRouterSection rows={routers} selectedKey={selectedKey} now={now} onSelect={onSelect} onMenu={onMenu} />
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
