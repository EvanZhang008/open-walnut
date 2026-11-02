/**
 * `walnut.ui.useView`: `useState` for a view choice of a plugin's own (a pane shown or hidden,
 * the tab it is on, the item it shows), kept by Walnut the way every Walnut view is
 * (utils/view-memory.ts): in localStorage, mirrored to the server's ui-prefs, so it comes back
 * after the plugin reloads, the page reloads, the user visits another page, or the app restarts.
 * 2026-11-02, the user, on a practice plugin that lost its open panes: "can we make it default
 * feature in walnut no matter where include plugin, remember the state ... a generic walnut
 * thing not only to this plugin".
 *
 * Kept under `open-walnut-view:plugin.<plugin id>.<name>`; `options.id` keeps one per item (a
 * problem, a document) under `<name>.of`, the last VIEW_IDS_MAX written. A stored value the plugin no longer takes
 * (another type than `initial`'s, or one `options.accept` refuses) reads as `initial`; `accept` is
 * asked when the stored value changes, so keep it a check of the value's shape.
 * `walnut-plugin validate` warns on a view choice a plugin's web code keeps in plain `useState`.
 */
import { usePageView, usePageViewOf } from '@/utils/view-memory'
import type { PluginUseView } from './types'

// No dot: the key is `plugin.<id>.<name>` and a plugin id may hold dots, so a dot here could
// land on another plugin's key (`acme` + `notes.tab` against `acme.notes` + `tab`).
const NAME = /^[A-Za-z0-9][\w-]{0,63}$/

function sameKind(initial: unknown, v: unknown): boolean {
  if (initial === null || initial === undefined) return v !== undefined
  if (Array.isArray(initial)) return Array.isArray(v)
  return typeof v === typeof initial && (typeof v !== 'object' || (v !== null && !Array.isArray(v)))
}

export function createPluginUseView(pluginId: string): PluginUseView {
  const page = `plugin.${pluginId}`
  return function useView<T>(name: string, initial: T | (() => T), options?: { id?: string; accept?: (value: unknown) => boolean }) {
    if (!NAME.test(name)) throw new Error('walnut.ui.useView name must be 1-64 letters, digits, "_" or "-"')
    const start = typeof initial === 'function' ? (initial as () => T)() : initial
    const accept = (v: unknown): v is T => sameKind(start, v) && (options?.accept ? options.accept(v) : true)
    // One hook either way, so a plugin may pass an id on one render and not on the next.
    const id = options?.id
    const [byId, setById] = usePageViewOf<T>(page, `${name}.of`, id ?? '', start, accept)
    const [own, setOwn] = usePageView<T>(page, name, start, accept)
    return id === undefined ? [own, setOwn] : [byId, setById]
  }
}
