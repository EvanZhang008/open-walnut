/**
 * Settings > Remote Hosts > Overview: the fleet as a dashboard, the page's first part and open by
 * default (2026-11-11, the user asked for the dashboard of 2026-11-03 back after the 11-07 list
 * replaced it). From the top: a strip of four numbers (hosts online, sessions open, 30 day spend,
 * hosts that need a look), a diagram of how this Mac reaches each host (HostFleetTopology.tsx),
 * one card per live host (HostFleetCard.tsx), then the hosts Walnut is not connected to, one
 * compact row each with Connect. The Hosts list under it is where a host is added, edited and
 * removed.
 *
 * Its numbers and its diagram are what the rows of the list say (host-list-store.ts), the
 * header's "need a look" count included, so the Overview never disagrees with the list; a host
 * switched off in the list is left out of it. The cards read the page's one fleet read
 * (useHostFleet.ts): what each host answered last, at once, read again only on a press (opening
 * the Overview, Refresh, a card's Details).
 */
import { useCallback } from 'react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { flashOnce, focusLanded } from '@/utils/focus-landed';
import { SettingsButton } from '../inputs/SettingsButton';
import { ChevronGlyph } from '../settings-glyphs';
import { isLive } from './host-fleet-dashboard-model';
import { usd } from './host-fleet-model';
import { readAgo } from './host-fleet-read-model';
import { listSummary } from './host-row-model';
import { useRowReports } from './host-list-store';
import { FleetNumber } from './FleetNumber';
import { HostFleetCard, HostFleetOfflineRow } from './HostFleetCard';
import { HostFleetTopology } from './HostFleetTopology';
import type { HostFleet } from './useHostFleet';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function Stat({ value, label, tone, testId, title, why }: { value: string | null; label: string; tone?: string; testId: string; title?: string; why?: string }) {
  return (
    <div className="hf-stat" data-testid={testId} data-tone={tone} title={title}>
      <FleetNumber className="hf-stat-value" value={value} unknown={value === null ? { why: why ?? 'not known yet', title: title ?? label } : null} />
      <span className="hf-stat-label">{label}</span>
    </div>
  );
}

/** `onPickRow`: a diagram node's host shown in the Hosts list, for a host with no card here (one switched off). */
export function HostFleetOverview({ fleet, onPickRow }: { fleet: HostFleet; onPickRow?: (host: string) => boolean }) {
  const [open, setOpen] = usePersistentState<boolean>('walnut-host-fleet-open', true, isBool);
  const rows = useRowReports();
  const { pending, refreshing, now, newest, error, refreshError, hosts } = fleet;

  const onToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) fleet.refresh();
  }, [open, setOpen, fleet]);

  // A diagram node picks its card (or its Not connected row), flashed and focused with its ring
  // (a mouse press turns :focus-visible off, so a plain focus showed nothing); a host the Overview
  // leaves out (switched off) has only its row in the list.
  const onPick = useCallback((host: string) => {
    const el = document.getElementById(`hf-card-${host}`);
    if (!el) { onPickRow?.(host); return; }
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    flashOnce(el);
    focusLanded(el);
  }, [onPickRow]);

  const counted = rows.filter((r) => r.counted);
  const offHere = new Set(counted.filter((r) => r.off).map((r) => r.host));
  const shown = fleet.shown.filter((h) => !offHere.has(h.host));
  const live = shown.filter(isLive);
  const away = shown.filter((h) => !isLive(h));
  const sum = counted.length ? listSummary(rows) : null;
  const reachable = sum ? sum.online + sum.down : 0;

  return (
    <section className="hf-dash" data-testid="host-fleet" data-open={open ? 'true' : 'false'} aria-labelledby="hf-dash-title">
      <div className="hf-dash-head">
        <h4 className="hf-dash-title" id="hf-dash-title">
          <button type="button" className="hf-dash-toggle" aria-expanded={open} onClick={onToggle} data-testid="host-fleet-toggle">
            <ChevronGlyph size={12} className="settings-disclosure-chevron" />
            Overview
          </button>
        </h4>
        <span className="hf-dash-read">
          {newest !== null && !refreshing && <span className="hf-dash-updated" data-testid="host-fleet-read" title={new Date(newest).toLocaleString()}>Read {readAgo(newest, now)}</span>}
          <SettingsButton
            variant="text"
            holdFocus
            busy={refreshing}
            busyLabel="Refreshing..."
            className="hf-dash-refresh"
            onClick={() => fleet.refresh()}
            data-testid="host-fleet-refresh"
            aria-label={refreshing ? 'Refreshing every host' : 'Read every host again'}
          >
            Refresh
          </SettingsButton>
        </span>
      </div>
      {open && (
        <>
          {error && <p className="hf-error" role="status">Could not read the hosts: {error}.{hosts ? ' Showing what was read last.' : ''}</p>}
          {refreshError && <p className="hf-error" role="status" data-testid="host-fleet-refresh-error">Could not read the hosts again: {refreshError}.{newest !== null ? ` Showing what was read ${readAgo(newest, now)}.` : ''}</p>}
          {!sum && !error && <p className="hf-loading" data-testid="host-fleet-reading">{hosts && pending > 0 ? 'Reading each host...' : hosts ? 'No host read yet.' : 'Reading the hosts...'}</p>}
          {sum && (
            <>
              <div className="hf-stats" data-testid="host-fleet-summary">
                <Stat testId="host-fleet-stat-online" value={`${sum.online}/${reachable}`} label="Hosts online" tone={sum.down ? 'warn' : 'good'} />
                <Stat testId="host-fleet-stat-sessions" value={sum.sessions === null ? null : String(sum.sessions)} label="Sessions open" why={sum.online ? 'no host counted yet' : 'no host connected'} />
                <Stat testId="host-fleet-stat-spend" value={sum.spendUsd === null ? null : usd(sum.spendUsd)} label="Spend, 30 days" title="At list price, not a bill" why="not counted yet" />
                <Stat testId="host-fleet-stat-problems" value={sum.needs ? String(sum.needs) : 'None'} label={sum.needs === 1 ? 'Host needs a look' : 'Hosts need a look'} tone={sum.needs ? 'warn' : 'good'} title="Hosts whose row in the list says Needs a look" />
              </div>
              {counted.length > 1 && (
                <div className="hf-panel hf-topo-panel">
                  <HostFleetTopology rows={rows} onPick={onPick} />
                </div>
              )}
              {pending > 0 && <p className="hf-loading hf-loading-more" data-testid="host-fleet-reading">Reading {pending === 1 ? '1 more host' : `${pending} more hosts`}...</p>}
              <div className="hf-grid">
                {live.map((h) => <HostFleetCard key={h.host} host={h} now={now} action={fleet.boot[h.host]} onBootStart={fleet.bootStart} onDetails={(host) => fleet.refresh([host])} />)}
              </div>
              {away.length > 0 && (
                <div className="hf-panel hf-off-list" data-testid="host-fleet-offline-list">
                  <p className="hf-off-head">Not connected ({away.length})</p>
                  {away.map((h) => <HostFleetOfflineRow key={h.host} host={h} now={now} onDetails={(host) => fleet.refresh([host])} />)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
