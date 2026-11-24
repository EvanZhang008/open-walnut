/**
 * Voice Accuracy's Over time group: each engine's estimated errors (or its median time) by day,
 * one line per engine, over every recording that engine scored that day (the summary's `trend`;
 * the table above counts only the recordings every engine has). The nightly run gives the in-use
 * engine a point each day, the others only on days they ran. Hand-drawn SVG at the pane's
 * measured width, so its words keep their size on a phone; the chart palette (globals.css) only.
 * A day reads in full under the chart: the latest by default, the one under the pointer or a
 * tap, or the one the arrow keys pick.
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CompareTrendDay } from '@/api/stt-compare';
import { EmptyState } from '@/components/common/EmptyState';
import { dayLabel, niceTicks } from '@/components/usage/breakdown-model';
import { useElementWidth } from '@/hooks/useElementWidth';
import { usePageView } from '@/utils/view-memory';
import { SettingsGroup } from '../SettingsSection';
import { SegmentedControl } from '../inputs/SegmentedControl';
import {
  TREND_METRICS, isTrendMetric, recordingsWord, trendDays, trendEngines, trendLines, trendWords, type TrendMetric,
} from './voice-accuracy-model';

const HEIGHT = 180;
const PAD = { top: 10, right: 16, bottom: 24, left: 44 };
/** Before the pane is measured (and in a test DOM). */
const FALLBACK_WIDTH = 560;
/** The least room between two day labels. */
const LABEL_GAP = 64;
/** Colour slots of the chart palette (--chart-s1..s6). */
const SLOTS = 6;

const dayTime = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** Which days get a label: one per LABEL_GAP at most, always the first and the last. */
export function labelIndexes(xs: ReadonlyArray<number>, gap = LABEL_GAP): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) if (!out.length || xs[i]! - xs[out[out.length - 1]!]! >= gap) out.push(i);
  const last = xs.length - 1;
  if (last > 0 && out[out.length - 1] !== last) {
    if (out.length > 1 && xs[last]! - xs[out[out.length - 1]!]! < gap) out.pop();
    out.push(last);
  }
  return out;
}

const EMPTY_METRIC: Record<TrendMetric, string> = {
  mixed: 'These days have no estimated errors',
  cjk: 'These dictations have no Chinese words',
  latin: 'These dictations have no English words',
  ms: 'These days have no engine times recorded',
};

interface Props {
  trend: ReadonlyArray<CompareTrendDay>;
  /** The summary's engines, in order (the in-use one is drawn first either way). */
  order: ReadonlyArray<string>;
  nameOf(id: string): string;
  /** The engine post-processes another's text: its time is added time. */
  adds(id: string): boolean;
}

