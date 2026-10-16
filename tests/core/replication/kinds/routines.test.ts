/**
 * The `routines` copy kind (docs/plan/walnut-replica-servers-impl.md, WP5): the Mac's
 * cron-jobs.json plus each routine's status projection to a host replica, in the same
 * two files, read only there. The Routines page's reads (routines-core.ts) answer
 * from the copy without the engine (which would recompute and persist), and every
 * routine write answers needs_leader. Real files, real route, real follower.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-routines', { CLOUD_MODE: false }))

import { CRON_FILE, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound, syncCopyKinds } from '../../../../src/core/replication/kinds/copy-kind.js'
import { ROUTINES_KIND, projectStatus, readRoutineRows } from '../../../../src/core/replication/kinds/routines.js'
import { readRoutinesCopy, _resetRoutinesCopyForTesting } from '../../../../src/core/replication/kinds/routines-follower.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests } from '../../../../src/core/replication/replica-status.js'
import * as core from '../../../../src/core/routines/routines-core.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
const stateFile = () => path.join(path.dirname(CRON_FILE), 'cron-state.json')
// The leader's files live under a dir of their own here, so the copy's same-named files are the host's.
let macDir = ''
const kind = { ...ROUTINES_KIND, rows: () => readRoutineRows(path.join(macDir, 'cron-jobs.json'), path.join(macDir, 'cron-state.json')), watch: () => () => {} }

function job(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `rt-acme-${String(i).padStart(4, '0')}`, name: `Acme digest ${i}`, enabled: i % 4 !== 0, createdAtMs: 1_000 + i, updatedAtMs: 2_000 + i,
    schedule: { kind: 'every', everyMs: 3_600_000 }, sessionTarget: 'main', wakeMode: 'next-heartbeat',
    payload: { kind: 'systemEvent', text: `digest ${i}` }, ...over,
  }
}

/** The real routines engine on the Mac's files (no timer: every write in here is driven). */
async function macCronService(now: () => number) {
  const { CronService } = await import('../../../../src/core/cron/service.js')
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  return new CronService({
    nowMs: now, log: quiet, storePath: path.join(macDir, 'cron-jobs.json'), cronEnabled: false,
    broadcastCronNotification: () => {}, runMainAgentWithPrompt: async () => undefined,
    runIsolatedAgentJob: async () => ({ status: 'ok', summary: 'done' }), runExecutor: async () => ({ status: 'ok' }), onEvent: () => {},
  } as never)
}

const TRIGGER = {
  name: 'Acme watch', enabled: true, schedule: { kind: 'every', everyMs: 300_000 }, sessionTarget: 'main',
  payload: { kind: 'systemEvent', text: 'go' }, check: { run: 'echo \'{"fire": false}\'', host: '__local__' },
}

function state(i: number): Record<string, unknown> {
  return { nextRunAtMs: 10_000 - i, lastRunAtMs: 5_000 + i, lastStatus: 'ok', lastDurationMs: 40, runningAtMs: 9, lastCheck: { atMs: 7, ok: true }, warningNoticeAtMs: 3 }
}

async function writeMac(jobs: Record<string, unknown>[], states: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(macDir, { recursive: true })
  await fsp.writeFile(path.join(macDir, 'cron-jobs.json'), JSON.stringify({ version: 2, jobs }))
  await fsp.writeFile(path.join(macDir, 'cron-state.json'), JSON.stringify({ version: 1, states }))
}

async function round() {
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

function setReplica(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  else for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  setReplica(true)
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  setReplica(true)
  _resetRoutinesCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  macDir = path.join(WALNUT_HOME, 'mac-side')
  h.calls.length = 0
  const jobs = Array.from({ length: 8 }, (_, i) => job(i))
  await writeMac(jobs, Object.fromEntries(jobs.map((j, i) => [j.id, state(i)])))
})

describe('the status projection', () => {
  it('keeps what the page shows, drops what moves unseen', () => {
    expect(projectStatus(state(1) as never)).toEqual({ nextRunAtMs: 9_999, lastRunAtMs: 5_001, lastStatus: 'ok', lastDurationMs: 40 })
    expect(projectStatus(undefined)).toEqual({})
    // A trigger's next run is the daemon's re-arm of its next check: left out.
    expect(projectStatus(state(1) as never, { trigger: true })).toEqual({ lastRunAtMs: 5_001, lastStatus: 'ok', lastDurationMs: 40 })
  })
})

