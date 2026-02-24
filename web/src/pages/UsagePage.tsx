import { useUsage } from '@/hooks/useUsage';
import { UsageSummaryCards } from '@/components/usage/UsageSummaryCards';
import { UsageDailyChart } from '@/components/usage/UsageDailyChart';
import { UsageBreakdownTable } from '@/components/usage/UsageBreakdownTable';
import { UsageRecentTable } from '@/components/usage/UsageRecentTable';
import { formatTokens } from '@/utils/format';
import type { Period } from '@/api/usage';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

export function UsagePage() {
  const { summary, daily, bySource, byModel, recent, loading, error, period, setPeriod, refresh } = useUsage();

  const activeSummary = summary?.[period === 'today' ? 'today' : period === '7d' ? 'week' : period === '30d' ? 'month' : 'allTime'];

  return (
    <div className="usage-page">
      <div className="usage-header">
        <h1>Usage &amp; Costs</h1>
        <button className="usage-refresh-btn" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="usage-period-tabs">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            className={`usage-period-tab${period === p.value ? ' active' : ''}`}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="usage-error">Error: {error}</div>}

      <UsageSummaryCards summary={activeSummary ?? null} loading={loading} />

      <div className="usage-chart-section">
        <h2>Daily Costs</h2>
        <UsageDailyChart data={daily} loading={loading} />
      </div>

      <div className="usage-breakdown-grid">
        <div className="usage-breakdown-panel">
          <h2>By Source</h2>
          <UsageBreakdownTable data={bySource} loading={loading} />
        </div>
        <div className="usage-breakdown-panel">
          <h2>By Model</h2>
          <UsageBreakdownTable data={byModel} loading={loading} />
        </div>
      </div>

      {activeSummary && (
        <div className="usage-cache-card">
          <h2>Cache Efficiency</h2>
          <div className="usage-cache-stats">
            <div className="usage-cache-stat">
              <span className="usage-cache-label">Cache Hit Rate</span>
              <span className="usage-cache-value">
                {(activeSummary.input_tokens + activeSummary.cache_read_tokens + activeSummary.cache_creation_tokens) > 0
                  ? ((activeSummary.cache_read_tokens / (activeSummary.input_tokens + activeSummary.cache_read_tokens + activeSummary.cache_creation_tokens)) * 100).toFixed(1)
                  : '0.0'}%
              </span>
            </div>
            <div className="usage-cache-stat">
              <span className="usage-cache-label">Total Input</span>
              <span className="usage-cache-value">{formatTokens(activeSummary.input_tokens + activeSummary.cache_read_tokens + activeSummary.cache_creation_tokens)}</span>
            </div>
            <div className="usage-cache-stat">
              <span className="usage-cache-label">Cache Read</span>
              <span className="usage-cache-value">{formatTokens(activeSummary.cache_read_tokens)}</span>
            </div>
            <div className="usage-cache-stat">
              <span className="usage-cache-label">Cache Write</span>
              <span className="usage-cache-value">{formatTokens(activeSummary.cache_creation_tokens)}</span>
            </div>
            <div className="usage-cache-stat">
              <span className="usage-cache-label">Uncached Input</span>
              <span className="usage-cache-value">{formatTokens(activeSummary.input_tokens)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="usage-recent-section">
        <h2>Recent Activity</h2>
        <UsageRecentTable data={recent} loading={loading} />
      </div>
    </div>
  );
}