export function VoiceAccuracyTrend({ trend, order, nameOf, adds }: Props) {
  const [metric, setMetric] = usePageView<TrendMetric>('settings-voice-accuracy', 'trend-metric', 'mixed', isTrendMetric);
  // The day read out under the chart while the pointer or the keys are on it; null: the latest.
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const readoutId = useId();
  const width = useElementWidth(boxRef) || FALLBACK_WIDTH;
  const enough = trendDays(trend) >= 2;
  // A colour per engine over every metric, so switching the metric never repaints a line.
  const engineIds = trendEngines(trend, order);
  const slotOf = (id: string) => String(engineIds.indexOf(id) % SLOTS);
  const { days, lines } = trendLines(trend, order, metric);
  const label = TREND_METRICS.find((m) => m.value === metric)!.label;

  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = days.length ? dayTime(days[0]!) : 0;
  const t1 = days.length ? dayTime(days[days.length - 1]!) : 0;
  const xOf = (day: string) => (t1 === t0 ? PAD.left + plotW / 2 : PAD.left + (plotW * (dayTime(day) - t0)) / (t1 - t0));
  const scale = metric === 'ms' ? 1 : 100;
  const ticks = niceTicks(Math.max(0, ...lines.flatMap((l) => l.points.map((p) => p.value * scale))), 3);
  const top = ticks[ticks.length - 1]!;
  const yOf = (value: number) => PAD.top + plotH * (1 - (value * scale) / top);
  const tickWords = (t: number) => (metric === 'ms' ? `${t} s` : `${t}%`);
  const xs = days.map(xOf);
  const labels = labelIndexes(xs);
  const shown = hoverDay && days.includes(hoverDay) ? hoverDay : days[days.length - 1];

  const pickAt = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!days.length || !box.width) return;
    const x = ((e.clientX - box.left) * width) / box.width;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
    setHoverDay(days[best]!);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(0, days.indexOf(shown ?? ''));
    const to = e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowRight' ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    setHoverDay(days[Math.min(days.length - 1, Math.max(0, to))] ?? null);
  };

  return (
    <SettingsGroup
      heading="Over time"
      description="Each engine by day, over every recording it scored that day, not only the ones shared above."
      data-testid="va-trend"
    >
      {/* The padding is on the outer box: the inner one is measured, so it is the chart's own width. */}
      <div className="va-trend" data-empty={enough ? undefined : 'true'}>
        <div ref={boxRef} className="va-trend-box" data-metric={metric}>
          {!enough && (
            <EmptyState
              size="row"
              title="Needs two days of scored dictations"
              hint="The nightly comparison scores each day's dictations; the lines start once two days have them."
              testId="va-trend-empty"
            />
          )}
          {enough && (
            <div className="va-trend-head">
              <ul className="va-trend-legend" aria-label="Engines">
                {lines.map((l) => (
                  <li key={l.id} data-slot={slotOf(l.id)} data-lead={l.id === 'in-use' ? 'true' : undefined}>
                    <i className="va-trend-swatch" aria-hidden="true" />{nameOf(l.id)}
                  </li>
                ))}
              </ul>
              <SegmentedControl<TrendMetric>
                size="sm"
                value={metric}
                onChange={setMetric}
                aria-label="Show over time"
                options={TREND_METRICS.map((m) => ({ value: m.value, label: m.label, testId: `va-trend-${m.value}` }))}
              />
            </div>
          )}
          {enough && lines.length === 0 && <EmptyState size="row" title={EMPTY_METRIC[metric]} testId="va-trend-none" />}
          {enough && lines.length > 0 && shown && (
            <>
              <div
                className="va-trend-plot"
                tabIndex={0}
                role="group"
                aria-label={`${label} by day. The arrow keys pick a day.`}
                aria-describedby={readoutId}
                onKeyDown={onKey}
                onBlur={() => setHoverDay(null)}
              >
                <svg
                  viewBox={`0 0 ${width} ${HEIGHT}`}
                  width="100%"
                  height={HEIGHT}
                  role="img"
                  aria-label={`${label} by day for ${lines.map((l) => nameOf(l.id)).join(', ')}`}
                  data-testid="va-trend-chart"
                  onPointerMove={pickAt}
                  onPointerDown={pickAt}
                  // A finger's tap keeps its day after the finger lifts; a mouse leaving gives back the latest.
                  onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHoverDay(null); }}
                >
                  {ticks.map((t) => (
                    <g key={t}>
                      <line className="va-trend-grid" x1={PAD.left} x2={width - PAD.right} y1={yOf(t / scale)} y2={yOf(t / scale)} />
                      <text className="va-trend-tick" x={PAD.left - 8} y={yOf(t / scale) + 4} textAnchor="end">{tickWords(t)}</text>
                    </g>
                  ))}
                  {labels.map((i) => (
                    <text key={days[i]} className="va-trend-tick" x={xs[i]} y={HEIGHT - 6}
                      textAnchor={days.length === 1 ? 'middle' : i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>
                      {dayLabel(days[i]!)}
                    </text>
                  ))}
                  {hoverDay === shown && <line className="va-trend-guide" x1={xOf(shown)} x2={xOf(shown)} y1={PAD.top} y2={PAD.top + plotH} />}
                  {/* The in-use line is drawn last, so it sits on top. */}
                  {[...lines].reverse().map((l) => (
                    <g key={l.id} className="va-trend-line" data-slot={slotOf(l.id)} data-engine={l.id} data-lead={l.id === 'in-use' ? 'true' : undefined} data-testid="va-trend-line">
                      {l.points.length > 1 && (
                        <path d={l.points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.day).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ')} />
                      )}
                      {l.points.map((p) => (
                        <circle
                          key={p.day}
                          cx={xOf(p.day)}
                          cy={yOf(p.value)}
                          r={p.day === shown && hoverDay ? 5 : l.id === 'in-use' ? 3.5 : 3}
                          data-day={p.day}
                          data-value={trendWords(p.value, metric, adds(l.id))}
                          data-testid="va-trend-point"
                        >
                          <title>{`${nameOf(l.id)}, ${dayLabel(p.day)}: ${trendWords(p.value, metric, adds(l.id))}, ${recordingsWord(p.takes)}`}</title>
                        </circle>
                      ))}
                    </g>
                  ))}
                </svg>
              </div>
              <p className="va-trend-readout" id={readoutId} aria-live="polite" data-testid="va-trend-readout" data-day={shown}>
                <span className="va-trend-readout-day">{dayLabel(shown)}</span>
                {lines.map((l) => {
                  const p = l.points.find((x) => x.day === shown);
                  return p ? (
                    <span key={l.id} className="va-trend-readout-item" data-slot={slotOf(l.id)}>
                      <i className="va-trend-swatch" aria-hidden="true" />
                      {`${nameOf(l.id)} ${trendWords(p.value, metric, adds(l.id))}, ${recordingsWord(p.takes)}`}
                    </span>
                  ) : null;
                })}
              </p>
            </>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}
