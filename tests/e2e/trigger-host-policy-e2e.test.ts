/**
 * Who may make a daemon run a trigger check where, through the real server
 * (src/core/routines/check-host-policy.ts).
 *
 * The gate's bypass (2026-09): a session on a remote exec host ran `trigger_test`
 * and `trigger_create` with this Mac as the host (or no host at all), and the
 * check (a curl of this server's /api/health/sleep) ran here as a local caller.
 * Every entry is driven here: the legacy and v1 check-test, trigger, create and
 * update routes, the named ops and the `api` passthrough as the gateway runs
 * them, the actions route, the bridge relay, and a paired device and an API key
 * over real HTTP from this machine's LAN address.
 *
 * The daemon LOOKUP is stubbed and records every host it is asked for, so
 * "refused before anything reaches a daemon" is asserted as zero lookups. No
 * check command runs anywhere: the stub answers `triggers.test` itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-host-policy-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { executeOp } from '../../src/ops/index.js'
import { resolveApiBase } from '../../src/ops/executor.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { createDevice } from '../../src/core/device-auth.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { LOCAL_ORIGIN, ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, hostOrigin } from '../../src/lib/caller-origin.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const HOST = hostOrigin('remote-dev')
const REMOTE_SID = 'c0ffee00-1111-2222-3333-444455556666'
const LOCAL_SID = 'c0ffee00-9999-8888-7777-666655554444'
const RUN = 'curl -s http://127.0.0.1/api/health/sleep; echo \'{"fire":false}\''
const API_KEY = 'wlnt_sk_trigger_host_policy'
const TEST_RESULT = {
  ok: true, exitCode: 0, durationMs: 1, stdoutTail: '{"fire":false}', stderrTail: '',
  parsed: { fire: false, hasState: false }, error: null, wouldFire: false, newItemCount: 0,
}

let server: HttpServer
let port = 0
let daemon: MockDaemon
let taskId = ''
/** Every host the server asked the daemon pool for, and every RPC it sent. */
const lookups: string[] = []
const sends: Array<{ host: string; cmd: string }> = []

function fakeDaemon(host: string): TriggerDaemon {
  return {
    host,
    hasCapability: (cap) => cap === 'triggers-v1',
    triggersPushed: true,
    async send(cmd) {
      sends.push({ host, cmd })
      return cmd === 'triggers.test' ? { ok: true, result: TEST_RESULT } : { ok: true }
    },
  }
}

type Reply = { status: number; json: any }
async function call(method: string, p: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** Run `fn` and return the daemon lookups it caused. */
async function lookupsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const before = lookups.length
  await fn()
  return lookups.slice(before)
}

const asHost = { [ORIGIN_HEADER]: HOST }
const asUnknown = { [ORIGIN_HEADER]: '' }
const asRemoteSession = { ...asHost, 'x-walnut-caller-sid': REMOTE_SID }

function refusalText(r: Reply): string {
  return typeof r.json?.error === 'string' ? r.json.error : String(r.json?.error?.message ?? '')
}

function expectRefused(r: Reply, v1: boolean, text: RegExp): void {
  expect(r.status, JSON.stringify(r.json)).toBe(403)
  if (v1) expect(r.json.error.code).toBe('forbidden')
  expect(refusalText(r)).toMatch(text)
}

const ON_THIS_MAC = /A check that runs on this Mac is accepted only from a caller on this Mac\. A session on host remote-dev may run checks on its own host: pass host "remote-dev"\./
const ON_OTHER_BOX = /A check that runs on host other-box is accepted only from a caller on this Mac or a session on host other-box/
const UNIDENTIFIED = /this caller could not be identified/

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest((host) => { lookups.push(host); return fakeDaemon(host) })
  taskId = (await addTask({ title: 'Trigger target' })).task.id
  // Fabricated rows, no pid: one session on the remote host, one on this Mac.
  await createSessionRecord(REMOTE_SID, taskId, '', '/home/me/marina', { host: 'remote-dev' })
  await createSessionRecord(LOCAL_SID, taskId, '', '/tmp', {})
}, 60_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const CHECK_TEST_ROUTES = [
  ['/api/v1/routines/check-test', true],
  ['/api/routines/check-test', false],
  ['/api/cron/check-test', false],
] as const

