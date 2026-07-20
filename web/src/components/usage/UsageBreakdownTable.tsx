import type { UsageByGroup } from '@/api/usage';
import { formatTokens } from '@/utils/format';
import { usageDisplayName } from '@/utils/usageLabels';

interface Props {
  data: UsageByGroup[];
  loading: boolean;
  /** The row currently drilled into (by raw name), if any. */
  activeName?: string;
  /** Click a row to drill into it (toggles off if already active). */
  onSelect?: (name: string) => void;
}

export function UsageBreakdownTable({ data, loading, activeName, onSelect }: Props) {
  if (loading && data.length === 0) return <div className="usage-table-placeholder">Loading…</div>;
  if (data.length === 0) return <div className="usage-table-placeholder">No data</div>;

  const clickable = !!onSelect;

  return (
    <table className={`usage-table${clickable ? ' clickable' : ''}`}>
      <thead>
        <tr>
          <th>Name</th>
          <th className="num">Cost</th>
          <th className="num">Input</th>
          <th className="num">Cache R</th>
          <th className="num">Cache W</th>
          <th className="num">Output</th>
          <th className="usage-share-col">Share</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => {
          const isActive = activeName === row.name;
          return (
            <tr
              key={row.name}
              className={isActive ? 'active' : ''}
              onClick={clickable ? () => onSelect!(row.name) : undefined}
              title={clickable ? (isActive ? 'Click to clear this filter' : `Filter to ${usageDisplayName(row.name)}`) : undefined}
            >
              <td><span className="usage-source-badge">{usageDisplayName(row.name)}</span></td>
              <td className="num">${row.cost_usd.toFixed(2)}</td>
              <td className="num">{formatTokens(row.input_tokens)}</td>
              <td className="num">{formatTokens(row.cache_read_tokens)}</td>
              <td className="num">{formatTokens(row.cache_creation_tokens)}</td>
              <td className="num">{formatTokens(row.output_tokens)}</td>
              <td className="usage-share-col">
                <div className="usage-share-bar-track">
                  <div className="usage-share-bar-fill" style={{ width: `${Math.min(100, row.percentage)}%` }} />
                </div>
                <span className="usage-share-pct">{row.percentage.toFixed(1)}%</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
