import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hot reload must never cost the user a plugin that was working.

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

import { apiGet, apiGetText } from '../../web/src/api/client.js'
import { appRegistry } from '../../web/src/apps/registry.js'
import {
  disposeWebPluginsForTesting,
  getWebPluginRuntimeSnapshot,
  refreshWebPlugins,
  setWebPluginActivationTimeoutForTesting,
  setWebPluginCleanupBudgetForTesting,
  setWebPluginImporterForTesting,
} from '../../web/src/plugins/loader.js'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'
import type {
  Disposable,
  PluginRuntimeResponse,
  PluginWebModuleDescriptor,
  WalnutWebApiHost,
} from '../../web/src/plugins/types.js'

const Component = () => null

type Build = () => {
  activate?: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>
  deactivate?: () => void | Promise<void>
}

/** Registered per `<id>@<hash>`, so a reload runs the build the descriptor actually names. */
const builds = new Map<string, Build>()

function build(id: string, hash: string, factory: Build): void {
  builds.set(`${id}@${hash}`, factory)
}

function descriptorFor(id: string, hash: string): PluginWebModuleDescriptor {
  return {
    id,
    name: `${id} plugin`,
    hash,
    size: 10,
    url: `/api/plugin-runtime/${id}/web-module?v=${hash}`,
  }
}

function runtime(
  modules: Array<[string, string]>,
  extra: {
    plugins?: Array<{ id: string; state: string }>
    moduleErrors?: Array<{ id: string; error: string }>
  } = {},
): PluginRuntimeResponse {
  return {
    plugins: extra.plugins ?? modules.map(([id]) => ({ id, state: 'active' })),
    tombstones: [],
    modules: modules.map(([id, hash]) => descriptorFor(id, hash)),
    moduleErrors: extra.moduleErrors ?? [],
  }
}

function serve(modules: Array<[string, string]>, extra?: Parameters<typeof runtime>[1]): void {
  vi.mocked(apiGet).mockResolvedValue(runtime(modules, extra))
}

function runningHash(pluginId: string): string | undefined {
  return getWebPluginRuntimeSnapshot().modules.find((module) => module.id === pluginId)?.hash
}

function errorMessages(): string[] {
  return getWebPluginRuntimeSnapshot().errors.map((entry) => entry.error)
}

function pageKeys(): string[] {
  return pluginUiRegistry.getSnapshot().pages.map((entry) => entry.key)
}

function appKeys(): string[] {
  return appRegistry.getSnapshot().apps.map((entry) => entry.key)
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status })
}

async function importFromBuilds(_source: string, descriptor: PluginWebModuleDescriptor) {
  const factory = builds.get(`${descriptor.id}@${descriptor.hash}`)
  if (!factory) throw new Error(`no build registered for ${descriptor.id}@${descriptor.hash}`)
  return factory()
}

beforeEach(() => {
  builds.clear()
  setWebPluginImporterForTesting(importFromBuilds)
  vi.mocked(apiGetText).mockResolvedValue('module source')
})