describe('check-test, legacy and v1', () => {
  it('refuses a session on a remote host a check on this Mac or a third host, and asks no daemon', async () => {
    for (const [route, v1] of CHECK_TEST_ROUTES) {
      const seen = await lookupsDuring(async () => {
        expectRefused(await call('POST', route, { check: { run: RUN, host: '__local__' } }, asHost), v1, ON_THIS_MAC)
        // No host and no session behind the call: this Mac.
        expectRefused(await call('POST', route, { check: { run: RUN } }, asHost), v1, ON_THIS_MAC)
        expectRefused(await call('POST', route, { check: { run: RUN }, id: 'job-x' }, { ...asHost, 'x-walnut-caller-sid': 'no-such-session' }), v1, ON_THIS_MAC)
        expectRefused(await call('POST', route, { check: { run: RUN, host: 'other-box' } }, asRemoteSession), v1, ON_OTHER_BOX)
        expectRefused(await call('POST', route, { check: { run: RUN, host: 'remote-dev' } }, asUnknown), v1, UNIDENTIFIED)
      })
      expect(seen, route).toEqual([])
    }
    expect(sends).toEqual([])
  })

  it('runs a check for a caller on this Mac anywhere, and for a remote session on its own host', async () => {
    for (const [route] of CHECK_TEST_ROUTES) {
      const seen = await lookupsDuring(async () => {
        for (const [body, headers] of [
          [{ check: { run: RUN, host: '__local__' } }, {}],
          [{ check: { run: RUN, host: 'remote-dev' } }, { [ORIGIN_HEADER]: LOCAL_ORIGIN }],
          [{ check: { run: RUN, host: 'remote-dev' } }, asHost],
          // No host: the calling session's host, as trigger_create does.
          [{ check: { run: RUN } }, asRemoteSession],
          [{ check: { run: RUN } }, { 'x-walnut-caller-sid': LOCAL_SID }],
        ] as const) {
          const r = await call('POST', route, body, headers)
          expect(r.status, `${route} ${JSON.stringify(body)}`).toBe(200)
          expect(r.json.result.parsed).toEqual({ fire: false, hasState: false })
        }
      })
      expect(seen, route).toEqual(['__local__', 'remote-dev', 'remote-dev', 'remote-dev', '__local__'])
    }
  })
})

const TRIGGER_BODY = { run: RUN, every: '5m', prompt: 'Act on it.', description: 'Probe trigger for the host rule.' }
const createBody = (check: Record<string, unknown>) => ({
  name: 'host rule probe', schedule: { kind: 'every', everyMs: 600_000 }, check,
  executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
})

