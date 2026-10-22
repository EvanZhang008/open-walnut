/** Pure formatting for the picker's cost block (SessionCostBlock). */
import { formatModelName } from '@/utils/model-name';
import type { SessionCost, SessionCostLine, SessionCostModel, SessionCostRates, SessionCostTier } from '@/api/session-cost';

/** $29.19, $0.42, $0.0031 (small amounts keep two significant digits). */
export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n === 0) return '$0';
  return `$${n.toPrecision(2)}`;
}

/** A per-million rate: $4, $0.2, $0.125. */
export function fmtRate(n: number): string {
  return `$${Number(n.toPrecision(4))}`;
}

/** A table cell amount: $1,234.56, $0.16, $0.0031. */
export function fmtCost(n: number): string {
  if (n >= 0.01) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return fmtUsd(n);
}

const LINE_LABELS: Record<SessionCostLine['kind'], string> = {
  input: 'Input', cacheWrite: 'Cache write', cacheWrite5m: 'Cache write (5m)', cacheWrite1h: 'Cache write (1h)',
  cacheRead: 'Cache read', output: 'Output', webSearch: 'Web search',
};
export function costLineLabel(kind: SessionCostLine['kind']): string { return LINE_LABELS[kind]; }

/** The rows worth a line: anything that was used or cost something. */
export function visibleLines(tier: SessionCostTier): SessionCostLine[] {
  return tier.lines.filter(l => l.count > 0 || l.costUsd > 0);
}

/** "Prompt up to 272K · 1,052 requests" / "Prompt over 272K · 746 requests"; "" for a model with one price. */
export function tierLabel(tier: SessionCostTier, threshold?: number): string {
  const n = `${tier.responses.toLocaleString('en-US')} request${tier.responses === 1 ? '' : 's'}`;
  if (!threshold) return '';
  return `Prompt ${tier.tier === 'long' ? 'over' : 'up to'} ${fmtTokenCount(threshold)} · ${n}`;
}

export function fmtTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** 45s, 12m, 3h 4m, 5d 11h. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** claude-opus-5-5 → Opus 5.5; gpt-6-1-sol → GPT-6.1 Sol; anything else as reported. */
export function costModelLabel(model: string, speed?: string): string {
  let label: string;
  const gpt = /^gpt-(\d+)(?:-(\d+))?-([a-z]+)$/.exec(model);
  if (gpt) label = `GPT-${gpt[1]}${gpt[2] ? `.${gpt[2]}` : ''} ${gpt[3]!.charAt(0).toUpperCase()}${gpt[3]!.slice(1)}`;
  else if (/^claude-/.test(model)) label = formatModelName(model);
  else label = model;
  return speed === 'fast' ? `${label} fast` : label;
}

export function cacheReadTokens(m: SessionCostModel): number { return m.tokens.cacheRead; }
export function cacheWriteTokens(m: SessionCostModel): number {
  return m.tokens.cacheWrite5m + m.tokens.cacheWrite1h + m.tokens.cacheWrite;
}

/** "$4 in · $20 out · $0.2 cache read · $5 / $8 cache write (5m / 1h)" */
export function fmtRates(r: Omit<SessionCostRates, 'threshold' | 'long'>, single?: boolean): string {
  const parts = [`${fmtRate(r.input)} in`, `${fmtRate(r.output)} out`];
  if (r.cacheRead !== undefined) parts.push(`${fmtRate(r.cacheRead)} cache read`);
  if (r.cacheWrite !== undefined) {
    parts.push(!single && r.cacheWrite1h !== undefined
      ? `${fmtRate(r.cacheWrite)} / ${fmtRate(r.cacheWrite1h)} cache write (5m / 1h)`
      : `${fmtRate(r.cacheWrite)} cache write`);
  }
  return parts.join(' · ');
}

export function fmtPriceSource(m: SessionCostModel): string {
  const src = m.priceSource;
  if (!src) return '';
  if (src.kind === 'override') return `your price for ${src.key} (config.yaml usage.prices)`;
  if (src.kind === 'builtin') return `Walnut's built-in table (${src.key})`;
  const day = src.asOf ? new Date(src.asOf).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `LiteLLM price list (${src.key}${day ? `, ${day}` : ''})`;
}

/** The headline after "Cost": the amount, plus what it leaves out. */
export function costHeadline(cost: SessionCost): string {
  if (cost.status === 'unavailable') return 'not available';
  if (cost.status === 'pending') {
    const p = cost.pending;
    const pct = p && p.totalBytes > 0 ? ` (${Math.min(99, Math.floor((p.readBytes / p.totalBytes) * 100))}%)` : '';
    return `reading the transcript${pct}…`;
  }
  if (cost.status === 'empty') return '$0 so far';
  const missing = `${cost.unpricedResponses} request${cost.unpricedResponses === 1 ? '' : 's'} without a price`;
  if (cost.totalUsd === null) return `unknown (${missing})`;
  const base = fmtUsd(cost.totalUsd);
  return cost.unpricedResponses > 0 ? `${base} + ${missing}` : base;
}

/** "span 5d 11h · model time 1h 6m": first to last request, and the time the model spent answering. */
export function costTimes(cost: SessionCost, liveApiMs?: number | null): string {
  const parts: string[] = [];
  if (cost.firstAt && cost.lastAt) {
    const span = Date.parse(cost.lastAt) - Date.parse(cost.firstAt);
    if (span >= 1000) parts.push(`span ${fmtDuration(span)}`);
  }
  const api = liveApiMs ?? cost.apiDurationMs;
  if (api && api >= 1000) parts.push(`model time ${fmtDuration(api)}`);
  return parts.join(' · ');
}

export function engineName(engine: string): string {
  return engine === 'claude' ? 'Claude Code' : engine === 'codex' ? 'Codex' : engine === 'opencode' ? 'OpenCode' : engine;
}
