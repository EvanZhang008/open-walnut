/**
 * A host that runs a session refuses its start or resume on a gone folder and says so on its
 * channel (a session:error the leader re-emits with source 'host-channel'): the server's
 * session:error handler takes the runner's folder-gone way for it first, before anything in that
 * handler can return or wait (a turn a retrier keeps, src/core/sessions/turn-run.ts), so a released
 * workspace is made again and what the host parked goes once it is there
 * (src/providers/session-folder-prep.ts noteHostFolderGone).
 *
 * Real: the server and its bus subscriber, judge-of. Faked: the folder-gone recorder (a spy: the
 * remake behind it is tested in tests/providers/host-folder-prep.test.ts) and, for one case, the
 * turn-run's answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

const seen = vi.hoisted(() => ({ noted: [] as unknown[][], takenBy: null as string | null }))
vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/sessions/folder-gone.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  noteFolderGone: vi.fn(async (...args: unknown[]) => { seen.noted.push(args); return null }),
}))
vi.mock('../../src/core/sessions/turn-run.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  turnEndTakenBy: vi.fn(async () => seen.takenBy),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { noteHostJudged, _resetJudgeOfForTesting } from '../../src/core/sessions/judge-of.js'

const HOST_SID = '50000000-0000-4000-8000-0000000000f7'
const LEADER_SID = '50000000-0000-4000-8000-0000000000f8'
const GONE = 'Working directory no longer exists on devbox: /work/worktrees/released-ws'
const WAIT = { timeout: 10_000 }
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH

function hostSays(sessionId: string, error: string, source = 'host-channel'): void {
  bus.emit(EventNames.SESSION_ERROR, { sessionId, error, errorKind: 'delivery_failed', parked: true }, ['main-ai'], { source })
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await startServer({ port: 0, dev: true })
}, 60_000)

afterAll(async () => {
  await stopServer()
  _resetJudgeOfForTesting()
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
})

beforeEach(() => {
  seen.noted.length = 0
  seen.takenBy = null
  noteHostJudged(HOST_SID, 'devbox')
})

describe('a host-run session the host refused on a gone folder', () => {
  it('the server takes the folder-gone way for it', async () => {
    hostSays(HOST_SID, GONE)
    await vi.waitFor(() => expect(seen.noted).toEqual([[HOST_SID]]), WAIT)
  })

  it('also when a retrier keeps the turn (the handler returns early for it)', async () => {
    seen.takenBy = 'restart_recovery'
    hostSays(HOST_SID, GONE)
    await vi.waitFor(() => expect(seen.noted).toEqual([[HOST_SID]]), WAIT)
  })

  it('not for another error, nor for a session this leader runs, nor for an error said here', async () => {
    hostSays(HOST_SID, 'the model is overloaded')
    hostSays(LEADER_SID, GONE)
    hostSays(HOST_SID, GONE, 'session-runner')
    // A last one that does count: once it is seen, the three before it were handled too.
    hostSays(HOST_SID, `${GONE} (again)`)
    await vi.waitFor(() => expect(seen.noted).toEqual([[HOST_SID]]), WAIT)
  })
})
