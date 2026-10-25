/**
 * The Org page's left column, like a chat app's channel list: Main pinned on top,
 * then one row per project (org-channels-model.ts orders them). A row says who it
 * is, its state dot, when its work last moved, one line of what is happening and,
 * when something waits on the user, how many. Up and Down move the selection.
 */
import { useRef, type KeyboardEvent } from 'react';
import { timeAgo } from '@/utils/time';
import { avatarColor, initials, type ChannelRow, type ChannelState } from './org-channels-model';

const STATE_LABEL: Record<ChannelState, string> = {
  alert: 'Needs you', working: 'Working', quiet: 'Quiet', parked: 'Parked',
};

export function OrgAvatar({ row, size = 34 }: { row: ChannelRow; size?: number }) {
  const main = row.kind === 'main';
  return (
    <span
      className={`org-avatar${main ? ' is-main' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37), ...(main ? {} : { background: avatarColor(row.name) }) }}
      aria-hidden="true"
    >
      {main ? 'M' : initials(row.name)}
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

function Row({ row, selected, now, onSelect }: { row: ChannelRow; selected: boolean; now: number; onSelect: (key: string) => void }) {
  const badge = row.alerts.length > 0
    ? <span className="org-badge is-alert" data-testid="org-channel-badge">{row.alerts.length}</span>
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
      title={`${row.name}: ${STATE_LABEL[row.state]}${row.lastAt ? `, moved ${timeAgo(new Date(row.lastAt).toISOString(), { now })}` : ''}`}
      onClick={() => onSelect(row.key)}
    >
      <OrgAvatar row={row} />
      <span className="org-channel-mid">
        <span className="org-channel-top">
          <span className="org-channel-name">{row.name}</span>
          <span className="org-channel-time">{shortAgo(row.lastAt, now)}</span>
        </span>
        <span className={`org-channel-latest${row.state === 'alert' ? ' is-alert' : ''}`} data-testid="org-channel-latest">{row.latest}</span>
      </span>
      {badge}
    </button>
  );
}

interface Props {
  main: ChannelRow;
  rows: readonly ChannelRow[];
  total: number;
  selectedKey: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (key: string) => void;
  onOpenChart: () => void;
  now: number;
}

export function OrgChannelList({ main, rows, total, selectedKey, query, onQuery, onSelect, onOpenChart, now }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const keys = [main.key, ...rows.map((r) => r.key)];
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
    <aside className="org-list" aria-label="Org">
      <header className="org-list-head">
        <h1 className="org-list-title">Org</h1>
        <button type="button" className="btn btn-sm" data-testid="org-open-chart" onClick={onOpenChart} title="Every project and its tasks on one sheet; drag a task to move it">Org chart</button>
      </header>
      <input
        className="org-search"
        type="search"
        value={query}
        placeholder="Search leads…"
        aria-label="Search leads"
        data-testid="org-search"
        onChange={(e) => onQuery(e.target.value)}
      />
      <div ref={listRef} className="org-list-scroll" role="listbox" aria-label="Main and the project leads" onKeyDown={onKeyDown}>
        <Row row={main} selected={selectedKey === main.key} now={now} onSelect={onSelect} />
        <div className="org-list-section" role="presentation">Leads · {total}</div>
        {rows.map((r) => <Row key={r.key} row={r} selected={selectedKey === r.key} now={now} onSelect={onSelect} />)}
      </div>
      {total === 0 && <p className="org-empty-note" data-testid="org-empty">No open work yet. Ask Main to start something.</p>}
      {total > 0 && rows.length === 0 && <p className="org-empty-note" data-testid="org-no-match">No lead matches “{query}”.</p>}
    </aside>
  );
}
