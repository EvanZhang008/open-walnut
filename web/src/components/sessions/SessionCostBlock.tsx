/**
 * The picker's cost line: what this session cost, priced per request from the
 * engine's own usage records (GET /api/sessions/:id/cost). One quiet line while
 * closed; open, it lists each model's requests and cost, and a model opens to the
 * rates it was priced at and where those rates came from.
 */
import React from 'react';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { fetchSessionCostComparison, type SessionCost, type SessionCostComparison, type SessionCostModel } from '@/api/session-cost';
import { useSessionCost } from '@/hooks/useSessionCost';
import { log } from '@/utils/log';
import {
  cacheWriteTokens, costHeadline, costToggleValue, costLineLabel, costModelLabel, costTimes, engineName, fmtCost, fmtPriceSource, fmtRate,
  fmtRates, fmtTokenCount, fmtUsd, tierLabel, visibleLines, comparisonLabel, comparisonRates, fmtRatio,
} from './session-cost-format';
import { useOpenSessionUsage, useSessionBudgetUsage } from '@/hooks/useSessionBudgetUsage';
import { budgetSummary } from './session-usage-model';
import { FoldWarnDot } from './PickerFoldBar';
import '@/styles/session-cost.css';

/** The comparison's long first read answers `pending`: asked again this many times, this often. */
const COMPARE_RETRIES = 20;
const PENDING_RETRY_MS = 2_000;

export interface CompareModel { id: string; label: string }

interface Props {
  sessionId: string;
  /** The live CLI's own model time, when the picker already pulled it. */
  liveApiMs?: number | null;
  /** The models the picker offers, for "same usage on other models". */
  compareModels?: CompareModel[];
  /** The budget row (off where the budget itself is on show, as in Usage & Budget). */
  budgetRow?: boolean;
  /** The cost read the caller already holds (useSessionCost), so the block reads nothing itself. */
  read?: { cost: SessionCost | null; error: string | null };
  /** The picker's Cost fold: always open, no head of its own (the toggle names the total). */
  fold?: boolean;
}

const BUDGET_PAUSED = 'Budget reached: the session is paused';

/** A dot on the picker's Cost toggle while the session's budget has paused it: seen without opening. */
export function BudgetPausedMark({ sessionId }: { sessionId: string }) {
  const usage = useSessionBudgetUsage(sessionId, false);
  const data = usage.data?.sessionId === sessionId ? usage.data : null;
  if (data?.budget.state !== 'paused') return null;
  return <FoldWarnDot reason={BUDGET_PAUSED} testId="cost-budget-paused" />;
}

/** The session's budget in one line, with the way to set or change it. */
function BudgetRow({ sessionId }: { sessionId: string }) {
  const usage = useSessionBudgetUsage(sessionId, false);
  const open = useOpenSessionUsage();
  const data = usage.data?.sessionId === sessionId ? usage.data : null;
  if (!data && (!usage.error || usage.errorStatus === 400 || usage.errorStatus === 404)) return null;
  const paused = data?.budget.state === 'paused';
  return (
    <div className="session-cost-budget" data-testid="session-cost-budget" data-state={data?.budget.state ?? 'error'}>
      <span className="session-cost-budget-label">Budget</span>
      <span className="session-cost-budget-value">
        {paused && <FoldWarnDot reason={BUDGET_PAUSED} testId="session-cost-budget-paused" />}
        <strong data-testid="session-cost-budget-summary">{data ? budgetSummary(data) : <span className="session-cost-muted">{usage.error}</span>}</strong>
      </span>
      {data && open && (
        <button type="button" className="session-cost-budget-edit" onClick={() => open(sessionId)}>
          {data.budget.limitUsd === null ? 'Set budget' : 'Change'}
        </button>
      )}
    </div>
  );
}

