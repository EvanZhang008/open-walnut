/**
 * Which control a plugin's config field gets, and how its value travels.
 *
 * Pure, so the mapping is gradable without a DOM: `PluginConfigCards` is a shared renderer every
 * plugin's Settings form goes through, and a field type it does not recognise renders NOTHING — the
 * field simply is not there, with no error to notice. That is how Mail's `poll_interval_seconds` and
 * Slack's `poll_minutes` (both `integer`) were invisible in Settings while being perfectly valid in
 * config.yaml.
 *
 * `integer` is `number` with a whole-number step. A string `array` is a textarea: one entry per line
 * is what a list of channels looks like when you read it, and commas are accepted because that is
 * what people paste. Anything else (an object, an array of objects) stays config.yaml-only — a
 * half-rendered nested form is worse than an honest absence.
 */

export interface PluginFieldSchema {
  type?: string;
  default?: unknown;
  items?: { type?: string };
}

export type PluginFieldKind = 'boolean' | 'text' | 'number' | 'integer' | 'list';

/** The control for this schema, or `null` for "config.yaml only". */
export function fieldKindFor(schema: PluginFieldSchema | undefined): PluginFieldKind | null {
  switch (schema?.type) {
    case 'boolean': return 'boolean';
    case 'string': return 'text';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'array': return schema.items?.type === 'string' ? 'list' : null;
    default: return null;
  }
}

/**
 * What the textarea shows. The stored value is an array (it came off the wire) until the user types,
 * from which point the draft holds their raw text — re-parsing on every keystroke would delete the
 * comma the moment it was typed.
 */
export function listTextFor(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join('\n');
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/** Newlines and commas both separate; blanks are dropped, so a trailing separator is not an entry. */
export function parseListText(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The value as the config file should hold it. Identity for every kind whose control already edits
 * the final shape; only a list has a text form on screen and an array on disk.
 */
export function valueForSave(schema: PluginFieldSchema | undefined, value: unknown): unknown {
  if (fieldKindFor(schema) !== 'list') return value;
  return typeof value === 'string' ? parseListText(value) : value;
}

/** `default: a, b` when the manifest names one, else how to type the list. */
export function listPlaceholder(schema: PluginFieldSchema | undefined): string {
  const fallback = schema?.default;
  if (Array.isArray(fallback) && fallback.length > 0) return `default: ${fallback.join(', ')}`;
  return 'One per line, or comma-separated';
}

/**
 * Plugin config keys another Settings pane already edits with a proper control
 * (N3-04). One place per setting: the plugin's own rows leave these keys out
 * and show one line that links to the pane that owns them, the same rule that
 * moved the task sync block out of Integrations.
 */
export interface FieldOwner {
  keys: readonly string[];
  /** Settings pane id (the hash the link opens). */
  pane: string;
  label: string;
  help: string;
  link: string;
}

const FIELD_OWNERS: Record<string, FieldOwner> = {
  calendar: {
    keys: ['source_enabled', 'hidden_calendar_ids', 'visible_calendar_ids'],
    pane: 'calendar',
    label: 'Which calendars show',
    help: 'Calendar Accounts turns Mac calendars on and picks which ones show.',
    link: 'Open Calendar Accounts',
  },
};

/** The pane that owns this plugin field, or null when the plugin's rows edit it. Pure. */
export function fieldOwnerFor(pluginId: string, key: string): FieldOwner | null {
  const owner = FIELD_OWNERS[pluginId];
  return owner && owner.keys.includes(key) ? owner : null;
}
