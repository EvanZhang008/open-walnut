/**
 * Said on window when Settings is about to scroll to a row by id (a Find a setting
 * hit, a deep link): a section that keeps that row folded away opens it first, so
 * the scroll finds it (SettingsFoldGroup listens). (Phones & Cloud's ways are sub-pages now: a row on one resolves
 * to that page itself, settings-way-panes.ts.)
 */
export const SETTINGS_ANCHOR_EVENT = 'walnut:settings-anchor';

let last: { id: string; at: number } | null = null;

/** The row Settings last scrolled to and when: a section that mounts after the event (its data
 *  loaded later) reads it. */
export function lastSettingsAnchor(): { id: string; at: number } | null {
  return last;
}

export function announceSettingsAnchor(id: string): void {
  last = { id, at: Date.now() };
  window.dispatchEvent(new CustomEvent(SETTINGS_ANCHOR_EVENT, { detail: { id } }));
}
