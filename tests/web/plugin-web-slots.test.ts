import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `walnut.ui.slot`: a plugin's small component on the task detail or the session
// header. It belongs to its plugin like a page does: registered under the plugin's
// namespace, gone the moment the plugin is disabled, and refused at registration
// when it names a place the host does not have.

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
vi.mock('@/utils/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

import { apiGet, apiGetText } from '../../web/src/api/client.js'
import { appRegistry } from '../../web/src/apps/registry.js'
import {
  disposeWebPluginsForTesting,
  getWebPluginRuntimeSnapshot,
  refreshWebPlugins,
  setWebPluginImporterForTesting,
} from '../../web/src/plugins/loader.js'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'
import type { PluginRuntimeResponse, WalnutWebApiHost } from '../../web/src/plugins/types.js'

const Component = () => null

let activate: (api: WalnutWebApiHost) => void = () => {}

function serve(active: boolean, state = 'active'): void {
  const response: PluginRuntimeResponse = {
    plugins: [{ id: 'sample', state }],
    tombstones: [],
    modules: active ? [{ id: 'sample', name: 'Sample', hash: 'h1', size: 10, url: '/api/plugin-runtime/sample/web-module?v=h1' }] : [],
    moduleErrors: [],
  }
  vi.mocked(apiGet).mockResolvedValue(response)
}

const slots = () => pluginUiRegistry.getSnapshot().slots.map((entry) => [entry.key, entry.value.target, entry.value.title])
const errors = () => getWebPluginRuntimeSnapshot().errors.map((entry) => entry.error)

beforeEach(() => {
  setWebPluginImporterForTesting(async () => ({ activate: (api: WalnutWebApiHost) => activate(api) }))
  vi.mocked(apiGetText).mockResolvedValue('module source')
})

afterEach(async () => {
  await disposeWebPluginsForTesting()
  pluginUiRegistry.clear()
  appRegistry.clear()
  vi.clearAllMocks()
})

describe('walnut.ui.slot', () => {
  it('registers each slot under its plugin, and a disabled plugin takes them all away', async () => {
    activate = (api) => {
      api.ui.slot?.({ id: 'task-time', target: 'task.detail', title: 'Time', component: Component })
      api.ui.slot?.({ id: 'session-time', target: 'session.header', title: 'Time', component: Component, order: 10 })
    }
    serve(true)
    await refreshWebPlugins()
    expect(slots()).toEqual([
      ['sample:task-time', 'task.detail', 'Time'],
      ['sample:session-time', 'session.header', 'Time'],
    ])
    expect(pluginUiRegistry.getSnapshot().slots[0]!.pluginName).toBe('Sample')

    serve(false, 'disabled')
    await refreshWebPlugins()
    expect(slots()).toEqual([])
  })

  it('removes one slot when its own disposable is disposed', async () => {
    activate = (api) => {
      const gone = api.ui.slot!({ id: 'a', target: 'task.detail', title: 'A', component: Component })
      api.ui.slot!({ id: 'b', target: 'task.detail', title: 'B', component: Component })
      gone.dispose()
    }
    serve(true)
    await refreshWebPlugins()
    expect(slots()).toEqual([['sample:b', 'task.detail', 'B']])
  })

  it.each([
    ['an unknown target', { target: 'task.sidebar', title: 'Time' }, 'slot target must be one of'],
    ['an empty title', { target: 'task.detail', title: '  ' }, 'slot title is required'],
    ['a non-finite order', { target: 'task.detail', title: 'Time', order: Number.NaN }, 'slot order must be finite'],
  ])('refuses %s at registration, so the plugin learns it at once', async (_name, bad, message) => {
    activate = (api) => {
      api.ui.slot!({ id: 'x', component: Component, ...bad } as never)
    }
    serve(true)
    await refreshWebPlugins()
    expect(slots()).toEqual([])
    expect(errors().some((e) => e.includes(message))).toBe(true)
  })

  it('refuses a component that is not one', async () => {
    activate = (api) => {
      api.ui.slot!({ id: 'x', target: 'session.header', title: 'Time', component: 'nope' as never })
    }
    serve(true)
    await refreshWebPlugins()
    expect(slots()).toEqual([])
    expect(errors()).toHaveLength(1)
  })
})

describe('the slot registry', () => {
  it('keeps a stale disposable from removing a later slot of the same id', () => {
    const stale = pluginUiRegistry.registerSlot('plugin-a', 'Plugin A', {
      id: 'time', target: 'task.detail', title: 'Before', component: Component,
    })
    expect(pluginUiRegistry.removeOwner('plugin-a')).toBe(1)
    pluginUiRegistry.registerSlot('plugin-a', 'Plugin A', {
      id: 'time', target: 'task.detail', title: 'After', component: Component,
    })
    stale.dispose()
    expect(pluginUiRegistry.getSnapshot().slots.map((s) => s.value.title)).toEqual(['After'])
  })
})
