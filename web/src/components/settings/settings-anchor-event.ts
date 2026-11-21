/**
 * Said on window when Settings is about to scroll to a row by id (a Find a setting
 * hit, a deep link): a section that keeps that row folded away opens it first, so
 * the scroll finds it. (Phones & Cloud's ways are sub-pages now: a row on one resolves
 * to that page itself, settings-way-panes.ts.)
 */
export const SETTINGS_ANCHOR_EVENT = 'walnut:settings-anchor';

export function announceSettingsAnchor(id: string): void {
  window.dispatchEvent(new CustomEvent(SETTINGS_ANCHOR_EVENT, { detail: { id } }));
}
