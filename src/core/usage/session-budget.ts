import { WALNUT_HOME } from '../../constants.js';
import { getConfig } from '../config-manager.js';
import { getSessionByClaudeId } from '../session-tracker.js';
import { getDaemonConnection } from '../../providers/daemon-connection.js';
import { engineCaps } from '../agents/engine-registry.js';
import { responseUsageStore } from './collection.js';
import type { BudgetState } from '../../providers/usage-budget-core.js';

function fail(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status });
}
async function target(sid: string) {
  const session = await getSessionByClaudeId(sid);
  if (!session) throw fail('session_not_found', 'Session not found', 404);
  if (engineCaps(session.engine).historySource !== 'provider-jsonl') {
    throw fail('budget_unsupported', 'This session engine does not provide verified budget evidence', 400);
  }
  const config = await getConfig();
  const host = session.host ?? '__local__', def = config.hosts?.[host];
  const conn = await getDaemonConnection(host, host === '__local__' ? { hostname: '__local__' }
    : { hostname: def?.hostname ?? host, user: def?.user, port: def?.port });
  await conn.connect();
  if (!conn.hasCapability('budget-v1')) throw fail('budget_needs_upgrade', 'The session host needs the budget daemon upgrade', 503);
  return { session, config, host, conn };
}

interface BudgetSnapshot {
  budget: BudgetState;
  usage: ReturnType<ReturnType<typeof responseUsageStore>['getSessionUsage']>;
  checkedAt: string | null;
}
function response(session: { claudeSessionId: string; title?: string }, snapshot: BudgetSnapshot) {
  const usage = !snapshot.usage.verifiedCalls && !snapshot.usage.unverifiedCalls && snapshot.budget.limitUsd === null
    ? responseUsageStore().getSessionUsage(session.claudeSessionId) : snapshot.usage;
  return { sessionId: session.claudeSessionId, title: session.title, ...usage,
    budget: snapshot.budget, checkedAt: snapshot.checkedAt };
}

async function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(fail('budget_timeout', 'The budget host did not answer in time. Refresh before retrying a change.', 503)), milliseconds);
  });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
}

export function getSessionBudget(sid: string) {
  return deadline(readSessionBudget(sid), 10_000);
}
async function readSessionBudget(sid: string) {
  const { session, conn } = await target(sid);
  const result = await conn.send('usage.budget.get', { sid, home: WALNUT_HOME }, 10_000);
  if (!result.ok || !result.result) throw fail('budget_unavailable', String(result.error ?? 'Budget evidence unavailable'), 503);
  return response(session, result.result as unknown as BudgetSnapshot);
}

export function configureSessionBudget(sid: string, request: { limitUsd: number | null; revision: number }) {
  return deadline(writeSessionBudget(sid, request), 30_000);
}
async function writeSessionBudget(sid: string, request: { limitUsd: number | null; revision: number }) {
  const { session, config, host, conn } = await target(sid);
  const result = await conn.send('usage.budget.configure', { sid, home: WALNUT_HOME, ...request,
    proxyLogDir: config.usage?.proxy_log_dirs?.[host] }, 30_000);
  if (!result.ok || !result.result) {
    const code = String(result.code ?? result.errorKind ?? 'budget_unavailable');
    throw fail(code, String(result.error ?? 'Budget update was not confirmed'), code === 'BUDGET_CONFLICT' ? 409 : 503);
  }
  return response(session, result.result as unknown as BudgetSnapshot);
}
