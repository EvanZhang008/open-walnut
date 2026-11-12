/**
 * Light subagents through a real server (core/subagents, routes/subagents-v1.ts): a session
 * starts one, waits for its answer or reads it later, sees it in its Background tasks
 * ledger, stops it from the panel's stop route, and is told about a run whose end no call
 * returned. The engine is the only thing faked (the runner): the real registry, routes,
 * session store and send queue.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-light-subagents'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { _resetLightSubagentsForTest, _setLightRunnerForTest, _skipEngineCheckForTest, prune } from '../../src/core/subagents/registry.js'
import type { LightRunSpec } from '../../src/core/subagents/types.js'

const SID = '5ab0a6e1-1111-4bbb-8ccc-dddddddddd01'
const OTHER = '5ab0a6e1-2222-4bbb-8ccc-dddddddddd02'
const READER = '5ab0a6e1-3333-4bbb-8ccc-dddddddddd03'
const ACP_PARENT = '5ab0a6e1-4444-4bbb-8ccc-dddddddddd04'
const BURST = '5ab0a6e1-5555-4bbb-8ccc-dddddddddd05'
const LINGER = '5ab0a6e1-6666-4bbb-8ccc-dddddddddd06'
let base = ''

/** Runs held until released by name; each records the spec it was given. */
const gates = new Map<string, () => void>()
const specs: LightRunSpec[] = []
/** Every message sent into a session (the queue drains at once, so read the sends). */
const sent: string[] = []
const sentAbout = (id: string) => sent.find((t) => t.includes(id))
function release(prompt: string): void { gates.get(prompt)?.() }

async function call(method: string, path: string, body?: unknown, sid: string | null = SID): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > end) throw new Error('timed out')
    await sleep(50)
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const [sid, mode] of [[SID, 'bypass'], [OTHER, 'default'], [READER, 'bypass'], [ACP_PARENT, 'bypass'], [BURST, 'bypass'], [LINGER, 'bypass']] as const) {
    const id = (await addTask({ title: `Parent ${sid.slice(9, 13)}`, project: 'Orchard' } as never)).task.id
    await createSessionRecord(sid, id, 'Orchard', WALNUT_HOME, { mode })
  }
  // An ACP parent started in bypass whose user then picked read-only in its engine's own Mode control.
  await updateSessionRecord(ACP_PARENT, { engine: 'opencode', acpConfig: { mode: 'read-only' }, acpRuntimeId: 'acp-light-parent-runtime' } as never)
  bus.subscribe('light-subagents-test', (e) => { sent.push(JSON.stringify(e.data ?? {})) }, { global: true, interest: [EventNames.SESSION_SEND] })
  _skipEngineCheckForTest(true)
  _setLightRunnerForTest(async (spec) => {
    specs.push(spec)
    spec.onProgress({ kind: 'tool', toolName: 'Read' })
    spec.onProgress({ kind: 'text', text: `working on ${spec.prompt}` })
    spec.onProgress({ kind: 'tokens', tokens: 1234 })
    if (spec.prompt.startsWith('hold')) {
      await new Promise<void>((resolve, reject) => {
        gates.set(spec.prompt, resolve)
        spec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (spec.prompt.startsWith('linger')) {
      // A worker that takes a while to end after it is told to stop.
      await new Promise<void>((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 1_500), { once: true })
      })
    }
    if (spec.prompt.startsWith('fail')) throw new Error('the engine broke')
    return { answer: `answer to ${spec.prompt}`, tokens: 2000, warnings: [] }
  })
}, 60_000)

afterEach(() => { for (const g of gates.values()) g(); gates.clear() })

