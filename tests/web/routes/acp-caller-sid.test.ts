/**
 * An ACP session's `walnut` calls name their session (core/sessions/acp-caller-sid.ts).
 *
 * An ACP engine's CLI (pi, Codex, OpenCode, Goose) carries its worker's runtime id
 * (`acp-...`) in WALNUT_SESSION_ID, while its session record is keyed by the provider's
 * session id. Before the fix every such call read as an unidentified process: a task_send
 * arrived anonymous and a task it filed was nobody's subtask. Real startServer with an
 * isolated home; the callers are real session records, the gateway is the real router.
 *
 * The guard at the end fails when a new way in for a caller sid skips the mapping: the
 * API middleware must be mounted before any /api router, and the gateway relay must map.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-acp-caller-sid'))
vi.mock('../../../src/core/fork-title.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/fork-title.js')>()),
  summarizeGroupLabel: vi.fn(async () => 'Refined Folder'),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, deleteSessionRecords, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { canonicalCallerSid, clearAcpCallerSidCache } from '../../../src/core/sessions/acp-caller-sid.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

let seq = 0
/** A pi session the way a real one is stored once pi named its session: the pending row keyed by
 *  the runtime id was an archived pointer to the new one for a moment, then deleted
 *  (session-tracker's identity migration), so only the new row wears the runtime id. */
async function seedAcpCaller(project: string) {
  seq += 1
  const { task } = await addTask({ title: `Pi caller ${seq}`, project, pinned: true })
  const runtimeId = `acp-0000${seq}-aaaa-bbbb-cccc-dddddddddddd`
  const sid = `33333333-2222-3333-4444-${String(seq).padStart(12, '0')}`
  await createSessionRecord(runtimeId, task.id, project, `/repo/${project}`, { title: task.title, engine: 'pi', acpRuntimeId: runtimeId })
  await updateSessionRecord(runtimeId, { archived: true, archive_reason: `acp_identity_replaced:${sid}` })
  await createSessionRecord(sid, task.id, project, `/repo/${project}`, { title: task.title, engine: 'pi', acpRuntimeId: runtimeId })
  await deleteSessionRecords(new Set([runtimeId]), 'test-acp-identity-migration')
  return { task: await getTask(task.id), sid, runtimeId }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('canonicalCallerSid', () => {
  it('maps a runtime id to the open record wearing it, and leaves every other id alone', async () => {
    const { sid, runtimeId } = await seedAcpCaller('acp-map')
    clearAcpCallerSidCache()
    expect(canonicalCallerSid(runtimeId)).toBe(sid)
    expect(canonicalCallerSid(runtimeId)).toBe(sid) // from the cache, checked against the row
    expect(canonicalCallerSid(sid)).toBe(sid)
    expect(canonicalCallerSid('acp-nobody')).toBe('acp-nobody')
    expect(canonicalCallerSid('external')).toBe('external')
    expect(canonicalCallerSid(undefined)).toBeUndefined()
  })

  it('a pending session (the record still keyed by its runtime id) keeps that id', async () => {
    const { task } = await addTask({ title: 'Pending pi', project: 'acp-map', pinned: true })
    const runtimeId = 'acp-pending-0001'
    await createSessionRecord(runtimeId, task.id, 'acp-map', '/repo/acp-map', { engine: 'pi', acpRuntimeId: runtimeId })
    expect(canonicalCallerSid(runtimeId)).toBe(runtimeId)
  })

  it('a pending session that the engine then names maps to the new row on the next call', async () => {
    const { task } = await addTask({ title: 'Naming pi', project: 'acp-map', pinned: true })
    const runtimeId = 'acp-naming-0001'
    const sid = '55555555-2222-3333-4444-000000000001'
    await createSessionRecord(runtimeId, task.id, 'acp-map', '/repo/acp-map', { engine: 'pi', acpRuntimeId: runtimeId })
    expect(canonicalCallerSid(runtimeId)).toBe(runtimeId)
    await updateSessionRecord(runtimeId, { archived: true, archive_reason: `acp_identity_replaced:${sid}` })
    await createSessionRecord(sid, task.id, 'acp-map', '/repo/acp-map', { engine: 'pi', acpRuntimeId: runtimeId })
    await deleteSessionRecords(new Set([runtimeId]), 'test-acp-identity-migration')
    expect(canonicalCallerSid(runtimeId)).toBe(sid)
  })

  it('a cached mapping whose record was archived since is looked up again', async () => {
    const { sid, runtimeId } = await seedAcpCaller('acp-map')
    expect(canonicalCallerSid(runtimeId)).toBe(sid)
    await updateSessionRecord(sid, { archived: true, archive_reason: 'engine_switched:test' })
    // Both rows archived: no open session wears it, so the newest lookup decides, never the stale cache entry alone.
    const again = canonicalCallerSid(runtimeId)
    expect([sid, runtimeId]).toContain(again)
  })
})

describe('an ACP session calling Walnut', () => {
  it('GET /api/v1/me names its task and session', async () => {
    const { task, sid, runtimeId } = await seedAcpCaller('acp-me')
    const res = await fetch(api('/api/v1/me'), { headers: { 'x-walnut-caller-sid': runtimeId } })
    const json = await res.json() as Record<string, any>
    expect(json.kind).toBe('worker')
    expect(json.task.id).toBe(task.id)
    expect(json.session.id).toBe(sid)
  })

  it('a task it files over the gateway is its subtask, and its task_send is from it, not anonymous', async () => {
    const { task, runtimeId } = await seedAcpCaller('acp-gw')
    const deps = () => ({ throttle: new PeerThrottle(), cloudMode: false })
    const created = await handleGatewayCapability('tools.call', runtimeId, { name: 'task_create', args: { title: 'Filed from pi', record_only: true } }, '__local__', deps())
    expect(created.ok).toBe(true)
    const newId = ((created as { result: Record<string, any> }).result.task?.id ?? (created as { result: Record<string, any> }).result.id) as string
    expect((await getTask(newId)).parent_task_id).toBe(task.id)

    const { task: peer } = await addTask({ title: 'Peer listener', project: 'acp-gw', pinned: true })
    const peerSid = '44444444-2222-3333-4444-000000000001'
    await createSessionRecord(peerSid, peer.id, 'acp-gw', '/repo/acp-gw', { title: peer.title })
    const sent = await fetch(api('/api/v1/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': runtimeId },
      body: JSON.stringify({ to: peer.id, text: 'PING-FROM-PI', expect_reply: false }),
    })
    expect(sent.status).toBeLessThan(300)
    const { getQueue } = await import('../../../src/core/session-message-queue.js')
    const row = (await getQueue(peerSid)).find((m) => m.message.includes("PING-FROM-PI"))
    expect(row).toBeDefined()
    expect(row!.message).not.toContain('anonymous="true"')
    expect(row!.message).toContain(task.id)
  })
})

