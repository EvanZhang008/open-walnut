import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow, SettingsEmpty } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useUsageCosts } from '@/hooks/useUsageCosts';
import type { TimeSelection } from '@/hooks/useUsageOverview';
import { formatTokens } from '@/utils/format';
import { UsageDailyChart } from '@/components/usage/UsageDailyChart';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import { collectUsage, type CostLine, type CostReport, type CostTaskLine, type CostView, type DailyCost, type Period } from '@/api/usage';
import { openSessionOnHome } from '@/utils/open-session';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import '@/styles/settings-sections-addons.css';

const PRESETS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

const VIEWS: { value: CostView; label: string }[] = [
  { value: 'walnut', label: 'Walnut' },
  { value: 'agents', label: 'Agents' },
];

const VIEW_HELP: Record<CostView, string> = {
  walnut: "Walnut's own model calls: the Personal AI's chat, titles, parsing, summaries, search, plugins.",
  agents: 'Coding sessions: Claude Code, Codex, OpenCode and other engines, on every host.',
};

/** Rows shown before a group folds the rest into "N more". */
const VISIBLE = 8;

export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function totalTokens(line: CostLine): number {
  return line.tokens.input + line.tokens.output + line.tokens.cacheRead + line.tokens.cacheWrite;
}

export function UsageSection() {
  const [view, setView] = useState<CostView>('walnut');
  const [time, setTime] = useState<TimeSelection>({ preset: '7d' });
  const { report, current, loading, error, refresh, range } = useUsageCosts(view, time);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const update = async () => {
    setUpdating(true); setUpdateError('');
    try { await collectUsage(); await refresh(); }
    catch (err) { setUpdateError(err instanceof Error ? err.message : String(err)); }
    finally { setUpdating(false); }
  };
  const shown = current ?? report;
  const presetValue = (time.preset === 'custom' ? '' : time.preset) as Period;
  const chartSelectedDay = time.preset === 'custom' && time.start && time.start === time.end ? time.start : undefined;

  return (
    <SettingsSection
      id="usage"
      title="Usage & Costs"
      description="What models cost, estimated from tokens at public list prices."
      actions={(
        <SettingsButton className="usage-refresh-btn" onClick={update} busy={updating || !!shown?.collection?.running} busyLabel="Updating...">
          Update now
        </SettingsButton>
      )}
    >
      <SettingsGroup>
        <SettingsRow
          label="Show"
          help={VIEW_HELP[view]}
          control={<SegmentedControl aria-label="Show" value={view} onChange={(v) => setView(v)}
            options={VIEWS.map((v) => ({ value: v.value, label: v.label, testId: `usage-view-${v.value}` }))} />}
        />
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
        <div aria-busy={loading || undefined} data-testid="usage-costs" data-view={shown.view}>
          <Headline report={shown} />
          {shown.totals.requests === 0 ? (
            <SettingsGroup><SettingsEmpty>No model calls in this period.</SettingsEmpty></SettingsGroup>
          ) : (
            <>
              <SettingsGroup heading="By day">
                <div className="settings-row settings-row-stacked usage-chart-section" data-wide="true">
                  <UsageDailyChart data={chartDays(shown, range)} loading={loading} selectedDate={chartSelectedDay}
                    onSelectDay={(date) => {
                      if (chartSelectedDay === date) setTime({ preset: '7d' });
                      else setTime({ preset: 'custom', start: date, end: date });
                    }} />
                </div>
              </SettingsGroup>
              {shown.view === 'agents' && <TaskList report={shown} />}
              {shown.groups.map((group) => <LineGroup key={group.id} id={group.id} heading={group.heading} lines={group.lines} total={shown.totals.costUsd} />)}
            </>
          )}
          <HowCounted report={shown} />
        </div>
      )}
    </SettingsSection>
  );
}

