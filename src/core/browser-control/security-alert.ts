import { siteKey } from '../vault/url-match.js';
import { checkAgentActions } from './agent-actions.js';

export class SecurityAlertError extends Error {
  readonly code = 'bad_security_alert';
  readonly status = 400;
}

/** The caller supplies alert facts; no mail, vault item or transcript is read. Account names are never persisted or returned. */
export async function checkSecurityAlert(raw: unknown) {
  if (raw === undefined) return undefined;
  const alert = raw as { domain?: unknown; occurred_at?: unknown; account?: unknown } | null;
  const domain = typeof alert?.domain === 'string' ? alert.domain.toLowerCase().trim() : '';
  const stamp = typeof alert?.occurred_at === 'string' ? alert.occurred_at : '';
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) ? Date.parse(stamp) : NaN;
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)
    || siteKey(`https://${domain}`)?.domain !== domain || !Number.isFinite(at) || at > Date.now() + 60_000) {
    throw new SecurityAlertError('A security alert needs its registrable domain and exact ISO occurred_at time.');
  }
  const account = typeof alert?.account === 'string' ? alert.account.trim() : undefined;
  const checked = await checkAgentActions(domain, at, account);
  return { ...checked, domain, occurred_at: new Date(at).toISOString(),
    next: checked.status === 'ours'
      ? 'This matches our recorded form fill, not proof the site accepted a sign-in. Do not ask the user to confirm this agent action.'
      : 'Have the owning task or your supervisor verify recent agent actions. Do not ask the user for something agents can check.' };
}
