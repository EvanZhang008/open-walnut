import type { UsageRecord } from '@/api/usage';
import { formatTokens } from '@/utils/format';

interface Props {
  data: UsageRecord[];
  loading: boolean;
}

export function UsageRecentTable({ data, loading }: Props) {
  if (loading && data.length === 0) return <div className="usage-table-placeholder">Loading...</div>;
  if (data.length === 0) return <div className="usage-table-placeholder">No activity recorded yet</div>;

  return (
    <div className="usage-recent-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Source</th>
            <th>Model</th>
            <th className="num">Input</th>
            <th className="num">Cache Read</th>
            <th className="num">Cache Write</th>
            <th className="num">Output</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id}>
              <td className="mono">{formatTime(r.timestamp)}</td>
              <td>
                <span className="usage-source-badge">{r.source}</span>
                {r.parent_source && <span className="usage-parent-source">via {r.parent_source}</span>}
              </td>
              <td className="mono">{shortenModel(r.model)}</td>
              <td className="num">{formatTokens(r.input_tokens)}</td>
              <td className="num">{formatTokens(r.cache_read_input_tokens)}</td>
              <td className="num">{formatTokens(r.cache_creation_input_tokens)}</td>
              <td className="num">{formatTokens(r.output_tokens)}</td>
              <td className="num">${r.cost_usd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortenModel(m: string): string {
  // Remove prefix like "global.anthropic." for display
  return m.replace(/^(global\.anthropic\.|us\.|eu\.)/, '');
}