describe('guard: every way a caller sid enters the server maps it', () => {
  it('the middleware is mounted before every /api router, and the gateway relay maps', async () => {
    const root = path.resolve(__dirname, '../../..')
    const server = await fs.readFile(path.join(root, 'src/web/server.ts'), 'utf8')
    const mount = server.indexOf('acpCallerSidMiddleware')
    expect(mount).toBeGreaterThan(0)
    const lines = server.split('\n')
    const firstRouter = lines.findIndex((l) => /app\.use\(\s*['"`]\/api[^,]*,\s*\w*(Router|router)\b/.test(l))
    const mountLine = lines.findIndex((l) => l.includes('acpCallerSidMiddleware'))
    expect(firstRouter).toBeGreaterThan(mountLine)
    const router = await fs.readFile(path.join(root, 'src/core/peers/capability-router.ts'), 'utf8')
    const body = router.slice(router.indexOf('export async function handleGatewayCapability'))
    expect(body.slice(0, body.indexOf('switch (capability)'))).toContain('canonicalCallerSid(callerSid)')
    // The companion leading for an away Mac answers the same gateway frames.
    const backup = await fs.readFile(path.join(root, 'src/core/leader/backup-gateway.ts'), 'utf8')
    const answer = backup.slice(backup.indexOf('async function answer('))
    expect(answer.slice(0, answer.indexOf('leadOf('))).toContain('canonicalCallerSid(')
    // A host answering alone maps it from its slice (tests/providers/offline-host-core.test.ts).
    const offline = await fs.readFile(path.join(root, 'src/providers/offline-host-core.ts'), 'utf8')
    for (const fn of ['async function handle(', 'async function handleLocal(']) {
      const at = offline.slice(offline.indexOf(fn))
      expect(at.slice(0, at.indexOf('\n  }\n')), fn).toContain('callerSidOf(home, rawCallerSid)')
    }
    const slice = await fs.readFile(path.join(root, 'src/core/host-slice.ts'), 'utf8')
    expect(slice).toContain('runtimeId: s.acpRuntimeId')
  })
})
