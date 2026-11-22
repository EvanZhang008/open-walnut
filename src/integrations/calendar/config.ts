/**
 * The calendar plugin's config: `plugins.calendar` in config.yaml, with the legacy top-level
 * `calendar` section filling its gaps for one release, and the experimental switch that lets
 * mail accounts bring their calendars (`mail_calendars`).
 */
import { getConfig } from '../../core/config-manager.js';
import { experimentalEnabled, type ExperimentalFlags } from '../../core/experimental.js';

/**
 * `plugins.calendar` in config.yaml.
 *
 * `source_enabled`, not `enabled`: `plugins.<id>.enabled` is the plugin LIFECYCLE switch
 * the store writes, so putting the calendar's own on/off flag there would mean a user
 * turning the calendar off in Settings also unregisters its routes, and the toggle that
 * would turn it back on goes with them.
 */
export interface CalendarPluginConfig {
  source_enabled?: boolean;
  hidden_calendar_ids?: string[];
  /**
   * Allowlist. `null` means CLEARED and is not the same as absent: absent falls back to the
   * legacy top-level `calendar.visible_calendar_ids` (which the migration deliberately keeps),
   * so a cleared allowlist written as `undefined` would be dropped by `yaml.dump` and the old
   * one would come back on the next read. See {@link mergeCalendarConfig}.
   */
  visible_calendar_ids?: string[] | null;
  /** Single events hidden in Walnut by exact id (an occurrence id hides one occurrence). Plugin-only. */
  hidden_event_ids?: string[];
  /**
   * Where a create with no calendar id goes. `''` means CLEARED (written by Settings), which
   * wins over a legacy top-level value the same way a `null` allowlist does. See
   * {@link CalendarService.defaultCalendar} for what makes a configured id usable.
   */
  default_calendar_id?: string | null;
  refresh_minutes?: number;
  read_ttl_seconds?: number;
  /**
   * Mail accounts whose calendar Walnut reads too (`imap:<id>`), added by "Add its calendar".
   * Read only while the `mail_calendars` experiment is on; an older Walnut ignores the key.
   */
  mail_calendar_accounts?: string[];
}

/** The legacy top-level `config.calendar`, read for one release. */
export interface LegacyCalendarConfig extends Omit<CalendarPluginConfig, 'source_enabled' | 'hidden_event_ids' | 'mail_calendar_accounts'> {
  enabled?: boolean;
}

/** The HOST's `walnut.config.patch`: this bundle's own config-manager copy would hold a second write lock. */
export type CalendarConfigPatcher = (patch: Record<string, unknown>) => Promise<void>;

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Plugin config wins; the legacy top-level section fills the gaps.
 *
 * Both halves are read because `migrateConfigToPlugins` COPIES rather than moves: a config
 * that already had `plugins.calendar` (the store wrote `enabled` there when the user
 * toggled the plugin) never receives the copy, so the visibility lists can still only
 * exist at the top level. Delete this function, the legacy branch and the top-level
 * `calendar` key (`Config.calendar`, src/core/types.ts) and the copy block in
 * src/core/integration-loader.ts together once 0.4.6 has shipped.
 *
 * `visible_calendar_ids` is merged by PRESENCE, not by nullishness: every hide/unhide the web
 * UI performs sends `visible_calendar_ids: null` to mean "no allowlist", and a `??` here read
 * that as "nothing to say" and resurrected the legacy allowlist, so clearing it silently did
 * nothing. A present `null` therefore wins over the legacy value. `hidden_calendar_ids: []`
 * and `source_enabled: false` need no such care: neither is nullish.
 */
export function mergeCalendarConfig(
  pluginConfig: CalendarPluginConfig | undefined,
  legacy: LegacyCalendarConfig | undefined,
): CalendarPluginConfig {
  const plugin = pluginConfig ?? {};
  const old = legacy ?? {};
  return {
    source_enabled: plugin.source_enabled ?? old.enabled,
    hidden_calendar_ids: plugin.hidden_calendar_ids ?? old.hidden_calendar_ids,
    visible_calendar_ids:
      plugin.visible_calendar_ids !== undefined ? plugin.visible_calendar_ids : old.visible_calendar_ids,
    hidden_event_ids: idList(plugin.hidden_event_ids),
    // By presence, like the allowlist: Settings clears it by writing '' into the plugin
    // section, and that has to win over an id still sitting in the legacy section.
    default_calendar_id:
      plugin.default_calendar_id !== undefined ? plugin.default_calendar_id : old.default_calendar_id,
    refresh_minutes: plugin.refresh_minutes ?? old.refresh_minutes,
    read_ttl_seconds: plugin.read_ttl_seconds ?? old.read_ttl_seconds,
    mail_calendar_accounts: idList(plugin.mail_calendar_accounts),
  };
}

/**
 * Read this plugin's config straight off `getConfig()` rather than through
 * `walnut.config.get()`, which can only see `plugins.calendar`: the legacy fallback above
 * needs the top-level section too. This is a read of a file with no cache in front of it,
 * so a builtin plugin's own copy of config-manager answers the same bytes as the host's.
 * WRITES still go through `walnut.config.patch`, so there stays exactly one writer.
 */
export async function readCalendarConfig(): Promise<CalendarPluginConfig> {
  const config = (await getConfig()) as {
    plugins?: Record<string, Record<string, unknown>>;
    calendar?: LegacyCalendarConfig;
  };
  return mergeCalendarConfig(
    config.plugins?.calendar as CalendarPluginConfig | undefined,
    config.calendar,
  );
}

/** Whether mail accounts may bring their calendars (the `mail_calendars` experiment). */
export function mailCalendarsOn(flags: ExperimentalFlags | undefined): boolean {
  return experimentalEnabled(flags, 'mail_calendars');
}

/** The mail accounts whose calendars are read: none while the experiment is off (today's behaviour). */
export function activeMailCalendarAccounts(config: CalendarPluginConfig, flags: ExperimentalFlags | undefined): string[] {
  if (!mailCalendarsOn(flags)) return [];
  return [...new Set(config.mail_calendar_accounts ?? [])];
}

/** The experiment switches, read the same way as the calendar config (no cache in front of the file). */
export async function readExperimentalFlags(): Promise<ExperimentalFlags | undefined> {
  return ((await getConfig()) as { experimental?: ExperimentalFlags }).experimental;
}
