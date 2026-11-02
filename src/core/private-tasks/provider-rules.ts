/**
 * What a task must pass before it syncs to each task provider (2026-11-01, the user: "a task
 * provider section ... for all the task plugins we automatically support this, so it shows each
 * plugin and the user can define the rules, hard rules or AI rules, for it to eval and just
 * return pass or fail, with reasons"). Earlier the same day the check ran for every service and
 * pulled the user's own tasks out of his personal list.
 *
 * Per provider (`private_tasks.providers[<plugin id>]`, Settings > Task providers):
 *   - `check`: whether anything is checked. Default = the plugin manifest's `syncAudience`: off
 *     for a service only the user reads (a personal list), on for one others read, and on for a
 *     plugin that says nothing (the safe case). Off: every task syncs; only the user's own Local
 *     choice keeps one out.
 *   - hard rules (`words`): words or /patterns/; a match fails the task. Default: the shared list.
 *   - the AI rule (`ai`, `ai_rule`): the fast model reads the task against the rule in the
 *     user's words and answers pass or fail, with a reason. Default: on, DEFAULT_AI_RULE.
 */
import type { Config, ProviderSyncRules, SyncAudience, Task } from '../types.js';

/** The AI rule a provider uses until the user writes its own. */
export const DEFAULT_AI_RULE = [
  'Keep out my own personal or confidential matters: my promotion, performance review, level or rating;',
  'feedback, a complaint or an opinion about a specific colleague; pay, compensation, equity or bonus;',
  'health or medical matters; immigration or visa; personal money, taxes or banking; family or personal',
  'relationships; looking for another job, interviews elsewhere or resigning; a personal side project',
  'or hobby unrelated to the team\'s work. Ordinary team work passes: code, bugs, reviews, designs,',
  'operations, meetings about the product, helping teammates with their work.',
].join(' ');

/** The longest AI rule the judge reads (the rest is cut). */
export const MAX_AI_RULE = 4000;

/** The rules in force for one provider, every default filled in. */
export interface SyncRules {
  provider: string;
  check: boolean;
  /** Where `check` came from: the user's setting, or the plugin's default. */
  checkSet: boolean;
  /** The plugin's own default for `check`. */
  checkDefault: boolean;
  words: string[];
  ai: boolean;
  aiRule: string;
}

/** The rules of `provider`, from the config and the plugin's manifest default. Pure. */
export function resolveSyncRules(
  config: Pick<Config, 'private_tasks'>, provider: string, manifestAudience: SyncAudience | undefined,
): SyncRules {
  const cfg = config.private_tasks;
  const own: ProviderSyncRules = cfg?.providers?.[provider] ?? {};
  const checkDefault = (manifestAudience ?? 'shared') === 'shared';
  const legacy = cfg?.audience?.[provider];
  const set = typeof own.check === 'boolean' ? own.check : legacy === 'self' ? false : legacy === 'shared' ? true : undefined;
  const words = Array.isArray(own.words) ? own.words : cfg?.words ?? [];
  const ai = typeof own.ai === 'boolean' ? own.ai : cfg?.model_check !== false;
  const aiRule = typeof own.ai_rule === 'string' && own.ai_rule.trim() ? own.ai_rule.trim() : DEFAULT_AI_RULE;
  return { provider, check: set ?? checkDefault, checkSet: set !== undefined, checkDefault, words: words.filter((w) => typeof w === 'string'), ai, aiRule };
}

/** The rules of `provider` now. Walnut itself (`local`) checks nothing. */
export async function syncRulesFor(config: Pick<Config, 'private_tasks'>, provider: string): Promise<SyncRules> {
  if (!provider || provider === 'local') {
    return { provider: 'local', check: false, checkSet: false, checkDefault: false, words: [], ai: false, aiRule: DEFAULT_AI_RULE };
  }
  const { registry } = await import('../integration-registry.js');
  return resolveSyncRules(config, provider, registry.get(provider)?.syncAudience);
}

/** The line a released task's open letter is settled with. */
const SETTLED_REASON = (service: string) =>
  `Walnut no longer checks tasks before they sync to ${service}: the task syncs to it again`;

/**
 * Give back to its service every task Walnut kept out of one whose check is off: a hold the
 * rules or a parent set (never the user's own Local choice) no longer applies, so the task syncs
 * again (linked to its old outside copy when it has one) and its open letter is settled. Runs
 * once the boot's plugins loaded and when the settings change. Returns the ids released. A task
 * whose service is not loaded is left as it is: its default is unknown.
 */
export async function releaseHoldsOfUnsharedServices(): Promise<string[]> {
  const { registry } = await import('../integration-registry.js');
  await registry.waitForPlugins(5 * 60_000);
  const tm = await import('../task-manager.js');
  const { getConfig } = await import('../config-manager.js');
  const { serviceName, settleHoldLetter } = await import('./sync-gate.js');
  const { log } = await import('../../logging/index.js');
  const config = await getConfig();
  const released: string[] = [];
  const tasks = await tm.listTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    const hold = task.sync_hold;
    if (task.source !== 'local' || !hold || hold.by === 'user') continue;
    if (!registry.get(hold.target) || (await syncRulesFor(config, hold.target)).check) continue;
    // A release sends it to its project's service now: only when that is still this one.
    if ((await tm.projectSyncSourceOf(task.project)) !== hold.target) continue;
    // A subtask follows a parent the user chose to keep local.
    const parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
    if (parent?.source === 'local' && parent.org_role !== 'lead' && parent.sync_hold?.by === 'user') continue;
    // Only the hold this pass read: a choice made meanwhile stands.
    const same = (t: Readonly<Task>) => t.sync_hold?.at === hold.at && t.sync_hold?.state === hold.state;
    const r = await tm.releaseSyncHold(task.id, same).catch((err) => {
      log.task.warn('private tasks: hold not released', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!r?.released) continue;
    released.push(task.id);
    await settleHoldLetter(hold, SETTLED_REASON(await serviceName(hold.target)), task.id);
  }
  if (released.length) log.task.info('private tasks: tasks given back to a service whose check is off', { count: released.length, taskIds: released });
  return released;
}
