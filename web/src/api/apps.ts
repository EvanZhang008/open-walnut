/**
 * Plugin apps — the small catalogue of static HTML surfaces a plugin can ship.
 *
 * The server owns discovery (which plugins declared an app, where its files
 * live) and hands back an opaque same-origin `url` under `/plugin-apps/…`.
 * The frontend never builds that path itself: a plugin may ship its entry as
 * `app/index.html` or `index.html`, and only the server knows which.
 */
import { apiGet } from './client';

export interface PluginApp {
  /** Stable id used in the route (`/apps/<id>`) and the sidebar test id. */
  id: string;
  /** Owning plugin — shown to the app in `walnut:init` so it can namespace data. */
  pluginId: string;
  title: string;
  /** URL path to an icon the server serves, or null → generic glyph. */
  icon: string | null;
  /** Opaque same-origin page URL, e.g. `/plugin-apps/<pluginId>/app/index.html`. */
  url: string;
}

export async function fetchApps(): Promise<PluginApp[]> {
  return apiGet<PluginApp[]>('/api/apps');
}
