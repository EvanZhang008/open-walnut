/**
 * The picker's cost line: what this session cost, priced per request from the
 * engine's own usage records (GET /api/sessions/:id/cost). One quiet line while
 * closed; open, it lists each model's requests and cost, and a model opens to the
 * rates it was priced at and where those rates came from.
 */
import React from 'react';
import { fetchSessionCost, fetchSessionCostComparison, type SessionCost, type SessionCostComparison, type SessionCostModel } from '@/api/session-cost';
import { log } from '@/utils/log';
import {
  cacheWriteTokens, costHeadline, costLineLabel, costModelLabel, costTimes, engineName, fmtCost, fmtPriceSource, fmtRate,
  fmtRates, fmtTokenCount, fmtUsd, tierLabel, visibleLines, comparisonLabel, comparisonRates, fmtRatio,
} from './session-cost-format';
import '@/styles/session-cost.css';

const PENDING_RETRIES = 20;
const PENDING_RETRY_MS = 2_000;

export interface CompareModel { id: string; label: string }

interface Props {
  sessionId: string;
  /** The live CLI's own model time, when the picker already pulled it. */
  liveApiMs?: number | null;
  /** The models the picker offers, for "same usage on other models". */
  compareModels?: CompareModel[];
}

const COMPARE_RETRIES = PENDING_RETRIES;

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
          {error ? <div className="session-cost-warn">The comparison {error}.</div>
            : !data ? <div className="session-cost-muted">Pricing every model…</div>
            : data.status === 'pending' ? <div className="session-cost-muted">{gaveUp ? 'The transcript is still being read; open this again in a minute.' : 'Reading the transcript…'}</div>
            : data.status !== 'ok' ? <div className="session-cost-muted">{data.reason ?? 'Nothing to compare yet.'}</div>
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
        <span className="session-cost-model-name">{open ? '▾' : '▸'} {costModelLabel(m.model, m.speed)}</span>
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

export function SessionCostBlock({ sessionId, liveApiMs, compareModels }: Props) {
  const [cost, setCost] = React.useState<SessionCost | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A closed picker gives its slot back at once: the low-priority lane holds two requests.
    const abort = new AbortController();
    setCost(null);
    setError(null);
    // A long first read answers `pending`; ask again until it lands (the host keeps reading).
    const load = (attempt: number) => {
      fetchSessionCost(sessionId, abort.signal)
        .then((c) => {
          if (cancelled) return;
          setCost(c);
          if (c.status === 'pending' && attempt < PENDING_RETRIES) timer = setTimeout(() => load(attempt + 1), PENDING_RETRY_MS);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          log.warn('session-cost', 'cost fetch failed', { sessionId, error: String(err) });
          setError('could not be read');
        });
    };
    load(0);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [sessionId]);

  const times = cost ? costTimes(cost, liveApiMs) : '';
  const expandable = !!cost && cost.models.length > 0;
  return (
    <div className="model-picker-details session-cost" data-testid="session-cost" data-status={cost?.status ?? (error ? 'error' : 'loading')}>
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
        </span>
        {times && (
          <span className="session-cost-times" data-testid="session-cost-times"
            title="Span: first to last request. Model time: the time the model spent answering, subagents included.">
            {times}
          </span>
        )}
      </button>
      {cost?.status === 'unavailable' && cost.reason && (
        <div className="session-cost-muted" data-testid="session-cost-reason">{cost.reason}</div>
      )}
      {open && cost && (
        <div className="session-cost-body">
          {cost.models.map((m) => <ModelRow key={`${m.model}:${m.speed}`} m={m} />)}
          <div className="session-cost-foot session-cost-muted">
            Priced per request from {engineName(cost.engine)}&apos;s own usage records ({cost.responses} requests
            {cost.engine === 'claude' ? ', subagents included' : ''}).
            {cost.engineCostUsd !== undefined && Math.abs(cost.engineCostUsd - (cost.totalUsd ?? 0)) >= 0.01
              ? ` ${engineName(cost.engine)}'s own estimate, from its built-in prices: ${fmtUsd(cost.engineCostUsd)}.`
              : ''}
          </div>
          <CostComparison sessionId={sessionId} models={compareModels ?? []} actualUsd={cost.status === 'priced' ? cost.totalUsd : null} />
        </div>
      )}
    </div>
  );
}
