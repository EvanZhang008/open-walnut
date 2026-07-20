import { useMemo } from 'react';
import { useUsageOverview } from '@/hooks/useUsageOverview';
import { UsageSummaryCards } from '@/components/usage/UsageSummaryCards';
import { UsageDailyChart } from '@/components/usage/UsageDailyChart';
import { UsageBreakdownTable } from '@/components/usage/UsageBreakdownTable';
import { UsageRecentTable } from '@/components/usage/UsageRecentTable';
import { UsageFilterChips, chipValue, type Chip } from '@/components/usage/UsageFilterChips';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import type { Period } from '@/api/usage';

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

  return (
    <div id="usage" className="card settings-section settings-section-wide">
      <div className="usage-header">
        <h3 className="settings-section-title">Usage &amp; Costs</h3>
        <button className="usage-refresh-btn" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="usage-period-tabs">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            className={`usage-period-tab${time.preset === p.value ? ' active' : ''}`}
            onClick={() => setTime({ preset: p.value })}
          >
            {p.label}
          </button>
        ))}
        <UsageDateRange
          active={time.preset === 'custom'}
          start={time.start}
          end={time.end}
          bounds={bounds}
          onApply={(start, end) => setTime({ preset: 'custom', start, end })}
        />
      </div>

      <UsageFilterChips chips={chips} onClearAll={clearDrill} />

      {error && <div className="usage-error">Error: {error}</div>}

      <UsageSummaryCards summary={overview?.summary ?? null} loading={loading} filtered={chips.length > 0 || time.preset === 'custom'} />

      <div className="usage-chart-section">
        <div className="usage-section-head">
          <h2>Daily Costs</h2>
          <span className="usage-section-hint">click a bar to focus that day</span>
        </div>
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

      <div className="usage-breakdown-grid">
        <div className="usage-breakdown-panel">
          <h2>By Source</h2>
          <UsageBreakdownTable
            data={overview?.bySource ?? []}
            loading={loading}
            activeName={drill.source}
            onSelect={(name) => setDrill((d) => ({ ...d, source: d.source === name ? undefined : name }))}
          />
        </div>
        <div className="usage-breakdown-panel">
          <h2>By Agent</h2>
          <UsageBreakdownTable
            data={overview?.byAgent ?? []}
            loading={loading}
            activeName={drill.agentId}
            onSelect={(name) => setDrill((d) => ({ ...d, agentId: d.agentId === name ? undefined : name }))}
          />
        </div>
        <div className="usage-breakdown-panel">
          <h2>By Model</h2>
          <UsageBreakdownTable
            data={overview?.byModel ?? []}
            loading={loading}
            activeName={drill.model}
            onSelect={(name) => setDrill((d) => ({ ...d, model: d.model === name ? undefined : name }))}
          />
        </div>
      </div>

      {overview?.summary && (
        <div className="usage-cache-card">
          <h2>Cache Efficiency</h2>
          <CacheStats summary={overview.summary} />
        </div>
      )}

      <div className="usage-recent-section">
        <div className="usage-section-head">
          <h2>Recent Activity</h2>
          <span className="usage-section-hint">
            {effectiveRange.start
              ? `showing ${effectiveRange.start}${effectiveRange.end && effectiveRange.end !== effectiveRange.start ? ` → ${effectiveRange.end}` : ''}`
              : 'all time'}
          </span>
        </div>
        <UsageRecentTable data={overview?.recent ?? []} loading={loading} />
      </div>
    </div>
  );
}

function CacheStats({ summary }: { summary: NonNullable<ReturnType<typeof useUsageOverview>['overview']>['summary'] }) {
  const totalIn = summary.input_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
  const hitRate = totalIn > 0 ? (summary.cache_read_tokens / totalIn) * 100 : 0;
  const fmt = (n: number) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'k' : String(n));
  const stats = [
    { label: 'Cache Hit Rate', value: `${hitRate.toFixed(1)}%` },
    { label: 'Total Input', value: fmt(totalIn) },
    { label: 'Cache Read', value: fmt(summary.cache_read_tokens) },
    { label: 'Cache Write', value: fmt(summary.cache_creation_tokens) },
    { label: 'Uncached Input', value: fmt(summary.input_tokens) },
  ];
  return (
    <div className="usage-cache-stats">
      {stats.map((s) => (
        <div className="usage-cache-stat" key={s.label}>
          <span className="usage-cache-label">{s.label}</span>
          <span className="usage-cache-value">{s.value}</span>
        </div>
      ))}
    </div>
  );
}