afterEach(async () => {
  await disposeWebPluginsForTesting()
  pluginUiRegistry.clear()
  appRegistry.clear()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('a failed hot reload keeps the plugin that was working', () => {
  it('keeps the running generation when the candidate cannot be downloaded', async () => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.app({ id: 'main', title: 'Sample', component: Component })
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    expect(pageKeys()).toEqual(['sample:page'])

    serve([['sample', 'hash-two']])
    vi.mocked(apiGetText).mockRejectedValue(httpError(404, 'Not Found'))
    await refreshWebPlugins()

    // Nothing was torn down, so the user's plugin is still the one that works.
    expect(cleanup).not.toHaveBeenCalled()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(appKeys()).toEqual(['sample:main'])
    expect(errorMessages()).toEqual(['Not Found'])
    // And the snapshot reports what is RUNNING, not what the server offered.
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('keeps the running generation when the candidate will not evaluate', async () => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    build('sample', 'hash-two', () => { throw new SyntaxError('Unexpected token }') })
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    serve([['sample', 'hash-two']])
    await refreshWebPlugins()

    expect(cleanup).not.toHaveBeenCalled()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(errorMessages()).toEqual(['Unexpected token }'])
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('restores the previous build when the candidate activates and throws', async () => {
    const activations: string[] = []
    const cleanups: Array<ReturnType<typeof vi.fn>> = []
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations.push('hash-one')
        const cleanup = vi.fn()
        cleanups.push(cleanup)
        api.ui.app({ id: 'main', title: 'Sample', component: Component })
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    build('sample', 'hash-two', () => ({
      activate(api) {
        activations.push('hash-two')
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        throw new Error('candidate exploded')
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    serve([['sample', 'hash-two']])
    await refreshWebPlugins()

    // One live generation at a time, which is also why the candidate could reuse the page path.
    expect(activations).toEqual(['hash-one', 'hash-two', 'hash-one'])
    expect(cleanups[0]).toHaveBeenCalledOnce()
    expect(cleanups[1]).not.toHaveBeenCalled()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(appKeys()).toEqual(['sample:main'])
    expect(errorMessages()).toEqual(['candidate exploded'])
    // A failed candidate must not be able to pose as the live build.
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('keeps a still-active plugin whose module the server failed to rebuild', async () => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.app({ id: 'main', title: 'Sample', component: Component })
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    // The plugin is still active; only the web module is missing from this answer.
    serve([], {
      plugins: [{ id: 'sample', state: 'active' }],
      moduleErrors: [{ id: 'sample', error: 'bundle step failed' }],
    })
    await refreshWebPlugins()

    expect(cleanup).not.toHaveBeenCalled()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(appKeys()).toEqual(['sample:main'])
    expect(errorMessages()).toEqual(['bundle step failed'])
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('still unloads a plugin that is really gone, build error or not', async () => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    // Disabled, not active: the missing module is a consequence, not the reason to keep the UI.
    serve([], {
      plugins: [{ id: 'sample', state: 'disabled' }],
      moduleErrors: [{ id: 'sample', error: 'bundle step failed' }],
    })
    await refreshWebPlugins()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(pageKeys()).toEqual([])
    expect(runningHash('sample')).toBeUndefined()
  })

  it.each(['activating', 'disposing'])('keeps the UI while the server is mid-reload (%s)', async (state) => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    // A reconnect refresh that lands mid-reload sees no module yet; that is not an uninstall.
    serve([], { plugins: [{ id: 'sample', state }] })
    await refreshWebPlugins()

    expect(cleanup).not.toHaveBeenCalled()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('unloads an active plugin that stopped shipping a web module', async () => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    // Active, no module, and no build error: the web entry was removed on purpose.
    serve([], { plugins: [{ id: 'sample', state: 'active' }] })
    await refreshWebPlugins()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(pageKeys()).toEqual([])
    expect(runningHash('sample')).toBeUndefined()
  })

  it.each(['needs-dependency', 'failed', 'quarantined'])('unloads a plugin left %s', async (state) => {
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    // A cascade disable is a real outcome, so leaving a dead panel behind would be a lie.
    serve([], { plugins: [{ id: 'sample', state }] })
    await refreshWebPlugins()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(pageKeys()).toEqual([])
  })

  it('does nothing at all when the hash has not moved', async () => {
    let activations = 0
    const deactivate = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations++
        api.ui.page({ id: 'page', path: '/sample', component: Component })
      },
      deactivate,
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    await refreshWebPlugins()
    await refreshWebPlugins()

    expect(activations).toBe(1)
    expect(deactivate).not.toHaveBeenCalled()
    // No re-download either: a same-hash refresh must not pay for the module at all.
    expect(vi.mocked(apiGetText)).toHaveBeenCalledOnce()
    expect(pageKeys()).toEqual(['sample:page'])
    expect(errorMessages()).toEqual([])
  })
})

describe('a teardown that never finishes stays contained', () => {
  it('disposes whatever a timed-out activation hands back late', async () => {
    const lateCleanup = vi.fn()
    setWebPluginActivationTimeoutForTesting(10)
    build('sample', 'hash-one', () => ({
      activate: () => new Promise<Disposable>((resolve) => {
        setTimeout(() => resolve({ dispose: lateCleanup }), 40)
      }),
    }))
    serve([['sample', 'hash-one']])

    await refreshWebPlugins()
    expect(errorMessages()).toEqual([
      'Web Plugin "sample" activation timed out after 10ms',
    ])
    expect(lateCleanup).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 60))

    // The context is already disposed, so the late resource is disposed on arrival.
    expect(lateCleanup).toHaveBeenCalledOnce()
  })

  it('consumes a late activation rejection instead of leaking it', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      setWebPluginActivationTimeoutForTesting(10)
      build('sample', 'hash-one', () => ({
        activate: () => new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('late failure')), 40)
        }),
      }))
      serve([['sample', 'hash-one']])
      await refreshWebPlugins()

      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(unhandled).not.toHaveBeenCalled()
      expect(errorMessages()).toEqual([
        'Web Plugin "sample" build hash-one failed to start, so it is skipped until a new build arrives',
      ])
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('refuses to start the next build while a hung activation is still running', async () => {
    setWebPluginActivationTimeoutForTesting(10)
    let restarts = 0
    build('sample', 'hash-one', () => ({ activate: () => new Promise<never>(() => undefined) }))
    build('sample', 'hash-two', () => ({ activate() { restarts++ } }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    expect(errorMessages()).toEqual(['Web Plugin "sample" activation timed out after 10ms'])

    serve([['sample', 'hash-two']])
    await refreshWebPlugins()

    // Giving up waiting is not the same as the plugin having stopped.
    expect(restarts).toBe(0)
    expect(errorMessages()).toEqual([
      'Web Plugin "sample" is still starting up, so the new build was not started',
    ])
    expect(runningHash('sample')).toBeUndefined()
  })

  it('does not restore the old build while the failed candidate is still starting up', async () => {
    setWebPluginActivationTimeoutForTesting(10)
    let activations = 0
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations++
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    build('sample', 'hash-two', () => ({ activate: () => new Promise<never>(() => undefined) }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    expect(activations).toBe(1)

    serve([['sample', 'hash-two']])
    await refreshWebPlugins()

    // Restoring on top of a candidate that is still running its own activate would double-open it.
    expect(cleanup).toHaveBeenCalledOnce()
    expect(activations).toBe(1)
    expect(pageKeys()).toEqual([])
    expect(errorMessages()).toEqual([
      'Web Plugin "sample" activation timed out after 10ms',
    ])
    expect(runningHash('sample')).toBeUndefined()
  })

  it('waits for a late disposable that is itself still disposing', async () => {
    setWebPluginActivationTimeoutForTesting(10)
    let finishDisposal = () => {}
    let restarts = 0
    build('sample', 'hash-one', () => ({
      activate: () => new Promise<Disposable>((resolve) => {
        setTimeout(() => resolve({
          dispose: () => new Promise<void>((done) => { finishDisposal = done }),
        }), 20)
      }),
    }))
    build('sample', 'hash-two', () => ({ activate() { restarts++ } }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    await new Promise((resolve) => setTimeout(resolve, 40))

    serve([['sample', 'hash-two']])
    await refreshWebPlugins()

    // Handing the late resource over is not the same as it being gone.
    expect(restarts).toBe(0)
    expect(errorMessages()).toEqual([
      'Web Plugin "sample" is still starting up, so the new build was not started',
    ])

    finishDisposal()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await refreshWebPlugins()

    expect(restarts).toBe(1)
    expect(errorMessages()).toEqual([])
  })

  it('restores the displaced build once the hung candidate settles, then waits for a new one', async () => {
    setWebPluginActivationTimeoutForTesting(10)
    let activations = 0
    let release = () => {}
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations++
        api.ui.page({ id: 'page', path: '/sample', component: Component })
      },
    }))
    build('sample', 'hash-two', () => ({
      activate: () => new Promise<void>((resolve) => { release = resolve }),
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    serve([['sample', 'hash-two']])
    await refreshWebPlugins()
    expect(pageKeys()).toEqual([])

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await refreshWebPlugins()

    // The build it displaced gets its place back, and the one that would not start is not retried.
    expect(activations).toBe(2)
    expect(pageKeys()).toEqual(['sample:page'])
    expect(runningHash('sample')).toBe('hash-one')
    expect(errorMessages()).toEqual([
      'Web Plugin "sample" build hash-two failed to start, so it is skipped until a new build arrives',
    ])
  })

  it('recovers on settlement after automatic retries have been exhausted', async () => {
    vi.useFakeTimers()
    setWebPluginActivationTimeoutForTesting(10)
    let release = () => {}
    let starts = 0
    build('sample', 'hash-one', () => ({ activate() { starts++ } }))
    build('sample', 'hash-two', () => ({
      activate: () => new Promise<void>(resolve => { release = resolve }),
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    serve([['sample', 'hash-two']])
    const replacement = refreshWebPlugins()
    await vi.advanceTimersByTimeAsync(10)
    await replacement
    await vi.advanceTimersByTimeAsync(20_000)
    expect(starts).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toBe(2)
    expect(runningHash('sample')).toBe('hash-one')
  })

  it('cancels restoration on disable and permits an explicit enable of the same build', async () => {
    setWebPluginActivationTimeoutForTesting(10)
    let release = () => {}
    let oldStarts = 0
    let newStarts = 0
    build('sample', 'hash-one', () => ({ activate() { oldStarts++ } }))
    build('sample', 'hash-two', () => ({
      activate() {
        newStarts++
        if (newStarts === 1) return new Promise<void>(resolve => { release = resolve })
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()
    serve([['sample', 'hash-two']])
    await refreshWebPlugins()
    serve([], { plugins: [{ id: 'sample', state: 'disabled' }] })
    await refreshWebPlugins()
    release()
    await vi.waitFor(() => expect(vi.mocked(apiGet).mock.calls.length).toBeGreaterThanOrEqual(4))
    await refreshWebPlugins()
    expect(oldStarts).toBe(1)
    expect(runningHash('sample')).toBeUndefined()
    serve([['sample', 'hash-two']])
    await refreshWebPlugins()
    expect(newStarts).toBe(2)
    expect(oldStarts).toBe(1)
    expect(runningHash('sample')).toBe('hash-two')
  })

  it('bounds a module evaluation that never settles and keeps the running build', async () => {
    setWebPluginActivationTimeoutForTesting(20)
    const cleanup = vi.fn()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: cleanup }
      },
    }))
    for (const hash of ['hash-one', 'hash-two']) {
      build('other', hash, () => ({
        activate(api) {
          api.ui.page({ id: 'page', path: '/other', component: Component })
        },
      }))
    }
    serve([['sample', 'hash-one'], ['other', 'hash-one']])
    await refreshWebPlugins()

    // A top-level await that never settles, which used to hold the whole refresh queue open.
    setWebPluginImporterForTesting(async (source, descriptor) => {
      if (descriptor.id === 'sample') return new Promise<never>(() => undefined)
      return importFromBuilds(source, descriptor)
    })
    serve([['sample', 'hash-two'], ['other', 'hash-two']])
    await refreshWebPlugins()

    expect(errorMessages()).toEqual([
      'Web Plugin "sample" module evaluation timed out after 20ms',
    ])
    // It failed in preflight, so the running build was never touched.
    expect(cleanup).not.toHaveBeenCalled()
    expect(runningHash('sample')).toBe('hash-one')
    expect(runningHash('other')).toBe('hash-two')
    expect(pageKeys()).toEqual(['sample:page', 'other:page'])
  })

  it('never advertises a module nothing is running, and takes its web entry away', async () => {
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.app({ id: 'main', title: 'Sample', component: Component })
        throw new Error('activate exploded')
      },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    expect(getWebPluginRuntimeSnapshot().modules).toEqual([])
    expect(appKeys()).toEqual([])
    expect(errorMessages()).toEqual(['activate exploded'])
    // The plugin row itself is still the server's answer, so a gated core app keeps its own.
    expect(getWebPluginRuntimeSnapshot().plugins).toEqual([{ id: 'sample', state: 'active' }])
  })

  it('reloads the other plugins and refuses to double-start the wedged one', async () => {
    setWebPluginCleanupBudgetForTesting(20)
    const activations: string[] = []
    const wedged = vi.fn(() => new Promise<void>(() => undefined))
    for (const hash of ['hash-one', 'hash-two']) {
      build('wedged', hash, () => ({
        activate(api) {
          activations.push(`wedged@${hash}`)
          api.ui.page({ id: 'page', path: '/wedged', component: Component })
          return { dispose: wedged }
        },
      }))
      build('healthy', hash, () => ({
        activate(api) {
          activations.push(`healthy@${hash}`)
          api.ui.page({ id: 'page', path: '/healthy', component: Component })
        },
      }))
    }
    serve([['wedged', 'hash-one'], ['healthy', 'hash-one']])
    await refreshWebPlugins()
    expect(activations).toEqual(['wedged@hash-one', 'healthy@hash-one'])

    serve([['wedged', 'hash-two'], ['healthy', 'hash-two']])
    await refreshWebPlugins()

    // The wedged teardown is still running, so its new build was NOT started.
    expect(activations).toEqual(['wedged@hash-one', 'healthy@hash-one', 'healthy@hash-two'])
    expect(pageKeys()).toEqual(['healthy:page'])
    expect(errorMessages()).toEqual([
      'Web Plugin "wedged" cleanup did not finish within 20ms, so the new build was not started',
    ])
    expect(runningHash('healthy')).toBe('hash-two')
    expect(runningHash('wedged')).toBeUndefined()

    // A later refresh says the same thing rather than quietly starting a second copy.
    await refreshWebPlugins()
    expect(activations).toEqual(['wedged@hash-one', 'healthy@hash-one', 'healthy@hash-two'])
    expect(errorMessages()).toEqual([
      'Web Plugin "wedged" is still shutting down, so the new build was not started',
    ])
  })

  it('runs every remaining disposer even when one of them wedges', async () => {
    setWebPluginCleanupBudgetForTesting(20)
    const order: string[] = []
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
        return { dispose: () => new Promise<void>(() => { order.push('wedged') }) }
      },
      deactivate: () => { order.push('deactivate') },
    }))
    serve([['sample', 'hash-one']])
    await refreshWebPlugins()

    serve([], { plugins: [] })
    await refreshWebPlugins()

    // The budget bounds how long we WAIT, not how much gets cleaned up.
    expect(order).toEqual(['wedged', 'deactivate'])
    expect(pageKeys()).toEqual([])
  })
})

describe('a refresh that could succeed later asks again', () => {
  it('retries a module the server was still rewriting', async () => {
    vi.useFakeTimers()
    let activations = 0
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations++
        api.ui.page({ id: 'page', path: '/sample', component: Component })
      },
    }))
    serve([['sample', 'hash-one']])
    vi.mocked(apiGetText)
      .mockRejectedValueOnce(httpError(409, 'Conflict'))
      .mockResolvedValue('module source')

    await refreshWebPlugins()
    expect(activations).toBe(0)
    expect(errorMessages()).toEqual(['Conflict'])
    // The runtime answer landed, so the shell renders; only this module is missing.
    expect(getWebPluginRuntimeSnapshot()).toMatchObject({ ready: true, loading: false })

    await vi.advanceTimersByTimeAsync(500)

    expect(activations).toBe(1)
    expect(pageKeys()).toEqual(['sample:page'])
    expect(errorMessages()).toEqual([])
  })

  it('stops asking once the ladder is spent, though the runtime answer keeps succeeding', async () => {
    // A runtime answer must not clear the counter, or a failing module would retry forever.
    vi.useFakeTimers()
    build('sample', 'hash-one', () => ({ activate() { /* never reached */ } }))
    serve([['sample', 'hash-one']])
    vi.mocked(apiGetText).mockRejectedValue(httpError(503, 'Service Unavailable'))

    await refreshWebPlugins()
    expect(vi.mocked(apiGetText)).toHaveBeenCalledOnce()

    // 0.5 + 1 + 2 + 4 + 8 seconds of backoff, one attempt behind each.
    await vi.advanceTimersByTimeAsync(16_000)
    expect(vi.mocked(apiGetText)).toHaveBeenCalledTimes(6)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.mocked(apiGetText)).toHaveBeenCalledTimes(6)
    expect(errorMessages()).toEqual(['Service Unavailable'])
    expect(getWebPluginRuntimeSnapshot()).toMatchObject({ ready: true, loading: false })
  })

  it('keeps a runtime retry budget of its own after a module has spent one', async () => {
    vi.useFakeTimers()
    build('sample', 'hash-one', () => ({
      activate(api) {
        api.ui.page({ id: 'page', path: '/sample', component: Component })
      },
    }))
    serve([['sample', 'hash-one']])
    vi.mocked(apiGetText).mockRejectedValue(httpError(503, 'Service Unavailable'))

    await refreshWebPlugins()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(vi.mocked(apiGetText)).toHaveBeenCalledTimes(6)

    // The module ladder is spent. The runtime's own failure still gets its own five tries.
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('FAILED after 15000ms'))
    await refreshWebPlugins()
    expect(errorMessages()).toEqual(['FAILED after 15000ms'])

    vi.mocked(apiGetText).mockResolvedValue('module source')
    await vi.advanceTimersByTimeAsync(500)

    expect(pageKeys()).toEqual(['sample:page'])
    expect(errorMessages()).toEqual([])
  })

  it('does not retry a module that downloaded and would not parse', async () => {
    vi.useFakeTimers()
    build('sample', 'hash-one', () => { throw new SyntaxError('Unexpected token }') })
    serve([['sample', 'hash-one']])

    await refreshWebPlugins()
    expect(vi.mocked(apiGet)).toHaveBeenCalledOnce()

    // The next build is the only fix, and the server announces that itself.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.mocked(apiGet)).toHaveBeenCalledOnce()
    expect(errorMessages()).toEqual(['Unexpected token }'])
  })
})

describe('refreshes stay serialized', () => {
  it('never runs two refreshes at once, however fast they arrive', async () => {
    let inFlight = 0
    let peakInFlight = 0
    let activations = 0
    build('sample', 'hash-one', () => ({
      activate(api) {
        activations++
        api.ui.page({ id: 'page', path: '/sample', component: Component })
      },
    }))
    vi.mocked(apiGet).mockImplementation(async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return runtime([['sample', 'hash-one']]) as never
    })

    await Promise.all([refreshWebPlugins(), refreshWebPlugins(), refreshWebPlugins()])

    expect(peakInFlight).toBe(1)
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(3)
    // Only the first refresh saw a new hash, and no refresh double-registered the page path.
    expect(activations).toBe(1)
    expect(pageKeys()).toEqual(['sample:page'])
    expect(errorMessages()).toEqual([])
  })
})
