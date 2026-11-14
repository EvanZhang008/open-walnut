/**
 * A project's Claude Code plugins its sessions leave out: `task_projects.metadata`
 * key `claude_plugins_off`, a list of full plugin ids (`name@marketplace`).
 *
 * A Claude Code session of a task in that project starts with
 * `--settings {"enabledPlugins":{"<id>":false}}` (providers/claude-scope-settings.ts),
 * which overrides the user's own enabledPlugins for that one process: the plugin's
 * skills, agents and MCP servers stay out of its context. The user's settings files
 * are never written. A project without the key, and Inbox, spawn as before.
 */
import { ProjectSettingsError } from './project-launch-defaults.js';

export const CLAUDE_PLUGINS_OFF_KEY = 'claude_plugins_off';

/** At most this many ids, each at most this long: the list rides every spawn's argv. */
export const CLAUDE_PLUGINS_OFF_MAX_ITEMS = 100;
export const CLAUDE_PLUGIN_ID_MAX_CHARS = 200;

/** `name@marketplace`, no whitespace, exactly one `@`. */
const PLUGIN_ID = /^[^\s@]+@[^\s@]+$/;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CLAUDE_PLUGIN_ID_MAX_CHARS && PLUGIN_ID.test(value);
}

/**
 * A metadata patch with `claude_plugins_off` checked: an array of plugin ids
 * (trimmed, duplicates dropped, order kept). `undefined` (the routes' JSON null)
 * and `[]` clear the key. Anything else is a ProjectSettingsError (a 400).
 */
export function checkClaudePluginsOffPatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(patch, CLAUDE_PLUGINS_OFF_KEY)) return patch;
  const raw = patch[CLAUDE_PLUGINS_OFF_KEY];
  if (raw === undefined) return patch;
  if (!Array.isArray(raw)) {
    throw new ProjectSettingsError(`${CLAUDE_PLUGINS_OFF_KEY} must be a list of plugin ids (name@marketplace)`);
  }
  if (raw.length > CLAUDE_PLUGINS_OFF_MAX_ITEMS) {
    throw new ProjectSettingsError(`${CLAUDE_PLUGINS_OFF_KEY} takes at most ${CLAUDE_PLUGINS_OFF_MAX_ITEMS} plugin ids`);
  }
  const ids: string[] = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim() : item;
    if (!validId(id)) {
      throw new ProjectSettingsError(
        `${CLAUDE_PLUGINS_OFF_KEY}: ${JSON.stringify(item)} is not a plugin id of the form name@marketplace ` +
        `(no spaces, at most ${CLAUDE_PLUGIN_ID_MAX_CHARS} characters)`,
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ...patch, [CLAUDE_PLUGINS_OFF_KEY]: ids.length > 0 ? ids : undefined };
}

/**
 * The ids a registry row holds. Tolerant: a hand-edited blob's non-list value or
 * malformed entry is left out, so the spawn goes on without it instead of failing.
 */
export function readClaudePluginsOff(meta: Record<string, unknown> | null | undefined): string[] {
  const raw = meta?.[CLAUDE_PLUGINS_OFF_KEY];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw.slice(0, CLAUDE_PLUGINS_OFF_MAX_ITEMS)) {
    if (validId(item) && !ids.includes(item)) ids.push(item);
  }
  return ids;
}
