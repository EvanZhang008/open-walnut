/**
 * `requiresPlugin` on a core app: the row exists only while that plugin is running.
 *
 * The gate is a pure filter applied where the catalogue is resolved, so the Sidebar, the
 * Settings "Manage" group and the Command Palette cannot disagree about whether the row is
 * there: they all read the same resolved list.
 *
 * Two rules that look like details and are not:
 *
 * - NOT READY means HIDDEN. The runtime snapshot starts empty and fills in after a fetch, so
 *   trusting it early would render the row, then take it away. A row that appears a beat late
 *   is a small delay; a row that appears and vanishes reads as a bug.
 * - Only `active` counts. `disabled`, `needs-dependency`, `failed` and "not in the list at
 *   all" are all reasons the plugin's routes are not answering, so a console pointed at them
 *   would only be able to show an error.
 */
import { describe, expect, it } from 'vitest'
import {
  activePluginKey,
  filterAppsByPlugin,
  type PluginRuntimeGate,
  type RegisteredApp,
} from '../../web/src/apps/registry.js'

function app(key: string, requiresPlugin?: string): RegisteredApp {
  const [owner, id] = key.split(':')
  return {
    key,
    id: id!,
    owner: owner!,
    kind: owner === 'core' ? 'core' : 'native',
    title: id!,
    path: owner === 'core' ? `/${id}` : `/apps/${owner}~${id}`,
    routeId: owner === 'core' ? id! : `${owner}~${id}`,
    component: () => null,
    badge: null,
    order: 30,
    fullBleed: false,
    placement: 'sidebar',
    persistent: false,
    lockVisibility: false,
    generation: 1,
    ...(requiresPlugin ? { requiresPlugin } : {}),
  }
}

const CATALOG = [app('core:home'), app('core:mail', 'mail'), app('core:settings')]

function runtime(ready: boolean, plugins: Array<{ id: string; state: string }>): PluginRuntimeGate {
  return { ready, plugins }
}

const KEYS = (apps: RegisteredApp[]): string[] => apps.map((entry) => entry.key)

/**
 * The gate as the catalogue applies it: the snapshot is reduced to one primitive key first
 * (`activePluginKey`), because that is what the catalogue's memo compares. Tested together so
 * neither half can drift into disagreeing about what "active" means.
 */
const gate = (apps: RegisteredApp[], snapshot: PluginRuntimeGate): RegisteredApp[] =>
  filterAppsByPlugin(apps, activePluginKey(snapshot))

describe('filterAppsByPlugin', () => {
  it('keeps every app that requires nothing, whatever the runtime says', () => {
    expect(KEYS(gate(CATALOG, runtime(false, [])))).toEqual(['core:home', 'core:settings'])
    expect(KEYS(gate(CATALOG, runtime(true, [{ id: 'mail', state: 'active' }]))))
      .toEqual(['core:home', 'core:mail', 'core:settings'])
  })

  it('hides the gated row until the runtime snapshot is ready', () => {
    // The plugin IS active; the client just does not know yet.
    expect(KEYS(gate(CATALOG, runtime(false, [{ id: 'mail', state: 'active' }]))))
      .toEqual(['core:home', 'core:settings'])
  })

  it('hides the gated row for every state that is not active', () => {
    for (const state of ['disabled', 'blocked', 'needs-dependency', 'needs-config', 'failed', 'quarantined', 'discovered']) {
      expect(
        KEYS(gate(CATALOG, runtime(true, [{ id: 'mail', state }]))),
        `state ${state} must not show the row`,
      ).toEqual(['core:home', 'core:settings'])
    }
  })

  it('hides the gated row when the plugin is not installed at all', () => {
    expect(KEYS(gate(CATALOG, runtime(true, [{ id: 'calendar', state: 'active' }]))))
      .toEqual(['core:home', 'core:settings'])
  })

  it('returns the same array instance when nothing is gated, so the catalogue memo holds', () => {
    const plain = [app('core:home'), app('core:settings')]
    expect(gate(plain, runtime(true, []))).toBe(plain)
  })
})

describe('activePluginKey', () => {
  it('is one primitive, stable across a publish the gate cannot see', () => {
    // The runtime store publishes at least twice per refresh (loading, then the result), plus
    // once for every unrelated plugin change. The catalogue must not re-resolve for those, so
    // the key it compares has to be equal whenever the ACTIVE SET is equal, whatever else moved
    // (list order included).
    const first = activePluginKey(runtime(true, [
      { id: 'mail', state: 'active' },
      { id: 'calendar', state: 'disabled' },
    ]))
    const second = activePluginKey(runtime(true, [
      { id: 'calendar', state: 'disabled' },
      { id: 'mail', state: 'active' },
      { id: 'jira', state: 'needs-config' },
    ]))
    expect(first).toBe('mail')
    expect(second).toBe(first)
    // Not ready is its own key, and it is the one that hides everything gated.
    expect(activePluginKey(runtime(false, [{ id: 'mail', state: 'active' }]))).toBe('')
  })
})
