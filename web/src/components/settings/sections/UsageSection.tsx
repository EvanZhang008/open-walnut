import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow, SettingsEmpty } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { usePersistentState } from '@/hooks/usePersistentState';
import { useUsageCosts } from '@/hooks/useUsageCosts';
import type { TimeSelection } from '@/hooks/useUsageOverview';
import { formatTokens as formatTokenCount } from '@/utils/format';
import { timeAgo } from '@/utils/time';
import { UsageBreakdownCard } from '@/components/usage/UsageBreakdownCard';
import { UsageAccounts } from '@/components/usage/UsageAccounts';
import { dayLabel, periodDays } from '@/components/usage/breakdown-model';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import { collectUsage, type CostLine, type CostOrigin, type CostReport, type CostTaskLine, type Period } from '@/api/usage';
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

const ORIGINS: { value: CostOrigin; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'walnut', label: 'Walnut' }, { value: 'outside', label: 'Outside Walnut' },
];
const isOrigin = (v: unknown): v is CostOrigin => ORIGINS.some((o) => o.value === v);

/** A choice names what it holds in this period, so the filter shows what it leaves out. */
function originLabel(value: CostOrigin, label: string, report: CostReport | null | undefined): string {
  const s = report?.started;
  if (!s) return label;
  const usd = value === 'all' ? s.walnut.costUsd + s.outside.costUsd + (s.imported?.costUsd ?? 0) : s[value].costUsd;
  return `${label} ${money(usd)}`;
}

export function UsageSection() {
  const [time, setTime] = useState<TimeSelection>({ preset: '30d' });
  const [origin, setOrigin] = usePersistentState<CostOrigin>('walnut-usage-origin', 'all', isOrigin);
  const { report, current, keptAt, loading, error, refresh, range } = useUsageCosts('all', time, 'all', origin);
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
        <SettingsRow
          label="Started by"
          title="Work Walnut started, or Claude Code and Codex sessions it did not (a terminal claude, an agent's claude -p, a codex exec from a shell, the Codex app). Both count by default."
          control={
            <SegmentedControl aria-label="Started by" value={origin} onChange={setOrigin}
              options={ORIGINS.map((o) => ({ value: o.value, label: originLabel(o.value, o.label, shown), testId: `usage-origin-${o.value}` }))} />
          }
        />
      </SettingsGroup>

      {(shown?.started?.imported?.costUsd ?? 0) > 0 && (
        <p className="settings-addons-muted usage-headline-note" data-testid="usage-imported-note">
          {`All also counts ${money(shown!.started!.imported!.costUsd)} imported from the usage bill. A bill covers whole days of the account, so Walnut and Outside Walnut leave those days out: the bill already includes them.`}
        </p>
      )}

      {error && <SettingsNotice kind="error" role="alert">{`Couldn't load usage: ${error}`}</SettingsNotice>}
      {updateError && <SettingsNotice kind="error" role="alert">{updateError}</SettingsNotice>}
      {keptAt !== null && (
        <SettingsNotice kind="info"><span data-testid="usage-kept">{`Showing the report read ${timeAgo(new Date(keptAt).toISOString(), { long: true })}; reading it again.`}</span></SettingsNotice>
      )}
      {shown && !shown.ready && <SettingsNotice kind="info">Adding up past usage. The numbers fill in within a minute.</SettingsNotice>}

      {!shown ? (
        <SettingsGroup><SettingsLoadingRow>Loading usage...</SettingsLoadingRow></SettingsGroup>
      ) : (
        <div aria-busy={loading || undefined} data-testid="usage-costs" data-view={shown.view}>
          <Headline report={shown} days={days} origin={origin} />
          {shown.totals.requests === 0 ? (
            <SettingsGroup><SettingsEmpty>No model calls in this period.</SettingsEmpty></SettingsGroup>
          ) : (
            <>
              <UsageBreakdownCard report={shown} days={days} loading={loading}
                onPick={(b) => setTime(time.preset === 'custom' && time.start === b.start && time.end === b.end
                  ? { preset: '30d' } : { preset: 'custom', start: b.start, end: b.end })} />
              <UsageAccounts accounts={shown.accounts} />
              <TaskList report={shown} heading="Most expensive tasks" />
            </>
          )}
          <HowCounted report={shown} />
        </div>
      )}
    </SettingsSection>
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

function Headline({ report, days, origin }: { report: CostReport; days: string[]; origin: CostOrigin }) {
  const t = report.totals;
  const unpriced = unpricedNote(report);
  const busiest = report.daily.reduce<CostReport['daily'][number] | undefined>((m, d) => (!m || d.costUsd > m.costUsd ? d : m), undefined);
  // Walnut or Outside Walnut alone show nothing on the days an imported bill covers, so their average is over the days that have usage.
  const billed = (report.started?.imported?.costUsd ?? 0) > 0;
  const dayCount = Math.max(1, origin !== 'all' && billed ? report.daily.filter((d) => d.costUsd > 0).length : days.length);
  // Codex usage that bills the account Codex is signed in to, not a proxy: shown beside the total so it is not missed.
  const direct = (report.accounts ?? []).filter((a) => a.direct).reduce((n, a) => n + a.costUsd, 0);
  return (
    <SettingsGroup className="settings-addons-summary" data-testid="usage-summary">
      <div className="settings-addons-stats" data-count={direct > 0 ? 4 : 3}>
        <Stat value={money(t.costUsd)} label="Estimated cost" testId="usage-total-cost" />
        <Stat value={money(t.costUsd / dayCount)} label="Average day" testId="usage-average-day" />
        {direct > 0 && <Stat value={money(direct)} label="Billed directly" testId="usage-direct-cost" />}
        <Stat value={busiest && busiest.costUsd > 0 ? money(busiest.costUsd) : '-'} label={busiest && busiest.costUsd > 0 ? `Busiest day, ${dayLabel(busiest.date)}` : 'Busiest day'} />
      </div>
      {direct > 0 && (
        <p className="settings-addons-muted usage-headline-note" data-testid="usage-direct-note">
          Billed directly: Codex requests on an account of its own, not through a proxy. They are part of the total.
        </p>
      )}
      <p className="settings-addons-muted usage-headline-note" data-testid="usage-volume">
        {`${formatTokens(totalTokens(t))} tokens · ${count(t.requests, 'request')}: in ${formatTokens(t.tokens.input)} · out ${formatTokens(t.tokens.output)} · cache read ${formatTokens(t.tokens.cacheRead)} · cache write ${formatTokens(t.tokens.cacheWrite)}.`}
      </p>
      {unpriced && <p className="settings-addons-muted usage-headline-note" data-testid="usage-unpriced">{unpriced}</p>}
    </SettingsGroup>
  );
}

function Stat({ value, label, testId, highlight }: { value: string; label: string; testId?: string; highlight?: boolean }) {
  return (
    <div className="settings-addons-stat" data-testid={testId} data-direct={highlight || undefined}
      title={highlight ? 'Codex requests billed to the account Codex is signed in to, not through a proxy.' : undefined}>
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
