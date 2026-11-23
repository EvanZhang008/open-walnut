/**
 * task_start_check on a host's own server (replica/start-ceiling.ts awayStartCheck): the leader's
 * answer (web/routes/task-start-check-v1.ts), with the caller read as this replica's away starts read
 * it (awayStartCaller), so a plugin job asks the same question whether the Mac answers or is away.
 * The route table answers this host's own call here (route-table.ts), and the decision table says
 * the op answers here (away-op-decisions.ts).
 *
 * Real: the handler, the actor reader (write-actor.ts), the relay's job hold and the self-call
 * credential, the ceiling. Faked: a session's mode (the sessions copy).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { awayStartCheck, replicaStartCaller, type StartCallerDeps } from '../../src/replica/start-ceiling.js'
import { writeActorOf } from '../../src/replica/write-actor.js'
import { classify } from '../../src/replica/route-table.js'
import { AWAY_OP_DECISIONS } from '../../src/replica/away-op-decisions.js'
import { holdRelayJob, _clearRelayJobsForTesting } from '../../src/core/plugin-jobs/job-caller.js'
import { getSelfCallToken, setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { hostOrigin } from '../../src/lib/caller-origin.js'
import { UNPROVEN_NOTE } from '../../src/core/sessions/delegated-mode.js'

const HOST = 'devbox'
const REFUSAL = 'A default session cannot start a task in bypass mode. Change the caller\'s mode first.'
const JOB = { plugin: 'acme', job: 'sync' }
const DEVICE_TOKEN = 'device-token-1'

const actorOf = writeActorOf({ verifyDevice: (t) => (t === DEVICE_TOKEN ? { id: 'd1', name: 'phone' } : null), localCalls: () => true })
/** The real job read, with a sessions copy of two sessions. */
const startCaller: StartCallerDeps = {
  sessionMode: async (sid) => ({ 'sess-default': 'default', 'sess-bypass': 'bypass' } as Record<string, string>)[sid],
  vouchedJob: replicaStartCaller.vouchedJob,
}
const handler = awayStartCheck({ actorOf, startCaller })

function call(body: unknown, headers: Record<string, string>, path = '/v1/tasks/start-check', method = 'POST'): Promise<{ status: number; body: any } | 'passed on'> {
  return new Promise((resolve, reject) => {
    const req = { method, path, body, headers, socket: { remoteAddress: '10.0.0.9' } } as unknown as Request
    let status = 200
    const res = {
      status(s: number) { status = s; return this },
      json(b: unknown) { resolve({ status, body: b }); return this },
    } as unknown as Response
    handler(req, res, (err?: unknown) => (err ? reject(err) : resolve('passed on')))
  })
}

/** This host's own call (the replica's in-process credential), as local-calls.ts makes it for a job. */
const selfCall = (over: Record<string, string> = {}) => ({
  authorization: `Bearer ${getSelfCallToken()}`, 'x-walnut-caller-sid': 'external', 'x-walnut-origin': hostOrigin(HOST),
  'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job, ...over,
})

describe('the start check on a host\'s own server', () => {
  beforeEach(() => { setSelfApiRoot('http://127.0.0.1:45997', { credential: true }) })
  afterEach(() => { setSelfApiRoot(null); _clearRelayJobsForTesting() })

  it('a plugin job its daemon vouched for (the relay\'s held token on this replica\'s self-call) may start in bypass', async () => {
    const token = holdRelayJob(JOB, HOST)!
    expect(await call({ mode: 'bypass' }, selfCall({ 'x-walnut-caller-job': token }))).toEqual({
      status: 200, body: { allowed: true, mode: 'bypass', caller: 'plugin-job' },
    })
  })

  it('an outside caller is refused as a 200 with the ceiling\'s words: no token, a forged one, another job\'s, an unknown bearer', async () => {
    const token = holdRelayJob(JOB, HOST)!
    for (const headers of [
      selfCall(),
      selfCall({ 'x-walnut-caller-job': 'f'.repeat(48) }),
      selfCall({ 'x-walnut-plugin-job': 'other', 'x-walnut-caller-job': token }),
      selfCall({ authorization: 'Bearer forged', 'x-walnut-caller-job': token }),
      {},
    ]) {
      expect(await call({ mode: 'bypass' }, headers), JSON.stringify(headers)).toEqual({
        status: 200, body: { allowed: false, mode: 'bypass', caller: 'external', reason: REFUSAL },
      })
    }
  })

  it('a session meets its own mode; the unproven mark makes any caller an outside one, with its note', async () => {
    const asSession = (sid: string, over: Record<string, string> = {}) => ({ authorization: `Bearer ${getSelfCallToken()}`, 'x-walnut-caller-sid': sid, ...over })
    expect(await call({ mode: 'bypass' }, asSession('sess-default'))).toEqual({ status: 200, body: { allowed: false, mode: 'bypass', caller: 'session', reason: REFUSAL } })
    expect(await call({ mode: 'bypass' }, asSession('sess-bypass'))).toEqual({ status: 200, body: { allowed: true, mode: 'bypass', caller: 'session' } })
    expect(await call({ mode: 'bypass' }, asSession('sess-bypass', { 'x-walnut-caller-unproven': '1' }))).toEqual({
      status: 200, body: { allowed: false, mode: 'bypass', caller: 'external', reason: `${REFUSAL} ${UNPROVEN_NOTE}` },
    })
  })

  it('a paired device is the person; a malformed mode is a 400; other routes pass on', async () => {
    expect(await call({ mode: 'bypass' }, { authorization: `Bearer ${DEVICE_TOKEN}` })).toEqual({ status: 200, body: { allowed: true, mode: 'bypass', caller: 'person' } })
    const bad = await call({ mode: 'yolo' }, selfCall())
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
    expect(await call({ mode: 'bypass' }, selfCall(), '/v1/tasks/t1/start')).toBe('passed on')
    expect(await call({ mode: 'bypass' }, selfCall(), '/v1/tasks/start-check', 'GET')).toBe('passed on')
  })

  it('the route table answers it here (a read, never the task writes\' needs_leader), and the op is a host row', () => {
    expect(classify('POST', '/api/v1/tasks/start-check')).toMatchObject({ away: 'read' })
    expect(classify('POST', '/api/v1/tasks/t1')).toMatchObject({ away: 'needs-leader' })
    expect(AWAY_OP_DECISIONS.task_start_check).toMatchObject({ answer: 'host', by: 'src/replica/start-ceiling.ts' })
  })
})
