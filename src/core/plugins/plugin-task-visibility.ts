/**
 * Which running plugins keep their agents' tasks to their own view (manifest
 * `taskVisibility: "plugin"`, see Task.plugin_only).
 *
 * A plugin reaches the task routes through `walnut.ops.call`, whose requests name the
 * caller `plugin:<id>` (callPluginOp in server-api.ts). The create routes ask this module
 * whether that caller keeps its tasks, and stamp the new task when it does. The answer
 * follows the plugin's live generation: a reload registers again, and the old
 * generation's dispose never removes the newer registration.
 */

import { TEST_RUN_OWNER } from '../test-run.js';

export type PluginTaskVisibility = 'everywhere' | 'plugin';

const PLUGIN_CALLER_PREFIX = 'plugin:';

const keeping = new Map<string, symbol>();

/** The manifest value, closed set: anything but `"plugin"` keeps today's behaviour. */
export function parseTaskVisibility(raw: unknown): PluginTaskVisibility | undefined {
  return raw === 'plugin' ? 'plugin' : undefined;
}

/** Record that a generation of `pluginId` keeps its tasks; the returned function undoes it. */
export function registerPluginKeepsTasks(pluginId: string): () => void {
  const token = Symbol(pluginId);
  keeping.set(pluginId, token);
  return () => {
    if (keeping.get(pluginId) === token) keeping.delete(pluginId);
  };
}

export function pluginKeepsTasks(pluginId: string): boolean {
  return keeping.has(pluginId);
}

/** The plugin id a caller sid names (`plugin:<id>`), when that plugin keeps its tasks. */
export function pluginOnlyForCaller(sid: string | undefined | null): string | undefined {
  const raw = sid?.trim();
  if (!raw || !raw.startsWith(PLUGIN_CALLER_PREFIX)) return undefined;
  const id = raw.slice(PLUGIN_CALLER_PREFIX.length);
  return id && keeping.has(id) ? id : undefined;
}

/**
 * Give back to the board every task kept by a plugin that no longer asks for it: one no
 * plugin folder declares any more (removed), or whose manifest dropped `taskVisibility:
 * "plugin"`. Without this a removed plugin's tasks, and their sessions, would be in no view
 * at all. `keeping` is every discovered plugin (enabled or not) whose manifest keeps tasks,
 * so a disabled plugin keeps its tasks for when it is enabled again. Run by the primary
 * after a complete plugin walk only; a replica runs only some plugins. Returns the ids given back.
 */
export async function releaseTasksOfPluginsNotKeeping(keeping: ReadonlySet<string>): Promise<string[]> {
  const { listTasks, setTasksPluginOnly } = await import('../task-manager.js')
  const { bus, EventNames } = await import('../event-bus.js')
  const byPlugin = new Map<string, string[]>()
  for (const task of await listTasks()) {
    const owner = task.plugin_only
    // A test run's task (TEST_RUN_OWNER, src/core/test-run.ts) is no plugin's: the test-run sweep ends it.
    if (!owner || keeping.has(owner) || owner === TEST_RUN_OWNER) continue
    const ids = byPlugin.get(owner)
    if (ids) ids.push(task.id)
    else byPlugin.set(owner, [task.id])
  }
  const released: string[] = []
  for (const [pluginId, ids] of byPlugin) {
    const done = await setTasksPluginOnly(ids, pluginId, false)
    for (const task of done.changed) {
      released.push(task.id)
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: `plugin/${pluginId}` })
    }
  }
  return released
}

export function resetPluginTaskVisibilityForTesting(): void {
  keeping.clear();
}
