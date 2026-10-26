/**
 * Where the Org page was in this window, so coming back to it (the sidebar, a reload, the
 * Mac app reopened) shows the same place: the node picked (Main or a VP), its tab, the task
 * open beside it, and how far the list and the Team view were scrolled. 2026-10-26, the
 * user: "if last time I am in Main it stay in Main, if I am in Lead 12 it should be in lead
 * 12 after I click back".
 *
 * Kept in this device's localStorage under a key ui-prefs-sync never mirrors (it syncs only
 * `open-walnut-*` and `walnut-todo-*`): a phone's place is not the Mac's, and syncing it would
 * move one device's page whenever the other moved.
 */

const KEY = 'walnut.org.place';

export interface OrgPlace {
  node?: string;
  tab?: string;
  open?: string;
  /** The channel list's scrollTop. */
  listTop?: number;
  /** The Team view's scrollTop, for the node it was read on. */
  team?: { key: string; top: number };
}

export function readOrgPlace(): OrgPlace {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as OrgPlace) : {};
  } catch {
    return {};
  }
}

export function writeOrgPlace(patch: Partial<OrgPlace>): void {
  try {
    const next: OrgPlace = { ...readOrgPlace(), ...patch };
    for (const k of Object.keys(next) as (keyof OrgPlace)[]) if (next[k] === undefined) delete next[k];
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* storage off: the page still works, it just starts fresh */ }
}

/** The URL params a bare /org should take on, or null when there is nothing to restore. */
export function placeParams(place: OrgPlace): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (place.node) out.node = place.node;
  if (place.node && place.tab) out.tab = place.tab;
  if (place.open) out.open = place.open;
  return Object.keys(out).length ? out : null;
}
