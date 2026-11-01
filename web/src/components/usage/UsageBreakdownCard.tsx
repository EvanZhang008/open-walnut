import { useMemo, useState } from 'react';
import { SettingsGroup } from '@/components/settings/SettingsSection';
import { SegmentedControl } from '@/components/settings/inputs/SegmentedControl';
import { usePersistentState } from '@/hooks/usePersistentState';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import type { CostLine, CostReport } from '@/api/usage';
import { UsageBreakdownChart, UsageSparkline } from './UsageBreakdownChart';
import {
  autoGranularity, buildBreakdown, coverageOf, dayLabel, STALE_AFTER_MS,
  type BreakdownId, type Bucket, type Granularity,
} from './breakdown-model';

export const BREAKDOWNS: { value: BreakdownId; label: string; noun: string }[] = [
  { value: 'agent', label: 'Agent', noun: 'Agent' },
  { value: 'model', label: 'Model', noun: 'Model' },
  { value: 'project', label: 'Project', noun: 'Project' },
  { value: 'host', label: 'Host', noun: 'Host' },
  { value: 'kind', label: 'Kind', noun: 'Kind of work' },
  { value: 'token', label: 'Token type', noun: 'Token type' },
];
export const isBreakdown = (v: unknown): v is BreakdownId => BREAKDOWNS.some((b) => b.value === v);

const GRAINS: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' },
];
const isGrain = (v: unknown): v is Granularity | 'auto' => v === 'auto' || GRAINS.some((g) => g.value === v);

/** Rows shown before the table folds the rest into "N more". */
const VISIBLE = 8;

function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function totalTokens(line: CostLine): number {
  return line.tokens.input + line.tokens.output + line.tokens.cacheRead + line.tokens.cacheWrite;
}

