/**
 * Open the keyboard shortcuts sheet from anywhere (Settings > Tasks' button): ShortcutsHelp.tsx
 * listens for this event, so a caller does not import the sheet and what it pulls in.
 */
export const SHORTCUTS_HELP_EVENT = 'walnut:shortcuts-help';

export function openShortcutsHelp(): void {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_HELP_EVENT));
}
