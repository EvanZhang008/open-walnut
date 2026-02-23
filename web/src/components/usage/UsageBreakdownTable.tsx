import type { UsageByGroup } from '@/api/usage';
import { formatTokens } from '@/utils/format';

interface Props {
  data: UsageByGroup[];
  loading: boolean;
}

export function UsageBreakdownTable({ data, loading }: Props) {
  if (loading && data.length === 0) return <div className="usage-table-placeholder">Loading...</div>;
  if (data.length === 0) return <div className="usage-table-placeholder">No data</div>;

  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>Name</th>
          <th className="num">Cost</th>
          <th className="num">Input</th>
          <th className="num">Cache Read</th>
          <th className="num">Cache Write</th>
          <th className="num">Output</th>
          <th className="num">%</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row.name}>
            <td><span className="usage-source-badge">{row.name}</span></td>
            <td className="num">${row.cost_usd.toFixed(4)}</td>
            <td className="num">{formatTokens(row.input_tokens)}</td>
            <td className="num">{formatTokens(row.cache_read_tokens)}</td>
            <td className="num">{formatTokens(row.cache_creation_tokens)}</td>
            <td className="num">{formatTokens(row.output_tokens)}</td>
            <td className="num">{row.percentage.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

