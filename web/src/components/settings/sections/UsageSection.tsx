import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow, SettingsEmpty } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useUsageCosts } from '@/hooks/useUsageCosts';
import type { TimeSelection } from '@/hooks/useUsageOverview';
import { formatTokens as formatTokenCount } from '@/utils/format';
import { UsageBreakdownChart, UsageSparkline } from '@/components/usage/UsageBreakdownChart';
import { buildBreakdown, dayLabel, periodDays, type BreakdownId, type Bucket } from '@/components/usage/breakdown-model';
import { usePersistentState } from '@/hooks/usePersistentState';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import { collectUsage, type CostLine, type CostReport, type CostTaskLine, type Period } from '@/api/usage';
import { openSessionOnHome } from '@/utils/open-session';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import '@/styles/settings-sections-addons.css';
import '@/styles/usage-breakdown.css';

const PRESETS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

const BREAKDOWNS: { value: BreakdownId; label: string; noun: string }[] = [
  { value: 'agent', label: 'Agent', noun: 'Agent' },
  { value: 'model', label: 'Model', noun: 'Model' },
  { value: 'project', label: 'Project', noun: 'Project' },
  { value: 'host', label: 'Host', noun: 'Host' },
];
const isBreakdown = (v: unknown): v is BreakdownId => BREAKDOWNS.some((b) => b.value === v);

/** Rows shown before a group folds the rest into "N more". */
const VISIBLE = 8;

export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Token counts with a B step: a busy machine's all-time total runs into the hundreds of billions. */
function formatTokens(n: number): string {
  return n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B` : formatTokenCount(n);
}

function totalTokens(line: CostLine): number {
  return line.tokens.input + line.tokens.output + line.tokens.cacheRead + line.tokens.cacheWrite;
}

/** "1,234 requests · 5.6M tokens", the part every breakdown row carries under its amount. */
function volume(requests: number, tokens?: number): string {
  return tokens === undefined ? count(requests, 'request') : `${count(requests, 'request')} · ${formatTokens(tokens)} tokens`;
}

export function UsageSection() {
  const [time, setTime] = useState<TimeSelection>({ preset: '30d' });
  const [breakdown, setBreakdown] = usePersistentState<BreakdownId>('walnut-usage-breakdown', 'agent', isBreakdown);
  const { report, current, loading, error, refresh, range } = useUsageCosts('all', time);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const update = async () => {
    setUpdating(true); setUpdateError('');
    try { await collectUsage(); await refresh(); }
    catch (err) { setUpdateError(err instanceof Error ? err.message : String(err)); }
    finally { setUpdating(false); }
  };
  const shown = current ?? report;
  // Every day of the period, empty ones too ("All time" runs from the first recorded day).
  const days = useMemo(() => shown ? periodDays(range.start ?? shown.bounds.min ?? shown.daily[0]?.date,
    range.end ?? shown.daily[shown.daily.length - 1]?.date) : [], [shown, range.start, range.end]);
  const presetValue = (time.preset === 'custom' ? '' : time.preset) as Period;

  return (
    <SettingsSection
      id="usage"
      title="Usage & Costs"
      description="What models cost: Walnut itself and every coding agent, estimated from tokens at public list prices."
      actions={(
        <SettingsButton className="usage-refresh-btn" onClick={update} busy={updating || !!shown?.collection?.running} busyLabel="Updating...">
          Update now
        </SettingsButton>
      )}
    >
      <SettingsGroup>
        <SettingsRow
          label="Period"
          control={
            <span className="settings-addons-inline usage-period-tabs">
              <SegmentedControl aria-label="Period" value={presetValue} onChange={(v) => setTime({ preset: v })}
                options={PRESETS.map((p) => ({ value: p.value, label: p.label, testId: `usage-period-${p.value}` }))} />
              <UsageDateRange active={time.preset === 'custom'} start={time.start} end={time.end}
                bounds={shown?.bounds ?? { min: null, max: null }}
                onApply={(start, end) => setTime({ preset: 'custom', start, end })} />
            </span>
          }
        />
      </SettingsGroup>

      {error && <SettingsNotice kind="error" role="alert">{`Couldn't load usage: ${error}`}</SettingsNotice>}
      {updateError && <SettingsNotice kind="error" role="alert">{updateError}</SettingsNotice>}
      {shown && !shown.ready && <SettingsNotice kind="info">Adding up past usage. The numbers fill in within a minute.</SettingsNotice>}

      {!shown ? (
        <SettingsGroup><SettingsLoadingRow>Loading usage...</SettingsLoadingRow></SettingsGroup>
      ) : (
        <div aria-busy={loading || undefined} data-testid="usage-costs" data-view={shown.view} data-breakdown={breakdown}>
          <Headline report={shown} days={days} />
          {shown.totals.requests === 0 ? (
            <SettingsGroup><SettingsEmpty>No model calls in this period.</SettingsEmpty></SettingsGroup>
          ) : (
            <>
              <BreakdownCard report={shown} days={days} breakdown={breakdown} onBreakdown={setBreakdown} loading={loading}
                onPick={(b) => setTime(time.preset === 'custom' && time.start === b.start && time.end === b.end
                  ? { preset: '30d' } : { preset: 'custom', start: b.start, end: b.end })} />
              <TaskList report={shown} heading="Most expensive tasks" />
            </>
          )}
          <HowCounted report={shown} />
        </div>
      )}
    </SettingsSection>
  );
}