function pct(v: number): string { return v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(v < 10 ? 1 : 0)}%`; }

const fullDay = (d: string) => `${dayLabel(d)}, ${d.slice(0, 4)}`;

/** One line about how much of the period Walnut holds, host by host when they started on different days. */
function coverageLine(report: CostReport, days: string[], stillReading: boolean, hostName: (h: string) => string): string {
  const byFrom = (x: { from: string }, y: { from: string }) => x.from.localeCompare(y.from);
  const own = (report.stored ?? []).filter((s) => !s.imported).sort(byFrom);
  const imported = (report.stored ?? []).filter((s) => s.imported).sort(byFrom);
  if (!own.length && !imported.length) return 'Nothing stored yet. Update now reads every host.';
  const ownFrom = own[0]?.from ?? '', latest = own[own.length - 1]?.from ?? '';
  const each = own.length && ownFrom !== latest
    ? own.map((s) => `${hostName(s.host)} from ${fullDay(s.from)}`).join(', ') : `from ${fullDay(ownFrom)}`;
  const parts: string[] = [];
  if (imported.length && ownFrom && days[0] && days[0] < ownFrom) {
    // Days before Walnut recorded usage, brought in from a bill: whole-account totals.
    parts.push(`Before ${fullDay(ownFrom)}: imported from ${imported[0].host}, counted for the whole account, with no sessions or projects.`);
    if (days[0] < imported[0].from) parts.push('Nothing earlier in it.');
    parts.push(`Recorded by Walnut${own.length > 1 && ownFrom !== latest ? ':' : ''} ${each}.`);
  } else if (days[0] && days[0] < latest) {
    // The period reaches back past a host's first stored day: say where each one starts.
    parts.push(`Stored ${each}.`);
    if (days[0] < ownFrom) parts.push('Nothing earlier: those transcripts were gone before Walnut kept usage.');
  } else parts.push('Every day of this period is stored.');
  if (stillReading) parts.push('The latest hours are still being read.');
  return parts.join(' ');
}

export function UsageBreakdownCard({ report, days, loading, onPick }: {
  report: CostReport; days: string[]; loading: boolean; onPick: (b: Bucket) => void;
}) {
  const hostName = useHostDisplayLabels();
  const [breakdown, setBreakdown] = usePersistentState<BreakdownId>('walnut-usage-breakdown', 'agent', isBreakdown);
  const [grainPick, setGrain] = usePersistentState<Granularity | 'auto'>('walnut-usage-grain', 'auto', isGrain);
  const [open, setOpen] = useState(false);
  // Until the user picks one, the grain follows the period (days, weeks past three months, months past two years).
  const grain: Granularity = grainPick === 'auto' ? autoGranularity(days.length) : grainPick;
  const data = useMemo(() => buildBreakdown(report.groups.find((g) => g.id === breakdown), days,
    (line) => breakdown === 'host' ? hostName(line.key) : line.label, grain), [report, breakdown, days, hostName, grain]);
  const oldest = (report.countedUntil ?? []).map((u) => Date.parse(u.until)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const stillReading = !!report.collection?.running || oldest === undefined || Date.now() - oldest > STALE_AFTER_MS;
  const storedFrom = (report.stored ?? []).map((s) => s.from).sort()[0];
  const ownFrom = (report.stored ?? []).filter((s) => !s.imported).map((s) => s.from).sort()[0];
  const today = new Date().toLocaleDateString('en-CA');
  const coverage = data.buckets.map((b) => coverageOf(b, storedFrom, stillReading && b.end >= today, ownFrom));
  const noun = BREAKDOWNS.find((b) => b.value === breakdown)!.noun;
  const rows = open ? data.rows : data.rows.slice(0, VISIBLE);
  const hidden = data.rows.length - rows.length;
  // One bucket (Today) has no trend to draw.
  const trend = data.buckets.length > 1;
  const byToken = breakdown === 'token';
  const tokenTotal = byToken ? data.rows.reduce((n, r) => n + totalTokens(r.line), 0) : 0;
  const per = grain === 'day' ? 'day' : grain === 'week' ? 'week' : 'month';
  return (
    <SettingsGroup className="usage-bd" data-testid="usage-breakdown" heading={`Cost per ${per}`}>
      <div className="settings-row settings-row-stacked usage-bd-body" data-wide="true" data-grain={grain} data-breakdown={breakdown}>
        {/* Both switches sit above the chart, where they can wrap; the heading row is too narrow for six choices. */}
        <div className="usage-bd-toolbar">
          <span className="usage-bd-switch">
            <span className="usage-bd-switch-label">Break down by</span>
            <SegmentedControl aria-label="Break down by" value={breakdown} onChange={(v) => { setBreakdown(v); setOpen(false); }}
              options={BREAKDOWNS.map((b) => ({ value: b.value, label: b.label, testId: `usage-breakdown-${b.value}` }))} />
          </span>
          <span className="usage-bd-switch">
            <span className="usage-bd-switch-label">Each point is a</span>
            <SegmentedControl aria-label="Each point is a" value={grainPick === 'auto' ? grain : grainPick} onChange={(v) => setGrain(v)}
              options={GRAINS.map((g) => ({ value: g.value, label: g.label, testId: `usage-grain-${g.value}` }))} />
          </span>
        </div>
        <p className="usage-bd-coverage" data-testid="usage-coverage">{coverageLine(report, days, stillReading, hostName)}</p>
        <UsageBreakdownChart data={data} loading={loading} onPick={onPick} coverage={coverage} />
        <table className="usage-bd-table" data-testid={`usage-group-${breakdown}`}>
          <thead>
            <tr>
              <th>{noun}</th>
              {byToken && <th className="num usage-bd-col-req">Tokens</th>}
              {byToken && <th className="num usage-bd-col-share2">Share of tokens</th>}
              <th className="num usage-bd-col-cost">Cost</th>
              <th className={`num ${byToken ? 'usage-bd-col-share2' : 'usage-bd-col-share'}`}>{byToken ? 'Share of cost' : 'Share'}</th>
              {!byToken && <th className="num usage-bd-col-req usage-bd-req">Requests</th>}
              {trend && <th className="usage-bd-col-trend usage-bd-trend">{`By ${per}`}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line.key} className="usage-line" data-key={r.line.key}
                title={byToken ? `${tokensText(totalTokens(r.line))} tokens` : `${r.line.requests.toLocaleString('en-US')} requests · ${tokensText(totalTokens(r.line))} tokens${r.line.unpriced ? ` · ${r.line.unpriced.toLocaleString('en-US')} without a price` : ''}`}>
                <td><span className="usage-bd-name"><i className="usage-bd-swatch" style={{ background: r.color }} /><span>{r.label}</span></span></td>
                {/* A cost reported with no tokens (a web search) has no token share. */}
                {byToken && <td className="num muted">{totalTokens(r.line) ? tokensText(totalTokens(r.line)) : '-'}</td>}
                {byToken && <td className="num muted">{tokenTotal > 0 && totalTokens(r.line) ? pct(totalTokens(r.line) / tokenTotal * 100) : '-'}</td>}
                <td className="num usage-line-cost">{money(r.line.costUsd)}</td>
                <td className="num muted">{pct(r.share)}</td>
                {!byToken && <td className="num muted usage-bd-req">{r.line.requests.toLocaleString('en-US')}</td>}
                {trend && <td className="usage-bd-trend"><UsageSparkline values={r.values} color={r.color} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 && (
          <button type="button" className="usage-bd-more" onClick={() => setOpen(true)} data-testid="usage-breakdown-more">
            {`${hidden} more · ${money(data.rows.slice(VISIBLE).reduce((n, r) => n + r.line.costUsd, 0))}`}
          </button>
        )}
        {breakdown === 'kind' && (
          <p className="usage-bd-foot">Routines are the runs a routine started. A trigger that fires into a task you work in counts with that task.</p>
        )}
        {byToken && (
          <p className="usage-bd-foot">Each token type at the model&apos;s list rate. Cache reads are most of the tokens and cost far less per token than input, so the two shares differ.</p>
        )}
      </div>
    </SettingsGroup>
  );
}