describe('a host replica keeps the routines copy', () => {
  it('writes the same two files the Mac keeps, at 0600, in the Mac order, and converges', async () => {
    expect(await round()).toMatchObject({ action: 'synced', entries: 8, sent: 8 })
    expect(stepsSince(h.calls)).toEqual(['sync:routines', 'put:routines:8'])
    for (const f of [CRON_FILE, stateFile()]) expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    const jobs = (JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')) as { version: number; jobs: Array<{ id: string; state?: unknown }> })
    expect(jobs.version).toBe(2)
    expect(jobs.jobs.map((j) => j.id)).toEqual(Array.from({ length: 8 }, (_, i) => job(i).id))
    expect(jobs.jobs.every((j) => j.state === undefined)).toBe(true)
    const states = (JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as { states: Record<string, Record<string, unknown>> }).states
    expect(states[job(2).id as string]).toEqual({ nextRunAtMs: 9_998, lastRunAtMs: 5_002, lastStatus: 'ok', lastDurationMs: 40 })
    forgetKindManifests(['routines'])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:routines'])
  })

  it('a running mark or a last-check write moves no row; a finished run is one row', async () => {
    await round()
    const jobs = Array.from({ length: 8 }, (_, i) => job(i))
    const states = Object.fromEntries(jobs.map((j, i) => [j.id, { ...state(i), runningAtMs: 77, lastCheck: { atMs: 88, ok: false } }]))
    await writeMac(jobs, states)
    const from = h.calls.length
    expect((await round()).sent ?? 0).toBe(0)
    expect(stepsSince(h.calls, from).filter((x) => x.startsWith('put'))).toEqual([])
    states[job(3).id as string] = { ...state(3), lastRunAtMs: 6_000, lastStatus: 'error', lastError: 'exit 1' }
    await writeMac(jobs, states)
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect((await readRoutinesCopy({ includeDisabled: true }))!.find((j) => j.id === job(3).id)!.state).toMatchObject({ lastStatus: 'error', lastError: 'exit 1' })
  })

  it('real quiet trigger checks (the engine writes updatedAtMs, nextRunAtMs, lastCheck, checkLog) move no row; an error check is one row', async () => {
    setReplica(false)
    let now = 50_000
    const service = await macCronService(() => now)
    const trig = await service.add(TRIGGER as never)
    setReplica(true)
    await round()
    const copied = async () => (await readRoutinesCopy({ includeDisabled: true }))!.find((j) => j.id === trig.id)!
    const before = await copied()
    const macJob = () => (JSON.parse(fs.readFileSync(path.join(macDir, 'cron-jobs.json'), 'utf8')) as { jobs: Array<Record<string, any>> }).jobs.find((j) => j.id === trig.id)!
    const macState = () => (JSON.parse(fs.readFileSync(path.join(macDir, 'cron-state.json'), 'utf8')) as { states: Record<string, Record<string, any>> }).states[trig.id]!
    const check = async (outcome: 'quiet' | 'error') => {
      now += 300_000
      setReplica(false)
      const applied = await service.applyTriggerChecked({
        type: 'trigger.checked', id: trig.id, atMs: now, outcome, ...(outcome === 'quiet' ? { reason: 'fire-false' } : { error: 'exit 2' }),
        durationMs: 120, nextRunAtMs: now + 300_000, consecutiveErrors: outcome === 'error' ? 1 : 0,
      } as never)
      setReplica(true)
      expect(applied.found).toBe(true)
    }
    for (let i = 0; i < 3; i++) {
      await check('quiet')
      // The engine did move its clocks on the Mac.
      expect(macJob().updatedAtMs).toBe(now)
      expect(macState()).toMatchObject({ nextRunAtMs: now + 300_000, lastCheck: { atMs: now, outcome: 'quiet' } })
      expect(macState().checkLog.length).toBe(i + 1)
      const from = h.calls.length
      expect((await round()).sent ?? 0).toBe(0)
      expect(stepsSince(h.calls, from).filter((x) => x.startsWith('put'))).toEqual([])
    }
    expect(await copied()).toEqual(before)
    // The copy's updatedAtMs reads as the definition's creation; no next check is copied.
    expect(before.updatedAtMs).toBe(before.createdAtMs)
    expect(before.state.nextRunAtMs).toBeUndefined()
    await check('error')
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect((await copied()).state).toMatchObject({ lastStatus: 'error', consecutiveErrors: 1 })
    service.stop()
  })

  it('a reorder on the Mac reorders the copy', async () => {
    await round()
    const jobs = Array.from({ length: 8 }, (_, i) => job(i)).reverse()
    await writeMac(jobs, Object.fromEntries(jobs.map((j, i) => [j.id, state(i)])))
    await round()
    const ids = (JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)
    expect(ids).toEqual(jobs.map((j) => j.id))
  })

  it('removing most of 30 routines is refused; a few go', async () => {
    const jobs = Array.from({ length: 30 }, (_, i) => job(i))
    await writeMac(jobs, {})
    await round()
    await writeMac(jobs.slice(0, 24), {})
    expect(await round()).toMatchObject({ action: 'synced', removed: 6 })
    await writeMac(jobs.slice(0, 5), {})
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await readRoutinesCopy({ includeDisabled: true }))!.length).toBe(24)
  })

  it('a jobs file the Mac cannot read skips the round; a state file it cannot read is no status', async () => {
    await round()
    await fsp.rm(path.join(macDir, 'cron-state.json'))
    await fsp.symlink('cron-state.json', path.join(macDir, 'cron-state.json'))
    expect((await kind.rows()).every((r) => Object.keys(r.status).length === 0)).toBe(true)
    await fsp.rm(path.join(macDir, 'cron-jobs.json'))
    await fsp.symlink('cron-jobs.json', path.join(macDir, 'cron-jobs.json'))
    await expect(kind.rows()).rejects.toThrow(/ELOOP/)
    h.calls.length = 0
    expect(await syncCopyKinds([kind], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
    expect((await readRoutinesCopy({ includeDisabled: true }))!.length).toBe(8)
  })
})

describe('the Routines page on the replica', () => {
  it('list, detail and status read the copy (no engine runs here)', async () => {
    await round()
    const { jobs } = await core.listRoutines(false) as { jobs: Array<{ id: string; enabled: boolean; state: { nextRunAtMs?: number } }> }
    expect(jobs.length).toBe(6) // 0 and 4 are disabled
    expect(jobs.every((j) => j.enabled)).toBe(true)
    const next = jobs.map((j) => j.state.nextRunAtMs ?? 0)
    expect([...next].sort((a, b) => a - b)).toEqual(next)
    expect(((await core.listRoutines(true)).jobs as unknown[]).length).toBe(8)
    expect((await core.getRoutine(job(5).id as string)).job).toMatchObject({ id: job(5).id, name: 'Acme digest 5' })
    await expect(core.getRoutine('rt-missing')).rejects.toMatchObject({ statusCode: 404 })
    expect(await core.getRoutinesStatus()).toEqual({ enabled: false, storePath: '', jobs: 8, nextWakeAtMs: null })
    // The copy is read, never rewritten by a read.
    const before = fs.readFileSync(CRON_FILE, 'utf8') + fs.readFileSync(stateFile(), 'utf8')
    await core.listRoutines(true)
    expect(fs.readFileSync(CRON_FILE, 'utf8') + fs.readFileSync(stateFile(), 'utf8')).toBe(before)
  })

  it('before the first round the page answers needs_leader kind_not_copied, never "no routines"', async () => {
    await expect(core.listRoutines(true)).rejects.toMatchObject({ code: 'needs_leader', why: 'kind_not_copied' })
    await expect(core.getRoutine(job(1).id as string)).rejects.toMatchObject({ code: 'needs_leader', why: 'kind_not_copied' })
    await round()
    expect((await core.listRoutines(true)).jobs).toHaveLength(8)
  })

  it('every routine write answers needs_leader and leaves the copy as it was', async () => {
    await round()
    const before = fs.readFileSync(CRON_FILE, 'utf8')
    const id = job(1).id as string
    const writes: Array<() => Promise<unknown>> = [
      () => core.createRoutine({ name: 'x', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'systemEvent', text: 'x' } }),
      () => core.patchRoutine(id, { name: 'renamed' }),
      () => core.deleteRoutine(id),
      () => core.toggleRoutine(id),
      () => core.runRoutineNow(id),
    ]
    for (const w of writes) await expect(w()).rejects.toMatchObject({ code: 'needs_leader', why: 'routine_writes_need_mac' })
    expect(fs.readFileSync(CRON_FILE, 'utf8')).toBe(before)
  })

  it("the phone's routes say the same: 503 needs_leader with the why, never the v1 funnel's 500", async () => {
    const [{ default: express }, { routinesV1Router }, { errorHandler }] = await Promise.all([
      import('express'), import('../../../../src/web/routes/routines-v1.js'), import('../../../../src/web/middleware/error-handler.js'),
    ])
    const app = express()
    app.use(express.json())
    app.use('/api/v1', routinesV1Router)
    app.use(errorHandler)
    const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
      const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/v1`
      const none = await fetch(`${base}/routines?includeDisabled=true`)
      expect(none.status).toBe(503)
      expect(await none.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied' } })
      await round()
      const list = await fetch(`${base}/routines?includeDisabled=true`)
      expect(list.status).toBe(200)
      expect(((await list.json()) as { jobs: unknown[] }).jobs).toHaveLength(8)
      const before = fs.readFileSync(CRON_FILE, 'utf8')
      const add = await fetch(`${base}/routines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'systemEvent', text: 'x' } }) })
      expect(add.status).toBe(503)
      expect(await add.json()).toMatchObject({ error: { code: 'needs_leader', why: 'routine_writes_need_mac' } })
      expect(fs.readFileSync(CRON_FILE, 'utf8')).toBe(before)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe("the replica's own routines engine never writes the copy", () => {
  it('registered but not started: no caller drives it, and its one write point refuses', async () => {
    await round()
    // The copied next runs are in the past: an engine list would recompute them and persist.
    const bytes = () => `${fs.readFileSync(CRON_FILE, 'utf8')}\n${fs.readFileSync(stateFile(), 'utf8')}`
    const before = bytes()
    // The engine every server builds (server.ts), over the same two files, which on a
    // host replica are the copy's. Registered, never started (boot policy `cron`).
    const { CronService } = await import('../../../../src/core/cron/service.js')
    const quiet = { debug() {}, info() {}, warn() {}, error() {} }
    const engine = new CronService({
      storePath: CRON_FILE, cronEnabled: true, log: quiet,
      broadcastCronNotification: () => {}, runMainAgentWithPrompt: async () => undefined,
      runIsolatedAgentJob: async () => ({ status: 'ok', summary: 'done' }), runExecutor: async () => ({ status: 'ok' }), onEvent: () => {},
    } as never)
    const { setCronService, getCronService } = await import('../../../../src/web/routes/cron.js')
    setCronService(engine)
    try {
      // What reached the engine on a replica: the trigger push at every daemon connect,
      // a daemon's check report, the timeline's tracking read.
      const { compileTriggersForHost } = await import('../../../../src/core/routines/trigger-push.js')
      const armed = await compileTriggersForHost('__local__')
      const { handleTriggerChecked } = await import('../../../../src/core/routines/trigger-events.js')
      await handleTriggerChecked('devbox', {
        type: 'trigger.checked', id: job(1).id, atMs: Date.now(), outcome: 'quiet', reason: 'fire-false', durationMs: 5, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: 0,
      } as never)
      expect(bytes()).toBe(before)
      // A trigger set that is null is "the engine is not running": never an empty set, which would disarm the host.
      expect(armed).toBeNull()
      expect(getCronService()).toBeNull()
      // The engine itself, to whoever holds it: its one write point refuses, the copy stays.
      await expect(engine.list({ includeDisabled: true })).rejects.toMatchObject({ code: 'needs_leader', why: 'routine_writes_need_mac' })
      expect(bytes()).toBe(before)
      // The page still reads the copy.
      expect(((await core.listRoutines(true)).jobs as unknown[]).length).toBe(8)
      // On the Mac the same registration is the engine.
      setReplica(false)
      expect(getCronService()).toBe(engine)
    } finally {
      setCronService(null)
      setReplica(true)
    }
  })
})