/** The session's usage priced at other models' list prices; asked for only once opened. */
function CostComparison({ sessionId, models, actualUsd }: { sessionId: string; models: CompareModel[]; actualUsd: number | null }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<SessionCostComparison | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [gaveUp, setGaveUp] = React.useState(false);
  const ids = models.map((m) => m.id).join(',');
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setData(null);
    setError(null);
    setGaveUp(false);
    const load = (attempt: number) => {
      fetchSessionCostComparison(sessionId, ids ? ids.split(',') : [], abort.signal)
        .then((c) => {
          if (cancelled) return;
          setData(c);
          if (c.status !== 'pending') return;
          if (attempt < COMPARE_RETRIES) timer = setTimeout(() => load(attempt + 1), PENDING_RETRY_MS);
          else setGaveUp(true);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          log.warn('session-cost', 'cost comparison fetch failed', { sessionId, error: String(err) });
          setError('could not be read');
        });
    };
    load(0);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [open, sessionId, ids]);

  // The first row naming an id labels it (the picker lists its Default row last).
  const labels = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) if (!map.has(m.id)) map.set(m.id, m.label);
    return map;
  }, [models]);
  const groups = [
    { group: 'walnut' as const, title: 'In Walnut' },
    { group: 'popular' as const, title: 'Popular, not in Walnut' },
  ];
  return (
    <div className="session-cost-compare" data-testid="session-cost-compare">
      <button type="button" className="session-cost-compare-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} Same usage on other models
      </button>
      {open && (
        <div className="session-cost-compare-body" data-status={data?.status ?? (error ? 'error' : 'loading')}>
          {error ? <UnavailableState size="row" title={`The comparison ${error}`} />
            : !data ? <LoadingState size="row" title="Pricing every model…" />
            : data.status === 'pending'
              ? (gaveUp
                ? <EmptyState size="row" title="The transcript is still being read" hint="Open this again in a minute." />
                : <LoadingState size="row" title="Reading the transcript…" />)
            : data.status !== 'ok' ? <EmptyState size="row" title={data.reason ?? 'Nothing to compare yet'} />
            : (
              <>
                <table className="session-cost-table session-cost-compare-table" data-testid="session-cost-compare-table">
                  <thead>
                    <tr><th scope="col">Model</th><th scope="col">Cost</th><th scope="col">vs this session</th></tr>
                  </thead>
                  {groups.map(({ group, title }) => {
                    const rows = data.rows.filter((r) => r.group === group);
                    if (rows.length === 0) return null;
                    return (
                      <tbody key={group} data-group={group}>
                        <tr className="session-cost-tier"><th scope="rowgroup" colSpan={3}>{title}</th></tr>
                        {rows.map((r) => (
                          <tr key={r.key} data-key={r.key} className={r.current ? 'is-current' : undefined}
                            title={[comparisonRates(r), ...r.assumptions].join('\n')}>
                            <th scope="row">{comparisonLabel(r, labels)}{r.current ? ' · used in this session' : ''}</th>
                            <td>{fmtCost(r.costUsd)}</td>
                            <td>{fmtRatio(r.costUsd, actualUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    );
                  })}
                </table>
                <div className="session-cost-muted">
                  The same {data.responses.toLocaleString('en-US')} requests priced at each model&apos;s list price and prompt
                  tiers. Other models tokenize and cache differently, so read this as a guide. Hover a model for its prices.
                </div>
              </>
            )}
        </div>
      )}
    </div>
  );
}

/** Tokens × price per million = cost, one block per prompt tier, and the model's total. */
function CostTable({ m }: { m: SessionCostModel }) {
  const tiers = m.tiers ?? [];
  const threshold = m.rates?.threshold;
  return (
    <table className="session-cost-table" data-testid="session-cost-table">
      <thead>
        <tr><th scope="col" /><th scope="col">Tokens</th><th scope="col">Price / 1M</th><th scope="col">Cost</th></tr>
      </thead>
      {tiers.map((t) => (
        <tbody key={t.tier} data-tier={t.tier}>
          {threshold ? (
            <tr className="session-cost-tier">
              <th scope="rowgroup" colSpan={3}>{tierLabel(t, threshold)}</th>
              <td>{fmtCost(t.costUsd)}</td>
            </tr>
          ) : null}
          {visibleLines(t).map((l) => (
            <tr key={l.kind} data-kind={l.kind}>
              <th scope="row">{costLineLabel(l.kind)}</th>
              <td title={l.count.toLocaleString('en-US')}>
                {l.kind === 'webSearch' ? `${l.count.toLocaleString('en-US')} searches` : fmtTokenCount(l.count)}
              </td>
              <td>{l.kind === 'webSearch' ? `${fmtRate(l.rate)} / 1K` : fmtRate(l.rate)}</td>
              <td>{fmtCost(l.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      ))}
      <tfoot>
        <tr><th scope="row" colSpan={3}>Total</th><td data-testid="session-cost-table-total">{fmtCost(tiers.reduce((n, t) => n + t.costUsd, 0))}</td></tr>
      </tfoot>
    </table>
  );
}

function ModelRow({ m }: { m: SessionCostModel }) {
  const [open, setOpen] = React.useState(false);
  const r = m.rates;
  return (
    <div className="session-cost-model" data-testid="session-cost-model" data-model={m.model}>
      <button type="button" className="session-cost-model-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="session-cost-model-name wn-title">{open ? '▾' : '▸'} {costModelLabel(m.model, m.speed)}</span>
        <span className="session-cost-model-meta">
          {m.responses} req · {fmtTokenCount(m.tokens.input + m.tokens.cacheRead + cacheWriteTokens(m))} in · {fmtTokenCount(m.tokens.output)} out
        </span>
        <span className="session-cost-model-usd" data-testid="session-cost-model-usd">
          {m.costUsd === null ? 'no price' : fmtUsd(m.costUsd)}
        </span>
      </button>
      {open && (
        <div className="session-cost-model-detail" data-testid="session-cost-model-detail">
          {m.tiers && m.tiers.length > 0 ? <CostTable m={m} /> : r ? <div>Per million tokens: {fmtRates(r, r.singleCacheWrite)}</div> : null}
          {r?.threshold && r.long && (
            <div className="session-cost-muted">
              A request whose prompt is over {fmtTokenCount(r.threshold)} tokens pays the higher prices on all of its tokens.
            </div>
          )}
          {m.usRegionResponses > 0 && (
            <div className="session-cost-muted">{m.usRegionResponses} requests ran US-only; their cost includes the 1.1x US-region price.</div>
          )}
          {m.unpricedResponses > 0 && (
            <div className="session-cost-warn">{m.unpricedResponses} request{m.unpricedResponses === 1 ? '' : 's'} without a price: {m.unpricedReason}</div>
          )}
          {m.priceSource && <div className="session-cost-muted">Prices: {fmtPriceSource(m)}</div>}
        </div>
      )}
    </div>
  );
}

/** The Cost toggle's number: "$102", "$141+", "n/a", "…" while it is read. */
export function costToggleLabel({ cost, error }: { cost: SessionCost | null; error: string | null }): string {
  return cost ? costToggleValue(cost) : error ? 'n/a' : '…';
}

export function SessionCostBlock({ sessionId, liveApiMs, compareModels, budgetRow = true, read, fold = false }: Props) {
  // A caller that already reads the cost (the picker's Cost toggle) hands it in: one read per open.
  const own = useSessionCost(read ? null : sessionId);
  const { cost, error } = read ?? own;
  const [open, setOpen] = React.useState(false);
  const times = cost ? costTimes(cost, liveApiMs) : '';
  const expandable = !!cost && cost.models.length > 0;
  // The picker's Cost fold is the opened block (its toggle already says the total); a cost with
  // nothing priced to break down shows only its reason there, as the old disabled head did.
  const shown = (fold && expandable) || open;
  return (
    <div className={`model-picker-details session-cost${fold ? ' session-cost-fold' : ''}`} data-testid="session-cost" data-status={cost?.status ?? (error ? 'error' : 'loading')}>
      {fold ? (
        <div className="session-cost-fold-head">
          {/* "This session $102 · span 1d 17h · model time 2h 38m": the whole sentence where the toggle
              had to shorten it ("$141 + 4 requests without a price"). */}
          <span className="session-cost-title">
            This session <strong data-testid="session-cost-total">{cost ? costHeadline(cost) : error ?? 'calculating…'}</strong>
            {cost?.status === 'unavailable' && cost.reason && (
              <span className="session-cost-reason" data-testid="session-cost-reason">{cost.reason}</span>
            )}
          </span>
          {times && (
            <span className="session-cost-times" data-testid="session-cost-times"
              title="Span: first to last request. Model time: the time the model spent answering, subagents included.">
              {times}
            </span>
          )}
        </div>
      ) : (
      <button
        type="button"
        className="session-cost-head"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        title={expandable ? 'Cost per model, with the rates used' : undefined}
      >
        <span className="session-cost-title">
          {expandable ? (open ? '▾ ' : '▸ ') : ''}Cost{' '}
          <strong data-testid="session-cost-total">
            {cost ? costHeadline(cost) : error ?? 'calculating…'}
          </strong>
          {/* Why there is no price, on the same line (a row of its own grew the picker under the
              pointer when it landed); the whole sentence is the tooltip. */}
          {cost?.status === 'unavailable' && cost.reason && (
            <span className="session-cost-muted session-cost-reason" data-testid="session-cost-reason">{cost.reason}</span>
          )}
        </span>
        {times && (
          <span className="session-cost-times" data-testid="session-cost-times"
            title="Span: first to last request. Model time: the time the model spent answering, subagents included.">
            {times}
          </span>
        )}
      </button>
      )}
      {shown && cost && cost.models.map((m) => <ModelRow key={`${m.model}:${m.speed}`} m={m} />)}
      {budgetRow && <BudgetRow sessionId={sessionId} />}
      {shown && cost && (
        <>
          <CostComparison sessionId={sessionId} models={compareModels ?? []} actualUsd={cost.status === 'priced' ? cost.totalUsd : null} />
          <div className="session-cost-foot session-cost-muted">
            Priced per request from {engineName(cost.engine)}&apos;s own usage records ({cost.responses} requests
            {cost.engine === 'claude' ? ', subagents included' : ''}).
            {cost.engineCostUsd !== undefined && Math.abs(cost.engineCostUsd - (cost.totalUsd ?? 0)) >= 0.01
              ? ` ${engineName(cost.engine)}'s own estimate, from its built-in prices: ${fmtUsd(cost.engineCostUsd)}.`
              : ''}
          </div>
        </>
      )}
    </div>
  );
}
