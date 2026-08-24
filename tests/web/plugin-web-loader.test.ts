import { afterEach, describe, expect, it, vi } from 'vitest'

const appsCatalogue = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
}))

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
vi.mock('@/hooks/useApps', () => ({ refreshAppsCatalogue: appsCatalogue.refresh }))
vi.mock('@/commands/markdown-bridge', () => ({ refreshMarkdownCommands: vi.fn(async () => undefined) }))
vi.mock('@/commands/skill-bridge', () => ({ refreshSkillCommands: vi.fn(async () => undefined) }))
vi.mock('@/utils/log', () => ({
  log: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}))
vi.mock('../../web/src/plugins/views.tsx', () => ({
  createPluginViews: () => ({
    CalendarView: () => null,
    FileView: () => null,
    NoteView: () => null,
    TerminalView: () => null,
    SessionView: () => null,
    TaskView: () => null,
    ChatView: () => null,
  }),
}))

import { apiGet } from '../../web/src/api/client.js'
import { wsClient } from '../../web/src/api/ws.js'
import { appRegistry } from '../../web/src/apps/registry.js'
import {
  disposeWebPluginsForTesting,
  getWebPluginRuntimeSnapshot,
  refreshWebPlugins,
  refreshWebPluginsWithCommands,
  setWebPluginActivationTimeoutForTesting,
  setWebPluginImporterForTesting,
} from '../../web/src/plugins/loader.js'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'
import type { PluginRuntimeResponse, WalnutWebApiHost } from '../../web/src/plugins/types.js'

const Component = () => null

function response(hash: string | null): PluginRuntimeResponse {
  return {
    plugins: hash ? [{ id: 'sample', state: 'active' }] : [],
    tombstones: [],
    modules: hash ? [{
      id: 'sample',
      name: 'Sample Plugin',
      hash,
      size: 10,
      url: `/api/plugin-runtime/sample/web-module?v=${hash}`,
    }] : [],
    moduleErrors: [],
  }
}

afterEach(async () => {
  await disposeWebPluginsForTesting()
  pluginUiRegistry.clear()
  appRegistry.clear()
  vi.clearAllMocks()
})