describe('creating a trigger, legacy and v1', () => {
  it('trigger_create routes: a remote session arms a check on its own host only', async () => {
    for (const [route, v1] of [['/api/v1/routines/trigger', true], ['/api/routines/trigger', false]] as const) {
      const seen = await lookupsDuring(async () => {
        expectRefused(await call('POST', route, { ...TRIGGER_BODY, host: '__local__' }, asRemoteSession), v1, ON_THIS_MAC)
        // An explicit task and no host is this Mac.
        expectRefused(await call('POST', route, { ...TRIGGER_BODY, session: taskId }, asHost), v1, ON_THIS_MAC)
        expectRefused(await call('POST', route, { ...TRIGGER_BODY, host: 'other-box' }, asRemoteSession), v1, ON_OTHER_BOX)
        expectRefused(await call('POST', route, { ...TRIGGER_BODY, session: taskId, host: 'remote-dev' }, asUnknown), v1, UNIDENTIFIED)
      })
      expect(seen, route).toEqual([])
      const own = await call('POST', route, TRIGGER_BODY, asRemoteSession)
      expect(own.status, JSON.stringify(own.json)).toBe(201)
      expect(own.json.job.check.host).toBe('remote-dev')
      const local = await call('POST', route, { ...TRIGGER_BODY, session: taskId }, {})
      expect(local.status).toBe(201)
      expect(local.json.job.check.host).toBe('__local__')
    }
  })

  it('the routine create routes: a check on this Mac only for a caller on this Mac', async () => {
    for (const [route, v1] of [['/api/v1/routines', true], ['/api/routines', false], ['/api/cron', false]] as const) {
      const seen = await lookupsDuring(async () => {
        expectRefused(await call('POST', route, createBody({ run: RUN, host: '__local__' }), asHost), v1, ON_THIS_MAC)
        expectRefused(await call('POST', route, createBody({ run: RUN }), asHost), v1, ON_THIS_MAC)
        expectRefused(await call('POST', route, createBody({ run: RUN, host: 'remote-dev' }), asUnknown), v1, UNIDENTIFIED)
      })
      expect(seen, route).toEqual([])
      expect((await call('POST', route, createBody({ run: RUN, host: 'remote-dev' }), asHost)).status).toBe(201)
      expect((await call('POST', route, createBody({ run: RUN }), {})).status).toBe(201)
    }
  })
})

describe('changing a saved check, legacy and v1', () => {
  async function saved(check: Record<string, unknown>): Promise<string> {
    const r = await call('POST', '/api/routines', createBody(check), {})
    expect(r.status).toBe(201)
    return r.json.job.id
  }

  it('refuses a new command, cwd or host on this Mac, and leaves the job as it was', async () => {
    for (const [base, v1] of [['/api/v1/routines', true], ['/api/routines', false], ['/api/cron', false]] as const) {
      const localId = await saved({ run: 'bash ~/check.sh', cwd: '/srv', host: '__local__' })
      const remoteId = await saved({ run: 'bash ~/check.sh', host: 'remote-dev' })
      const seen = await lookupsDuring(async () => {
        expectRefused(await call('PATCH', `${base}/${localId}`, { check: { run: RUN, cwd: '/srv' } }, asHost), v1, ON_THIS_MAC)
        expectRefused(await call('PATCH', `${base}/${localId}`, { check: { run: 'bash ~/check.sh', cwd: '/tmp' } }, asHost), v1, ON_THIS_MAC)
        expectRefused(await call('PATCH', `${base}/${remoteId}`, { check: { run: 'bash ~/check.sh', host: '__local__' } }, asHost), v1, ON_THIS_MAC)
        expectRefused(await call('PATCH', `${base}/${remoteId}`, { check: { run: RUN, host: 'remote-dev' } }, asUnknown), v1, UNIDENTIFIED)
      })
      expect(seen, base).toEqual([])
      const job = (await call('GET', `/api/routines/${localId}`, undefined)).json.job
      expect(job.check).toMatchObject({ run: 'bash ~/check.sh', cwd: '/srv', host: '__local__' })
    }
  })

  it('lets a remote session change what hands over nothing new, or its own host', async () => {
    const localId = await saved({ run: 'bash ~/check.sh', cwd: '/srv', host: '__local__' })
    const remoteId = await saved({ run: 'bash ~/check.sh', host: 'remote-dev' })
    const ok = async (id: string, body: unknown) => {
      const r = await call('PATCH', `/api/v1/routines/${id}`, body, asHost)
      expect(r.status, JSON.stringify(r.json)).toBe(200)
    }
    await ok(localId, { name: 'renamed' })
    await ok(localId, { check: { run: 'bash ~/check.sh', cwd: '/srv', timeoutSeconds: 90 } })
    await ok(remoteId, { check: { run: RUN, host: 'remote-dev' } })
    // Moving this Mac's trigger onto its own host takes the command off this Mac.
    await ok(localId, { check: { run: 'bash ~/check.sh', cwd: '/srv', host: 'remote-dev' } })
    expect((await call('PATCH', `/api/v1/routines/${remoteId}`, { check: { run: RUN, host: '__local__' } }, {})).status).toBe(200)
  })
})

