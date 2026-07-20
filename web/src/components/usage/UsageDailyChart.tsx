import { useState } from 'react';
import type { DailyCost } from '@/api/usage';
import { formatTokens } from '@/utils/format';

interface Props {
  data: DailyCost[];
  loading: boolean;
  /** Currently selected day (YYYY-MM-DD) when the chart drives a custom range. */
  selectedDate?: string;
  /** Click a bar to drill into that single day (toggles off if already selected). */
  onSelectDay?: (date: string) => void;
}

interface Hover {
  i: number;
  x: number;
  y: number;
}

const CHART_H = 200;
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PAD_BOTTOM = 24;
const PAD_TOP = 12;

export function UsageDailyChart({ data, loading, selectedDate, onSelectDay }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);

  if (loading && data.length === 0) {
    return <div className="usage-chart-placeholder">Loading…</div>;
  }
  if (data.length === 0) {
    return <div className="usage-chart-placeholder">No data for this selection</div>;
  }

  const maxCost = Math.max(...data.map((d) => d.cost_usd), 0.01);
  const innerW = 1000; // viewBox width; svg scales to container
  const plotW = innerW - PAD_LEFT - PAD_RIGHT;
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const slot = plotW / data.length;
  const barW = Math.max(2, Math.min(48, slot * 0.7));

  // Three gridlines: max, mid, zero.
  const gridVals = [maxCost, maxCost / 2, 0];

  const hovered = hover ? data[hover.i] : null;

  return (
    <div className="usage-chart-wrapper">
      <svg
        viewBox={`0 0 ${innerW} ${CHART_H}`}
        className="usage-chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily cost chart"
      >
        {/* Gridlines + Y labels */}
        {gridVals.map((v, gi) => {
          const y = PAD_TOP + plotH * (1 - v / maxCost);
          return (
            <g key={gi}>
              <line x1={PAD_LEFT} y1={y} x2={innerW - PAD_RIGHT} y2={y} className="usage-chart-grid" />
              <text x={PAD_LEFT - 6} y={y + 3} className="usage-chart-axis" textAnchor="end">
                ${v >= 10 ? v.toFixed(0) : v.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((d, i) => {
          const h = (d.cost_usd / maxCost) * plotH;
          const x = PAD_LEFT + i * slot + (slot - barW) / 2;
          const y = PAD_TOP + plotH - h;
          const isSel = selectedDate === d.date;
          const isHov = hover?.i === i;
          return (
            <g key={d.date}>
              {/* Full-height hit area so thin bars are still easy to hover/click */}
              <rect
                x={PAD_LEFT + i * slot}
                y={PAD_TOP}
                width={slot}
                height={plotH}
                fill="transparent"
                style={{ cursor: onSelectDay ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover({ i, x: x + barW / 2, y })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelectDay?.(d.date)}
              />
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, 1)}
                rx="2"
                className={`usage-chart-bar${isSel ? ' selected' : ''}${isHov ? ' hovered' : ''}`}
                pointerEvents="none"
              />
            </g>
          );
        })}

        {/* X-axis labels: first, last, and evenly spaced */}
        {data.map((d, i) => {
          const step = Math.ceil(data.length / 8);
          if (!(i === 0 || i === data.length - 1 || i % step === 0)) return null;
          const x = PAD_LEFT + i * slot + slot / 2;
          return (
            <text key={`x${d.date}`} x={x} y={CHART_H - 6} className="usage-chart-axis" textAnchor="middle">
              {d.date.slice(5)}
            </text>
          );
        })}
      </svg>

      {/* HTML tooltip positioned over the hovered bar (percentage coords into the svg box) */}
      {hovered && hover && (
        <div
          className="usage-chart-tooltip"
          style={{ left: `${(hover.x / innerW) * 100}%`, top: `${(hover.y / CHART_H) * 100}%` }}
        >
          <div className="usage-chart-tooltip-date">{hovered.date}</div>
          <div className="usage-chart-tooltip-cost">${hovered.cost_usd.toFixed(2)}</div>
          <div className="usage-chart-tooltip-meta">
            {formatTokens(hovered.input_tokens + hovered.cache_read_tokens + hovered.cache_creation_tokens)} in · {formatTokens(hovered.output_tokens)} out · {hovered.api_calls} calls
          </div>
          {onSelectDay && <div className="usage-chart-tooltip-hint">click to filter this day</div>}
        </div>
      )}
    </div>
  );
}