afterAll(async () => {
  _setLightRunnerForTest(null)
  _skipEngineCheckForTest(false)
  _resetLightSubagentsForTest()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('light subagents', () => {
  it('refuses a call with no session, an unknown engine and an empty prompt', async () => {
    expect((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'x' }, null)).json.code).toBe('no_session')
    const bad = await call('POST', '/api/v1/subagents', { engine: 'cobol', prompt: 'x' })
    expect(bad.status).toBe(400)
    expect(String(bad.json.error)).toContain('Engines: codex')
    expect((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: '  ' })).status).toBe(400)
  })

  it('waits for the answer and runs in the parent\'s directory with its permissions', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', prompt: 'review the diff', description: 'Review' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ state: 'completed', answer: 'answer to review the diff', engine: 'codex', model: 'gpt-6.1-sol', tokens: 2000, full_access: true })
    const spec = specs.find((s) => s.prompt === 'review the diff')!
    expect(spec).toMatchObject({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', cwd: WALNUT_HOME, host: '__local__', fullAccess: true, parentSid: SID })
    // Its answer came back in the call: nothing more goes into the session.
    await sleep(3_500)
    expect(sentAbout(String(r.json.id))).toBeUndefined()
  })

  it('a session without full access gets a read-only subagent', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'opencode', prompt: 'look only' }, OTHER)
    expect(r.json).toMatchObject({ state: 'completed', full_access: false })
    expect(specs.find((s) => s.prompt === 'look only')!.fullAccess).toBe(false)
  })

  it('a run past the wait answers running, shows in the ledger, and is told to the session when it ends', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'hold long', wait_ms: 300, tool_use_id: 'toolu_light_1' })
    expect(r.json).toMatchObject({ state: 'running', tool_uses: 1, last_tool: 'Read', saying: 'working on hold long' })
    const id = String(r.json.id)
    // The panel's ledger (no Claude Code runner here: the light rows alone).
    const panel = await until(async () => {
      const res = await fetch(`${base}/api/sessions/${SID}/workflow`)
      const body = res.status === 200 ? await res.json() as { tasks?: Array<Record<string, unknown>> } : {}
      return body.tasks?.find((t) => t.taskId === id)
    })
    expect(panel).toMatchObject({ taskType: 'walnut_subagent', status: 'running', subagentType: 'Codex', toolUseId: 'toolu_light_1', prompt: 'hold long', toolUses: 1 })
    release('hold long')
    const told = await until(() => sentAbout(id), 10_000)
    expect(told).toContain('answer to hold long')
    // Reading it afterwards still works.
    expect((await call('GET', `/api/v1/subagents/${id}`)).json).toMatchObject({ state: 'completed', answer: 'answer to hold long' })
  })

  it('a read that waits takes the end, so no notification follows', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'hold read', background: true })
    expect(r.json.state).toBe('running')
    const id = String(r.json.id)
    const read = call('GET', `/api/v1/subagents/${id}?wait_ms=5000`, undefined, SID)
    await sleep(200)
    release('hold read')
    expect((await read).json).toMatchObject({ state: 'completed', answer: 'answer to hold read' })
    await sleep(3_500)
    expect(sentAbout(id)).toBeUndefined()
  })

  it('only its own session reads or stops a run', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'hold private', background: true })
    const id = String(r.json.id)
    expect((await call('GET', `/api/v1/subagents/${id}`, undefined, READER)).status).toBe(404)
    expect((await call('POST', `/api/v1/subagents/${id}/stop`, {}, READER)).status).toBe(404)
    expect((await call('GET', '/api/v1/subagents', undefined, READER)).json.subagents).toEqual([])
    release('hold private')
  })

  it('the panel\'s stop button stops it, and the engine run is cancelled', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'hold stop', background: true })
    const id = String(r.json.id)
    const stop = await call('POST', `/api/v1/sessions/${SID}/background-tasks/${id}/stop`, {}, null)
    expect(stop.status).toBe(200)
    expect(stop.json).toMatchObject({ taskId: id, stopped: true })
    expect(specs.find((s) => s.prompt === 'hold stop')!.signal.aborted).toBe(true)
    const after = await call('GET', `/api/v1/subagents/${id}`)
    expect(after.json).toMatchObject({ state: 'stopped' })
    expect((await call('POST', `/api/v1/subagents/${id}/stop`, {})).json).toMatchObject({ stopped: false, state: 'stopped' })
  })

  it('a failed engine run says why', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'goose', prompt: 'fail please' })
    expect(r.json).toMatchObject({ state: 'failed', error: 'the engine broke' })
  })

  it('holds at most four running per session', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(String((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: `hold n${i}`, background: true }, READER)).json.id))
    const fifth = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'hold n4', background: true }, READER)
    expect(fifth.status).toBe(429)
    expect(fifth.json.code).toBe('too_many')
    // Another session is not held by this one's runs.
    expect((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'quick other' }, OTHER)).json.state).toBe('completed')
    for (let i = 0; i < 4; i++) release(`hold n${i}`)
    const list = await until(async () => {
      const rows = (await call('GET', '/api/v1/subagents', undefined, READER)).json.subagents as Array<{ id: string; state: string }>
      return rows.filter((x) => ids.includes(x.id)).every((x) => x.state === 'completed') && rows
    })
    expect(list.length).toBeGreaterThanOrEqual(4)
  })

  it('starts at once never pass the per-session limit together', async () => {
    const all = await Promise.all([0, 1, 2, 3, 4].map((i) => call('POST', '/api/v1/subagents', { engine: 'codex', prompt: `hold burst${i}`, background: true }, BURST)))
    expect(all.filter((r) => r.status === 200)).toHaveLength(4)
    expect(all.filter((r) => r.status === 429)).toHaveLength(1)
    for (let i = 0; i < 5; i++) release(`hold burst${i}`)
  })

  it('a stopped run keeps its slot until its worker has really ended', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(String((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: `linger ${i}`, background: true }, LINGER)).json.id))
    for (const id of ids) expect((await call('POST', `/api/v1/subagents/${id}/stop`, {}, LINGER)).json).toMatchObject({ stopped: true })
    // Stopped on the panel, but the workers are still going: no room yet.
    expect((await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'quick early' }, LINGER)).status).toBe(429)
    await until(async () => (await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'quick late' }, LINGER)).status === 200, 10_000)
  })

  it('an ACP parent: its engine\'s own Mode choice decides the posture, and its runtime id is the caller', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'acp parent asks' }, ACP_PARENT)
    expect(r.json).toMatchObject({ state: 'completed', full_access: false })
    const spec = specs.find((s) => s.prompt === 'acp parent asks')!
    expect(spec).toMatchObject({ fullAccess: false, parentSid: ACP_PARENT, callerSid: 'acp-light-parent-runtime' })
    // A Claude Code parent's own id is the caller.
    expect(specs.find((s) => s.prompt === 'review the diff')!.callerSid).toBe(SID)
  })

  it('ended runs are dropped after their keep, whether or not the session starts another', async () => {
    const r = await call('POST', '/api/v1/subagents', { engine: 'codex', prompt: 'kept a while' }, OTHER)
    const id = String(r.json.id)
    prune()
    expect((await call('GET', `/api/v1/subagents/${id}`, undefined, OTHER)).status).toBe(200)
    prune(Date.now() + 7 * 3_600_000)
    expect((await call('GET', `/api/v1/subagents/${id}`, undefined, OTHER)).status).toBe(404)
  })
})
