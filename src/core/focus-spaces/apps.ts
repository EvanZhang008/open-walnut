/**
 * Apps in a focus space: which plugins have an App, what each declares (manifest `focusSpaces`),
 * and the focus a plugin is in as it reads it (`walnut.focus.current()`).
 *
 * The mode rule is scope.ts `focusAppMode`, the same file the browser reads: a space's own choice
 * for the App, else its declaration (`scoped` starts fresh in each space, `shared` is Main's), and
 * a plugin that declares nothing is hidden in a space until the person shows it there.
 */
import { focusAppMode, type FocusAppMode, type FocusScope } from './scope.js'
import { getActiveFocus } from './active.js'
import { getFocusSpace } from './store.js'

export interface FocusApp {
  pluginId: string
  name: string
  declared?: 'scoped' | 'shared'
}

/** The plugins with an App of their own, as the space form lists them. */
export async function focusApps(): Promise<FocusApp[]> {
  const [{ registry }, { pluginManifestHasUi }] = await Promise.all([
    import('../integration-registry.js'),
    import('../integration-loader.js'),
  ])
  return registry.getAll()
    .filter((p) => pluginManifestHasUi(registry, p.id) === true)
    .map((p) => ({ pluginId: p.id, name: p.name, ...(p.focusSpaces ? { declared: p.focusSpaces } : {}) }))
}

export interface PluginFocus {
  /** The saved space, when the focus is one. */
  spaceId?: string
  name: string
  scope: FocusScope
  /** How this plugin's App works in it: `isolated` keeps its own state under `spaceId`. */
  mode: FocusAppMode
}

/** The focus the person is in, as `pluginId` should treat it; null = none. */
export async function pluginFocus(pluginId: string, declared: 'scoped' | 'shared' | undefined): Promise<PluginFocus | null> {
  const active = await getActiveFocus()
  if (!active) return null
  const space = active.spaceId ? await getFocusSpace(active.spaceId) : null
  return {
    ...(active.spaceId ? { spaceId: active.spaceId } : {}),
    name: active.name,
    scope: active.scope,
    mode: focusAppMode(space?.apps[pluginId], declared),
  }
}