function Headline({ report }: { report: CostReport }) {
  const t = report.totals;
  return (
    <SettingsGroup className="settings-addons-summary" data-testid="usage-summary">
      <div className="settings-addons-stats">
        <Stat value={money(t.costUsd)} label="Estimated cost" testId="usage-total-cost" />
        <Stat value={formatTokens(totalTokens(t))} label="Tokens" />
        <Stat value={t.requests.toLocaleString('en-US')} label="Requests" />
      </div>
      <p className="settings-addons-muted usage-headline-note">
        {`In ${formatTokens(t.tokens.input)} · out ${formatTokens(t.tokens.output)} · cache read ${formatTokens(t.tokens.cacheRead)} · cache write ${formatTokens(t.tokens.cacheWrite)}.`}
        {t.unpriced > 0 && ` ${count(t.unpriced, 'request')} with no public price (${report.unpricedModels.join(', ')}) ${t.unpriced === 1 ? 'is' : 'are'} not in the total.`}
      </p>
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
      help={help ?? `${count(line.requests, 'request')} · ${formatTokens(totalTokens(line))} tokens${share !== undefined ? ` · ${share.toFixed(share < 10 ? 1 : 0)}%` : ''}`}
      control={onOpen ? <SettingsButton onClick={onOpen}>{amount}</SettingsButton> : amount}
    />
  );
}

function LineGroup({ id, heading, lines, total }: { id: string; heading: string; lines: CostLine[]; total: number }) {
  const hostName = useHostDisplayLabels();
  if (!lines.length) return null;
  const label = (line: CostLine) => id === 'host' ? hostName(line.key) : line.label;
  const share = (line: CostLine) => total > 0 ? line.costUsd / total * 100 : undefined;
  const head = lines.slice(0, VISIBLE), rest = lines.slice(VISIBLE);
  return (
    <SettingsGroup heading={heading} data-testid={`usage-group-${id}`}>
      {head.map((line) => <LineRow key={line.key} line={line} label={label(line)} share={share(line)} />)}
      {rest.length > 0 && <details className="usage-more">
        <summary>{`${rest.length} more · ${money(rest.reduce((n, l) => n + l.costUsd, 0))}`}</summary>
        {rest.map((line) => <LineRow key={line.key} line={line} label={label(line)} share={share(line)} />)}
      </details>}
    </SettingsGroup>
  );
}

function TaskList({ report }: { report: CostReport }) {
  const navigate = useNavigate();
  const hostName = useHostDisplayLabels();
  const tasks = report.tasks ?? [];
  if (!tasks.length && !report.shortSessions) return null;
  const help = (t: CostTaskLine) => [t.project || 'Inbox', t.engines.join(', '), t.hosts.map(hostName).join(', '), count(t.requests, 'request')].join(' · ');
  const row = (t: CostTaskLine) => <LineRow key={t.key} line={t} help={help(t)}
    onOpen={t.sessionId ? () => openSessionOnHome(t.sessionId!, navigate) : undefined} />;
  return (
    <SettingsGroup heading="By task" data-testid="usage-group-task">
      {tasks.map(row)}
      {report.moreTasks && <SettingsRow label={`${count(report.moreTasks.count, 'more task')}`}
        help={count(report.moreTasks.requests, 'request')} control={<span className="usage-line-cost">{money(report.moreTasks.costUsd)}</span>} />}
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
        {report.view === 'agents'
          ? <SettingsRow label="Sources" help="Claude Code: each host's transcripts, every response counted once. Codex and OpenCode: their own session records." />
          : <SettingsRow label="Sources" help="The Personal AI's chat from its transcripts; every other call as Walnut records it. The speech model runs on this Mac and costs nothing." />}
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

/** One bar per day of the period, empty days included, in the chart's shape (the newest 400 days at most). */
function chartDays(report: CostReport, range: { start?: string; end?: string }): DailyCost[] {
  const byDate = new Map(report.daily.map((d) => [d.date, d]));
  const start = range.start ?? report.bounds.min ?? report.daily[0]?.date;
  const end = range.end ?? report.daily[report.daily.length - 1]?.date ?? start;
  const out: DailyCost[] = [];
  if (start && end) {
    const stop = Date.parse(`${end}T00:00:00Z`);
    for (let t = Math.max(Date.parse(`${start}T00:00:00Z`), stop - 399 * 86_400_000); t <= stop; t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const d = byDate.get(date);
      out.push({ date, cost_usd: d?.costUsd ?? 0, api_calls: d?.requests ?? 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });
    }
  }
  return out.length ? out : report.daily.map((d) => ({ date: d.date, cost_usd: d.costUsd, api_calls: d.requests, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }));
}
