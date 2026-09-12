import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

import { startLiveServer } from '../live/provider-matrix/harness.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('starts the matrix with isolated stores and no external-session import', async () => {
  vi.useFakeTimers()
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn(() => { child.exitCode = 0; child.emit('exit', 0, null); return true }),
  })
  spawn.mockReturnValue(child)
  const server = await startLiveServer()
  try {
    const options = spawn.mock.calls[0][2]
    expect(options.env).toMatchObject({
      OPEN_WALNUT_HOME: server.dataDir,
      WALNUT_DAEMON_DIR: path.join(server.dataDir, 'daemon'),
      WALNUT_STREAMS_DIR: path.join(server.dataDir, 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(server.dataDir, 'legacy-streams'),
      WALNUT_DISABLE_BACKGROUND_AI: '1',
      WALNUT_EXTERNAL_SESSION_IMPORT: '0',
    })
    expect(options.env.AWS_ACCESS_KEY_ID).toBeUndefined()
  } finally {
    const stopped = server.stop()
    await vi.runAllTimersAsync()
    await stopped
    fs.closeSync(spawn.mock.calls[0][2].stdio[1])
  }
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
})
