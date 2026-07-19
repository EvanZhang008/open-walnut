/**
 * Cross-component refresh signal for the Settings plugin sections.
 *
 * PluginStoreSection (add/update/remove source) and PluginConfigCards (save
 * config) each mutate which plugins exist / their status, but they render from
 * independent fetches. Emitting this event after any mutation lets both
 * refetch without a page reload — e.g. "Configure in Integrations" right after
 * adding a source shows the new plugin's form immediately.
 */
export const PLUGINS_CHANGED_EVENT = 'walnut:plugins-changed';

/** Emit once per delay — a later echo covers the server's async soft reload. */
export function emitPluginsChanged(delaysMs: number[] = [0]): void {
  for (const delay of delaysMs) {
    setTimeout(() => window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT)), delay);
  }
}
