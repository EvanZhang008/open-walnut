/**
 * Settings > Remote Hosts: the one line under the header, for the whole fleet (useHostFleet.ts):
 * "2 of 3 online, 4 sessions open, $362 in 30 days, 2 need a look", then when the hosts were
 * read and Refresh. "need a look" takes you to the first such row of the list. While a read
 * runs this line is the page's one "Refreshing..." (2026-11-04 review: it showed four times at
 * once, on every card and row).
 */
import { fleetSummary } from './host-fleet-dashboard-model';
import { readAgo } from './host-fleet-read-model';
import { summaryWords } from './host-row-model';
import type { HostFleet } from './useHostFleet';

const Sep = () => <span className="rh-summary-sep">{', '}</span>;

export function HostSummaryLine({ fleet, onNeedsLook }: { fleet: HostFleet; onNeedsLook: () => void }) {
  const { shown, pending, refreshing, now, newest, error, refreshError, hosts } = fleet;
  const words = shown.length ? summaryWords(fleetSummary(shown, now)) : null;
  return (
    <div className="rh-summary" data-testid="rh-summary">
      <p className="rh-summary-line">
        {words ? (
          <>
            <span data-testid="rh-summary-online">{words.online}</span>
            {words.sessions && <><Sep /><span data-testid="rh-summary-sessions">{words.sessions}</span></>}
            {words.spend && <><Sep /><span data-testid="rh-summary-spend" title="At list price, not a bill">{words.spend}</span></>}
            {words.needs && (
              <>
                <Sep />
                <button type="button" tabIndex={0} className="rh-summary-needs" data-testid="rh-summary-needs" onClick={onNeedsLook} title="Go to the first host that needs a look">
                  {words.needs}
                </button>
              </>
            )}
          </>
        ) : (
          <span className="rh-summary-muted" data-testid="host-fleet-reading">{hosts && pending > 0 ? 'Reading each host...' : hosts ? 'No host read yet.' : 'Reading the hosts...'}</span>
        )}
        <span className="rh-summary-read">
          {refreshing ? (
            <span role="status" data-testid="host-fleet-refreshing">Refreshing...</span>
          ) : (
            <>
              {newest !== null && <span data-testid="host-fleet-read" title={new Date(newest).toLocaleString()}>Read {readAgo(newest, now)}</span>}
              <button type="button" tabIndex={0} className="rh-summary-refresh" onClick={() => fleet.refresh()} data-testid="host-fleet-refresh" aria-label="Read every host again">Refresh</button>
            </>
          )}
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
