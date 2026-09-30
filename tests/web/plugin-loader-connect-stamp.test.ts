/**
 * The plugin loader stamps each refresh signal so the skill bridge can reuse a
 * skill list read that already covers it. The page's FIRST socket connect
 * announces no change (it only proves the server is up), so it is stamped 0:
 * stamping it with the connect time made every page load read the 1.2MB skill
 * list twice, because index.ts's read leaves before the socket opens
 * (2026-09-29). A reconnect, and every plugin event, keeps a real stamp.
 * The bridge side (0 reuses a read, a failed read still reads) is pinned in
 * tests/web/skill-bridge-shared-load.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ws = vi.hoisted(() => ({
  connection: [] as Array<(state: string) => void>,
  events: new Map<string, (data: unknown) => void>(),
}))
const skills = vi.hoisted(() => ({ refresh: vi.fn(async (_opts?: { changedAt?: number }) => undefined) }))

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(async () => ({ plugins: [], tombstones: [], modules: [], moduleErrors: [] })),
  apiGetText: vi.fn(async () => ''),
  apiPost: vi.fn(),
}))
vi.mock('@/api/ws', () => ({
  wsClient: {
    subscribeAll: vi.fn(() => () => undefined),
    sendRpc: vi.fn(),
    onEvent: (name: string, cb: (data: unknown) => void) => { ws.events.set(name, cb) },
    onConnectionChange: (cb: (state: string) => void) => { ws.connection.push(cb) },
  },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: vi.fn(() => null) }))
vi.mock('@/hooks/useApps', () => ({ refreshAppsCatalogue: vi.fn(async () => undefined) }))
vi.mock('@/commands/markdown-bridge', () => ({ refreshMarkdownCommands: vi.fn(async () => undefined) }))
vi.mock('@/commands/skill-bridge', () => ({ refreshSkillCommands: skills.refresh }))
vi.mock('@/utils/log', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../web/src/plugins/views.tsx', () => ({
  createPluginViews: () => ({
    CalendarView: () => null, FileView: () => null, NoteView: () => null, TerminalView: () => null,
    SessionView: () => null, TaskView: () => null, ChatView: () => null,
  }),
}))

import { disposeWebPluginsForTesting, initWebPlugins } from '../../web/src/plugins/loader.js'

const connectionChange = (state: string) => { for (const cb of ws.connection) cb(state) }

/** Wait out the loader's 250ms coalescing window and the run it starts. */
async function settleRun(): Promise<void> {
  await new Promise((r) => setTimeout(r, 320))
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const stamps = () => skills.refresh.mock.calls.map((call) => call[0]?.changedAt)

beforeEach(async () => {
  // A fresh page: no listeners registered, no skill refresh asked for yet.
  ws.connection.length = 0
  ws.events.clear()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })
  await initWebPlugins()
  skills.refresh.mockClear()
})

afterEach(async () => {
  await disposeWebPluginsForTesting()
  vi.unstubAllGlobals()
})

describe('plugin loader: refresh stamps', () => {
  it('the first connect asks with changedAt 0; a reconnect with a real stamp', async () => {
    connectionChange('connected')
    await settleRun()
    expect(stamps()).toEqual([0])

    connectionChange('disconnected')
    const beforeReconnect = performance.now()
    connectionChange('connected')
    await settleRun()
    expect(stamps()).toHaveLength(2)
    expect(stamps()[1]).toBeGreaterThanOrEqual(beforeReconnect)
  })

  it('a plugin event before the first connect keeps its stamp for the shared run', async () => {
    const beforeEvent = performance.now()
    ws.events.get('plugin:runtime-changed')!({ action: 'reloaded' })
    connectionChange('connected')
    await settleRun()
    expect(stamps()).toHaveLength(1)
    expect(stamps()[0]).toBeGreaterThanOrEqual(beforeEvent)
  })
})
