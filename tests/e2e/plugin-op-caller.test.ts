/**
 * Who a plugin op runs for, through a REAL server with an ordinary stub plugin (no mail, no
 * provider): the op route (`POST /api/plugin-runtime/:id/ops/:op`), the cloud companion's relay
 * (`server.plugin-op`) and a nested call inside another op. The op reports the caller its
 * handler was given, the raw identity headers its nested call carried (read back by the
 * plugin's own route) and a nested read of a task in an incoming-item area.
 *
 * Before: every such op ran as `plugin:<id>`, so a person was read as an agent (refused area
 * work) and a session's id was dropped for the plugin's. Only the companion's transport is
 * stubbed, looped back into the Mac's own relay handler.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedLegacySession } from '../helpers/router-history-fixtures.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-op-caller'))
// The companion's bridge to the Mac, looped back: the params cross as JSON into the Mac's handler.
const relayed = vi.hoisted(() => ({ params: [] as Array<Record<string, unknown>> }))
vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...real,
    callPrimaryControl: async (action: string, sid: string, params: Record<string, unknown> | undefined, timeoutMs?: number) => {
      if (action !== 'server.plugin-op') return real.callPrimaryControl(action as never, sid, params, timeoutMs)
      const wire = JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>
      relayed.params.push(wire)
      const { handlePluginControlRelay } = await import('../../src/core/plugins/plugin-control-relay.js')
      const out = await handlePluginControlRelay(action, wire)
      if (!out.ok) throw new Error(`relay refused: ${out.error}`)
      return { ok: true as const, result: out.result }
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { updateRouterAreas } from '../../src/core/router/areas.js'
import { disposeRouterStores } from '../../src/core/router/runtime.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import { callPluginOp, getPluginApiBase } from '../../src/core/plugins/server-api.js'
import { handlePluginControlRelay } from '../../src/core/plugins/plugin-control-relay.js'
import { callPrimaryPluginOp } from '../../src/web/routes/plugin-runtime-bridge.js'
import { executeOp } from '../../src/ops/executor.js'
import { definePluginOp } from '../../src/ops/registry.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../src/lib/caller-origin.js'
import type { Task } from '../../src/core/types.js'

let server: HttpServer
let port: number
let areaId = ''
let plainId = ''
const ordinarySid = 'b7c5e0f1-0000-4000-8000-00000000c001'
const areaSid = 'b7c5e0f1-0000-4000-8000-00000000c002'
const legacySid = 'b7c5e0f1-0000-4000-8000-00000000c003'

// `who` answers with its handler's caller, the raw headers of a nested call, and nested reads.
const PROBE_SERVER = `
let calls = 0
export function activate(walnut) {
  walnut.http.route('GET', '/echo', (req) => ({ json: {
    sid: req.headers['x-walnut-caller-sid'] ?? null,
    kind: req.headers['x-walnut-caller-kind'] ?? null,
    plugin: req.headers['x-walnut-plugin-id'] ?? null,
    origin: req.headers['x-walnut-origin'] ?? null,
  } }))
  walnut.registry.op({
    name: 'who', title: 'who', description: 'Caller probe', readonly: true, remote: 'allow',
    inputSchema: { type: 'object', properties: { read: { type: 'array', items: { type: 'string' } } } },
    handler: async (args, ctx) => {
      calls += 1
      const echo = walnut.ops.unwrap(await walnut.ops.call('api', { method: 'GET', path: '/api/plugins/probe/echo' }))
      const reads = {}
      for (const id of args.read ?? []) {
        const r = await walnut.ops.call('api', { method: 'GET', path: '/api/v1/tasks/' + encodeURIComponent(id) })
        reads[id] = r.ok ? 'ok' : /may not read/.test(r.message) ? 'denied' : 'error: ' + r.message
      }
      return { ctx: { kind: ctx.callerKind, sid: ctx.callerSid ?? null }, echo, reads }
    },
  })
  walnut.registry.op({
    name: 'calls', title: 'calls', description: 'Caller probe count', readonly: true, remote: 'allow',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ calls }),
  })
}
`

type Who = { ctx: { kind: string; sid: string | null }; echo: { sid: string | null; kind: string | null; plugin: string | null; origin: string | null }; reads: Record<string, string> }

async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

const who = (headers: Record<string, string> = {}) =>
  post('/api/plugin-runtime/probe/ops/probe_who', { read: [areaId, plainId] }, headers)
const calls = async () => (await post('/api/plugin-runtime/probe/ops/probe_calls', {})).data.result.calls as number

async function mark(taskId: string, patch: Record<string, unknown>) {
  await updateTaskRaw(taskId, patch as Partial<Task>, { source: 'router-areas', emitEvent: false })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const dir = path.join(WALNUT_HOME, 'plugins', 'probe')
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
  }))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), PROBE_SERVER)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // Plugins activate after the server listens.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (await post('/api/plugin-runtime/probe/ops/probe_calls', {})).status !== 200) {
    await new Promise((r) => setTimeout(r, 200))
  }

  areaId = (await addTask({ title: 'Area desk', project: 'Garden' })).task.id
  plainId = (await addTask({ title: 'Plain chores', project: 'Pantry' })).task.id
  const legacyHome = (await addTask({ title: 'Moved session home', project: 'Pantry' })).task.id
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: [areaId], sources: [] }],
    routers: [{ taskId: areaId, areaId: 'personal', paused: false }],
    items: [],
  }))
  await mark(areaId, { org_role: 'router', router_area_id: 'personal', router_paused: false })
  await createSessionRecord(ordinarySid, plainId, 'Pantry', WALNUT_HOME, { mode: 'dontAsk' })
  await createSessionRecord(areaSid, areaId, 'Garden', WALNUT_HOME, { profile: routerAreaProfile('personal'), mode: 'dontAsk' })
  // Fault injection: only legacyTaskId still ties this detached historical session to the area.
  await seedLegacySession(legacySid, legacyHome, 'Pantry', WALNUT_HOME, { mode: 'dontAsk', legacyTaskId: areaId, initialProcessStatus: 'stopped' })
  for (const sid of [ordinarySid, areaSid]) await updateSessionRecord(sid, { process_status: 'stopped' })
}, 90_000)

afterAll(async () => {
  await disposeRouterStores()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('the plugin op route runs the op for its own caller', () => {
  it('a person (no caller header) is a person: no session id, and area work reads', async () => {
    const r = await who()
    expect(r.data).toEqual({ ok: true, result: {
      ctx: { kind: 'person', sid: null },
      echo: { sid: null, kind: null, plugin: 'probe', origin: LOCAL_ORIGIN },
      reads: { [areaId]: 'ok', [plainId]: 'ok' },
    } })
  })

  it('an automated caller is an agent with no session: area work is refused', async () => {
    const r = await who({ 'x-walnut-caller-kind': 'automation' })
    expect(r.data.result).toEqual({
      ctx: { kind: 'agent', sid: null },
      echo: { sid: null, kind: 'automation', plugin: 'probe', origin: LOCAL_ORIGIN },
      reads: { [areaId]: 'denied', [plainId]: 'ok' },
    } satisfies Who)
  })

  it('an ordinary session keeps its id in every nested call, never the plugin\'s', async () => {
    const r = await who({ 'x-walnut-caller-sid': ordinarySid })
    expect(r.data.result).toEqual({
      ctx: { kind: 'agent', sid: ordinarySid },
      echo: { sid: ordinarySid, kind: null, plugin: 'probe', origin: LOCAL_ORIGIN },
      reads: { [areaId]: 'denied', [plainId]: 'ok' },
    } satisfies Who)
  })

  it('a session in an area, by its task or only by its legacy task, is refused before the handler', async () => {
    const before = await calls()
    for (const sid of [areaSid, legacySid]) {
      const r = await who({ 'x-walnut-caller-sid': sid })
      expect({ sid, status: r.status, code: r.data?.code }).toEqual({ sid, status: 403, code: 'area_forbidden' })
    }
    expect(await calls()).toBe(before)
  })

  it('a session id that is not one runs as the plugin, never as a person', async () => {
    for (const bad of ['x'.repeat(201), 'two ids', '']) {
      const r = await who({ 'x-walnut-caller-sid': bad })
      expect(r.data.result).toEqual({
        ctx: { kind: 'agent', sid: 'plugin:probe' },
        echo: { sid: 'plugin:probe', kind: null, plugin: 'probe', origin: LOCAL_ORIGIN },
        reads: { [areaId]: 'denied', [plainId]: 'ok' },
      } satisfies Who)
    }
  })
})

describe('a nested call cannot change who it runs for', () => {
  let dispose: { dispose(): void | Promise<void> } | undefined
  beforeAll(() => {
    // An op whose handler asks callPluginOp for a different caller and a different plugin.
    dispose = definePluginOp('caller-scope-test', {
      name: 'caller_scope_outer', title: 'outer', description: 'Nested caller probe',
      input: { claim: z.enum(['person', 'agent']) },
      handler: async (args) => callPluginOp('probe', 'probe_who', { read: [areaId] }, LOCAL_ORIGIN,
        args.claim === 'person' ? { kind: 'person' } : { kind: 'agent', sid: ordinarySid }),
      tags: { readonly: true, remote: 'allow' },
    })
  })
  afterAll(async () => { await dispose?.dispose() })

  it('a session\'s op whose nested call claims a person stays that session; the plugin making the call is named', async () => {
    const out = await executeOp('caller_scope_outer', { claim: 'person' }, {
      apiBase: getPluginApiBase(), origin: LOCAL_ORIGIN, callerSid: ordinarySid, callerPluginId: 'outer-plugin',
    }) as { ok: true; result: { ok: true; result: Who } }
    expect(out.result.result).toEqual({
      ctx: { kind: 'agent', sid: ordinarySid },
      echo: { sid: ordinarySid, kind: null, plugin: 'probe', origin: LOCAL_ORIGIN },
      reads: { [areaId]: 'denied' },
    })
  })

  it('a person\'s op whose nested call claims a session stays the person', async () => {
    const out = await executeOp('caller_scope_outer', { claim: 'agent' }, {
      apiBase: getPluginApiBase(), origin: LOCAL_ORIGIN, callerMode: 'human',
    }) as { ok: true; result: { ok: true; result: Who } }
    expect(out.result.result).toEqual({
      ctx: { kind: 'person', sid: null },
      echo: { sid: null, kind: null, plugin: 'probe', origin: LOCAL_ORIGIN },
      reads: { [areaId]: 'ok' },
    })
  })
})

describe('the companion\'s relay carries the caller, and an older one names none', () => {
  it('the bridge sends the caller across, and the Mac runs the op for it at the relay\'s origin', async () => {
    relayed.params.length = 0
    const person = await callPrimaryPluginOp('probe', 'probe_who', { read: [areaId] }, { kind: 'person' }) as { ok: true; result: Who }
    expect(relayed.params[0]?.caller).toEqual({ kind: 'person' })
    expect(person.result).toEqual({
      ctx: { kind: 'person', sid: null },
      echo: { sid: null, kind: null, plugin: 'probe', origin: REMOTE_HTTP_ORIGIN },
      reads: { [areaId]: 'ok' },
    })
    const session = await callPrimaryPluginOp('probe', 'probe_who', { read: [areaId] }, { kind: 'agent', sid: ordinarySid }) as { ok: true; result: Who }
    expect(session.result.echo).toEqual({ sid: ordinarySid, kind: null, plugin: 'probe', origin: REMOTE_HTTP_ORIGIN })
    expect(session.result.reads).toEqual({ [areaId]: 'denied' })
  })

  it('no caller (an older companion) or a caller of any other shape runs as the plugin, never a person', async () => {
    relayed.params.length = 0
    const old = await callPrimaryPluginOp('probe', 'probe_who', { read: [areaId] }) as { ok: true; result: Who }
    expect('caller' in (relayed.params[0] ?? {})).toBe(false)
    expect(old.result.ctx).toEqual({ kind: 'agent', sid: 'plugin:probe' })
    expect(old.result.reads).toEqual({ [areaId]: 'denied' })
    for (const caller of [
      { kind: 'person', sid: ordinarySid }, { kind: 'admin' }, { kind: 'agent', sid: 'x'.repeat(201) },
      { kind: 'person', scope: 'all' }, 'person', ['person'],
    ]) {
      const out = await handlePluginControlRelay('server.plugin-op', { pluginId: 'probe', opName: 'probe_who', args: { read: [areaId] }, caller })
      expect(out).toMatchObject({ ok: true, result: { ok: true, result: {
        ctx: { kind: 'agent', sid: 'plugin:probe' },
        echo: { sid: 'plugin:probe', kind: null, plugin: 'probe', origin: REMOTE_HTTP_ORIGIN },
        reads: { [areaId]: 'denied' },
      } } })
    }
  })
})
