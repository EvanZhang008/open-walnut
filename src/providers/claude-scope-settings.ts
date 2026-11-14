/**
 * What a Claude Code session carries less of, as `--settings` keys merged into the
 * spawn's one inline settings arg (claude-code-session.ts):
 *
 * - `enabledPlugins: { "<name>@<marketplace>": false }` for each plugin the task's
 *   project leaves out (`claude_plugins_off`, core/sessions/claude-plugins-off.ts).
 *   It overrides the user's own enabledPlugins for that one process: the plugin's
 *   skills, agents and MCP servers leave its context.
 * - `skillListingMaxDescChars: n` from config `session.skill_listing_desc_chars`: each
 *   skill's description in the skill listing is cut to n characters.
 *
 * Neither is set unless someone chose it: Walnut never sets an engine's own defaults.
 * Fresh spawns and resumes go through the same helper, so both carry the same keys.
 */

/** The range `session.skill_listing_desc_chars` takes (Claude Code's own default is the top). */
export const SKILL_LISTING_DESC_CHARS_MIN = 40;
export const SKILL_LISTING_DESC_CHARS_MAX = 1536;

/** The config knob when it holds a valid value, else undefined (nothing is sent). */
export function skillListingDescChars(config: { session?: { skill_listing_desc_chars?: unknown } } | null | undefined): number | undefined {
  const v = config?.session?.skill_listing_desc_chars;
  return validSkillListingDescChars(v) ? v : undefined;
}

export function validSkillListingDescChars(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SKILL_LISTING_DESC_CHARS_MIN && v <= SKILL_LISTING_DESC_CHARS_MAX;
}

/** The settings keys to merge into the spawn's `--settings`; `{}` when there is nothing to add. */
export function claudeScopeSettings(o: { pluginsOff?: readonly string[]; listingDescChars?: number }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.pluginsOff && o.pluginsOff.length > 0) {
    out.enabledPlugins = Object.fromEntries(o.pluginsOff.map((id) => [id, false]));
  }
  if (validSkillListingDescChars(o.listingDescChars)) out.skillListingMaxDescChars = o.listingDescChars;
  return out;
}
