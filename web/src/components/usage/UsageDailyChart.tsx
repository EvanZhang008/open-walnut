import type { DailyCost } from '@/api/usage';

interface Props {
  data: DailyCost[];
  loading: boolean;
}

export function UsageDailyChart({ data, loading }: Props) {
  if (loading && data.length === 0) {
    return <div className="usage-chart-placeholder">Loading...</div>;
  }
  if (data.length === 0) {
    return <div className="usage-chart-placeholder">No data yet</div>;
  }

  const maxCost = Math.max(...data.map((d) => d.cost_usd), 0.01);
  const barWidth = Math.max(8, Math.floor(600 / data.length) - 2);
  const chartWidth = data.length * (barWidth + 2) + 40;
  const chartHeight = 200;
  const barArea = chartHeight - 30;

  return (
    <div className="usage-chart-wrapper">
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="usage-chart-svg" preserveAspectRatio="xMinYMid meet">
        {/* Y-axis labels */}
        <text x="2" y="14" className="usage-chart-label">${maxCost.toFixed(2)}</text>
        <text x="2" y={barArea + 2} className="usage-chart-label">$0</text>

        {/* Bars */}
        {data.map((d, i) => {
          const h = maxCost > 0 ? (d.cost_usd / maxCost) * (barArea - 16) : 0;
          const x = 40 + i * (barWidth + 2);
          const y = barArea - h;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(h, 1)}
                className="usage-chart-bar"
                rx="2"
              >
                <title>{`${d.date}: $${d.cost_usd.toFixed(4)}`}</title>
              </rect>
              {/* X-axis labels for first, last, and every 7th */}
              {(i === 0 || i === data.length - 1 || i % 7 === 0) && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - 2}
                  className="usage-chart-label"
                  textAnchor="middle"
                >
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
