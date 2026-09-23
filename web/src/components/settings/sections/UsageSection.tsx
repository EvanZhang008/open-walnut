import { useMemo } from 'react';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow, SettingsEmpty } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useUsageOverview } from '@/hooks/useUsageOverview';
import { formatTokens } from '@/utils/format';
import { UsageDailyChart } from '@/components/usage/UsageDailyChart';
import { SettingsUsageBreakdown, SettingsUsageRecent, usageRangeHint } from './UsageTables';
import { UsageFilterChips, chipValue, type Chip } from '@/components/usage/UsageFilterChips';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import type { Period } from '@/api/usage';
import '@/styles/settings-sections-addons.css';

const PRESETS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

export function UsageSection() {
  const { overview, loading, error, time, setTime, drill, setDrill, clearDrill, refresh, effectiveRange } = useUsageOverview();

  // The chart drives a single-day custom range when a day is clicked; detect that.
  const chartSelectedDay = time.preset === 'custom' && time.start && time.start === time.end ? time.start : undefined;

  const chips: Chip[] = useMemo(() => {
    const out: Chip[] = [];
    if (drill.source) out.push({ key: 'source', label: 'Source', value: chipValue(drill.source), onRemove: () => setDrill((d) => ({ ...d, source: undefined })) });
    if (drill.model) out.push({ key: 'model', label: 'Model', value: chipValue(drill.model), onRemove: () => setDrill((d) => ({ ...d, model: undefined })) });
    if (drill.agentId) out.push({ key: 'agent', label: 'Agent', value: chipValue(drill.agentId), onRemove: () => setDrill((d) => ({ ...d, agentId: undefined })) });
    return out;
  }, [drill, setDrill]);

  const bounds = overview?.dateBounds ?? { min: null, max: null };

  const summary = overview?.summary ?? null;
  const empty = !loading && !error && summary !== null && summary.api_calls === 0 && chips.length === 0;
  // The first read has no numbers yet: one loading row, not three `--` stats that
  // may turn into the empty sentence a moment later. A refresh keeps the numbers.
  const firstLoad = loading && summary === null && !error;
  const presetValue = (time.preset === 'custom' ? '' : time.preset) as Period;
  const rangeHint = usageRangeHint(effectiveRange.start, effectiveRange.end);

  return (
    <SettingsSection
      id="usage"
      title="Usage & Costs"
      actions={(
        <SettingsButton className="usage-refresh-btn" onClick={refresh} busy={loading} busyLabel="Refreshing...">
          Refresh
        </SettingsButton>
      )}
    >
      <SettingsGroup>
        <SettingsRow
          label="Period"
          control={
            <span className="settings-addons-inline usage-period-tabs">
              <SegmentedControl
                aria-label="Period"
                value={presetValue}
                onChange={(v) => setTime({ preset: v })}
                options={PRESETS.map((p) => ({ value: p.value, label: p.label, testId: `usage-period-${p.value}` }))}
              />
              <UsageDateRange
                active={time.preset === 'custom'}
                start={time.start}
                end={time.end}
                bounds={bounds}
                onApply={(start, end) => setTime({ preset: 'custom', start, end })}
              />
            </span>
          }
        />
        {chips.length > 0 && (
          <div className="settings-row">
            <UsageFilterChips chips={chips} onClearAll={clearDrill} />
          </div>
        )}
      </SettingsGroup>

      {error && <SettingsNotice kind="error" role="alert">{`Couldn't load usage: ${error}`}</SettingsNotice>}

      {firstLoad ? (
        <SettingsGroup>
          <SettingsLoadingRow>Loading usage...</SettingsLoadingRow>
        </SettingsGroup>
      ) : empty ? (
        <SettingsGroup>
          <SettingsEmpty>No model calls recorded yet.</SettingsEmpty>
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup className="settings-addons-summary" data-testid="usage-summary">
            <div className="settings-addons-stats" aria-busy={loading || undefined}>
              <Stat value={summary ? `$${summary.total_cost.toFixed(2)}` : '--'} label={chips.length > 0 || time.preset === 'custom' ? 'Filtered cost' : 'Walnut cost'} />
              <Stat value={summary ? String(summary.api_calls) : '--'} label="API calls" />
              <Stat value={summary ? formatTokens(summary.input_tokens + summary.output_tokens) : '--'} label="Tokens in and out" />
            </div>
          </SettingsGroup>

          <SettingsGroup heading="Daily costs" headingTrailing="Click a bar to focus that day">
            <div className="settings-row settings-row-stacked usage-chart-section" data-wide="true">
              <UsageDailyChart
                data={overview?.daily ?? []}
                loading={loading}
                selectedDate={chartSelectedDay}
                onSelectDay={(date) => {
                  // Toggle: clicking the already-selected day clears back to 7 days.
                  if (chartSelectedDay === date) setTime({ preset: '7d' });
                  else setTime({ preset: 'custom', start: date, end: date });
                }}
              />
            </div>
          </SettingsGroup>

          {([
            ['By source', overview?.bySource, drill.source, (name: string) => setDrill((d) => ({ ...d, source: d.source === name ? undefined : name }))],
            ['By agent', overview?.byAgent, drill.agentId, (name: string) => setDrill((d) => ({ ...d, agentId: d.agentId === name ? undefined : name }))],
            ['By model', overview?.byModel, drill.model, (name: string) => setDrill((d) => ({ ...d, model: d.model === name ? undefined : name }))],
          ] as const).map(([heading, data, active, onSelect]) => (
            <SettingsGroup key={heading} heading={heading}>
              <div className="settings-row settings-row-stacked usage-breakdown-panel" data-wide="true">
                <SettingsUsageBreakdown data={data ?? []} loading={loading} activeName={active} onSelect={onSelect} />
              </div>
            </SettingsGroup>
          ))}

          {summary && (
            <SettingsGroup heading="Cache efficiency" className="usage-cache-card">
              <CacheStats summary={summary} />
            </SettingsGroup>
          )}

          <SettingsGroup heading="Recent activity" headingTrailing={rangeHint}>
            <div className="settings-row settings-row-stacked usage-recent-section" data-wide="true">
              <SettingsUsageRecent data={overview?.recent ?? []} loading={loading} />
            </div>
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="settings-addons-stat">
      <span className="settings-addons-stat-value">{value}</span>
      <span className="settings-addons-stat-label">{label}</span>
    </div>
  );
}

function CacheStats({ summary }: { summary: NonNullable<ReturnType<typeof useUsageOverview>['overview']>['summary'] }) {
  const totalIn = summary.input_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
  const hitRate = totalIn > 0 ? (summary.cache_read_tokens / totalIn) * 100 : 0;
  const fmt = (n: number) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'k' : String(n));
  const stats = [
    { label: 'Cache hit rate', value: `${hitRate.toFixed(1)}%` },
    { label: 'Total input', value: fmt(totalIn) },
    { label: 'Cache read', value: fmt(summary.cache_read_tokens) },
    { label: 'Cache write', value: fmt(summary.cache_creation_tokens) },
    { label: 'Uncached input', value: fmt(summary.input_tokens) },
  ];
  return (
    <>
      {stats.map((s) => (
        <SettingsRow
          key={s.label}
          className="usage-cache-stat"
          label={s.label}
          control={<span className="settings-addons-muted usage-cache-value">{s.value}</span>}
        />
      ))}
    </>
  );
}
