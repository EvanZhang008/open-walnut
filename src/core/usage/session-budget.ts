/**
 * Session budgets, server side: a thin relay to the daemon on the session's host,
 * which prices the session (the same per-request cost the picker shows), pauses
 * it at its limit and keeps the budget while the Mac is away
 * (src/providers/usage-budget-runtime.ts).
 *
 * The server's own jobs: hand the host the price list the cost line uses, and
 * tell the user once about each pause (sweepSessionBudgets, one bounded
 * `usage.budget.list` per connected host).
 */
import crypto from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { getConfig } from '../config-manager.js';
import { getSessionByClaudeId } from '../session-tracker.js';
import { link } from '../hosts/link.js';
import { currentPriceSnapshot, ensurePriceBook } from './price-book.js';
import type { PriceSnapshot } from './price-data.js';
import type { BudgetPrices, BudgetState } from '../../providers/usage-budget-runtime.js';
import type { SessionRecord } from '../types.js';
import { BUDGET_ENGINES } from './budget-engines.js';

/** Engines whose per-request usage the host can price (session-cost-core.ts). */
export { BUDGET_ENGINES };
/** How often the host prices a budgeted session between responses, in seconds (mirrors CHECK_EVERY). */
export const BUDGET_CHECK_EVERY_SEC: Record<string, number> = { claude: 2, codex: 5, opencode: 30 };

function fail(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status });
}
/** The daemon's error code as an HTTP status. */
function statusOf(code: string): number {
  return code === 'BUDGET_CONFLICT' ? 409 : code === 'BAD_REQUEST' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'NOT_OWNED' ? 403 : 503;
}

/** With no LiteLLM snapshot, an empty one still lets the host price with the built-in table. */
const EMPTY_SNAPSHOT: PriceSnapshot = { source: 'litellm', url: '', fetchedAt: '1970-01-01T00:00:00.000Z', models: {} };

export async function budgetPrices(): Promise<BudgetPrices> {
  await ensurePriceBook();
  const snapshot = currentPriceSnapshot() ?? EMPTY_SNAPSHOT;
  const overrides = (await getConfig()).usage?.prices;
  const hash = crypto.createHash('sha256').update(JSON.stringify([snapshot.fetchedAt, Object.keys(snapshot.models).length, overrides ?? null])).digest('hex').slice(0, 16);
  return { snapshot, ...(overrides ? { overrides } : {}), hash };
}

async function hostConnection(host: string) {
  const conn = await link(host);
  await conn.connect();
  return conn;
}

async function target(sid: string) {
  const session = await getSessionByClaudeId(sid);
  if (!session) throw fail('session_not_found', 'Session not found', 404);
  const engine = session.engine ?? 'claude';
  if (!(BUDGET_ENGINES as readonly string[]).includes(engine)) {
    throw fail('budget_unsupported', 'A budget needs per-request usage, which this session\'s engine does not record.', 400);
  }
  const host = session.host ?? '__local__';
  const conn = await hostConnection(host);
  // budget-v1 hosts priced only some Claude models; their budgets stay enforced by
  // that daemon until it updates (it does on connect), but this server cannot read them.
  if (!conn.hasCapability('budget-v2')) throw fail('budget_needs_upgrade', 'The session\'s host runs an older Walnut daemon; it updates on its next connect. Its saved budget still holds.', 503);
  return { session, engine, conn };
}

export interface SessionBudgetResponse {
  sessionId: string;
  title?: string;
  engine: string;
  budget: BudgetState;
  checkedAt: string | null;
  /** How often the host prices the session between responses. */
  checkEverySec: number;
  /**
   * The previous answer's fields, empty: a window still running the bundle from
   * before this answer maps over them when it opens Usage & Budget.
   */
  verifiedCostUsd: null;
  verifiedCalls: 0;
  unverifiedCalls: 0;
  byModel: [];
  byAgent: [];
}

function response(session: SessionRecord, engine: string, snapshot: { budget: BudgetState; checkedAt: string | null }): SessionBudgetResponse {
  return { sessionId: session.claudeSessionId, ...(session.title ? { title: session.title } : {}), engine,
    budget: snapshot.budget, checkedAt: snapshot.checkedAt, checkEverySec: BUDGET_CHECK_EVERY_SEC[engine] ?? 30,
    verifiedCostUsd: null, verifiedCalls: 0, unverifiedCalls: 0, byModel: [], byAgent: [] };
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
  const { session, engine, conn } = await target(sid);
  const result = await conn.send('usage.budget.get', { sid, engine, home: WALNUT_HOME }, 10_000);
  if (!result.ok || !result.result) {
    const code = String(result.code ?? 'budget_unavailable');
    throw fail(code, String(result.error ?? 'The budget could not be read'), statusOf(code));
  }
  return response(session, engine, result.result as unknown as { budget: BudgetState; checkedAt: string | null });
}

export function configureSessionBudget(sid: string, request: { limitUsd: number | null; revision: number }) {
  return deadline(writeSessionBudget(sid, request), 30_000);
}
async function writeSessionBudget(sid: string, request: { limitUsd: number | null; revision: number }) {
  const { session, engine, conn } = await target(sid);
  const result = await conn.send('usage.budget.configure', {
    sid, home: WALNUT_HOME, engine, ...request,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.acpRuntimeId ? { runtimeId: session.acpRuntimeId } : {}),
    prices: await budgetPrices(),
  }, 30_000);
  if (!result.ok || !result.result) {
    const code = String(result.code ?? result.errorKind ?? 'budget_unavailable');
    throw fail(code, String(result.error ?? 'The budget change was not confirmed'), statusOf(code));
  }
  return response(session, engine, result.result as unknown as { budget: BudgetState; checkedAt: string | null });
}

