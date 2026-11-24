/**
 * The AI search child on a host replica while the Mac is away (2026-11-24).
 *
 * `GET /api/search/agent` has no route-table row, so with the Mac away the replica runs it
 * itself: a micro-Claude child with Bash whose system prompt tells it to curl this server's
 * own `/api/search`. A host replica trusts no loopback caller (every port is a tunnel port,
 * local-trust.ts), so a curl with no credential was refused `401 not_paired`, and AI search
 * found nothing on the replica: the phone through it, or the host's own console.
 *
 * The real startServer boots as a host replica with the leader away; a paired phone asks for
 * an AI search; the `claude` it spawns is tests/helpers/shell-helper-fake-claude.cjs, which runs
 * the prompt's curl line in a real shell with the env the CLI was given, as the Bash tool does.
 * Only the CLI is a stand-in: the prompt, the child's env, the auth and the search route are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { sha256, useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-search-helper'))
// Every test server keeps background AI off; this test is about the one that runs.
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => false,
}))

const PHONE_TOKEN = 'marina-phone-token-search-helper'
const TASK_ID = 'tsk-acme-rollback-0001'
const NOW = '2026-11-24T00:00:00.000Z'

let env: HostReplicaEnv | null = null
let stopServer: (() => Promise<void>) | null = null
let port = 0
let bin = ''
let probe = ''
const saved: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key]
  process.env[key] = value
}

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  const role = await import('../../src/core/server-role.js')
  role._resetServerRoleForTesting()
  expect(role.isHostReplica()).toBe(true)
  expect(role.leaderAnswers()).toBe(false)

  // The stand-in CLI, in a temp dir (the only place a test's `claude` resolves, test-claude-guard.ts).
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'search-helper-bin-'))
  const fake = path.resolve(import.meta.dirname, '../helpers/shell-helper-fake-claude.cjs')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 })
  probe = path.join(bin, 'probe.jsonl')
  setEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
  setEnv('HELPER_FAKE_PROBE', probe)
  setEnv('HELPER_FAKE_TERMS', 'rollback')

  // A task in the replica's copy (the Mac sent it), found by the search the child runs.
  const taskDb = await import('../../src/core/task-db.js')
  taskDb.getDb()
  const apply = taskDb.openCopyApplyConnection()
  try {
    apply.prepare('INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(TASK_ID, 'Acme rollback drill', NOW, NOW)
  } finally { apply.close() }

  const server = await import('../../src/web/server.js')
  const http = await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
  const addr = http.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
  const { replicaDeviceCopy } = await import('../../src/replica/auth.js')
  expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] })).toMatchObject({ ok: true })
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  env?.restore()
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
  if (bin) fs.rmSync(bin, { recursive: true, force: true })
}, 60_000)

async function get(p: string, token?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, body }
}

function probes(): Array<{ command: string | null; status: number; body: string }> {
  try { return fs.readFileSync(probe, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

describe('the AI search child on a host replica, the Mac away', () => {
  it('the replica still refuses a caller with no credential (the loopback rule holds)', async () => {
    const r = await get('/api/search?q=rollback')
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('not_paired')
  })

  it("the child's search of its own Walnut is answered, and the phone gets the task it found", async () => {
    const r = await get(`/api/search/agent?q=${encodeURIComponent('the rollback drill task')}`, PHONE_TOKEN)
    const runs = probes()
    expect(runs.length, JSON.stringify(r.body).slice(0, 300)).toBe(1)
    const run = runs[0]!
    // The child ran the prompt's own curl line against this replica.
    expect(run.command).toContain(`http://127.0.0.1:${port}/api/search`)
    expect(run.status, run.body.slice(0, 200)).toBe(200)
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200)
    expect(r.body.results.map((x: { taskId: string }) => x.taskId)).toEqual([TASK_ID])
    // The prompt names the variable; the value rides the child's env only.
    const { getHelperCallToken } = await import('../../src/lib/self-api-root.js')
    expect(run.command).toContain('Authorization: Bearer $WALNUT_HELPER_TOKEN')
    expect(run.command).not.toContain(getHelperCallToken()!)
    expect(process.env.WALNUT_HELPER_TOKEN).toBeUndefined()
  }, 120_000)

  it('the helper credential reads search only: another read is 403, a write never runs, the phone still passes', async () => {
    const { getHelperCallToken } = await import('../../src/lib/self-api-root.js')
    const helper = getHelperCallToken()!
    const other = await get('/api/tasks', helper)
    expect(other.status).toBe(403)
    expect(other.body.code).toBe('helper_scope')
    const write = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', authorization: `Bearer ${helper}` },
      body: JSON.stringify({ title: 'made by a helper' }),
    })
    // Refused by the dispatcher before any away write (no wrong-token count, dispatch.ts helperCall).
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ code: 'helper_scope' })
    const phone = await get('/api/search?q=rollback&types=task,session&slim=1', PHONE_TOKEN)
    expect(phone.status).toBe(200)
    expect(JSON.stringify(phone.body)).toContain(TASK_ID)
  })
})
