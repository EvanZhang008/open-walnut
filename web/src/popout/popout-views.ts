/**
 * The pop-out views (`/popout?view=…`), each its own chunk. The browser extension's side panel and
 * toolbar popup frame `view=ext-panel` on every open, and that frame used to evaluate the whole
 * console (Home, Settings, Mail, every pop-out view) before it drew anything: about 700 ms of the
 * second it took to open (2026-11-06). Now a pop-out window loads only the view it shows.
 *
 * main.tsx starts the view's import before React mounts (`loadPopoutView`), in parallel with the
 * sign-in check and the preference sync, so PopoutRoot finds it loaded (`loadedPopoutView`) and
 * draws it in the first render; a view not loaded yet suspends until it is.
 *
 * Keep this file free of static imports: main.tsx imports it, and anything here lands in the
 * entry chunk every window evaluates.
 */
import type { ComponentType } from 'react';

type Loader = () => Promise<ComponentType>;

const LOADERS: Record<string, Loader> = {
  'ext-panel': () => import('./PopoutExtPanel').then((m) => m.PopoutExtPanel),
  'ext-tasks': () => import('./PopoutExtTasks').then((m) => m.PopoutExtTasks),
  file: () => import('./PopoutFileView').then((m) => m.PopoutFileView),
  'global-notes': () => import('./PopoutGlobalNotes').then((m) => m.PopoutGlobalNotes),
  note: () => import('./PopoutNote').then((m) => m.PopoutNote),
  session: () => import('./PopoutSession').then((m) => m.PopoutSession),
  task: () => import('./PopoutTask').then((m) => m.PopoutTask),
};

const started = new Map<string, Promise<ComponentType>>();
const loaded = new Map<string, ComponentType>();

export function isPopoutView(view: string | null | undefined): view is string {
  return !!view && Object.prototype.hasOwnProperty.call(LOADERS, view);
}

/** The view's component, its import started once per page; null for a view that does not exist. */
export function loadPopoutView(view: string | null | undefined): Promise<ComponentType> | null {
  if (!isPopoutView(view)) return null;
  let p = started.get(view);
  if (!p) {
    p = LOADERS[view]().then((c) => { loaded.set(view, c); return c; });
    // A failed import is tried again by the next ask (the stale-asset recovery reloads first).
    p.catch(() => { started.delete(view); });
    started.set(view, p);
  }
  return p;
}

/** The view's component once its import has landed, else undefined (it suspends then). */
export function loadedPopoutView(view: string): ComponentType | undefined {
  return loaded.get(view);
}

/** The view named in a pop-out address's query (`?view=`). */
export function popoutViewOf(search: string): string | null {
  return new URLSearchParams(search).get('view');
}