export type ListedBudget = BudgetState & { sid: string };

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/** The inbox letter for one pause. */
export function pauseLetterMarkdown(budget: ListedBudget, title: string): string {
  const why = budget.reason === 'unpriced'
    ? `It made a request on **${budget.unpricedModel ?? 'a model'}**, which has no price in Walnut's price list, so its spend could not be counted. Spent so far on priced requests: ${money(budget.spentUsd)} of ${money(budget.limitUsd)}.`
    : budget.reason === 'unreadable'
      ? `Its usage could not be read for a minute, so its spend is unknown${budget.checkError ? ` (${budget.checkError})` : ''}. Last known: ${money(budget.spentUsd)} of ${money(budget.limitUsd)}.`
      : `It spent ${money(budget.spentUsd)}, at or over its ${money(budget.limitUsd)} budget.`;
  const stop = budget.stopError
    ? `The stop could not be confirmed (${budget.stopError}); it is retried on every check, and no new message is sent to it.`
    : 'Its process was stopped and no new message is sent to it.';
  return [
    `**${title}** was paused. ${why}`,
    stop,
    budget.reason === 'unpriced'
      ? 'To continue, add a price for that model under usage prices in Settings, or raise or remove the budget in the session\'s Usage & Budget.'
      : budget.reason === 'unreadable'
        ? 'Once its usage can be read again and it is under the budget, your next message goes through. You can also remove the budget in the session\'s Usage & Budget.'
        : 'To continue, raise or remove the budget in the session\'s Usage & Budget, then send a message.',
  ].join('\n\n');
}

const SWEEP_HOST_MS = 8_000;

/**
 * Tell the user about every pause once: one bounded list call per connected
 * host. The host keeps a pause (with its id) across a Mac that was off, so the
 * first sweep after the Mac returns still finds it; the letter's op key keeps
 * it to one letter per pause.
 */
export async function sweepSessionBudgets(opts: { shouldStop?: () => boolean } = {}): Promise<{ hosts: number; paused: number; sent: number }> {
  const [{ getConnectedDaemonConnection }, { listNonTerminalSessions }, config] = await Promise.all([
    import('../../providers/daemon-connection.js'), import('../session-tracker.js'), getConfig(),
  ]);
  const prices = await budgetPrices();
  const alive = await listNonTerminalSessions();
  let hosts = 0, paused = 0, sent = 0;
  const targets = ['__local__', ...Object.keys(config.hosts ?? {})]
    .map(host => ({ host, conn: getConnectedDaemonConnection(host) }))
    .filter((t): t is { host: string; conn: NonNullable<typeof t.conn> } => !!t.conn && t.conn.hasCapability('budget-v2'));
  hosts = targets.length;
  // Every host at once, each with its own deadline: a slow host never starves the others.
  const lists = await Promise.all(targets.map(async ({ host, conn }) => {
    const runtimeIds: Record<string, string> = {};
    for (const s of alive) {
      if ((s.host ?? '__local__') === host && s.acpRuntimeId && s.claudeSessionId) runtimeIds[s.claudeSessionId] = s.acpRuntimeId;
    }
    try {
      const first = await conn.send('usage.budget.list', { runtimeIds, home: WALNUT_HOME }, SWEEP_HOST_MS);
      let listed = first.ok ? first.result as { budgets?: ListedBudget[]; pricesHash?: string | null } | undefined : undefined;
      // A host holding another price list gets this one (once per change).
      if (listed && listed.pricesHash !== prices.hash && !opts.shouldStop?.()) {
        const again = await conn.send('usage.budget.list', { runtimeIds, home: WALNUT_HOME, prices }, SWEEP_HOST_MS);
        if (again.ok) listed = again.result as typeof listed;
      }
      return listed?.budgets ?? [];
    } catch { return []; }
  }));
  for (const budget of lists.flat()) {
    if (budget.state !== 'paused' || !budget.pauseId) continue;
    paused += 1;
    if (await sendPauseLetter(budget)) sent += 1;
  }
  return { hosts, paused, sent };
}

async function sendPauseLetter(budget: ListedBudget): Promise<boolean> {
  const { sendLetterOnce } = await import('../human-inbox/store.js');
  const session = await getSessionByClaudeId(budget.sid);
  const title = session?.title || 'A session';
  const { duplicate } = await sendLetterOnce({
    subject: budget.reason === 'unpriced'
      ? `Budget paused "${title.slice(0, 80)}": a request had no price`
      : budget.reason === 'unreadable'
        ? `Budget paused "${title.slice(0, 80)}": its usage could not be read`
      : `Budget reached: "${title.slice(0, 80)}" paused at ${money(budget.spentUsd)}`,
    type: 'review',
    markdown: pauseLetterMarkdown(budget, title),
    ...(session?.taskId ? { taskRefs: [session.taskId] } : {}),
    sender: { sessionId: 'external', host: session?.host ?? 'local' },
  // By the pause alone: a budget that follows its session to a new thread id keeps its pause.
  }, { opKey: `budget-paused:${budget.pauseId}` });
  return !duplicate;
}
