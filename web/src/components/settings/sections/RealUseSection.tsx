/**
 * Settings > Real Use (server: src/core/usage-watch/, GET /api/v1/usage-watch): how Walnut's
 * tools, requests from the browser and the phone, and its pages behave in real use, from every
 * host, with the watches of shipped changes and the notes sent to their tasks. Read only; a
 * problem rings an alarm in Walnut Health. The tables are RealUseTables.tsx, the watches and
 * notes RealUseWatches.tsx, the words and order real-use-model.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { Link } from 'react-router-dom';
import { fetchUsageWatch, type UsageRange, type UsageWatchView } from '@/api/usage-watch';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { usePageView } from '@/utils/view-memory';
import { SettingsLoadingRow, SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SectionCard } from '../inputs/SectionCard';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { isUsageRange, recordedText, stamp, summaryOf } from './real-use-model';
import { HEALTH_PATH, PageErrorsBlock, RequestsBlock, ToolsBlock } from './RealUseTables';
import { NotesBlock, WatchesBlock } from './RealUseWatches';
import '@/styles/settings-sections-addons.css';
import '@/styles/health-monitor.css';
import '@/styles/real-use.css';
import { EmptyState } from '@/components/common/EmptyState';

const RANGE_OPTIONS: ReadonlyArray<{ value: UsageRange; label: string; testId: string }> = [
  { value: '24h', label: '24 hours', testId: 'real-use-range-24h' },
  { value: '7d', label: '7 days', testId: 'real-use-range-7d' },
];

function Summary({ view }: { view: UsageWatchView }) {
  const s = summaryOf(view.rows);
  const item = (n: number, words: string, bad = false) => (
    <span className={`ru-count${bad ? ' ru-bad' : ''}`}><b>{n.toLocaleString('en-US')}</b> {words}</span>
  );
  const recorded = recordedText(view.recorded);
  return (
    <>
      <p className="ru-summary" data-testid="real-use-summary">
        {item(s.toolCalls, s.toolCalls === 1 ? 'tool call' : 'tool calls')}
        {item(s.realErrors, s.realErrors === 1 ? 'real error' : 'real errors')}
        {item(s.cuts, s.cuts === 1 ? 'confirmed cut' : 'confirmed cuts')}
        {item(s.overBudget, 'over budget')}
        {item(s.slowReads, s.slowReads === 1 ? 'slow read' : 'slow reads')}
        {item(s.pageErrors, s.pageErrors === 1 ? 'page error' : 'page errors')}
        {item(s.alarms, s.alarms === 1 ? 'alarm' : 'alarms', s.alarms > 0)}
      </p>
      <p className="ru-meta">
        All hosts (every session's MCP tools and walnut CLI reach this Walnut) · {stamp(view.from)} to {stamp(Math.min(view.to, view.now))}
        {recorded && ` · ${recorded}`}
      </p>
    </>
  );
}

function Body({ view }: { view: UsageWatchView }) {
  const now = view.now;
  return (
    <>
      {!view.alarmsOn && (
        <SettingsNotice kind="info">
          Recording only: alarms, notes to tasks and the completion check are off. Turn on Real-use watch in{' '}
          <Link className="settings-addons-link" to="/settings#experimental" data-testid="real-use-open-experimental">Settings › Experimental</Link>.
        </SettingsNotice>
      )}
      <Summary view={view} />
      {view.rows.length > 0 && view.recorded < 0.9 && (
        <SettingsNotice kind="info">
          {`Walnut was not recording for ${100 - Math.floor(view.recorded * 100)}% of this time (the server was not running), so the numbers are low, and watches covering those hours read Unknown.`}
        </SettingsNotice>
      )}
      {view.rows.length === 0 ? (
        <EmptyState
          testId="real-use-empty"
          title="No real use recorded yet"
          hint="Walnut records every tool call, request and page error from now on; the first hour shows when it ends."
        />
      ) : (
        <>
          <ToolsBlock rows={view.rows} range={view.range} now={now} />
          <RequestsBlock rows={view.rows} range={view.range} now={now} />
          <PageErrorsBlock rows={view.rows} range={view.range} now={now} />
        </>
      )}
      <WatchesBlock watches={view.watches} now={now} />
      <NotesBlock notes={view.notes} now={now} watches={view.watches} alarmsOn={view.alarmsOn} />
    </>
  );
}

export function RealUseSection() {
  const [range, setRange] = usePageView<UsageRange>('settings', 'real-use.range', '7d', isUsageRange);
  const [view, setView] = useState<UsageWatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest read lands: a range switched mid-read never shows the old range's answer.
  const seq = useRef(0);

  const load = useLeanCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await fetchUsageWatch(range);
      if (mine !== seq.current) return;
      setView(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      const message = err instanceof Error ? err.message : String(err);
      log.warn('real-use', 'read failed', { range, error: message });
      setError(message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);
  // A row's state is its Walnut Health alarm: read again when one changes.
  useEvent('health-monitor:changed', () => { void load(); });

  const actions = (
    <>
      <SegmentedControl<UsageRange> value={range} options={RANGE_OPTIONS} onChange={setRange} aria-label="Range" />
      <SettingsButton onClick={() => void load()} busy={loading} busyLabel="Refreshing..." data-testid="real-use-refresh">Refresh</SettingsButton>
    </>
  );

  return (
    <SectionCard id="real-use" title="Real Use" actions={actions}>
      <div className="real-use" data-testid="real-use" data-range={range}>
        <p className="ru-note">
          Only names, sizes, times and error codes are kept, never what was sent or answered. A problem rings an alarm in{' '}
          <Link className="settings-addons-link" to={HEALTH_PATH} data-testid="real-use-open-health">Walnut Health</Link>, which tells the task that shipped the change.
        </p>
        {loading && !view && !error && <SettingsLoadingRow>Reading real use...</SettingsLoadingRow>}
        {error && (
          <SettingsNotice kind="error" role="alert" action={<SettingsButton onClick={() => void load()} busy={loading}>Try again</SettingsButton>}>
            {view ? `Could not refresh Real Use: ${error}` : `Could not load Real Use: ${error}`}
          </SettingsNotice>
        )}
        {view && <Body view={view} />}
      </div>
    </SectionCard>
  );
}
