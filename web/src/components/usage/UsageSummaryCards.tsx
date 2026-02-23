import type { UsageSummary } from '@/api/usage';
import { formatTokens } from '@/utils/format';

interface Props {
  summary: UsageSummary | null;
  loading: boolean;
}

export function UsageSummaryCards({ summary, loading }: Props) {
  const cards = [
    { label: 'Walnut Cost', value: summary ? `$${summary.total_cost.toFixed(2)}` : '--', accent: true },
    { label: 'Claude Code', value: summary ? `$${summary.session_cost.toFixed(2)}` : '--' },
    { label: 'Input Tokens', value: summary ? formatTokens(summary.input_tokens) : '--' },
    { label: 'Output Tokens', value: summary ? formatTokens(summary.output_tokens) : '--' },
    { label: 'Cache Read', value: summary ? formatTokens(summary.cache_read_tokens) : '--' },
    { label: 'Cache Write', value: summary ? formatTokens(summary.cache_creation_tokens) : '--' },
    { label: 'API Calls', value: summary ? String(summary.api_calls) : '--' },
  ];

  return (
    <div className={`usage-summary-cards${loading ? ' loading' : ''}`}>
      {cards.map((c) => (
        <div key={c.label} className={`usage-summary-card${c.accent ? ' accent' : ''}`}>
          <span className="usage-card-label">{c.label}</span>
          <span className="usage-card-value">{c.value}</span>
        </div>
      ))}
    </div>
  );
}