function BreakdownCard({ report, days, breakdown, onBreakdown, loading, onPick }: {
  report: CostReport; days: string[]; breakdown: BreakdownId;
  onBreakdown: (b: BreakdownId) => void; loading: boolean; onPick: (b: Bucket) => void;
}) {
  const hostName = useHostDisplayLabels();
  const [open, setOpen] = useState(false);
  const data = useMemo(() => buildBreakdown(report.groups.find((g) => g.id === breakdown), days,
    (line) => breakdown === 'host' ? hostName(line.key) : line.label), [report, breakdown, days, hostName]);
  const noun = BREAKDOWNS.find((b) => b.value === breakdown)!.noun;
  const rows = open ? data.rows : data.rows.slice(0, VISIBLE);
  const hidden = data.rows.length - rows.length;
  // One day (Today) has no trend to draw.
  const trend = data.buckets.length > 1;
  return (
    <SettingsGroup className="usage-bd" data-testid="usage-breakdown"
      heading={data.byWeek ? 'Cost per week' : 'Cost per day'}
      headingTrailing={(
        <span className="usage-bd-switch">
          <span className="usage-bd-switch-label">Break down by</span>
          <SegmentedControl aria-label="Break down by" value={breakdown} onChange={(v) => { onBreakdown(v); setOpen(false); }}
            options={BREAKDOWNS.map((b) => ({ value: b.value, label: b.label, testId: `usage-breakdown-${b.value}` }))} />
        </span>
      )}>
      <div className="settings-row settings-row-stacked usage-bd-body" data-wide="true">
        <UsageBreakdownChart data={data} loading={loading} onPick={onPick} />
        <table className="usage-bd-table" data-testid={`usage-group-${breakdown}`}>
          <thead>
            <tr>
              <th>{noun}</th>
              <th className="num usage-bd-col-cost">Cost</th>
              <th className="num usage-bd-col-share">Share</th>
              <th className="num usage-bd-col-req usage-bd-req">Requests</th>
              {trend && <th className="usage-bd-col-trend">{data.byWeek ? 'By week' : 'By day'}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line.key} className="usage-line" data-key={r.line.key}
                title={`${volume(r.line.requests, totalTokens(r.line))}${r.line.unpriced ? ` · ${r.line.unpriced.toLocaleString('en-US')} without a price` : ''}`}>
                <td><span className="usage-bd-name"><i className="usage-bd-swatch" style={{ background: r.color }} /><span>{r.label}</span></span></td>
                <td className="num usage-line-cost">{money(r.line.costUsd)}</td>
                <td className="num muted">{`${r.share.toFixed(r.share < 10 ? 1 : 0)}%`}</td>
                <td className="num muted usage-bd-req">{r.line.requests.toLocaleString('en-US')}</td>
                {trend && <td><UsageSparkline values={r.values} color={r.color} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 && (
          <button type="button" className="usage-bd-more" onClick={() => setOpen(true)} data-testid="usage-breakdown-more">
            {`${hidden} more · ${money(data.rows.slice(VISIBLE).reduce((n, r) => n + r.line.costUsd, 0))}`}
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

/** Why requests are not in the total, one clause per model and source: a missing model name reads differently from an unknown price. */
export function unpricedNote(report: CostReport): string | undefined {
  const t = report.totals;
  if (t.unpriced <= 0) return undefined;
  const parts = report.unpriced?.length
    ? report.unpriced.map((u) => u.model === 'unknown' || !u.model
      ? `${count(u.requests, 'request')} from ${u.where} recorded no model name, so ${u.requests === 1 ? 'it has' : 'they have'} no price`
      : `${count(u.requests, 'request')} to ${u.model} (${u.where}) ${u.requests === 1 ? 'has' : 'have'} no public price`)
    : [`${count(t.unpriced, 'request')} with no public price (${report.unpricedModels.join(', ')})`];
  return `Not in the total: ${parts.join('; ')}.`;
}

function Headline({ report, days }: { report: CostReport; days: string[] }) {
  const t = report.totals;
  const unpriced = unpricedNote(report);
  const busiest = report.daily.reduce<CostReport['daily'][number] | undefined>((m, d) => (!m || d.costUsd > m.costUsd ? d : m), undefined);
  const dayCount = Math.max(1, days.length);
  return (
    <SettingsGroup className="settings-addons-summary" data-testid="usage-summary">
      <div className="settings-addons-stats">
        <Stat value={money(t.costUsd)} label="Estimated cost" testId="usage-total-cost" />
        <Stat value={money(t.costUsd / dayCount)} label="Average day" testId="usage-average-day" />
        <Stat value={busiest && busiest.costUsd > 0 ? money(busiest.costUsd) : '-'} label={busiest && busiest.costUsd > 0 ? `Busiest day, ${dayLabel(busiest.date)}` : 'Busiest day'} />
      </div>
      <p className="settings-addons-muted usage-headline-note" data-testid="usage-volume">
        {`${formatTokens(totalTokens(t))} tokens · ${count(t.requests, 'request')}: in ${formatTokens(t.tokens.input)} · out ${formatTokens(t.tokens.output)} · cache read ${formatTokens(t.tokens.cacheRead)} · cache write ${formatTokens(t.tokens.cacheWrite)}.`}
      </p>
      {unpriced && <p className="settings-addons-muted usage-headline-note" data-testid="usage-unpriced">{unpriced}</p>}
    </SettingsGroup>
  );
}

function Stat({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div className="settings-addons-stat" data-testid={testId}>
      <span className="settings-addons-stat-value">{value}</span>
      <span className="settings-addons-stat-label">{label}</span>
    </div>
  );
}

function LineRow({ line, share, label, help, onOpen }: { line: CostLine; share?: number; label?: string; help?: string; onOpen?: () => void }) {
  const amount = <span className="usage-line-cost">{money(line.costUsd)}</span>;
  return (
    <SettingsRow
      className="usage-line"
      label={<span className="usage-line-label" title={label ?? line.label}>{label ?? line.label}</span>}
      help={help ?? `${volume(line.requests, totalTokens(line))}${share !== undefined ? ` · ${share.toFixed(share < 10 ? 1 : 0)}% of the cost` : ''}${line.unpriced ? ` · ${line.unpriced.toLocaleString('en-US')} without a price` : ''}`}
      control={onOpen ? <SettingsButton onClick={onOpen}>{amount}</SettingsButton> : amount}
    />
  );
}

function TaskList({ report, heading }: { report: CostReport; heading: string }) {
  const navigate = useNavigate();
  const hostName = useHostDisplayLabels();
  const tasks = report.tasks ?? [];
  if (!tasks.length && !report.shortSessions) return null;
  const help = (t: CostTaskLine) => [t.project || 'Inbox', t.engines.join(', '), t.hosts.map(hostName).join(', '), volume(t.requests, totalTokens(t))].join(' · ');
  const row = (t: CostTaskLine) => <LineRow key={t.key} line={t} help={help(t)}
    onOpen={t.sessionId ? () => openSessionOnHome(t.sessionId!, navigate) : undefined} />;
  return (
    <SettingsGroup heading={heading} data-testid="usage-group-task">
      {tasks.map(row)}
      {report.moreTasks && <SettingsRow label={`${count(report.moreTasks.count, 'more task')}`}
        help={volume(report.moreTasks.requests, report.moreTasks.tokens)} control={<span className="usage-line-cost">{money(report.moreTasks.costUsd)}</span>} />}
      {report.shortSessions && <details className="usage-more" data-testid="usage-short-sessions">
        <summary>{`${count(report.shortSessions.count, 'short session')} (tests and one-offs) · ${money(report.shortSessions.costUsd)}`}</summary>
        {report.shortSessions.lines.map(row)}
      </details>}
    </SettingsGroup>
  );
}

function HowCounted({ report }: { report: CostReport }) {
  const hostName = useHostDisplayLabels();
  const asOf = report.prices.asOf ? new Date(report.prices.asOf).toLocaleDateString('en-US') : undefined;
  return (
    <details className="settings-group usage-how" data-testid="usage-how">
      <summary>How this is counted</summary>
      <SettingsGroup>
        <SettingsRow label="Prices" help={`Each request's tokens at the model's public list price${report.prices.source === 'litellm' ? ' (LiteLLM price list' : ' (built-in price list'}${asOf ? `, ${asOf})` : ')'}, at its prompt-size rate. An estimate, not a bill: discounts, credits and taxes are not known here.`} />
        <SettingsRow label="Sources" help="Claude Code: each host's transcripts, every response counted once. Codex and OpenCode: their own session records. Walnut: the Personal AI's chat from its transcripts, every other call as Walnut records it; the speech model runs on this Mac and costs nothing." />
        <SettingsRow label="Up to date" help={report.countedUntil.length
          ? report.countedUntil.map((u) => `${hostName(u.host)}: ${u.until ? new Date(u.until).toLocaleString('en-US') : 'not read yet'}`).join(' · ')
          : 'Nothing read yet. Update now reads every host.'} />
        {report.checks.filter((c) => c.source === 'Canonical transcript' || c.source === 'Upstream token log' || c.source === 'Host collection').map((c) => (
          <SettingsRow key={`${c.host}:${c.source}`} label={`${c.source} · ${hostName(c.host)}`}
            help={`${c.status === 'matched' ? 'Matched' : c.status === 'partial' ? 'Partly matched' : 'Not checked'}. ${c.detail}`} />
        ))}
      </SettingsGroup>
    </details>
  );
}
