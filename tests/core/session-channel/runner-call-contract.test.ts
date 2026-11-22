/**
 * The one contract of a runner call forwarded to the host that runs the session
 * (src/core/session-channel/host-calls.ts hostCallArgs): the leader's routing
 * (src/providers/host-judged-runner.ts) sends the method's arguments after the session id and the
 * sid in the body; the host's routes (src/core/session-channel/host-routes.ts) call the runner with
 * that sid first. Real on both ends: the leader's wrappers over a runner prototype, the host's
 * routes over HTTP. Every member the leader forwards goes round once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-runner-call-contract'))

import { HOST_FORWARDED_RUNNER_METHODS, HOST_JUDGED_RUNNER_METHODS, HostRunsItError, installHostJudgedRouting } from '../../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { _resetRemoteJudgedSessionsForTesting, setRemoteJudgedCaller } from '../../../src/providers/remote-judged-session.js'
import { createHostSessionRoutes, type HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { HOST_CALL_ALLOWLIST } from '../../../src/core/session-channel/host-calls.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'

const SID = '50000000-0000-4000-8000-0000000000d1'

/** What the host's runner was called with, per member. */
const hostCalls: Array<{ member: string; args: unknown[] }> = []
const hostRunner = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    // Not a thenable: the routes await the runner.
    if (typeof prop !== 'string' || prop === 'then') return undefined
    if (prop === 'findSessionByClaudeId' || prop === 'findAcpSession') return () => undefined
    return (...args: unknown[]) => { hostCalls.push({ member: prop, args }); return null }
  },
})

let server: http.Server
let routes: HostSessionRoutes
let port = 0

/** A runner prototype whose own methods would mean the leader ran the call itself. */
class LeaderRunner {}
const leaderOwn: string[] = []
for (const m of HOST_JUDGED_RUNNER_METHODS) {
  (LeaderRunner.prototype as unknown as Record<string, unknown>)[m] = function () { leaderOwn.push(m); return undefined }
}
installHostJudgedRouting(LeaderRunner.prototype)
const runner = new LeaderRunner() as unknown as Record<string, (...a: unknown[]) => unknown>

beforeAll(async () => {
  routes = createHostSessionRoutes({
    enabled: async () => true, runner: async () => hostRunner as never, bundles: new StartBundles(), channel: () => null,
    emit: () => {}, enqueue: async () => {}, spillDir: path.join(os.tmpdir(), 'runner-call-contract-prompts'),
  })
  server = http.createServer((req, res) => { if (!routes.handle(req, res)) { res.statusCode = 404; res.end() } })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})
beforeEach(() => {
  setRemoteJudgedCaller(async (_host, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/host-api/sessions/call`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) })
    const a = await r.json() as { ok: boolean; value?: unknown; error?: string }
    if (a.ok !== true) throw new Error(a.error ?? 'refused')
    return a.value
  })
})
afterAll(async () => {
  setRemoteJudgedCaller(null)
  routes.close()
  await new Promise<void>((r) => server.close(() => r()))
})
afterEach(() => {
  hostCalls.length = 0
  leaderOwn.length = 0
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
})

describe('a runner call forwarded to the host that runs the session', () => {
  it('every forwarded member is one the host allows', () => {
    for (const m of HOST_FORWARDED_RUNNER_METHODS) expect(HOST_CALL_ALLOWLIST.runner as readonly string[], m).toContain(m)
  })

  it('reaches the host runner with the session id first and the rest as the leader passed them', async () => {
    noteHostJudged(SID, 'devbox')
    for (const m of HOST_FORWARDED_RUNNER_METHODS) {
      hostCalls.length = 0
      const out = runner[m](SID, `arg-of-${m}`, 7)
      if (out instanceof Promise) await out
      await vi.waitFor(() => expect(hostCalls, m).toHaveLength(1))
      expect(hostCalls[0], m).toEqual({ member: m, args: [SID, `arg-of-${m}`, 7] })
    }
    expect(leaderOwn).toEqual([])
  })

  it('a member with a callback is refused by name, never sent short', async () => {
    noteHostJudged(SID, 'devbox')
    await expect(runner.respawnOnCurrentPrompt(SID, () => true, { folder: true })).rejects.toBeInstanceOf(HostRunsItError)
    expect(HOST_CALL_ALLOWLIST.runner as readonly string[]).not.toContain('respawnOnCurrentPrompt')
    expect(hostCalls).toEqual([])
  })

  it('a legacy session runs on the leader runner itself', async () => {
    for (const m of HOST_FORWARDED_RUNNER_METHODS) runner[m]('legacy-sid')
    expect(leaderOwn).toEqual([...HOST_FORWARDED_RUNNER_METHODS])
    expect(hostCalls).toEqual([])
  })
})
