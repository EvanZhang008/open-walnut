import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow, SettingsEmpty } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useUsageOverview } from '@/hooks/useUsageOverview';
import { formatTokens } from '@/utils/format';
import { UsageDailyChart } from '@/components/usage/UsageDailyChart';
import { SettingsUsageBreakdown, SettingsUsageRecent, usageRangeHint } from './UsageTables';
import { UsageFilterChips, chipValue, type Chip } from '@/components/usage/UsageFilterChips';
import { UsageDateRange } from '@/components/usage/UsageDateRange';
import { collectUsage, type Period } from '@/api/usage';
import { openSessionOnHome } from '@/utils/open-session';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import '@/styles/settings-sections-addons.css';

const PRESETS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

export function UsageSection() {
  const navigate = useNavigate();
  const hostName = useHostDisplayLabels();
  const { overview, loading, error, time, setTime, drill, setDrill, clearDrill, refresh, effectiveRange } = useUsageOverview();
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState('');
  const collect = async () => {
    setCollecting(true); setCollectError('');
    try { await collectUsage(); refresh(); }
    catch (error) { setCollectError(error instanceof Error ? error.message : String(error)); }
    finally { setCollecting(false); }
  };

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

  const summary = overview?.summary ?? null;
  const empty = !loading && !error && summary !== null && summary.api_calls === 0 && chips.length === 0;
  // The first read has no numbers yet: one loading row, not three `--` stats that
  // may turn into the empty sentence a moment later. A refresh keeps the numbers.
  const firstLoad = loading && summary === null && !error;
  const presetValue = (time.preset === 'custom' ? '' : time.preset) as Period;
  const rangeHint = usageRangeHint(effectiveRange.start, effectiveRange.end);

  return (
    <SettingsSection
      id="usage"
      title="Usage & Costs"
      actions={(
        <SettingsButton className="usage-refresh-btn" onClick={collect} busy={collecting || overview?.collection?.running} busyLabel="Checking sources...">
          Check sources
        </SettingsButton>
      )}
    >
      <SettingsGroup>
        <SettingsRow
          label="Period"
          control={
            <span className="settings-addons-inline usage-period-tabs">
              <SegmentedControl
                aria-label="Period"
                value={presetValue}
                onChange={(v) => setTime({ preset: v })}
                options={PRESETS.map((p) => ({ value: p.value, label: p.label, testId: `usage-period-${p.value}` }))}
              />
              <UsageDateRange
                active={time.preset === 'custom'}
                start={time.start}
                end={time.end}
                bounds={bounds}
                onApply={(start, end) => setTime({ preset: 'custom', start, end })}
              />
            </span>
          }
        />
        {chips.length > 0 && (
          <div className="settings-row">
            <UsageFilterChips chips={chips} onClearAll={clearDrill} />
          </div>
        )}
      </SettingsGroup>

      {error && <SettingsNotice kind="error" role="alert">{`Couldn't load usage: ${error}`}</SettingsNotice>}
      {collectError && <SettingsNotice kind="error" role="alert">{collectError}</SettingsNotice>}
      {overview?.accuracy && <details className="settings-group" data-testid="usage-evidence">
        <summary>Source checks · {overview.accuracy.status === 'verified' ? 'Matched' : 'Partial coverage'}</summary>
        <SettingsGroup heading="Evidence">
        <SettingsRow label={overview.accuracy.note} help={`${overview.accuracy.timezone} · Prices ${overview.accuracy.pricingVersion}${overview.accuracy.until ? ` · Checked ${new Date(overview.accuracy.until).toLocaleString('en-US')}` : ''}`} />
        {overview.accuracy.checks.map(check => <div className="settings-row settings-row-stacked" key={`${check.host}:${check.source}`}>
          <div><strong>{check.source}</strong> <span className="settings-addons-muted">{hostName(check.host)} · {check.status === 'matched' ? 'Matched' : 'Unverified'}</span></div>
          <p className="settings-addons-muted">{check.detail} {check.matchedCalls > 0 && `${check.matchedCalls.toLocaleString()} matched calls. `}{check.unmatchedCalls > 0 && `${check.unmatchedCalls.toLocaleString()} unmatched calls.`}</p>
          {!!check.residuals?.length && <details><summary>Unmatched tokens by model</summary>
            {check.residuals.map(r => <p key={`${r.source}:${r.model}`}><strong>{r.model}</strong>: {r.count} calls, input {r.input_tokens === null ? 'Unknown' : formatTokens(r.input_tokens)}, output {r.output_tokens === null ? 'Unknown' : formatTokens(r.output_tokens)}, cache read {r.cache_read_input_tokens === null ? 'Unknown' : formatTokens(r.cache_read_input_tokens)}, cache write {r.cache_creation_input_tokens === null ? 'Unknown' : formatTokens(r.cache_creation_input_tokens)}</p>)}
          </details>}
        </div>)}
        </SettingsGroup>
      </details>}

      {firstLoad ? (
        <SettingsGroup>
          <SettingsLoadingRow>Loading usage...</SettingsLoadingRow>
        </SettingsGroup>
      ) : empty ? (
        <SettingsGroup>
          <SettingsEmpty>No response evidence collected for this period. Check sources to rebuild usage.</SettingsEmpty>
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup className="settings-addons-summary" data-testid="usage-summary">
            <div className="settings-addons-stats" aria-busy={loading || undefined}>
              <Stat value={summary && (summary.verified_calls ?? 0) > 0 ? `$${summary.total_cost.toFixed(2)}` : 'Unverified'} label="Verified token estimate" />
              <Stat value={summary ? String(summary.verified_calls ?? 0) : '--'} label="Matched calls" />
              <Stat value={summary ? String(summary.unverified_calls ?? 0) : '--'} label="Unverified calls" />
              <Stat value={summary ? summary.token_counts_complete === false ? 'Unknown' : formatTokens(summary.input_tokens + summary.output_tokens) : '--'} label="Tokens in and out" />
            </div>
          </SettingsGroup>

          {!!overview?.sessions?.length && <SettingsGroup heading="By task" headingTrailing="Includes coding sessions">
            {overview.sessions.slice(0, 10).map(session => <SettingsRow key={session.sessionId}
              label={session.title || 'Untitled task'}
              help={`${session.project || 'Inbox'} · ${hostName(session.host)} · ${session.calls.toLocaleString()} calls${session.unverified ? ` · ${session.unverified.toLocaleString()} unverified` : ''}`}
              control={<SettingsButton onClick={() => openSessionOnHome(session.sessionId, navigate)}>
                {session.unverified === session.calls ? 'Unverified' : `$${session.cost.toFixed(2)}`}
              </SettingsButton>} />)}
            {overview.sessions.length > 10 && <details><summary>{overview.sessions.length - 10} more tasks</summary>
              {overview.sessions.slice(10).map(session => <SettingsRow key={session.sessionId} label={session.title || 'Untitled task'}
                help={`${session.project || 'Inbox'} · ${session.calls.toLocaleString()} calls`}
                control={<SettingsButton onClick={() => openSessionOnHome(session.sessionId, navigate)}>{session.unverified === session.calls ? 'Unverified' : `$${session.cost.toFixed(2)}`}</SettingsButton>} />)}
            </details>}
          </SettingsGroup>}

          <SettingsGroup heading="Daily costs" headingTrailing="Verified calls only">
            <div className="settings-row settings-row-stacked usage-chart-section" data-wide="true">
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
          </SettingsGroup>

          {([
            ['By source', overview?.bySource, drill.source, (name: string) => setDrill((d) => ({ ...d, source: d.source === name ? undefined : name }))],
            ['By agent', overview?.byAgent, drill.agentId, (name: string) => setDrill((d) => ({ ...d, agentId: d.agentId === name ? undefined : name }))],
            ['By model', overview?.byModel, drill.model, (name: string) => setDrill((d) => ({ ...d, model: d.model === name ? undefined : name }))],
          ] as const).map(([heading, data, active, onSelect]) => (
            <SettingsGroup key={heading} heading={heading}>
              <div className="settings-row settings-row-stacked usage-breakdown-panel" data-wide="true">
                <SettingsUsageBreakdown data={data ?? []} loading={loading} activeName={active} onSelect={onSelect} />
              </div>
            </SettingsGroup>
          ))}

          {summary && (
            <SettingsGroup heading="Cache efficiency" className="usage-cache-card">
              <CacheStats summary={summary} />
            </SettingsGroup>
          )}

          <SettingsGroup heading="Recent activity" headingTrailing={rangeHint}>
            <div className="settings-row settings-row-stacked usage-recent-section" data-wide="true">
              <SettingsUsageRecent data={overview?.recent ?? []} loading={loading} />
            </div>
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="settings-addons-stat">
      <span className="settings-addons-stat-value">{value}</span>
      <span className="settings-addons-stat-label">{label}</span>
    </div>
  );
}

function CacheStats({ summary }: { summary: NonNullable<ReturnType<typeof useUsageOverview>['overview']>['summary'] }) {
  const unknown = summary.token_counts_complete === false;
  const totalIn = summary.input_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
  const hitRate = unknown ? null : totalIn > 0 ? (summary.cache_read_tokens / totalIn) * 100 : 0;
  const fmt = (n: number) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'k' : String(n));
  const stats = [
    { label: 'Cache hit rate', value: hitRate === null ? 'Unknown' : `${hitRate.toFixed(1)}%` },
    { label: 'Total input', value: unknown ? 'Unknown' : fmt(totalIn) },
    { label: 'Cache read', value: unknown ? 'Unknown' : fmt(summary.cache_read_tokens) },
    { label: 'Cache write', value: unknown ? 'Unknown' : fmt(summary.cache_creation_tokens) },
    { label: 'Uncached input', value: unknown ? 'Unknown' : fmt(summary.input_tokens) },
  ];
  return (
    <>
      {stats.map((s) => (
        <SettingsRow
          key={s.label}
          className="usage-cache-stat"
          label={s.label}
          control={<span className="settings-addons-muted usage-cache-value">{s.value}</span>}
        />
      ))}
    </>
  );
}
