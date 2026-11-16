/**
 * Where an app's own window (PopoutAppView.tsx) is in its app. The window's address never
 * changes (openPopout.ts `appWindowPath`), so the place lives in the window's memory and in its
 * session storage, which a reload keeps and another window does not see.
 */
import { appPathMatches, type RegisteredApp } from '@/apps/registry';

type AppPlaceShape = Pick<RegisteredApp, 'kind' | 'path' | 'exactPath'>;

export function appWindowPlaceKey(appKey: string): string {
  return `walnut-app-window-place:${appKey}`;
}

/** Is `place` (a path with its query and hash) inside this app? A built-in app has one page. */
export function isPlaceInApp(app: AppPlaceShape, place: string): boolean {
  const pathname = place.replace(/[?#].*$/, '');
  return app.kind === 'core' ? pathname === app.path : appPathMatches(app, pathname);
}

/** Where the window opens in the app: where it was before a reload, else where the console last was. */
export function appWindowStart(app: AppPlaceShape, kept: string | null, remembered: string): string {
  if (kept && isPlaceInApp(app, kept)) return kept;
  return isPlaceInApp(app, remembered) ? remembered : app.path;
}
