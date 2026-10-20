/**
 * The picker's cost line: what this session cost, priced per request from the
 * engine's own usage records (GET /api/sessions/:id/cost). One quiet line while
 * closed; open, it lists each model's requests and cost, and a model opens to the
 * rates it was priced at and where those rates came from.
 */
import React from 'react';
import { fetchSessionCost, type SessionCost, type SessionCostModel } from '@/api/session-cost';
import { log } from '@/utils/log';
import {
  cacheWriteTokens, costHeadline, costModelLabel, costTimes, engineName, fmtPriceSource, fmtRate, fmtRates,
  fmtTokenCount, fmtUsd,
} from './session-cost-format';
import '@/styles/session-cost.css';

const PENDING_RETRIES = 20;
const PENDING_RETRY_MS = 2_000;

interface Props {
  sessionId: string;
  /** The live CLI's own model time, when the picker already pulled it. */
  liveApiMs?: number | null;
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
          {r ? (
            <>
              <div>Per million tokens: {fmtRates(r, r.singleCacheWrite)}</div>
              {r.threshold && r.long && (
                <div>
                  Prompt above {fmtTokenCount(r.threshold)}: {fmtRates(r.long, r.singleCacheWrite)}
                  {` (${m.longResponses} of ${m.responses} requests)`}
                </div>
              )}
              <div className="session-cost-muted">Price: {fmtPriceSource(m)}</div>
            </>
          ) : null}
          <div className="session-cost-muted">
            Tokens: {fmtTokenCount(m.tokens.input)} input · {fmtTokenCount(m.tokens.cacheRead)} cache read
            {' · '}{fmtTokenCount(cacheWriteTokens(m))} cache write
            {m.tokens.cacheWrite1h > 0 ? ` (${fmtTokenCount(m.tokens.cacheWrite1h)} for 1h)` : ''}
            {' · '}{fmtTokenCount(m.tokens.output)} output
          </div>
          {m.usRegionResponses > 0 && (
            <div className="session-cost-muted">{m.usRegionResponses} requests ran US-only, billed at 1.1x.</div>
          )}
          {m.webSearches > 0 && (
            <div className="session-cost-muted">{m.webSearches} web searches at {fmtRate(10)} per thousand.</div>
          )}
          {m.unpricedResponses > 0 && (
            <div className="session-cost-warn">{m.unpricedResponses} request{m.unpricedResponses === 1 ? '' : 's'} without a price: {m.unpricedReason}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionCostBlock({ sessionId, liveApiMs }: Props) {
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
        </div>
      )}
    </div>
  );
}
