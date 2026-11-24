/**
 * A stop of a session its host runs and judges, refused by that host (a session that owns armed
 * crons, no force): the person's routes answer it as they answer the same refusal of a session of
 * this machine, 409 cron_owner, on the web route and on /api/v1 alike. The chain is the real one
 * from the route down: terminateSession, terminateOnHost, the session's proxy, and the leader
 * side's callHost (leader-side.ts), whose request to the host answers what host-routes.ts answers
 * for a SessionControlError there. Review round 1 of C8-16, S1: callHost threw a plain Error, and
 * both routes answered 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-judged-stop-refusal'))

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { writingAsHost } from '../../../src/core/sessions/session-row-owner.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { createLeaderSide } from '../../../src/core/session-channel/leader-side.js'
import { setRemoteJudgedCaller } from '../../../src/providers/remote-judged-session.js'

const SID = '7a0c3f52-1d4e-4b8a-9c21-5e6f7a8b9c0d'
const HOST = 'devbox'
const WORDS = 'This session owns armed crons; stop it with force to end them too'

const asked: Array<{ route: string; body: Record<string, unknown> }> = []

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', sessionLifecycleV1Router)
  a.use('/api/sessions', sessionsRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  asked.length = 0
  _resetJudgeOfForTesting()
  await createSessionRecord(SID, 'task-cron', 'Marina', '/w', { host: HOST, title: 'Cron owner' })
  await writingAsHost(() => updateSessionRecord(SID, { judge: 'host', process_status: 'idle' }))
  noteHostJudged(SID, HOST)
  // The host's answer to a stop its session refuses (host-routes.ts, a SessionControlError there).
  const side = createLeaderSide({
    log: () => {},
    request: async (_host: string, route: string, body: unknown) => {
      asked.push({ route, body: body as Record<string, unknown> })
      return { ok: false, error: WORDS, refusedWith: 409, code: 'cron_owner' }
    },
  } as never)
  setRemoteJudgedCaller((host, body) => side.callHost(host, body))
})

afterEach(async () => {
  setRemoteJudgedCaller(null)
  _resetJudgeOfForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a host\'s refusal of a stop reaches the person as that refusal', () => {
  it('/api/v1: 409 cron_owner with the host\'s words, and the session is not stopped here', async () => {
    const res = await request(app()).post(`/api/v1/sessions/${SID}/terminate`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'cron_owner', message: WORDS })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.body).toMatchObject({ sid: SID, target: 'lifecycle', member: 'terminateSession' })
    expect((await getSessionByClaudeId(SID))?.process_status).toBe('idle')
  })

  it('the web route: its own 409 cron_owner body', async () => {
    const res = await request(app()).post(`/api/sessions/${SID}/terminate`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toEqual({ error: 'cron_owner', message: WORDS, sessionId: SID })
  })
})
