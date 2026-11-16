/**
 * An App's session pane (`AppContribution.sessionPane`): the contract between a plugin, the
 * App registry and the session panel's kept view.
 *
 *   manifest    an App without `sessionPane` registers exactly as before and is never offered
 *               beside a session; one with it is; a sessionPane that is not a component isolates
 *               the plugin with a message naming the field
 *   lifecycle   disabling the plugin takes the pane App away, a rebuild re-registers it under a
 *               new generation (the pane's remount key)
 *   view memory the panel keeps `view: 'app'` with the App and one document per App; a malformed
 *               or oversized record reads as nothing kept, and a record of an older build (no
 *               `app`) still reads
 *   open event  openSessionApp's request is read back only when well formed
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiGetText: vi.fn(async () => 'module source'),
  apiPost: vi.fn(),
}))
vi.mock('@/api/ws', () => ({
  wsClient: {
    subscribeAll: vi.fn(() => () => undefined),
    sendRpc: vi.fn(),
    onEvent: vi.fn(),
    onConnectionChange: vi.fn(),
  },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: vi.fn(() => null) }))
vi.mock('@/hooks/useApps', () => ({ refreshAppsCatalogue: vi.fn(async () => undefined) }))
vi.mock('@/commands/markdown-bridge', () => ({ refreshMarkdownCommands: vi.fn(async () => undefined) }))
vi.mock('@/commands/skill-bridge', () => ({ refreshSkillCommands: vi.fn(async () => undefined) }))
vi.mock('@/utils/log', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../web/src/plugins/views.tsx', () => ({ createPluginViews: () => ({}) }))

import { apiGet } from '../../web/src/api/client.js'
import { AppRegistry, appRegistry, sessionPaneApps, appNavigateTarget, type SessionAppProps } from '../../web/src/apps/registry.js'
import {
  disposeWebPluginsForTesting,
  getWebPluginRuntimeSnapshot,
  refreshWebPlugins,
  setWebPluginImporterForTesting,
} from '../../web/src/plugins/loader.js'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'
import type { PluginRuntimeResponse, WalnutWebApiHost } from '../../web/src/plugins/types.js'
import {
  isPanelView,
  withPanelApp,
  withPanelAppDoc,
  PANEL_APP_DOC_MAX,
  PANEL_APP_DOCS_MAX,
} from '../../web/src/components/sessions/panel-view.js'
import { sessionAppOpenRequest, SESSION_APP_OPEN_EVENT } from '../../web/src/components/sessions/session-app-open.js'

const Page = () => null
const Pane = (_props: SessionAppProps) => null

function response(hash: string | null): PluginRuntimeResponse {
  return {
    plugins: hash ? [{ id: 'sketch', state: 'active' }] : [],
    tombstones: [],
    modules: hash ? [{ id: 'sketch', name: 'Sketch', hash, size: 10, url: `/api/plugin-runtime/sketch/web-module?v=${hash}` }] : [],
    moduleErrors: [],
  }
}

afterEach(async () => {
  await disposeWebPluginsForTesting()
  pluginUiRegistry.clear()
  appRegistry.clear()
  vi.clearAllMocks()
})

describe('sessionPane on an App contribution', () => {
  it('an App without it registers as before and is not offered beside a session', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('old-plugin'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) { api.ui.app({ id: 'main', title: 'Old', component: Page }) },
    }))
    await refreshWebPlugins()
    const apps = appRegistry.getSnapshot().apps
    expect(apps.map((app) => app.key)).toEqual(['sketch:main'])
    expect(apps[0].sessionPane).toBeUndefined()
    expect('sessionPane' in apps[0]).toBe(false)
    expect(sessionPaneApps(apps)).toEqual([])
  })

  it('an App with it is offered, and goes away with its plugin', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('pane-one'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.app({ id: 'main', title: 'Sketch', component: Page, sessionPane: Pane })
        api.ui.app({ id: 'other', title: 'Other', component: Page })
      },
    }))
    await refreshWebPlugins()
    const offered = sessionPaneApps(appRegistry.getSnapshot().apps)
    expect(offered.map((app) => [app.key, app.path])).toEqual([['sketch:main', '/apps/sketch~main']])
    expect(offered[0].sessionPane).toBe(Pane)
    const firstGeneration = offered[0].generation

    // A rebuild re-registers it: a new generation, which the pane uses to remount the App.
    vi.mocked(apiGet).mockResolvedValue(response('pane-two'))
    await refreshWebPlugins()
    const again = sessionPaneApps(appRegistry.getSnapshot().apps)
    expect(again.map((app) => app.key)).toEqual(['sketch:main'])
    expect(again[0].generation).toBeGreaterThan(firstGeneration)

    // Disabled: nothing is offered, and the standalone App is gone with it.
    vi.mocked(apiGet).mockResolvedValue(response(null))
    await refreshWebPlugins()
    expect(appRegistry.getSnapshot().apps).toEqual([])
    expect(sessionPaneApps(appRegistry.getSnapshot().apps)).toEqual([])
  })

  it('a sessionPane that is not a component isolates the plugin and names the field', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('bad-pane'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.app({ id: 'main', title: 'Sketch', component: Page, sessionPane: '<div/>' as unknown as typeof Pane })
      },
    }))
    await refreshWebPlugins()
    expect(getWebPluginRuntimeSnapshot().errors).toEqual([{ id: 'sketch', error: 'Plugin App sessionPane must be a React component' }])
    expect(appRegistry.getSnapshot().apps).toEqual([])
  })

  it('offers only native plugin Apps, in catalogue order', () => {
    const registry = new AppRegistry()
    registry.registerCore({ id: 'notes', title: 'Notes', path: '/notes', component: Page })
    registry.registerPlugin('b-plugin', 'B', { id: 'b', title: 'B', component: Page, sessionPane: Pane, order: 20 })
    registry.registerPlugin('a-plugin', 'A', { id: 'a', title: 'A', component: Page, sessionPane: Pane, order: 10 })
    expect(sessionPaneApps(registry.getSnapshot().apps).map((app) => app.key)).toEqual(['a-plugin:a', 'b-plugin:b'])
    registry.clear()
  })

  it('a pane navigates like its App: relative paths stay under the App', () => {
    expect(appNavigateTarget('/apps/sketch~main', 'doc/1')).toBe('/apps/sketch~main/doc/1')
    expect(appNavigateTarget('/apps/sketch~main', './doc')).toBe('/apps/sketch~main/doc')
    expect(appNavigateTarget('/apps/sketch~main', '/tasks/t1')).toBe('/tasks/t1')
  })
})

describe('the App view in the panel view memory', () => {
  it('keeps the App and a document per App', () => {
    let record = withPanelApp(null, 'sketch:main')
    expect(record).toEqual({ key: 'sketch:main' })
    record = withPanelAppDoc(record, 'sketch:main', 'drawings/plan.excalidraw')
    record = withPanelAppDoc(record, 'other:pane', 'b.txt')
    expect(record).toEqual({ key: 'other:pane', docs: { 'sketch:main': 'drawings/plan.excalidraw', 'other:pane': 'b.txt' } })
    // Back to the first App: its document is still there.
    record = withPanelApp(record, 'sketch:main')
    expect(record.docs?.['sketch:main']).toBe('drawings/plan.excalidraw')
    expect(isPanelView({ view: 'app', app: record })).toBe(true)
  })

  it('writes nothing for the same document again, forgets on null, refuses an oversized path', () => {
    const record = withPanelAppDoc(null, 'sketch:main', 'a')
    expect(withPanelAppDoc(record, 'sketch:main', 'a')).toBe(record)
    expect(withPanelAppDoc(record, 'sketch:main', 'x'.repeat(PANEL_APP_DOC_MAX + 1))).toBe(record)
    expect(withPanelAppDoc(record, 'sketch:main', null)).toEqual({ key: 'sketch:main' })
    expect(withPanelAppDoc(record, 'sketch:main', '')).toEqual({ key: 'sketch:main' })
    const fresh = withPanelApp(null, 'sketch:main')
    expect(withPanelAppDoc(fresh, 'sketch:main', null)).toBe(fresh)
  })

  it('keeps at most PANEL_APP_DOCS_MAX documents, dropping the oldest', () => {
    let record = withPanelApp(null, 'p:0')
    for (let i = 0; i <= PANEL_APP_DOCS_MAX; i++) record = withPanelAppDoc(record, `p:${i}`, `doc-${i}`)
    const keys = Object.keys(record.docs ?? {})
    expect(keys).toHaveLength(PANEL_APP_DOCS_MAX)
    expect(keys).not.toContain('p:0')
    expect(keys[keys.length - 1]).toBe(`p:${PANEL_APP_DOCS_MAX}`)
    expect(isPanelView({ view: 'app', app: record })).toBe(true)
  })

  it('a malformed record reads as nothing kept; an older build record still reads', () => {
    expect(isPanelView({ view: 'app' })).toBe(true)
    expect(isPanelView({ view: 'files', file: null })).toBe(true)
    expect(isPanelView({ view: 'app', app: { key: '' } })).toBe(false)
    expect(isPanelView({ view: 'app', app: { key: 7 } })).toBe(false)
    expect(isPanelView({ view: 'app', app: { key: 'k', docs: ['a'] } })).toBe(false)
    expect(isPanelView({ view: 'app', app: { key: 'k', docs: { k: 3 } } })).toBe(false)
    expect(isPanelView({ view: 'app', app: { key: 'k', docs: { k: 'x'.repeat(PANEL_APP_DOC_MAX + 1) } } })).toBe(false)
    expect(isPanelView({ view: 'app', app: { key: 'k'.repeat(201) } })).toBe(false)
    expect(isPanelView({ view: 'drawing' })).toBe(false)
  })
})

describe('openSessionApp requests', () => {
  const event = (detail: unknown) => new CustomEvent(SESSION_APP_OPEN_EVENT, { detail })
  it('reads a well-formed request, with or without a document', () => {
    expect(sessionAppOpenRequest(event({ sessionId: 's1', appKey: 'sketch:main' }))).toEqual({ sessionId: 's1', appKey: 'sketch:main' })
    expect(sessionAppOpenRequest(event({ sessionId: 's1', appKey: 'sketch:main', documentPath: 'a.excalidraw' })))
      .toEqual({ sessionId: 's1', appKey: 'sketch:main', documentPath: 'a.excalidraw' })
  })
  it('drops a malformed one', () => {
    expect(sessionAppOpenRequest(event(null))).toBeNull()
    expect(sessionAppOpenRequest(event({ sessionId: 's1' }))).toBeNull()
    expect(sessionAppOpenRequest(event({ sessionId: 's1', appKey: '' }))).toBeNull()
    expect(sessionAppOpenRequest(event({ sessionId: 's1', appKey: 'k', documentPath: 5 }))).toBeNull()
  })
})
