import { apiBaseUrl } from './http.js'

/** App id every scaffold registers; the host mounts it at `/apps/<pluginId>~<appId>`. */
export const DEFAULT_APP_ID = 'main'

/** Host route for a plugin App contribution. */
export function appPath(pluginId: string, appId: string = DEFAULT_APP_ID): string {
  return `/apps/${pluginId}~${appId}`
}

/** Clickable URL for a plugin App on the Walnut this CLI is pointed at. */
export function appUrl(
  pluginId: string,
  baseUrl: string = apiBaseUrl(),
  appId: string = DEFAULT_APP_ID,
): string {
  return new URL(appPath(pluginId, appId), baseUrl).toString()
}
