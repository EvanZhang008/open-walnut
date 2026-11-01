/**
 * Who reads each sync service (2026-11-01, the user's lead: the privacy check pulled the user's
 * own tasks out of his PERSONAL Microsoft To-Do, because it took every outside service for one a
 * team shares; the leak to stop is the work tracker colleagues read).
 *
 *   - `self`: only the user reads it (a personal list). Private matters belong there, so Walnut
 *     runs no privacy check for it, neither the words nor the model: a task is born synced and
 *     its edits go out. Only the user's own Local choice keeps a task out.
 *   - `shared`: others read it too (a team tracker). The check runs as built.
 *
 * The audience is the user's setting (`private_tasks.audience[<plugin id>]`, Settings > Tasks >
 * Private tasks), else the plugin's manifest `syncAudience`, else `shared`: a plugin that says
 * nothing is treated as the safe case.
 */
import type { Config, SyncAudience, Task } from '../types.js';

/** The manifest default of a plugin, or undefined. Read from the live registry. */
async function manifestAudience(pluginId: string): Promise<SyncAudience | undefined> {
  const { registry } = await import('../integration-registry.js');
  const plugin = registry.get(pluginId);
  return plugin?.syncAudience;
}

/** The audience a pure caller resolves from what it already holds. */
export function resolveAudience(
  config: Pick<Config, 'private_tasks'>, pluginId: string, manifestDefault: SyncAudience | undefined,
): SyncAudience {
  const set = config.private_tasks?.audience?.[pluginId];
  if (set === 'self' || set === 'shared') return set;
  return manifestDefault ?? 'shared';
}

/** Who reads `pluginId`: the user's setting, the manifest's default, else shared. */
export async function serviceAudience(config: Pick<Config, 'private_tasks'>, pluginId: string): Promise<SyncAudience> {
  if (!pluginId || pluginId === 'local') return 'self';
  return resolveAudience(config, pluginId, await manifestAudience(pluginId));
}

/** Whether Walnut checks what goes to `pluginId` for private matters. */
export async function privacyChecksApply(config: Pick<Config, 'private_tasks'>, pluginId: string): Promise<boolean> {
  return (await serviceAudience(config, pluginId)) === 'shared';
}

/** The line a released task's open letter is settled with. */
const SETTLED_REASON = (service: string) =>
  `${service} is a service only you read, so Walnut no longer keeps tasks out of it: the task syncs to it again`;

/**
 * Give back to its service every task Walnut kept out of one only the user reads: a hold the
 * words, the model or a parent set (never the user's own Local choice) no longer applies, so
 * the task syncs again (linked to its old outside copy when it has one) and its open letter is
 * settled. Runs once the boot's plugins loaded and when the setting changes. Returns the ids
 * released. A task whose service is not loaded is left as it is: its audience is unknown.
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
    if (!registry.get(hold.target) || (await privacyChecksApply(config, hold.target))) continue;
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
  if (released.length) log.task.info('private tasks: tasks given back to a service only the user reads', { count: released.length, taskIds: released });
  return released;
}
