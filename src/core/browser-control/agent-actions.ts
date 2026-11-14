import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { siteKey } from '../vault/url-match.js';
import { log } from '../../logging/index.js';

/** Only attribution metadata: no URLs, commands, account names, secrets or transcript words. */
export interface AgentAction {
  taskId: string;
  domain: string;
  at: number;
  kind: 'fill_login' | 'fill_code' | 'browser' | 'host_exec';
  /** Local salted fingerprint, never an account name. Missing identity cannot clear an alert. */
  accountKey?: string;
}
const MAX = 500;
const AGE_MS = 7 * 24 * 60 * 60_000;
const WINDOW_MS = 10 * 60_000;
const file = () => path.join(WALNUT_HOME, 'cache', 'agent-actions.json');

async function accountKey(account: string | undefined): Promise<string | undefined> {
  if (!account?.trim()) return undefined;
  const salt = await updateJsonFile<string>(path.join(WALNUT_HOME, 'cache', 'agent-action-salt.json'), '', (current) => current || randomBytes(32).toString('hex'));
  return createHash('sha256').update(`${salt}\u0000${account.trim().toLowerCase()}`).digest('hex');
}

export async function noteAgentAction(taskId: string | undefined, url: string, kind: AgentAction['kind'], at = Date.now(), account?: string): Promise<void> {
  const domain = siteKey(url)?.domain;
  if (!taskId || !domain) return;
  try {
    const identity = await accountKey(account);
    await updateJsonFile<AgentAction[]>(file(), [], (rows) => [...rows.filter((r) => r.at >= at - AGE_MS), { taskId, domain, kind, at, ...(identity ? { accountKey: identity } : {}) }].slice(-MAX));
  } catch (error) { log.session.warn('agent action attribution was not recorded', { error: String(error) }); }
}

/** A command URL is only a lead for checking, never proof of a successful sign-in. */
export async function noteHostAction(taskId: string, command: string): Promise<void> {
  for (const url of [...new Set(command.match(/https?:\/\/[^\s'"<>]+/g) ?? [])].slice(0, 5)) {
    await noteAgentAction(taskId, url, 'host_exec');
  }
}

export async function checkAgentActions(domain: string, at: number, account?: string) {
  try {
    const rows = await readJsonFile<AgentAction[]>(file(), [], { readErrors: 'throw' });
    const identity = await accountKey(account);
    const actions = rows.filter((r) => r.domain === domain && r.at <= at && at - r.at <= WINDOW_MS);
    const fills = identity ? actions.filter((r) => (r.kind === 'fill_login' || r.kind === 'fill_code') && r.accountKey === identity) : [];
    // Two different tasks near this alert need a check rather than guessing which one caused it.
    const ours = fills.length > 0 && new Set(fills.map((r) => r.taskId)).size === 1;
    return { status: ours ? 'ours' as const : 'unknown' as const,
      actions: (ours ? fills : actions).slice(-10).map(({ taskId, domain, at, kind }) => ({ taskId, domain, at, kind })) };
  } catch { return { status: 'unavailable' as const, actions: [] }; }
}
