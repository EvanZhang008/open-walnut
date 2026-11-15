/** A network connection's first dial reattaches running sessions, including their old managers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('net-adopt-watcher'))
const mocks = vi.hoisted(() => ({ list: vi.fn(), manager: vi.fn(), update: vi.fn() }))
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: mocks.list, getSessionsForTaskSync: () => [], updateSessionRecord: mocks.update,
  emitSessionStatusChanged: vi.fn(), updateSessionRecordConditionally: vi.fn(),
}))
vi.mock('../../src/providers/session-manager.js', () => ({ getRegisteredSessionManager: mocks.manager }))
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
afterEach(() => vi.restoreAllMocks())

describe('adoption resumes the existing live watcher', () => {
  it.each(['running', 'idle'])('the first joined dial reattaches a %s session without a new user send', async (status) => {
    const record = { claudeSessionId: 'sid-existing', host: 'devbox', process_status: status, archived: false }
    mocks.list.mockResolvedValue([record])
    mocks.update.mockImplementation(async (_sid, changes) => ({ ...record, ...changes }))
    const reattachWatcher = vi.fn().mockResolvedValue(true)
    mocks.manager.mockReturnValue({ reattachWatcher })
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.walnut-net.invalid', via: 'net', endpoint: '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b' })
    const inner = conn as unknown as Record<string, (...args: unknown[]) => unknown>
    vi.spyOn(inner, 'dialNetHost').mockResolvedValue(undefined)
    vi.spyOn(inner, 'setConnected').mockImplementation(() => {})
    vi.spyOn(inner, 'startPing').mockImplementation(() => {})
    vi.spyOn(conn, 'hasCapability').mockReturnValue(false)
    vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, alive: true })
    try {
      await conn.connect()
      await vi.waitFor(() => expect(reattachWatcher).toHaveBeenCalledOnce())
      expect(mocks.manager).toHaveBeenCalledWith('sid-existing')
    } finally { conn.disconnect(); vi.clearAllMocks() }
  })
})
