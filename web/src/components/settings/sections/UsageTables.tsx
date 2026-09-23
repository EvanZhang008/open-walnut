/**
 * Usage & Costs tables, settings style (F11): sentence-case headers, one line
 * per cell with tabular numbers, the same column widths in every breakdown
 * table, no dash placeholders and no inner scroller or box.
 */
import type { UsageByGroup, UsageRecord } from '@/api/usage';
import { formatTokens } from '@/utils/format';
import { usageDisplayName } from '@/utils/usageLabels';

/** "Sep 23, 1:25 AM": one date and time format across settings (F32). */
export function usageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Built from two parts: WebKit joins a combined date+time format with "at".
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** A `YYYY-MM-DD` day as "Sep 16", read in local time. */
export function usageDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(day);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Heading trailer for Recent activity: "Since Sep 16", "Sep 16 to Sep 20" or "All time" (F12). */
export function usageRangeHint(start?: string | null, end?: string | null): string {
  if (!start) return 'All time';
  if (end && end !== start) return `${usageDay(start)} to ${usageDay(end)}`;
  if (end === start) return usageDay(start);
  return `Since ${usageDay(start)}`;
}

/**
 * A row name as the table shows it: the shared label, with a bare lowercase
 * id (a feature such as `jev`) capitalized like every other name (N09).
 */
export function usageName(raw: string): string {
  const label = usageDisplayName(raw);
  return /^[a-z][a-z0-9]*$/.test(label) ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/**
 * Token counts a source never reported (a CLI engine records only cost) show
 * as a dash, not as a 0 next to a real cost (N09).
 */
export function tokensUnknown(row: { cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number }): boolean {
  return row.cost_usd > 0 && !row.input_tokens && !row.output_tokens && !row.cache_read_tokens && !row.cache_creation_tokens;
}

export function shortModel(m: string): string {
  return m.replace(/^(global\.anthropic\.|us\.|eu\.)/, '');
}

interface BreakdownProps {
  data: UsageByGroup[];
  loading: boolean;
  activeName?: string;
  onSelect?: (name: string) => void;
}

export function SettingsUsageBreakdown({ data, loading, activeName, onSelect }: BreakdownProps) {
  if (data.length === 0) return <p className="settings-usage-empty">{loading ? 'Loading...' : 'No calls in this period.'}</p>;
  return (
    <table className="settings-usage-table settings-usage-breakdown">
      <colgroup>
        <col className="settings-usage-col-name" />
        <col className="settings-usage-col-num" />
        <col className="settings-usage-col-num" />
        <col className="settings-usage-col-cache" />
        <col className="settings-usage-col-cache" />
        <col className="settings-usage-col-num" />
        <col className="settings-usage-col-share" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col" className="num">Cost</th>
          <th scope="col" className="num">Input</th>
          <th scope="col" className="num">Cache read</th>
          <th scope="col" className="num">Cache write</th>
          <th scope="col" className="num">Output</th>
          <th scope="col" className="num">Share</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => {
          const active = activeName === row.name;
          const label = usageName(row.name);
          const unknown = tokensUnknown(row);
          const tokens = (n: number) => (unknown ? <span title="Not recorded for this source">-</span> : formatTokens(n));
          return (
            <tr
              key={row.name}
              className={active ? 'is-active' : undefined}
              onClick={onSelect ? () => onSelect(row.name) : undefined}
              title={onSelect ? (active ? 'Click to clear this filter' : `Filter to ${label}`) : undefined}
            >
              <td title={label}>{label}</td>
              <td className="num">${row.cost_usd.toFixed(2)}</td>
              <td className="num">{tokens(row.input_tokens)}</td>
              <td className="num">{tokens(row.cache_read_tokens)}</td>
              <td className="num">{tokens(row.cache_creation_tokens)}</td>
              <td className="num">{tokens(row.output_tokens)}</td>
              <td className="num settings-usage-share">
                <span className="settings-usage-share-track" aria-hidden="true">
                  <span className="settings-usage-share-fill" style={{ width: `${Math.min(100, row.percentage)}%` }} />
                </span>
                {row.percentage.toFixed(1)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SettingsUsageRecent({ data, loading }: { data: UsageRecord[]; loading: boolean }) {
  if (data.length === 0) return <p className="settings-usage-empty">{loading ? 'Loading...' : 'No activity in this period.'}</p>;
  return (
    <table className="settings-usage-table settings-usage-recent">
      <colgroup>
        <col className="settings-usage-col-time" />
        <col className="settings-usage-col-source" />
        <col className="settings-usage-col-model" />
        <col className="settings-usage-col-num" />
        <col className="settings-usage-col-num" />
        <col className="settings-usage-col-cost" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Source</th>
          <th scope="col">Model</th>
          <th scope="col" className="num">Input</th>
          <th scope="col" className="num">Output</th>
          <th scope="col" className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => {
          const source = usageName(r.source);
          const via = [r.parent_source ? `via ${usageName(r.parent_source)}` : '', r.agentId ? `agent ${usageName(r.agentId)}` : '']
            .filter(Boolean).join(', ');
          const cache = `Cache read ${formatTokens(r.cache_read_input_tokens)}, cache write ${formatTokens(r.cache_creation_input_tokens)}`;
          const unknown = tokensUnknown({ cost_usd: r.cost_usd, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
            cache_read_tokens: r.cache_read_input_tokens, cache_creation_tokens: r.cache_creation_input_tokens });
          return (
            <tr key={r.id} title={cache}>
              <td className="num-font">{usageTime(r.timestamp)}</td>
              <td title={via ? `${source}, ${via}` : source}>
                {source}
                {via && <span className="settings-usage-via"> {via}</span>}
              </td>
              <td className="mono" title={r.model}>{shortModel(r.model)}</td>
              <td className="num">{unknown ? <span title="Not recorded for this source">-</span> : formatTokens(r.input_tokens)}</td>
              <td className="num">{unknown ? <span title="Not recorded for this source">-</span> : formatTokens(r.output_tokens)}</td>
              <td className="num">${r.cost_usd.toFixed(4)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
