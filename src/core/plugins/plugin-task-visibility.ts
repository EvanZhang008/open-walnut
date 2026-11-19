/**
 * Which running plugins keep their agents' tasks to their own view (manifest
 * `taskVisibility: "plugin"`, see Task.plugin_only).
 *
 * A plugin reaches the task routes through `walnut.ops.call`, whose requests name the
 * plugin in `x-walnut-plugin-id` (callPluginOp in server-api.ts; older ones only as the caller
 * sid `plugin:<id>`), whoever the caller is. The create routes ask this module
 * whether that caller keeps its tasks, and stamp the new task when it does. The answer
 * follows the plugin's live generation: a reload registers again, and the old
 * generation's dispose never removes the newer registration.
 *
 * A host's follower loads no plugin manifest, so it holds the leader's word instead: the
 * plugins that keep their tasks, which the leader's host server manager puts in the
 * settings of the follower's spec (host-server/manager.ts `pluginsKeepTasks`, read by
 * replica/front.ts while it runs). The follower's away create stamps through the same
 * function, so a plugin job's task made there stays off its board too. A change of that set
 * tells its listeners (onPluginsKeepingTasksChanged), so the manager sends the new word.
 */

import { TEST_RUN_OWNER } from '../test-run.js';

export type PluginTaskVisibility = 'everywhere' | 'plugin';

const PLUGIN_CALLER_PREFIX = 'plugin:';

const keeping = new Map<string, symbol>();
/** The leader's word on a follower (see the header); empty on the leader. */
let fromLeader: ReadonlySet<string> = new Set();

/** The manifest value, closed set: anything but `"plugin"` keeps today's behaviour. */
export function parseTaskVisibility(raw: unknown): PluginTaskVisibility | undefined {
  return raw === 'plugin' ? 'plugin' : undefined;
}

const listeners = new Set<() => void>();

/** Called when the set of plugins that keep their tasks here changes (not on a reload of one); returns the unsubscribe. */
export function onPluginsKeepingTasksChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function changed(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* a listener's failure is its own */ }
  }
}

/** Record that a generation of `pluginId` keeps its tasks; the returned function undoes it. */
export function registerPluginKeepsTasks(pluginId: string): () => void {
  const token = Symbol(pluginId);
  const added = !keeping.has(pluginId);
  keeping.set(pluginId, token);
  if (added) changed();
  return () => {
    if (keeping.get(pluginId) !== token) return;
    keeping.delete(pluginId);
    changed();
  };
}

export function pluginKeepsTasks(pluginId: string): boolean {
  return keeping.has(pluginId) || fromLeader.has(pluginId);
}

/** The plugins running here that keep their tasks (the leader sends them to its hosts' followers). */
export function pluginsKeepingTasks(): string[] {
  return [...keeping.keys()].sort();
}

const PLUGIN_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** A follower takes the leader's word: the plugins that keep their tasks (anything else in the value is dropped). */
export function setPluginsKeepingTasksFromLeader(raw: unknown): void {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && PLUGIN_ID_RE.test(x)) : [];
  fromLeader = new Set(ids.slice(0, 200));
}

/**
 * The plugin that keeps a new task: the plugin the call was made through (`x-walnut-plugin-id`,
 * set by callPluginOp for a person and a session alike) when named, else the plugin a caller sid
 * names (`plugin:<id>`, older callers). Only a plugin that keeps its tasks answers.
 */
export function pluginOnlyForCaller(sid: string | undefined | null, pluginId?: string | null): string | undefined {
  const named = pluginId?.trim();
  if (named) return pluginKeepsTasks(named) ? named : undefined;
  const raw = sid?.trim();
  if (!raw || !raw.startsWith(PLUGIN_CALLER_PREFIX)) return undefined;
  const id = raw.slice(PLUGIN_CALLER_PREFIX.length);
  return id && pluginKeepsTasks(id) ? id : undefined;
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
  fromLeader = new Set();
  listeners.clear();
}