describe('the host turned the routines copy off', () => {
  it('drops both files and keeps an off marker; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:routines-off', copies: async () => choice })
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(fs.existsSync(CRON_FILE)).toBe(true)
      choice = { routines: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:routines'])
      expect(fs.existsSync(CRON_FILE)).toBe(false)
      expect(fs.existsSync(stateFile())).toBe(false)
      expect(JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'routines.json'), 'utf8'))).toMatchObject({ v: 1, off: true })
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:routines')
      expect((await readRoutinesCopy({ includeDisabled: true }))!.length).toBe(8)
    } finally { await host.close() }
  })
})

describe('the leader starts a round when a routine changes', () => {
  it('every write of the routines store calls the kind watch (an add, a quiet check, an edit); after the stop it does not', async () => {
    // No bus event in here: the real writers tell only the browser sockets (server.ts onEvent).
    setReplica(false)
    let now = 70_000
    let n = 0
    const stop = ROUTINES_KIND.watch(() => { n++ })
    try {
      const service = await macCronService(() => now)
      const trig = await service.add(TRIGGER as never)
      expect(n).toBeGreaterThan(0)
      let seen = n
      now += 300_000
      await service.applyTriggerChecked({ type: 'trigger.checked', id: trig.id, atMs: now, outcome: 'quiet', reason: 'fire-false', durationMs: 5, nextRunAtMs: now + 300_000, consecutiveErrors: 0 } as never)
      expect(n).toBeGreaterThan(seen)
      seen = n
      await service.update(trig.id, { name: 'Acme watch, renamed' } as never)
      expect(n).toBeGreaterThan(seen)
      stop()
      seen = n
      await service.update(trig.id, { name: 'Acme watch, again' } as never)
      expect(n).toBe(seen)
      service.stop()
    } finally {
      stop()
      setReplica(true)
    }
  })
})

