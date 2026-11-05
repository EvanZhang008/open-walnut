/**
 * Settings > Remote Hosts: the one line under the header, for the whole fleet: "6 hosts: 2 online,
 * 2 not connected, 1 off, 1 found in ~/.ssh/config, 4 sessions open, $241 in 30 days", then when
 * the hosts were read and Refresh. The counts are what the rows of the list say
 * (host-list-store.ts), every row in one of them, so they add up to the rows shown (2026-11-05
 * review: "2 of 4 online, 1 off" sat above 6 rows), and the line moves at once when a host is
 * turned on or off, added or removed (2026-11-04 review). The "need a look" count is the header's (HostNeedsLook.tsx). While a read runs, Refresh
 * stays where it is as the page's one "Refreshing...", and keeps the focus.
 */
import { SettingsButton } from '../inputs/SettingsButton';
import { readAgo } from './host-fleet-read-model';
import { listSummary, summaryWords } from './host-row-model';
import { useRowReports } from './host-list-store';
import type { HostFleet } from './useHostFleet';

const Sep = () => <span className="rh-summary-sep">{', '}</span>;

export function HostSummaryLine({ fleet }: { fleet: HostFleet }) {
  const { pending, refreshing, now, newest, error, refreshError, hosts } = fleet;
  const rows = useRowReports();
  const words = rows.some((r) => r.counted || r.found) ? summaryWords(listSummary(rows)) : null;
  return (
    <div className="rh-summary" data-testid="rh-summary">
      <p className="rh-summary-line">
        {words ? (
          // One item for the counts (their text wraps inside it), one for Read and Refresh: on a
          // narrow window Refresh follows them, or starts the next line at the left edge.
          <span className="rh-summary-counts">
            <span data-testid="rh-summary-hosts" className="rh-summary-hosts">{words.hosts}</span>
            <span className="rh-summary-sep">{': '}</span>
            <span data-testid="rh-summary-online">{words.online}</span>
            {words.down && <><Sep /><span data-testid="rh-summary-down">{words.down}</span></>}
            {words.off && <><Sep /><span data-testid="rh-summary-off">{words.off}</span></>}
            {words.found && <><Sep /><span data-testid="rh-summary-found">{words.found}</span></>}
            {words.sessions && <><Sep /><span data-testid="rh-summary-sessions">{words.sessions}</span></>}
            {words.spend && <><Sep /><span data-testid="rh-summary-spend" title="At list price, not a bill">{words.spend}</span></>}
          </span>
        ) : (
          <span className="rh-summary-muted" data-testid="host-fleet-reading">{hosts && pending > 0 ? 'Reading each host...' : hosts ? 'No host read yet.' : 'Reading the hosts...'}</span>
        )}
        <span className="rh-summary-read">
          {newest !== null && !refreshing && <span data-testid="host-fleet-read" title={new Date(newest).toLocaleString()}>Read {readAgo(newest, now)}</span>}
          <SettingsButton
            variant="text"
            holdFocus
            busy={refreshing}
            busyLabel="Refreshing..."
            className="rh-summary-refresh"
            onClick={() => fleet.refresh()}
            data-testid="host-fleet-refresh"
            aria-label={refreshing ? 'Refreshing every host' : 'Read every host again'}
          >
            Refresh
          </SettingsButton>
        </span>
      </p>
      {words && pending > 0 && <p className="rh-summary-note" data-testid="host-fleet-reading">Reading {pending === 1 ? '1 more host' : `${pending} more hosts`}...</p>}
      {error && <p className="rh-summary-note" data-tone="bad" role="status">Could not read the hosts: {error}.{hosts ? ' Showing what was read last.' : ''}</p>}
      {refreshError && (
        <p className="rh-summary-note" data-tone="bad" role="status" data-testid="host-fleet-refresh-error">
          Could not read the hosts again: {refreshError}.{newest !== null ? ` Showing what was read ${readAgo(newest, now)}.` : ''}
        </p>
      )}
    </div>
  );
}
