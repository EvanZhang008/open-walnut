/**
 * Page use: where the user goes in Walnut and what he never opens (2026-10-31, the user:
 * panes nobody opened in a year should not be kept). Counts come from this machine only
 * (api/page-visits.ts, src/core/page-visits.ts); the list of what exists comes from the
 * same sources the nav and the sidebar draw, so a page nobody opened shows as such.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clearVisits, fetchVisits, type VisitStore } from '@/api/page-visits';
import { knownPlaces, type PaneName } from './page-use-model';
import { useAppCatalog } from '@/apps/hooks';
import { SettingsGroup, SettingsNotice, SettingsLoadingRow, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SectionCard } from '../inputs/SectionCard';
import { usePluginUi } from '@/plugins/hooks';
import '@/styles/settings-sections-addons.css';
import '@/styles/page-use.css';

export const PAGE_USE_BLURB = 'How often you open each page and Settings pane on this Mac. Only counts and dates are kept, never what was on the page, and nothing leaves this machine.';

const DAY_MS = 86_400_000;

function relative(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function lastDays(days: Record<string, number>, n: number, now: number): number {
  const cutoff = new Date(now - n * DAY_MS).toISOString().slice(0, 10);
  return Object.entries(days).reduce((sum, [d, c]) => (d >= cutoff ? sum + c : sum), 0);
}

export function PageUseSection({ corePanes }: { corePanes: ReadonlyArray<PaneName> }) {
  const apps = useAppCatalog();
  const pluginUi = usePluginUi();
  const [armed, setArmed] = useState(false);
  const [store, setStore] = useState<VisitStore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setStore(await fetchVisits()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const places = useMemo(() => knownPlaces(apps.all, [
    ...corePanes,
    ...pluginUi.settings.map((entry) => ({ id: entry.key, label: entry.value.label })),
  ]), [apps.all, corePanes, pluginUi.settings]);
  const now = Date.now();
  const opened = useMemo(() => {
    if (!store) return [];
    const labelOf = new Map(places.map((p) => [p.key, p]));
    return Object.entries(store.keys)
      .map(([key, e]) => ({ key, entry: e, place: labelOf.get(key) }))
      .sort((a, b) => b.entry.count - a.entry.count || b.entry.lastAt.localeCompare(a.entry.lastAt));
  }, [store, places]);
  const never = useMemo(() => (store ? places.filter((p) => !store.keys[p.key]) : []), [store, places]);

  // Two presses, not a confirm dialog (the Mac app's web view shows none).
  const reset = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    await clearVisits().catch(() => {});
    await load();
  };

  const actions = (
    <SettingsButton onClick={() => void load()} busy={loading} busyLabel="Refreshing...">Refresh</SettingsButton>
  );

  return (
    <SectionCard id="page-use" title="Page Use" description={PAGE_USE_BLURB} actions={actions}>
      <div className="settings-addons-contents page-use" data-testid="page-use">
        {loading && !store && <SettingsLoadingRow>Reading the counts...</SettingsLoadingRow>}
        {error && <SettingsNotice kind="error" role="alert">{`Couldn't read it: ${error}`}</SettingsNotice>}
        {store && (
          <SettingsGroup
            heading="Opened"
            footer={`Counting since ${new Date(store.since).toLocaleDateString()}.`}
          >
            {opened.length === 0 && <SettingsRow label="Nothing counted yet." help="Open a page and it shows here within a few seconds." />}
            {opened.length > 0 && (
              <div className="settings-row settings-row-stacked" data-wide="true">
                <table className="page-use-table" data-testid="page-use-opened">
                  <thead>
                    <tr><th>Page</th><th>Where</th><th>Visits</th><th>Last 30 days</th><th>Last opened</th></tr>
                  </thead>
                  <tbody>
                    {opened.map(({ key, entry, place }) => (
                      <tr key={key} data-key={key}>
                        <td>{place?.label ?? key}</td>
                        <td>{place?.where ?? (key.startsWith('settings:') ? 'Settings' : 'Page')}</td>
                        <td>{entry.count}</td>
                        <td>{lastDays(entry.days, 30, now)}</td>
                        <td>{relative(entry.lastAt, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsGroup>
        )}
        {store && (
          <SettingsGroup heading={`Never opened (${never.length})`}>
            {never.length === 0
              ? <SettingsRow label="You have opened every page." />
              : (
                <div className="settings-row settings-row-stacked" data-wide="true">
                  <ul className="page-use-never" data-testid="page-use-never">
                    {never.map((p) => <li key={p.key} data-key={p.key}><span>{p.label}</span> <span className="page-use-where">{p.where}</span></li>)}
                  </ul>
                </div>
              )}
          </SettingsGroup>
        )}
        {store && (
          <SettingsGroup>
            <SettingsRow label="Clear the counts" help="Starts counting again from now." control={<SettingsButton onClick={() => void reset()}>{armed ? 'Press again to clear' : 'Clear'}</SettingsButton>} />
          </SettingsGroup>
        )}
      </div>
    </SectionCard>
  );
}