describe('a routine with something secret-shaped in it never reaches a host', () => {
  const TOKEN = 'acmePlantedTok0123456789abcdefXYZ'
  function planted(): Record<string, unknown>[] {
    const jobs = Array.from({ length: 8 }, (_, i) => job(i))
    jobs[2] = job(2, { check: { run: `curl -s -H "Authorization: Bearer ${TOKEN}" https://api.example.com/acme`, host: 'marina-box' } })
    jobs[5] = job(5, { executor: { type: 'claude-code', config: { instructions: 'go', api_key: 'whatever-it-holds' } } })
    return jobs
  }

  it('the Mac leaves it out, the rest are copied, and no copied file holds it', async () => {
    const jobs = planted()
    await writeMac(jobs, Object.fromEntries(jobs.map((j, i) => [j.id, state(i)])))
    const ids = (await kind.rows()).map((r) => r.id)
    expect(ids).toHaveLength(6)
    expect(ids).not.toContain(job(2).id)
    expect(ids).not.toContain(job(5).id)
    expect(await round()).toMatchObject({ action: 'synced', entries: 6 })
    const text = fs.readFileSync(CRON_FILE, 'utf8') + fs.readFileSync(stateFile(), 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('whatever-it-holds')
    // Nor did any step that crossed the link (the host would refuse such a row, which hides a leak from the files).
    expect(h.calls.length).toBeGreaterThan(0)
    for (const c of h.calls) expect([c.op, c.text.includes(TOKEN), c.text.includes('whatever-it-holds')]).toEqual([c.op, false, false])
  })

  it('an error that quoted a header leaves the routine out too', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job(i))
    const states = Object.fromEntries(jobs.map((j, i) => [j.id, state(i)]))
    states[job(4).id as string] = { ...state(4), lastStatus: 'error', lastError: `401 for Authorization: Bearer ${TOKEN}` }
    await writeMac(jobs, states)
    expect((await kind.rows()).map((r) => r.id)).not.toContain(job(4).id)
  })

  it('the host refuses one sent anyway (an older Mac), and drops what it held of it', async () => {
    await round()
    expect((await readRoutinesCopy({ includeDisabled: true }))!.some((j) => j.id === job(2).id)).toBe(true)
    const { followerStep } = await import('../../../../src/core/replication/kind-follower.js')
    const [bad] = planted().slice(2, 3)
    const { id, state: _s, updatedAtMs: _u, ...rest } = bad as Record<string, unknown>
    const r = await followerStep({ op: 'put', kind: 'routines', schemaVersion: 1, rows: [{ id, job: { id, ...rest }, status: {} }], last: true })
    expect(r).toMatchObject({ ok: true, stored: 0 })
    expect(fs.readFileSync(CRON_FILE, 'utf8')).not.toContain(TOKEN)
    expect((await readRoutinesCopy({ includeDisabled: true }))!.some((j) => j.id === job(2).id)).toBe(false)
  })
})