describe('the ops and the passthrough, as the gateway runs them for a remote session', () => {
  const opts = () => ({ apiBase: `http://127.0.0.1:${port}/api/v1`, origin: HOST, callerSid: REMOTE_SID })

  it('trigger_test and trigger_create refuse this Mac and a third host before any daemon', async () => {
    const seen = await lookupsDuring(async () => {
      for (const [name, args, text] of [
        ['trigger_test', { run: RUN, host: '__local__' }, ON_THIS_MAC],
        ['trigger_test', { run: RUN, host: 'other-box' }, ON_OTHER_BOX],
        ['trigger_create', { ...TRIGGER_BODY, host: '__local__' }, ON_THIS_MAC],
        ['trigger_create', { ...TRIGGER_BODY, session: taskId }, ON_THIS_MAC],
      ] as const) {
        const r = await executeOp(name, args, opts())
        expect(r.ok, `${name} ${JSON.stringify(args)}`).toBe(false)
        expect((r as { message: string }).message).toMatch(text)
      }
      const orphan = await executeOp('trigger_test', { run: RUN }, { ...opts(), callerSid: 'no-such-session' })
      expect((orphan as { message: string }).message).toMatch(ON_THIS_MAC)
    })
    expect(seen).toEqual([])
    const own = await lookupsDuring(async () => {
      expect((await executeOp('trigger_test', { run: RUN }, opts())).ok).toBe(true)
      expect((await executeOp('trigger_create', TRIGGER_BODY, opts())).ok).toBe(true)
    })
    expect(own).toEqual(['remote-dev', 'remote-dev'])
  })

  it('the real gateway router labels the call with its daemon\'s host', async () => {
    // The router reaches this server through the executor's own base: prove it is this test server.
    expect(resolveApiBase()).toBe(`http://127.0.0.1:${port}/api/v1`)
    const gw = (args: Record<string, unknown>) => handleGatewayCapability(
      'tools.call', REMOTE_SID, { name: 'trigger_test', args }, 'remote-dev', { throttle: new PeerThrottle(), cloudMode: false })
    const seen = await lookupsDuring(async () => {
      for (const args of [{ run: RUN, host: '__local__' }, { run: RUN, host: 'other-box' }]) {
        const r = await gw(args)
        expect(r.ok, JSON.stringify(args)).toBe(false)
        if (!r.ok) {
          expect(r.error.code).toBe('internal')
          expect(r.error.message).toMatch(args.host === '__local__' ? ON_THIS_MAC : ON_OTHER_BOX)
        }
      }
    })
    expect(seen).toEqual([])
    // No host: the calling session's own host, where it may.
    const own = await lookupsDuring(async () => { expect((await gw({ run: RUN })).ok).toBe(true) })
    expect(own).toEqual(['remote-dev'])
  })

  it('the api passthrough reaches the same refusal on every route, legacy and v1', async () => {
    const localId = (await call('POST', '/api/routines', createBody({ run: 'bash ~/check.sh' }), {})).json.job.id
    const seen = await lookupsDuring(async () => {
      for (const [method, p, body] of [
        ['POST', '/api/v1/routines/check-test', { check: { run: RUN, host: '__local__' } }],
        ['POST', '/api/routines/check-test', { check: { run: RUN, host: 'other-box' } }],
        ['POST', '/api/cron/check-test', { check: { run: RUN, host: '__local__' } }],
        ['POST', '/api/v1/routines/trigger', { ...TRIGGER_BODY, host: '__local__' }],
        ['POST', '/api/routines/trigger', { ...TRIGGER_BODY, session: taskId }],
        ['POST', '/api/v1/routines', createBody({ run: RUN })],
        ['POST', '/api/routines', createBody({ run: RUN, host: '__local__' })],
        ['PATCH', `/api/v1/routines/${localId}`, { check: { run: RUN } }],
        ['PATCH', `/api/cron/${localId}`, { check: { run: RUN } }],
      ] as const) {
        const r = await executeOp('api', { method, path: p, body }, opts())
        expect(r.ok, `${method} ${p}`).toBe(false)
        expect((r as { message: string }).message, `${method} ${p}`).toMatch(p === '/api/routines/check-test' ? ON_OTHER_BOX : ON_THIS_MAC)
      }
    })
    expect(seen).toEqual([])
    // With no host, the remote session's own host: allowed there.
    const own = await lookupsDuring(async () => {
      expect((await executeOp('api', { method: 'POST', path: '/api/routines/check-test', body: { check: { run: RUN } } }, opts())).ok).toBe(true)
    })
    expect(own).toEqual(['remote-dev'])
    // A session on this Mac is untouched by the rule.
    const local = await executeOp('api', { method: 'POST', path: '/api/v1/routines/check-test', body: { check: { run: RUN } } },
      { apiBase: `http://127.0.0.1:${port}/api/v1`, origin: LOCAL_ORIGIN, callerSid: LOCAL_SID })
    expect(local.ok).toBe(true)
  })

  it('the actions route runs trigger_test for the origin it was called for', async () => {
    const seen = await lookupsDuring(async () => {
      const r = await call('POST', '/api/v1/actions/invoke', { tool: 'trigger_test', args: { run: RUN, host: '__local__' } }, asHost)
      expect(r.json).toMatchObject({ ok: false, tool: 'trigger_test', error: { code: 'op_failed' } })
      expect(r.json.error.message).toMatch(ON_THIS_MAC)
    })
    expect(seen).toEqual([])
  })

  it('the bridge relay keeps the origin it was handed', async () => {
    const seen = await lookupsDuring(async () => {
      for (const [action, params] of [
        ['server.routines.check-test', { body: { check: { run: RUN } } }],
        ['server.routines.trigger', { body: { ...TRIGGER_BODY, session: taskId } }],
        ['server.routines.create', { body: createBody({ run: RUN }) }],
      ] as const) {
        const r = await handleSessionControlRelay(action, '__server__', params, HOST)
        expect(r, action).toMatchObject({ ok: false, error: expect.stringMatching(ON_THIS_MAC) })
      }
    })
    expect(seen).toEqual([])
    // The replica's bridge relays for a paired client, which may.
    const relayed = await handleSessionControlRelay('server.routines.check-test', '__server__', { body: { check: { run: RUN } } }, REMOTE_HTTP_ORIGIN)
    expect(relayed.ok).toBe(true)
  })
})

