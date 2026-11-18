/**
 * Which needs-config plugins a config save has completed, so the server may load them.
 *
 * Loading one goes through reloadLoadedPlugin, which writes `plugins.<id>.enabled: true`
 * (it is the "turn on" path). A save that fills the missing fields of a plugin the user
 * turned OFF must leave it off: on 2026-11-18 a restore of the `plugins` section wrote
 * `ms-todo: { enabled: false, client_id }`, this check saw `client_id` arrive, and the
 * reload turned Microsoft To-Do back on behind the user's back (a pull every 30 s that
 * warned about every list until it was turned off again). Off is the user's answer;
 * only an explicit switch turns a plugin on.
 */
import type { UnconfiguredPlugin } from '../integration-types.js';

type PluginConfigs = Record<string, Record<string, unknown> | undefined> | undefined;

export function pluginsCompletedByConfig(
  pending: readonly UnconfiguredPlugin[],
  plugins: PluginConfigs,
): UnconfiguredPlugin[] {
  return pending.filter((plugin) => {
    const pluginConfig = plugins?.[plugin.id] ?? {};
    if (pluginConfig.enabled === false) return false;
    return plugin.missing.every((field) => field in pluginConfig);
  });
}
