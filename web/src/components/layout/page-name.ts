/**
 * The name of the page on screen, the one the phone's top bar shows (standard "Page heads": on a
 * phone the bar names the page and the page does not name itself again).
 *
 * 2026-11-26, the UI audit at 390 px on the user's data: the bar read the page's name on Home,
 * Notes, Mail, Calendar, Routines and Settings, but "Walnut" on Org, Memory, Agents and Commands
 * (pages the router draws that are not apps), while those pages and Apps wrote their name again
 * under it. tests/web/page-head-guard.test.ts fails on a routed page with no name here.
 */
import { matchPath, matchRoutes } from 'react-router-dom';
import type { RegisteredApp } from '@/apps/registry';
import type { PluginPageContribution } from '@/plugins/types';

/** Pages the router draws (App.tsx) that are not apps: path -> name. */
export const SHELL_PAGE_NAMES: Readonly<Record<string, string>> = {
  '/org': 'Org',
  '/agents': 'Agents',
  '/commands': 'Commands',
  '/memory': 'Memory',
  '/plugins/new': 'Build an app',
};

/** The bar's words when nothing on screen has a name (a hand-off card opened from another app). */
export const NO_PAGE_NAME = 'Walnut';

export function pageNameOf(
  pathname: string,
  app: Pick<RegisteredApp, 'title'> | undefined,
  pluginPages: ReadonlyArray<Pick<PluginPageContribution, 'path' | 'title'>> = [],
  /** A routed page's name the user set (the org's name for /org), over SHELL_PAGE_NAMES'. */
  named: Readonly<Record<string, string | undefined>> = {},
): string {
  if (app) return app.title;
  try { pathname = decodeURI(pathname); } catch { /* a malformed escape reads as written */ }
  // The router matches a path as it does (any case, a trailing slash, an encoded letter), and of a
  // plugin's pages the one it ranks first (a static path over a param one).
  const shell = Object.keys(SHELL_PAGE_NAMES).find((p) => matchPath(p, pathname));
  if (shell) return named[shell]?.trim() || SHELL_PAGE_NAMES[shell];
  const hit = matchRoutes(pluginPages.map((p, i) => ({ path: p.path, id: String(i) })), pathname)?.[0];
  return (hit && pluginPages[Number(hit.route.id)]?.title) || NO_PAGE_NAME;
}
