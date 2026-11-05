import { SettingsGroup } from '@/components/settings/SettingsSection';
import type { CostAccountLine } from '@/api/usage';

function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Which account Codex usage went through. An account billed directly (not through a proxy)
 * leads and is marked, because that spend lands on the account Codex is signed in to.
 */
export function UsageAccounts({ accounts }: { accounts?: CostAccountLine[] }) {
  if (!accounts?.length) return null;
  return (
    <SettingsGroup className="usage-accounts" data-testid="usage-accounts" heading="Codex by account">
      <ul className="usage-accounts-list">
        {accounts.map((a) => (
          <li key={a.key} className="usage-account" data-direct={a.direct || undefined} data-account={a.key}>
            <span className="usage-account-name">
              {a.label}
              {a.direct && <span className="usage-account-flag" title="These requests are billed to the account Codex is signed in to, not through a proxy.">Billed directly</span>}
            </span>
            <span className="usage-account-cost">{money(a.costUsd)}</span>
            <span className="usage-account-meta">
              {`${a.requests.toLocaleString('en-US')} requests · ${tokensText(a.tokens)} tokens`}
              {a.outsideRequests > 0 && ` · ${a.outsideRequests.toLocaleString('en-US')} outside Walnut`}
            </span>
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}