describe('native Web Plugin loader', () => {
  it('refreshes the legacy Webview catalogue with runtime changes', async () => {
    vi.mocked(apiGet).mockResolvedValue(response(null))

    await refreshWebPluginsWithCommands()

    expect(appsCatalogue.refresh).toHaveBeenCalledOnce()
  })

  it('activates contributions and removes them when the module disappears', async () => {
    const cleanup = vi.fn()
    vi.mocked(apiGet).mockResolvedValue(response('hash-one'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.app({ id: 'main', title: 'Sample', component: Component })
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        api.ui.settings({ id: 'settings', label: 'Sample', component: Component })
        return { dispose: cleanup }
      },
    }))

    await refreshWebPlugins()

    expect(appRegistry.getSnapshot().apps.map((entry) => entry.key)).toEqual(['sample:main'])
    expect(pluginUiRegistry.getSnapshot().pages.map((entry) => entry.key)).toEqual(['sample:page'])
    expect(pluginUiRegistry.getSnapshot().settings.map((entry) => entry.key)).toEqual(['sample:settings'])
    expect(getWebPluginRuntimeSnapshot()).toMatchObject({ ready: true, loading: false, errors: [] })

    vi.mocked(apiGet).mockResolvedValue(response(null))
    await refreshWebPlugins()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(appRegistry.getSnapshot().apps).toEqual([])
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
    expect(pluginUiRegistry.getSnapshot().settings).toEqual([])
  })

  it('reloads exactly one owner when its build hash changes', async () => {
    const cleanups: Array<ReturnType<typeof vi.fn>> = []
    let activations = 0
    vi.mocked(apiGet).mockResolvedValue(response('hash-one'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        activations++
        const cleanup = vi.fn()
        cleanups.push(cleanup)
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    await refreshWebPlugins()

    vi.mocked(apiGet).mockResolvedValue(response('hash-two'))
    await refreshWebPlugins()

    expect(activations).toBe(2)
    expect(cleanups[0]).toHaveBeenCalledOnce()
    expect(cleanups[1]).not.toHaveBeenCalled()
    expect(pluginUiRegistry.getSnapshot().pages).toHaveLength(1)
  })

  it('namespaces Web Plugin RPC calls to the owning Server Plugin', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('rpc-hash'))
    vi.mocked(wsClient.sendRpc).mockResolvedValue({ pong: true })
    let result: unknown
    setWebPluginImporterForTesting(async () => ({
      async activate(api: WalnutWebApiHost) {
        result = await api.ws.call('ping', { value: 1 })
      },
    }))

    await refreshWebPlugins()

    expect(wsClient.sendRpc).toHaveBeenCalledWith('sample:ping', { value: 1 })
    expect(result).toEqual({ pong: true })
  })

  it('isolates activation failures and still marks initial discovery complete', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('broken-hash'))
    setWebPluginImporterForTesting(async () => ({
      activate() {
        throw new Error('broken module')
      },
    }))

    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot()).toMatchObject({
      ready: true,
      loading: false,
      errors: [{ id: 'sample', error: 'broken module' }],
    })
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
  })

  it.each(['/tasks', '/popout', '/popout/session'])('rejects a page that conflicts with Walnut route %s', async (route) => {
    vi.mocked(apiGet).mockResolvedValue(response(`reserved-route-${route}`))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.page({ id: 'page', path: route, component: Component })
      },
    }))

    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot().errors).toEqual([{
      id: 'sample',
      error: `Plugin page path conflicts with Walnut: ${JSON.stringify(route)}`,
    }])
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
  })

  it('rejects a page that conflicts with a Core App added to the registry', async () => {
    appRegistry.registerCore({
      id: 'future-core',
      title: 'Future Core',
      path: '/future-core',
      component: Component,
    })
    vi.mocked(apiGet).mockResolvedValue(response('future-core-route'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.page({ id: 'page', path: '/future-core/details', component: Component })
      },
    }))

    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot().errors).toEqual([{
      id: 'sample',
      error: 'Plugin page path conflicts with Walnut: "/future-core/details"',
    }])
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
  })

  it('allows a Plugin page whose name only starts with the popout word', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('popouts-route'))
    setWebPluginImporterForTesting(async () => ({
      activate(api: WalnutWebApiHost) {
        api.ui.page({ id: 'page', path: '/popouts', component: Component })
      },
    }))

    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot().errors).toEqual([])
    expect(pluginUiRegistry.getSnapshot().pages).toHaveLength(1)
  })

  it('bounds a Plugin that never finishes activation', async () => {
    vi.mocked(apiGet).mockResolvedValue(response('hanging-hash'))
    setWebPluginActivationTimeoutForTesting(10)
    setWebPluginImporterForTesting(async () => ({
      activate: () => new Promise<never>(() => undefined),
    }))

    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot()).toMatchObject({
      ready: true,
      loading: false,
      errors: [{
        id: 'sample',
        error: 'Web Plugin "sample" activation timed out after 10ms',
      }],
    })
  })

  it('continues a reload after the old Plugin cleanup throws', async () => {
    let imports = 0
    vi.mocked(apiGet).mockResolvedValue(response('hash-one'))
    setWebPluginImporterForTesting(async () => {
      imports++
      return {
        activate(api: WalnutWebApiHost) {
          api.ui.page({ id: 'page', path: '/sample', component: Component })
        },
        ...(imports === 1
          ? { deactivate: () => { throw new Error('cleanup failed') } }
          : {}),
      }
    })
    await refreshWebPlugins()

    vi.mocked(apiGet).mockResolvedValue(response('hash-two'))
    await refreshWebPlugins()

    expect(imports).toBe(2)
    expect(pluginUiRegistry.getSnapshot().pages).toHaveLength(1)
    expect(getWebPluginRuntimeSnapshot().errors).toContainEqual({
      id: 'sample',
      error: 'cleanup failed',
    })
  })
})
