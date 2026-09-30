/**
 * Principal propagation (src/lib/caller-origin.ts): who a loopback self-call acts
 * for, and what it may reach when that caller is not on this Mac.
 *
 * The gate's bypass: a remote host's `walnut tools call api` reached
 * /api/health/* and /api/v1/health/* over loopback, which the "this machine only"
 * checks trusted, and deleted the store. These pin the pieces that close it:
 * the origin arithmetic (it can only go down), the request classifier (a header
 * cannot raise trust), the executor's refusals, the `api` passthrough's path
 * policy under every canonicalization trick, and the registry ratchet that keeps
 * the local-only route set derived instead of hand kept.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  HEALTH_LOCAL_ONLY_MESSAGE, LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN, ORIGIN_HEADER,
  hostOrigin, lowerOrigin, withCallerOrigin, ambientCallerOrigin,
} from '../../../src/lib/caller-origin.js'
import { requestOrigin, isOnBehalfOfRemote } from '../../../src/web/middleware/request-origin.js'
import { canonicalForms, isHealthServerPath, localOnlyRoutes, selfCallRefusal } from '../../../src/ops/origin-policy.js'
import { executeOp, getOp, listOpEntries, definePluginOp, removePluginOps } from '../../../src/ops/index.js'
import { controlRelayOrigin } from '../../../src/core/sessions/control-host-policy.js'
import { labelPluginFetch } from '../../../src/core/plugins/plugin-fetch-origin.js'

const HOST = hostOrigin('remote-dev')
const req = (remoteAddress: string, headers: Record<string, string | string[]> = {}) => ({
  socket: { remoteAddress, localPort: 3456 }, headers: { host: '127.0.0.1:3456', ...headers },
}) as never

afterEach(() => {
  vi.unstubAllGlobals()
  removePluginOps('origin-test')
})

describe('the origin can only go down', () => {
  it('names each class, and a remote host is never local', () => {
    expect(hostOrigin('__local__')).toBe(LOCAL_ORIGIN)
    expect(hostOrigin('remote-dev')).toBe('host:remote-dev')
    expect(hostOrigin('')).toBe(UNKNOWN_ORIGIN)
    expect(hostOrigin('bad\nhost')).toBe('host:bad_host')
    expect(controlRelayOrigin('__local__')).toBe(REMOTE_HTTP_ORIGIN)
    expect(controlRelayOrigin('remote-dev')).toBe(HOST)
  })

  it('takes the lowest of any mix: local, then a paired client, then a host or unknown', () => {
    expect(lowerOrigin(LOCAL_ORIGIN, undefined)).toBe(LOCAL_ORIGIN)
    expect(lowerOrigin(LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN)).toBe(REMOTE_HTTP_ORIGIN)
    expect(lowerOrigin(REMOTE_HTTP_ORIGIN, HOST)).toBe(HOST)
    expect(lowerOrigin(HOST, REMOTE_HTTP_ORIGIN, LOCAL_ORIGIN)).toBe(HOST)
    expect(lowerOrigin('', LOCAL_ORIGIN)).toBe(UNKNOWN_ORIGIN)
  })

  it('a nested scope cannot climb above the one it runs in', async () => {
    await withCallerOrigin(HOST, async () => {
      await withCallerOrigin(LOCAL_ORIGIN, async () => {
        await Promise.resolve()
        expect(ambientCallerOrigin()).toBe(HOST)
      })
    })
    expect(ambientCallerOrigin()).toBeUndefined()
  })
})

describe('a request\'s origin', () => {
  it('this machine with no header, or with the local value, is local', () => {
    expect(requestOrigin(req('127.0.0.1'))).toBe(LOCAL_ORIGIN)
    expect(requestOrigin(req('::1', { [ORIGIN_HEADER]: LOCAL_ORIGIN }))).toBe(LOCAL_ORIGIN)
  })

  it('a self-call made for someone elsewhere stays lowered, whatever else it looks like', () => {
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: HOST }))).toBe(HOST)
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: REMOTE_HTTP_ORIGIN }))).toBe(REMOTE_HTTP_ORIGIN)
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: '' }))).toBe(UNKNOWN_ORIGIN)
    // A repeated header reaches the route as an array or a joined string: never local.
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: [LOCAL_ORIGIN, LOCAL_ORIGIN] }))).toBe(UNKNOWN_ORIGIN)
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: `${LOCAL_ORIGIN}, ${LOCAL_ORIGIN}` }))).not.toBe(LOCAL_ORIGIN)
    expect(isOnBehalfOfRemote(req('127.0.0.1', { [ORIGIN_HEADER]: HOST }))).toBe(true)
    expect(isOnBehalfOfRemote(req('127.0.0.1'))).toBe(false)
  })

  it('a spoofed header cannot RAISE trust: a caller off this machine is remote-http, whatever it claims', () => {
    expect(requestOrigin(req('192.168.1.20', { [ORIGIN_HEADER]: LOCAL_ORIGIN }))).toBe(REMOTE_HTTP_ORIGIN)
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: LOCAL_ORIGIN, 'x-forwarded-for': '203.0.113.9' }))).toBe(REMOTE_HTTP_ORIGIN)
    expect(requestOrigin(req('127.0.0.1', { [ORIGIN_HEADER]: LOCAL_ORIGIN, host: 'rebind.example:3456' }))).toBe(REMOTE_HTTP_ORIGIN)
    expect(isOnBehalfOfRemote(req('192.168.1.20', { [ORIGIN_HEADER]: LOCAL_ORIGIN }))).toBe(true)
  })
})

describe('the api passthrough for a caller off this Mac', () => {
  const HEALTH_TRICKS = [
    ['GET', '/api/health/status'],
    ['GET', '/api/health/sleep?from=2026-09-20'],
    ['PUT', '/api/v1/health/settings'],
    ['DELETE', '/api/v1/health/data'],
    ['POST', '/api/v1/health/sync'],
    ['GET', '/API/Health/Status'],
    ['DELETE', '/API/V1/HEALTH/DATA'],
    ['GET', '/api/V1/Health/Status'],
    ['GET', '/api/health/'],
    ['GET', '/api/health'],
    ['GET', '/api//health/status'],
    ['GET', '/api/v1/../health/status'],
    ['GET', '/api/tasks/../health/status'],
    ['GET', '/api/x/%2e%2e/health/status'],
    ['GET', '/api/%68ealth/status'],
    ['GET', '/api/%2568ealth/status'],
    ['DELETE', '/api/v1/health%2Fdata'],
    ['GET', '/api/v1\\..\\health\\status'],
    ['GET', '/api/health\\status'],
    ['GET', '/api/x\\..\\health\\sleep'],
    // A backslash hidden behind percent escapes, once and twice.
    ['GET', '/api/v1%5C..%5Chealth%5Cstatus'],
    ['GET', '/api/v1%5c..%5chealth%5cstatus'],
    ['GET', '/api/v1%255C..%255Chealth%255Cstatus'],
    ['DELETE', '/api/v1/tasks%5C..%5C..%5Chealth%5Cdata'],
    // Not a health route to Express, refused anyway: decoding only widens.
    ['GET', '/api/v1/health%3Fx'],
  ] as const

  it('refuses every health path, however it is spelled', () => {
    for (const [method, path] of HEALTH_TRICKS) {
      for (const origin of [HOST, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN]) {
        expect(selfCallRefusal('api', method, path, origin), `${method} ${path} for ${origin}`).toBe(HEALTH_LOCAL_ONLY_MESSAGE)
      }
      expect(isHealthServerPath(path), path).toBe(true)
    }
  })

  it('refuses every route a local-only op binds or declares, legacy prefix and case included', () => {
    const refused = [
      ['DELETE', '/api/tasks/abc123'],
      ['DELETE', '/api/v1/tasks/abc123?force=true'],
      ['DELETE', '/api/V1/TASKS/abc123/'],
      ['DELETE', '/api/v1/x/../tasks/abc123'],
      ['POST', '/api/tasks/abc123/merge'],
      ['POST', '/api/v1/tasks/abc123/merge'],
      ['POST', '/api/plugin-runtime/any-plugin/ops/task_delete'],
      ['POST', '/api/plugin-runtime/any-plugin/ops/health_sleep'],
    ] as const
    for (const [method, path] of refused) {
      expect(selfCallRefusal('api', method, path, HOST), `${method} ${path}`).toMatch(/runs only for callers on this Mac|Health data/)
    }
    expect(selfCallRefusal('api', 'DELETE', '/api/tasks/abc123', HOST)).toMatch(/task_delete runs only for callers on this Mac/)
  })

  it('leaves ordinary routes alone, and never refuses a caller on this Mac', () => {
    const allowed = [
      ['GET', '/api/tasks/abc123'],
      ['GET', '/api/v1/tasks'],
      ['DELETE', '/api/v1/tasks/abc123/wait'],
      ['GET', '/api/time/summary?days=14'],
      ['GET', '/api/v1/notes/health-plan.md'],
      ['GET', '/api/v1/notes/100%'],
    ] as const
    for (const [method, path] of allowed) expect(selfCallRefusal('api', method, path, HOST), `${method} ${path}`).toBeNull()
    for (const [method, path] of HEALTH_TRICKS) expect(selfCallRefusal('api', method, path, LOCAL_ORIGIN)).toBeNull()
    expect(selfCallRefusal('api', 'DELETE', '/api/tasks/abc123', LOCAL_ORIGIN)).toBeNull()
    // Any other op is held to the health rule only.
    expect(selfCallRefusal('task_get', 'DELETE', '/tasks/abc123', HOST)).toBeNull()
    expect(selfCallRefusal('task_get', 'GET', '/api/health/status', HOST)).toBe(HEALTH_LOCAL_ONLY_MESSAGE)
  })

  it('the URL parser reads a backslash as a slash, raw or decoded from %5C, and the forms rely on it', () => {
    expect(new URL('http://walnut.invalid/api/v1\\..\\health').pathname).toBe('/api/health')
    expect(new URL('http://walnut.invalid/api/v1%5C..%5Chealth').pathname).toBe('/api/v1%5C..%5Chealth')
    expect(canonicalForms('/api/v1%5C..%5Chealth%5Cstatus')).toContain('/api/health/status')
    expect(canonicalForms('/api/v1%255C..%255Chealth%255Cstatus')).toContain('/api/health/status')
    expect(canonicalForms('/api/v1/tasks%5Cbatch%5Cdelete')).toContain('/api/v1/tasks/batch/delete')
  })

  it('refuses batch delete as task_delete, however it is spelled, and only to a caller off this Mac', () => {
    const enc = [...'tasks/batch/delete'].map((c) => (c === '/' ? c : `%${c.charCodeAt(0).toString(16)}`)).join('')
    const spellings = [
      '/api/v1/tasks/batch/delete',
      '/api/tasks/batch/delete',
      '/api/v1/tasks/batch/delete?force=true',
      '/api/tasks/batch/delete?force=true',
      '/API/V1/TASKS/BATCH/DELETE',
      '/api/v1/tasks/batch/delete/',
      `/api/v1/${enc}`,
      '/api/v1/tasks/%62atch/delete',
      '/api/v1/tasks%2Fbatch%2Fdelete',
      '/api/v1/./tasks/batch/delete',
      '/api/v1/x/../tasks/batch/delete',
      '/api/tasks/x/%2e%2e/batch/delete',
      '/api//tasks//batch//delete',
      '/api/v1/tasks\\batch\\delete',
      '/api/v1/tasks%5Cbatch%5Cdelete',
    ]
    for (const path of spellings) {
      for (const origin of [HOST, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN]) {
        expect(selfCallRefusal('api', 'POST', path, origin), `${path} for ${origin}`)
          .toMatch(/is what task_delete does, and task_delete runs only for callers on this Mac$/)
      }
      expect(selfCallRefusal('api', 'POST', path, LOCAL_ORIGIN), path).toBeNull()
    }
    // Only the POST deletes; a batch update is not a delete.
    expect(selfCallRefusal('api', 'GET', '/api/v1/tasks/batch/delete', HOST)).toBeNull()
    expect(selfCallRefusal('api', 'POST', '/api/v1/tasks/batch/update', HOST)).toBeNull()
  })

  it('refuses a path that never settles under decoding', () => {
    expect(canonicalForms('/api/%25252525252568ealth')).toBeNull()
    expect(selfCallRefusal('api', 'GET', '/api/%25252525252568ealth', HOST)).toMatch(/could not be read/)
  })
})

describe('the local-only route set is derived from the registry', () => {
  it('every core remote:deny op carries a route the passthrough can refuse', () => {
    for (const { owner, op } of listOpEntries()) {
      if (owner !== 'core' || op.tags.remote !== 'deny') continue
      expect(op.bind || op.routes?.length, `${op.name} declares no route`).toBeTruthy()
    }
    const ops = new Set(localOnlyRoutes().map((r) => r.op))
    for (const name of ['task_delete', 'task_merge', 'health_status', 'health_sleep', 'health_daily', 'health_series', 'day_review']) {
      expect(ops.has(name), name).toBe(true)
    }
  })

  it('a destructive handler op reaches only the routes it declares (the declaration is honest)', async () => {
    for (const name of ['task_delete', 'task_merge']) {
      const op = getOp(name)!
      const seen: Array<[string, string]> = []
      const call = async (method: string, path: string) => { seen.push([method, path]); return { task: { id: 'abc123' } } }
      await op.handler!({ id: 'abc123', force: true, survivor_id: 'abc123', victim_ids: ['def456'] }, call as never)
      expect(seen.length, name).toBeGreaterThan(0)
      for (const [method, path] of seen) {
        expect(selfCallRefusal('api', method, path, HOST), `${name} reached ${method} ${path}, which it does not declare`).not.toBeNull()
      }
    }
  })

  it('a plugin op registered later is covered at once', () => {
    definePluginOp('origin-test', {
      name: 'origin_test_wipe', title: 'Wipe', description: 'A local-only write.', input: {},
      handler: async () => ({}), tags: { readonly: false, remote: 'deny' },
    })
    expect(selfCallRefusal('api', 'POST', '/api/plugin-runtime/origin-test/ops/origin_test_wipe', HOST)).toMatch(/origin_test_wipe/)
  })
})

describe('the executor carries and enforces the origin', () => {
  function recordFetch() {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string> })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return calls
  }
  const base = 'http://127.0.0.1:1'

  it('every self-call says who it is for', async () => {
    const calls = recordFetch()
    await executeOp('task_get', { id: 'abc123' }, { apiBase: base, origin: HOST })
    await executeOp('task_get', { id: 'abc123' }, { apiBase: base, origin: LOCAL_ORIGIN })
    await executeOp('api', { method: 'GET', path: '/api/time/summary' }, { apiBase: base, origin: REMOTE_HTTP_ORIGIN })
    // An untyped caller that passes nothing runs as the strictest class, not as local.
    await executeOp('task_get', { id: 'abc123' }, undefined as never)
    expect(calls.map((c) => c.headers[ORIGIN_HEADER])).toEqual([HOST, LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN])
  })

  it('a health op runs only for this Mac, from every entry point, and sends nothing otherwise', async () => {
    const calls = recordFetch()
    for (const origin of [HOST, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN]) {
      const r = await executeOp('health_status', {}, { apiBase: base, origin })
      expect(r).toEqual({ ok: false, message: `health_status refused: ${HEALTH_LOCAL_ONLY_MESSAGE}` })
    }
    expect(calls).toHaveLength(0)
    expect((await executeOp('health_status', {}, { apiBase: base, origin: LOCAL_ORIGIN })).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('a destructive local-only op refuses a remote host, and the api passthrough cannot do it instead', async () => {
    const calls = recordFetch()
    expect(await executeOp('task_delete', { id: 'abc123' }, { apiBase: base, origin: HOST })).toMatchObject({ ok: false, message: /local-only/ })
    expect(await executeOp('api', { method: 'DELETE', path: '/api/tasks/abc123' }, { apiBase: base, origin: HOST }))
      .toMatchObject({ ok: false, message: /task_delete runs only for callers on this Mac/ })
    expect(await executeOp('api', { method: 'DELETE', path: '/api/v1/health/data' }, { apiBase: base, origin: HOST }))
      .toEqual({ ok: false, message: HEALTH_LOCAL_ONLY_MESSAGE })
    expect(calls).toHaveLength(0)
  })

  it('batch delete through the passthrough is refused with and without force, and sends nothing', async () => {
    const calls = recordFetch()
    for (const path of ['/api/v1/tasks/batch/delete', '/api/tasks/batch/delete', '/api/v1/tasks/batch/delete?force=true']) {
      for (const body of [{ task_ids: ['abc123'] }, { task_ids: ['abc123'], force: true }]) {
        for (const origin of [HOST, REMOTE_HTTP_ORIGIN]) {
          expect(await executeOp('api', { method: 'POST', path, body }, { apiBase: base, origin }), `${path} ${JSON.stringify(body)} ${origin}`)
            .toMatchObject({ ok: false, message: /task_delete runs only for callers on this Mac/ })
        }
      }
    }
    expect(calls).toHaveLength(0)
    // A caller on this Mac still batch-deletes.
    await executeOp('api', { method: 'POST', path: '/api/v1/tasks/batch/delete', body: { task_ids: ['abc123'], force: true } }, { apiBase: base, origin: LOCAL_ORIGIN })
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', `${base}/api/v1/tasks/batch/delete`]])
  })

  it('an op run inside another op\'s handler inherits the lower origin (a plugin\'s ops.call)', async () => {
    const calls = recordFetch()
    definePluginOp('origin-test', {
      name: 'origin_test_relay', title: 'Relay', description: 'Calls a health op in process, as a plugin could.', input: {},
      handler: async () => executeOp('health_status', {}, { apiBase: base, origin: LOCAL_ORIGIN }),
      tags: { readonly: true, remote: 'allow' },
    })
    const nested = await executeOp('origin_test_relay', {}, { apiBase: base, origin: HOST })
    expect(nested).toMatchObject({ ok: true, result: { ok: false, message: `health_status refused: ${HEALTH_LOCAL_ONLY_MESSAGE}` } })
    expect(calls).toHaveLength(0)
  })
})

describe('a plugin\'s fetch back to this server', () => {
  it('carries the caller\'s origin to a loopback name only, over any origin the plugin set', async () => {
    const own = { 'Content-Type': 'application/json', 'X-Walnut-Origin': LOCAL_ORIGIN }
    // Plugin code running for this Mac (or outside any caller) sends its headers as they are.
    expect(labelPluginFetch('http://127.0.0.1:3456/api/health/status', own)).toBe(own)
    await withCallerOrigin(LOCAL_ORIGIN, async () => {
      expect(labelPluginFetch('http://127.0.0.1:3456/api/health/status', own)).toBe(own)
    })
    await withCallerOrigin(HOST, async () => {
      for (const url of ['http://127.0.0.1:3456/api/health/status', 'http://localhost:3456/x', 'http://[::1]:3456/x', 'http://127.1:3456/x']) {
        expect(labelPluginFetch(url, own), url).toEqual({ 'Content-Type': 'application/json', [ORIGIN_HEADER]: HOST })
      }
      expect(labelPluginFetch('http://127.0.0.1:3456/x', undefined)).toEqual({ [ORIGIN_HEADER]: HOST })
      // A Host header naming this machine counts as well.
      expect(labelPluginFetch('http://192.0.2.7:3456/x', { host: 'localhost:3456' })).toEqual({ host: 'localhost:3456', [ORIGIN_HEADER]: HOST })
      // Another server is left alone: the header means nothing there.
      expect(labelPluginFetch('https://api.example.com/v1', own)).toBe(own)
    })
    await withCallerOrigin(REMOTE_HTTP_ORIGIN, async () => {
      expect(labelPluginFetch('http://127.0.0.1:3456/x', { [ORIGIN_HEADER]: HOST })).toEqual({ [ORIGIN_HEADER]: HOST })
      expect(labelPluginFetch('http://127.0.0.1:3456/x', {})).toEqual({ [ORIGIN_HEADER]: REMOTE_HTTP_ORIGIN })
    })
  })
})
