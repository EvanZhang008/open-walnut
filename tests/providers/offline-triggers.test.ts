/**
 * The trigger ops a host answers while its Walnut does not (offline-triggers-v1):
 * trigger_list and trigger_test read what the daemon runs, and trigger_pause /
 * _resume / _delete take effect here at once and are journaled for the server.
 *
 * Why: the checks run on the host, yet every trigger call needed the server. On
 * clouddev the sessions' transcripts hold about 40 refusals of trigger_list,
 * trigger_test, trigger_delete and trigger_pause between 2026-10-05 and 10-13,
 * all while the Mac slept (a watch could not even be switched off). Real files
 * for the host's copy and journal; the daemon's trigger table is a fake.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type OfflineTrigger, type OfflineTriggerStatus } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'

const NOW = Date.parse('2026-10-13T21:00:00Z')
const HOME = '/fixture/walnut-home'
const OTHER = '/fixture/other-walnut'
const TASK = 'mwatch00-0c01'
const SID = 'eeeeeeee-1111-4111-8111-111111111111'

function trig(id: string, home = HOME, extra: Partial<OfflineTrigger> = {}): OfflineTrigger {
  return {
    id, name: `Watch ${id}`, everyMs: 300_000, check: { run: `bash ~/.open-walnut/triggers/${id}/check.sh`, cwd: '/work/repo', timeoutSeconds: 30 },
    deliver: { home, taskId: TASK, prompt: 'Look at it.' }, ...extra,
  }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup(opts: { triggers?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'offline-triggers-'))
  if (!opts.dir) dirs.push(dir)
  const status: OfflineTriggerStatus = { nextRunAtMs: NOW + 60_000, lastRunAtMs: NOW - 240_000, lastFireAtMs: NOW - 3_600_000, consecutiveErrors: 0, pendingFires: 1, running: false }
  const table = {
    defs: [trig('job-pr'), trig('job-ci'), trig('job-theirs', OTHER), { ...trig('job-plain'), deliver: undefined }] as OfflineTrigger[],
    changes: 0,
    tests: [] as Array<{ check: Record<string, unknown>; id?: string }>,
    testReply: { ok: true, exitCode: 0, parsed: { fire: true, items: [{ id: 'c1' }] }, wouldFire: true, newItemCount: 1, error: null } as Record<string, unknown>,
    testError: null as string | null,
  }
  const host = createOfflineHost({
    fs, path, dir, now: () => NOW, randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(), log: () => {},
    isLive: () => true, turnActive: () => false, streamOffset: () => undefined,
    deliver: async () => ({ ok: true }),
    ...(opts.triggers === false ? {} : {
      triggers: {
        armed: () => table.defs.map((def) => ({ def, status })),
        test: async (check, id) => {
          table.tests.push({ check, ...(id ? { id } : {}) })
          if (table.testError) throw new Error(table.testError)
          return table.testReply
        },
        changed: () => { table.changes++ },
        cwdOf: (sid) => (sid === SID ? '/work/session-cwd' : undefined),
      },
    }),
  })
  host.configure({
    v: 1, home: HOME, hash: 'h1', asOf: NOW - 120_000, host: 'devbox',
    sessions: [{ sid: SID, taskId: TASK, title: 'Watcher' }],
    tasks: [{ id: TASK, title: 'Watch the PR', phase: 'WAITING', project: 'Ops' }],
    requests: [],
  })
  const call = (name: string, args: Record<string, unknown> = {}) => host.handle(HOME, SID, 'tools.call', { name, args })
  return { host, table, call, dir }
}

function result(r: Awaited<ReturnType<ReturnType<typeof setup>['call']>>): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.result
}

describe('trigger_list on the host', () => {
  it('lists the triggers this host checks for this Walnut, with what the daemon knows of each', async () => {
    const { call } = setup()
    const r = result(await call('trigger_list'))
    expect(r.offline).toBe(true)
    expect(r.triggers.map((t: { id: string }) => t.id)).toEqual(['job-pr', 'job-ci'])
    expect(r.triggers[0]).toMatchObject({
      id: 'job-pr', name: 'Watch job-pr', every: '5m', host: 'devbox', enabled: true, state: 'armed',
      run: 'bash ~/.open-walnut/triggers/job-pr/check.sh', cwd: '/work/repo', task: TASK,
      nextCheckAt: new Date(NOW + 60_000).toISOString(), lastCheckAt: new Date(NOW - 240_000).toISOString(),
      consecutiveErrors: 0, unackedFires: 1,
    })
    expect(r.outcome).toContain('2 trigger(s)')
  })

  it('says what it cannot see, and needs the server where the daemon has no trigger table', async () => {
    const { call } = setup()
    expect(result(await call('trigger_list')).outcome).toContain('other hosts')
    const old = setup({ triggers: false })
    const r = await old.call('trigger_list')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('hub_unreachable')
  })
})

describe('trigger_pause / _resume / _delete on the host', () => {
  it('a pause takes effect here at once, is journaled with the def, and shows as paused', async () => {
    const { host, table, call } = setup()
    const r = result(await call('trigger_pause', { id: 'job-pr' }))
    expect(r).toMatchObject({ id: 'job-pr', state: 'paused', changed: true, queued: true })
    expect(table.changes).toBe(1)
    expect(host.triggerHolds().get('job-pr')).toMatchObject({ home: HOME, on: false, def: { id: 'job-pr' } })
    const records = host.drain(HOME).records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'op', op: 'trigger_pause', args: { id: 'job-pr' }, callerSid: SID, trigger: { id: 'job-pr', check: { run: expect.any(String) } } })
    // The gateway keeps answering here until the server has taken it.
    expect(host.pendingHandover(HOME)).toBe(true)
    // The daemon disarmed it: the list now has it from the hold, paused.
    table.defs = table.defs.filter((d) => d.id !== 'job-pr')
    const listed = result(await call('trigger_list')).triggers
    expect(listed.find((t: { id: string }) => t.id === 'job-pr')).toMatchObject({ state: 'paused', enabled: false, changedHere: 'paused' })
    // A second pause changes nothing and journals nothing.
    expect(result(await call('trigger_pause', { id: 'job-pr' }))).toMatchObject({ changed: false })
    expect(host.drain(HOME).records).toHaveLength(1)
    expect(table.changes).toBe(1)
  })

  it('a resume arms a trigger paused here again from the def it had', async () => {
    const { host, table, call } = setup()
    result(await call('trigger_pause', { id: 'job-pr' }))
    table.defs = table.defs.filter((d) => d.id !== 'job-pr')
    const r = result(await call('trigger_resume', { id: 'job-pr' }))
    expect(r).toMatchObject({ state: 'armed', changed: true })
    expect(r.outcome).toContain('every 5m')
    expect(host.triggerHolds().get('job-pr')).toMatchObject({ on: true, def: { id: 'job-pr' } })
    expect(host.drain(HOME).records.map((x) => (x as { op: string }).op)).toEqual(['trigger_pause', 'trigger_resume'])
    expect(table.changes).toBe(2)
    // Armed again (the daemon followed the hold): resuming again is a no-op.
    table.defs.push(trig('job-pr'))
    expect(result(await call('trigger_resume', { id: 'job-pr' }))).toMatchObject({ changed: false })
  })

  it('a resume of one paused before the server went away needs the server; one running is a no-op', async () => {
    const { call, table } = setup()
    const r = await call('trigger_resume', { id: 'job-paused-on-mac' })
    expect(!r.ok && r.error.code).toBe('hub_unreachable')
    expect(result(await call('trigger_resume', { id: 'job-ci' }))).toMatchObject({ changed: false, state: 'armed' })
    expect(table.changes).toBe(0)
  })

  it('a delete stops it here, drops it from the list, and cannot be resumed', async () => {
    const { host, table, call } = setup()
    expect(result(await call('trigger_delete', { id: 'job-ci' }))).toMatchObject({ state: 'deleted', changed: true })
    expect(host.triggerHolds().get('job-ci')).toMatchObject({ on: false, deleted: true })
    table.defs = table.defs.filter((d) => d.id !== 'job-ci')
    expect(result(await call('trigger_list')).triggers.map((t: { id: string }) => t.id)).toEqual(['job-pr'])
    const again = await call('trigger_resume', { id: 'job-ci' })
    expect(!again.ok && again.error.code).toBe('not_found')
    expect(result(await call('trigger_delete', { id: 'job-ci' }))).toMatchObject({ changed: false })
    // A pause after a delete is not a resurrection either.
    expect(result(await call('trigger_pause', { id: 'job-ci' }))).toMatchObject({ changed: false })
  })

  it('never touches a trigger of another Walnut, one with no task, or one it does not run', async () => {
    const { host, table, call } = setup()
    for (const id of ['job-theirs', 'job-plain', 'job-nowhere']) {
      const r = await call('trigger_pause', { id })
      expect(!r.ok && r.error.code).toBe('hub_unreachable')
    }
    const missing = await call('trigger_delete', {})
    expect(!missing.ok && missing.error.code).toBe('bad_request')
    expect(table.changes).toBe(0)
    expect(host.drain(HOME).records).toEqual([])
  })

  it('the holds outlive a daemon restart, and end when the server has taken them', async () => {
    const first = setup()
    result(await first.call('trigger_pause', { id: 'job-pr' }))
    result(await first.call('trigger_delete', { id: 'job-ci' }))
    // A restarted daemon reads the journal back: the pause still holds at boot.
    const again = setup({ dir: first.dir })
    expect([...again.host.triggerHolds().keys()].sort()).toEqual(['job-ci', 'job-pr'])
    const { records } = again.host.drain(HOME)
    again.host.ack(HOME, Math.max(...records.map((r) => r.seq)))
    expect(again.host.triggerHolds().size).toBe(0)
    expect(again.host.pendingHandover(HOME)).toBe(false)
  })
})

describe('trigger_test on the host', () => {
  it('runs the check here in the caller\'s folder, and says whether it would fire', async () => {
    const { table, call } = setup()
    const r = result(await call('trigger_test', { run: 'bash check.sh', timeoutSeconds: 20, id: 'job-pr' }))
    expect(table.tests).toEqual([{ check: { run: 'bash check.sh', cwd: '/work/session-cwd', timeoutSeconds: 20 }, id: 'job-pr' }])
    expect(r.outcome).toContain('WOULD fire now (1 new item(s))')
    expect(r.result).toEqual(table.testReply)
    expect(r.next).toContain('needs the Walnut server')
    // A cwd given wins; an id of another Walnut's trigger is not measured against.
    result(await call('trigger_test', { run: 'x', cwd: '/tmp/elsewhere', id: 'job-theirs' }))
    expect(table.tests[1]).toEqual({ check: { run: 'x', cwd: '/tmp/elsewhere' } })
  })

  it('reports a script that does not parse, and the daemon\'s refusal', async () => {
    const { table, call } = setup()
    table.testReply = { ok: false, parsed: null, error: 'no JSON on the last line of stdout', wouldFire: false, newItemCount: 0 }
    expect(result(await call('trigger_test', { run: 'echo hi' })).outcome).toContain('did not produce a usable answer: no JSON')
    table.testError = 'triggers.test: too many concurrent tests (max 4)'
    const busy = await call('trigger_test', { run: 'echo hi' })
    expect(!busy.ok && busy.error).toMatchObject({ code: 'busy', message: 'too many concurrent tests (max 4)' })
    const empty = await call('trigger_test', { run: '  ' })
    expect(!empty.ok && empty.error.code).toBe('bad_request')
  })

  it('a check on another host needs the server; this host by name is fine', async () => {
    const { table, call } = setup()
    const r = await call('trigger_test', { run: 'x', host: 'otherbox' })
    expect(!r.ok && r.error.code).toBe('hub_unreachable')
    result(await call('trigger_test', { run: 'x', host: 'devbox' }))
    expect(table.tests).toHaveLength(1)
  })
})

describe('what the host says it answers', () => {
  it('lists the trigger ops and walnut_status, and walnut_status says the server is away', async () => {
    const { host, call } = setup()
    const listed = await host.handle(HOME, SID, 'tools.list', {})
    const names = (listed.ok ? (listed.result.ops as Array<{ name: string }>) : []).map((o) => o.name)
    expect(names).toEqual(expect.arrayContaining(['trigger_list', 'trigger_test', 'trigger_pause', 'trigger_resume', 'trigger_delete', 'walnut_status']))
    const status = result(await call('walnut_status'))
    expect(status).toMatchObject({ mode: 'HOST_OFFLINE', host: 'devbox', queuedForServer: 0 })
    expect(status.answersHere).toContain('trigger_pause')
    expect(host.answersRead('trigger_list', HOME)).toBe(true)
    expect(host.answersRead('trigger_pause', HOME)).toBe(false)
    const old = setup({ triggers: false })
    const oldList = await old.host.handle(HOME, SID, 'tools.list', {})
    expect((oldList.ok ? (oldList.result.ops as Array<{ name: string }>) : []).map((o) => o.name)).not.toContain('trigger_list')
  })
})
