/**
 * GET /api/sessions/git-status never waits on git (2026-11-25: on a loaded host one
 * `git status` of a large checkout took 4 to 9 s, and the route waited up to 1.5 s for
 * every cold or refreshed row, so its p90 was the 1,501 ms cap). It answers from the
 * cache at once; the newer reading reaches the page as a `session:git-status` event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-git-status-route'))

import { sessionsRouter } from '../../../src/web/routes/sessions.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import {
  _resetSessionGitStatusForTesting, _setSessionGitStatusDepsForTesting,
  type GitRepoStatus, type SessionGitGlance,
} from '../../../src/core/session-git-status.js'

/** Far under the old 1.5 s wait, with room for a loaded test host. */
const BUDGET_MS = 1_000

function app() {
  const server = express()
  server.use('/api/sessions', sessionsRouter)
  server.use(errorHandler)
  return server
}

const repo: GitRepoStatus = { repoRoot: '/w/big', branch: 'main', head: 'abc123456', upstream: 'origin/main', ahead: 0, behind: 0, files: 2, untracked: 0, conflicted: 0, insertions: 3, deletions: 1 }
let now = 1_000_000
let emitted: SessionGitGlance[]
let hang: boolean
let readLocal: ReturnType<typeof vi.fn>

beforeEach(() => {
  now = 1_000_000
  emitted = []
  hang = false
  readLocal = vi.fn(() => (hang ? new Promise<GitRepoStatus[]>(() => { /* a git that never ends */ }) : Promise.resolve([repo])))
  _setSessionGitStatusDepsForTesting({
    getSession: async () => ({ cwd: '/w/big' }),
    peekChanges: async () => null,
    readLocal,
    emit: (g) => { emitted.push(g) },
    countChanges: async () => undefined,
    shedding: () => true,
    changesBusy: () => false,
    transcriptSig: async () => null,
    now: () => now,
  })
})

afterEach(() => {
  _resetSessionGitStatusForTesting()
  _setSessionGitStatusDepsForTesting(null)
})

async function ask(query: string) {
  const started = Date.now()
  const res = await request(app()).get(`/api/sessions/git-status?${query}`)
  return { res, ms: Date.now() - started }
}

describe('GET /api/sessions/git-status while git hangs', () => {
  it('a cold row answers null at once, and its reading comes as an event', async () => {
    let release!: () => void
    readLocal.mockImplementationOnce(() => new Promise<GitRepoStatus[]>((r) => { release = () => r([repo]) }))
    const { res, ms } = await ask('ids=s1&refresh=1')
    expect(res.status).toBe(200)
    expect(res.body.glances).toEqual({ s1: null })
    expect(ms).toBeLessThan(BUDGET_MS)
    await vi.waitFor(() => expect(readLocal).toHaveBeenCalledTimes(1))
    release()
    await vi.waitFor(() => expect(emitted.map((g) => g.sessionId)).toEqual(['s1']))
  })

  it('a refresh answers the last reading at once and reads behind, once per folder', async () => {
    await ask('ids=s1')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    hang = true
    for (let i = 0; i < 4; i++) {
      now += 60_000 // every answer is stale: each ask wants a re-read
      const { res, ms } = await ask('ids=s1,s2&refresh=1')
      expect(res.status).toBe(200)
      expect(res.body.glances.s1.repos).toEqual([repo])
      expect(ms).toBeLessThan(BUDGET_MS)
    }
    // s1's re-read hangs; s2 (the same folder) and every later ask join it.
    await vi.waitFor(() => expect(readLocal).toHaveBeenCalledTimes(2))
    expect(readLocal.mock.calls.map(([dirs]) => dirs)).toEqual([['/w/big'], ['/w/big']])
  })
})
