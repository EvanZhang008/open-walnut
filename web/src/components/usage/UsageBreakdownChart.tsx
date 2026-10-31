import { useLayoutEffect, useRef, useState } from 'react';
import { monotonePath, niceTicks, type Breakdown, type Bucket } from './breakdown-model';

const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

function axisMoney(v: number): string {
  if (v >= 1000) return `$${Number((v / 1000).toFixed(1))}k`;
  if (v >= 1 || v === 0) return `$${Number(v.toFixed(1))}`;
  return `$${Number(v.toFixed(3))}`;
}

function money(v: number): string {
  if (v > 0 && v < 0.01) return '<$0.01';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Which x labels to print: about one per 90px, always the last, never one crowding it. */
function labelIndexes(n: number, plotW: number): Set<number> {
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
  const out = new Set<number>();
  for (let i = 0; i < n; i += every) if (n - 1 - i >= every / 2 || i === n - 1) out.add(i);
  out.add(n - 1);
  return out;
}

/**
 * Cost over the period as smooth stacked layers, one per series (the biggest at
 * the bottom), with a crosshair that lists the hovered day's split. A click picks
 * that day (or week) as the period.
 */
export function UsageBreakdownChart({ data, loading, onPick }: { data: Breakdown; loading?: boolean; onPick?: (bucket: Bucket) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { buckets, series } = data;
  const n = buckets.length;
  // A click can change the period under the pointer: an index past the new buckets is no hover.
  const hover = hovered !== null && hovered < n ? hovered : null;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH * (1 - v / top);
  const xOf = (i: number) => (n === 1 ? PAD.left + plotW / 2 : PAD.left + plotW * i / (n - 1));
  // One bucket (Today) still reads as layers: a flat band across the width.
  const xs = n === 1 ? [PAD.left, PAD.left + plotW] : buckets.map((_, i) => xOf(i));
  const valueAt = (vals: number[], j: number) => vals[n === 1 ? 0 : j];

  const base = new Array(n).fill(0) as number[];
  const layers = series.map((s) => {
    const lo = base.slice();
    for (let i = 0; i < n; i++) base[i] += s.values[i];
    const upper = monotonePath(xs.map((x, j) => [x, y(valueAt(base, j))] as [number, number]));
    const lower = monotonePath(xs.map((x, j) => [x, y(valueAt(lo, j))] as [number, number]).reverse(), false);
    return { key: s.key, label: s.label, color: s.color, d: `${upper} ${lower} Z` };
  });

  const labels = labelIndexes(n, plotW);
  const indexAt = (clientX: number) => {
    const el = box.current;
    if (!el || !n) return null;
    const x = clientX - el.getBoundingClientRect().left;
    const i = n === 1 ? 0 : Math.round(((x - PAD.left) / (plotW || 1)) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  };
  const hx = hover === null ? 0 : xOf(hover);
  const tipOnLeft = hx > width / 2;

  return (
    <div ref={box} className="usage-bd-chart" data-testid="usage-breakdown-chart" data-buckets={n} aria-busy={loading || undefined}
      onPointerMove={(e) => setHover(indexAt(e.clientX))} onPointerLeave={() => setHover(null)}
      onClick={(e) => { const i = indexAt(e.clientX); if (i !== null && onPick) onPick(buckets[i]); }}>
      {width > 0 && n > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label="Cost over time, stacked by the chosen breakdown">
          {ticks.map((v) => (
            <g key={v}>
              <line className="usage-bd-grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="usage-bd-tick" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">{axisMoney(v)}</text>
            </g>
          ))}
          {layers.map((l) => (
            <path key={l.key} d={l.d} fill={l.color} className="usage-bd-area" data-series={l.key}><title>{l.label}</title></path>
          ))}
          {[...labels].map((i) => (
            <text key={buckets[i].start} className="usage-bd-tick" x={xOf(i)} y={HEIGHT - 8}
              textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {buckets[i].label.replace('Week of ', '')}
            </text>
          ))}
          {hover !== null && (
            <g className="usage-bd-cross">
              <line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + plotH} />
              {series.map((s, k) => {
                const v = s.values[hover];
                const stacked = series.slice(0, k + 1).reduce((acc, x) => acc + x.values[hover], 0);
                return v > 0 ? <circle key={s.key} cx={hx} cy={y(stacked)} r={3.5} fill={s.color} /> : null;
              })}
            </g>
          )}
        </svg>
      )}
      {hover !== null && (
        <div className="usage-bd-tip" data-testid="usage-breakdown-tip"
          style={tipOnLeft ? { right: width - hx + 12 } : { left: hx + 12 }}>
          <div className="usage-bd-tip-head"><span>{buckets[hover].label}</span><b>{money(totals[hover])}</b></div>
          {series.filter((s) => s.values[hover] > 0).sort((a, b) => b.values[hover] - a.values[hover]).map((s) => (
            <div key={s.key} className="usage-bd-tip-row"><i style={{ background: s.color }} /><span>{s.label}</span><b>{money(s.values[hover])}</b></div>
          ))}
          {totals[hover] === 0 && <div className="usage-bd-tip-row muted">No model calls</div>}
        </div>
      )}
    </div>
  );
}

/** A row's own trend over the chart's buckets: one thin smooth line. */
export function UsageSparkline({ values, color }: { values: number[]; color: string }) {
  const w = 100, h = 22, max = Math.max(0, ...values);
  const pts = values.length > 1 && max > 0
    ? values.map((v, i) => [w * i / (values.length - 1), h - 2 - (h - 4) * v / max] as [number, number])
    : [];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} className="usage-bd-spark" aria-hidden="true">
      {pts.length > 0 && <path d={monotonePath(pts)} stroke={color} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