/** A private IPv4 address of this machine, when it has one (a laptop on Wi-Fi does). */
function privateIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [p0, p1] = a.address.split('.').map(Number)
      if (p0 === 10 || (p0 === 172 && p1 >= 16 && p1 <= 31) || (p0 === 192 && p1 === 168)) return a.address
    }
  }
  return null
}
const LAN_IP = privateIpv4()

describe.skipIf(!LAN_IP)('a paired device and an API key over real HTTP from the LAN', () => {
  function lanPost(p: string, token: string, body: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = http.request({
        host: LAN_IP!, port, path: p, method: 'POST', localAddress: LAN_IP!,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => { let json: any = null; try { json = JSON.parse(text) } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }) })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('may run a check on this Mac: both can already start a coding session here', async () => {
    const device = (await createDevice('lan-phone')).token
    await updateConfig({ api_keys: [{ name: 'script', key: API_KEY, created_at: new Date().toISOString() }] })
    const seen = await lookupsDuring(async () => {
      for (const token of [device, API_KEY]) {
        for (const route of ['/api/v1/routines/check-test', '/api/routines/check-test']) {
          const r = await lanPost(route, token, { check: { run: RUN, host: '__local__' } })
          expect(r.status, `${route} ${JSON.stringify(r.json)}`).toBe(200)
        }
      }
    })
    expect(seen).toEqual(['__local__', '__local__', '__local__', '__local__'])
  })
})
