/**
 * SessionRunner.isSessionStillAlive asks the daemon that owns a remote record
 * (probeDaemonSession) whether its CLI still runs, and believes the answer.
 *
 * Its own file because the probe is mocked by replacing daemon-connection. In
 * claude-code-session.test.ts this test reset the module registry to do that, and
 * every dynamic import after it in that file got a second copy of each module: a
 * second localDaemon spawned the real daemon binary, and the pooled '__local__'
 * connection flipped between two daemons (2026-10-28).
 */
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
const probeMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()),
  probeDaemonSession: probeMock,
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  getDaemonConnection: vi.fn(),
}))

import { SessionRunner } from '../../src/providers/claude-code-session.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')

describe('SessionRunner.isSessionStillAlive on a remote record', () => {
  it('routes remote records through probeDaemonSession', async () => {
    probeMock.mockResolvedValue({ alive: true })
    const runner = new SessionRunner(MOCK_CLI)
    try {
      const record = {
        claudeSessionId: 'remote-test',
        taskId: 't',
        project: 'p',
        process_status: 'running',
        mode: 'default',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0,
        host: 'clouddev',
        pid: 12345,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alive = (r: unknown): Promise<boolean> => (runner as any).isSessionStillAlive(r)
      expect(await alive(record)).toBe(true)
      expect(probeMock).toHaveBeenCalledWith('clouddev', 'remote-test')

      probeMock.mockResolvedValueOnce({ alive: false })
      expect(await alive(record)).toBe(false)

      probeMock.mockResolvedValueOnce(null) // daemon unreachable
      expect(await alive(record)).toBe(false)
    } finally {
      runner.destroy()
    }
  })
})
