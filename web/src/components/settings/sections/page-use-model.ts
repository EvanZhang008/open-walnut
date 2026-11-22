/**
 * What Settings > Page Use lists: every page and Settings pane a visit can be counted
 * for, from the same sources the sidebar and the Settings nav draw. Kept apart from the
 * component so it is testable without the React tree.
 */
import { pageKeyForPath, settingsVisitKey } from '@/api/page-visits';

export interface KnownPlace { key: string; label: string; where: 'Page' | 'Settings' | 'App' }

/** Pages with no sidebar app of their own (the Settings nav links some of them). */
const FIXED_PAGES: readonly KnownPlace[] = [
  { key: 'page:task', label: 'Task details', where: 'Page' },
  { key: 'page:org', label: 'Org', where: 'Page' },
  { key: 'page:agents', label: 'Agents', where: 'Page' },
  { key: 'page:commands', label: 'Commands', where: 'Page' },
  { key: 'page:memory', label: 'Memory', where: 'Page' },
];

/** A Settings pane as the registry or a plugin names it (no import of the registry: it imports this file). */
export interface PaneName { id: string; label: string; navHidden?: boolean }

/** Every place a visit can be counted for, labelled; de-duplicated by key, first label wins. */
export function knownPlaces(
  apps: ReadonlyArray<{ path: string; title: string; pluginId?: string }>,
  panes: ReadonlyArray<PaneName>,
): KnownPlace[] {
  const out = new Map<string, KnownPlace>();
  const add = (p: KnownPlace | null) => { if (p && !out.has(p.key)) out.set(p.key, p); };
  for (const app of apps) {
    const key = pageKeyForPath(app.path);
    // A plugin's app is an App wherever its route lives, so one kind of thing reads one way.
    if (key) add({ key, label: app.title, where: key.startsWith('app:') || app.pluginId ? 'App' : 'Page' });
  }
  for (const p of FIXED_PAGES) add(p);
  for (const pane of panes) {
    if (pane.navHidden) continue;
    const key = settingsVisitKey(pane.id);
    if (key) add({ key, label: pane.label, where: 'Settings' });
  }
  return [...out.values()];
}

/** Names for keys no app or pane names now (a page with no sidebar entry). */
const UNLISTED_NAMES: Readonly<Record<string, string>> = { popout: 'Browser extension panel' };

/**
 * A counted key that no known place names (an app since removed, a page with no sidebar entry):
 * a readable name from the key itself, never the key, which stays for the row's tooltip.
 * `app:interview-practice~main` -> "Interview practice", App.
 */
export function placeOfKey(key: string): Omit<KnownPlace, 'key'> {
  const [kind, rest = ''] = key.split(/:(.*)/s);
  // An app's `~main` names its route inside the app; a plugin pane's `mail~rules` is its whole name.
  const id = kind === 'settings' ? rest.replace(/~/g, ' ') : (rest.split('~')[0] ?? rest);
  const words = id.replace(/[-_.]+/g, ' ').trim();
  const label = UNLISTED_NAMES[id] ?? (words ? words[0]!.toUpperCase() + words.slice(1) : key);
  return { label, where: kind === 'settings' ? 'Settings' : kind === 'app' ? 'App' : 'Page' };
}

