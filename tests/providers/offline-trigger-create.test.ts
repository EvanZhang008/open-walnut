/**
 * trigger_create while the Walnut server is away (offline-host-core.ts opTriggerCreate):
 * the host gives the routine its id, arms the check at once (a `trigger_create` op
 * record is a hold that is on, with its def) and journals what the server needs to
 * store it under the same id.
 *
 * Why: on 2026-11-03 a lead had to send a review request at 9:07 the next morning
 * while the Mac's server was down; trigger_create needed the server, so it wrote the
 * to-do into a file and waited. Real files for the host's copy and journal; the
 * daemon's trigger table is a fake with the daemon's own def check.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type OfflineTrigger } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { validateTriggerDef } from '../../src/providers/trigger-check-core.js'
import { HOST_TRIGGER_ID_RE } from '../../src/core/routines/trigger-api.js'

const NOW = Date.parse('2026-11-04T05:00:00Z')
const HOME = '/fixture/walnut-home'
const TASK = 'mlead000-0c01'
const OTHER_TASK = 'mpeer000-0c02'
const DONE_TASK = 'mdone000-0c03'
const SID = 'eeeeeeee-3333-4333-8333-333333333333'
const BASE = { run: 'bash ~/.open-walnut/triggers/review/check.sh', every: '5m', prompt: 'Send the review request now.', description: 'Checks the clock every 5 minutes; at 9:07 the session sends the review request.' }

/** The v2 kinds a current Mac drains (it names them in offline.drain). */
const KINDS = ['task-fields']

const dirs: string[] = []
const journals: Array<{ close: () => void }> = []
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup(opts: { drains?: string[] | null; validate?: boolean | 'refuse'; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'offline-trigger-create-'))
  if (!opts.dir) dirs.push(dir)
  const table = { armed: [] as OfflineTrigger[], changes: 0 }
  const drains = opts.drains === undefined ? ['task-fields', 'trigger-create'] : opts.drains
  const host = createOfflineHost({
    fs, path, dir, now: () => NOW, randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(), log: () => {},
    isLive: () => true, turnActive: () => false, streamOffset: () => undefined,
    deliver: async () => ({ ok: true }),
    drainsOf: () => drains,
    triggers: {
      // What the daemon arms: the holds that are on (effectiveTriggerDefs in the twins).
      armed: () => table.armed.map((def) => ({ home: HOME, def, status: { nextRunAtMs: NOW + 5_000 } })),
      test: async () => ({}),
      changed: () => {
        table.changes++
        table.armed = [...host.triggerHolds().values()].filter((h) => h.on && h.def).map((h) => h.def!)
      },
      cwdOf: (sid) => (sid === SID ? '/work/session-cwd' : undefined),
      ...(opts.validate === false ? {} : {
        validate: (def: OfflineTrigger) => {
          if (opts.validate === 'refuse') return { ok: false as const, error: `trigger ${def.id}: refused by this daemon` }
          const r = validateTriggerDef(def)
          return r.ok ? { ok: true as const } : { ok: false as const, error: r.error }
        },
      }),
    },
  })
  journals.push(host.journal)
  host.configure({
    v: 1, home: HOME, hash: 'h1', asOf: NOW - 60_000, host: 'devbox',
    sessions: [{ sid: SID, taskId: TASK, title: 'Review lead' }],
    tasks: [
      { id: TASK, title: 'Get the review in', phase: 'IN_PROGRESS', project: 'Ops', updated_at: '2026-11-04T04:00:00.000Z' },
      { id: OTHER_TASK, title: 'Peer', phase: 'IN_PROGRESS', project: 'Ops' },
      { id: DONE_TASK, title: 'Done', phase: 'COMPLETE', project: 'Ops' },
    ],
    requests: [],
  })
  const call = (name: string, args: Record<string, unknown> = {}) => host.handle(HOME, SID, 'tools.call', { name, args })
  return { host, table, call, dir }
}

function result(r: Awaited<ReturnType<ReturnType<typeof setup>['call']>>): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.result
}

describe('trigger_create on a host while its Walnut is away', () => {
  it('arms the check here at once under an id of its own, and journals what the server stores', async () => {
    const { host, table, call } = setup()
    const r = result(await call('trigger_create', { ...BASE, maxFiresPerDay: 0, timeoutSeconds: 900 }))
    expect(r).toMatchObject({ queued: true, offline: true, host: 'devbox' })
    expect(r.id).toMatch(HOST_TRIGGER_ID_RE)
    expect(r.outcome).toContain('every 5m')
    expect(r.next).toContain('Do not create it again')
    // Armed here now: the daemon followed the hold.
    expect(table.changes).toBe(1)
    expect(table.armed.map((d) => d.id)).toEqual([r.id])
    expect(host.triggerHolds().get(r.id)).toMatchObject({ home: HOME, on: true, created: true })
    const records = host.drain(HOME, KINDS).records as Array<Record<string, any>>
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'op', op: 'trigger_create', callerSid: SID,
      // Decided here, all of it: the server stores what this host runs.
      args: {
        id: r.id, run: BASE.run, prompt: BASE.prompt, description: BASE.description, name: BASE.prompt,
        every: 300_000, session: TASK, host: 'devbox', cwd: '/work/session-cwd', timeoutSeconds: 300, maxFiresPerDay: 0,
      },
      trigger: {
        id: r.id, everyMs: 300_000, check: { run: BASE.run, cwd: '/work/session-cwd', timeoutSeconds: 300 },
        limits: { maxFiresPerDay: 1_000_000 }, deliver: { home: HOME, taskId: TASK, prompt: BASE.prompt },
      },
    })
    expect(records[0].args.wait).toBeUndefined()
    // The list says it runs here and is not the server's yet.
    const listed = result(await call('trigger_list')).triggers
    expect(listed).toEqual([expect.objectContaining({ id: r.id, state: 'armed', changedHere: 'created', queued: true })])
    expect(host.pendingHandover(HOME)).toBe(true)
  })

  it('a host id never looks like one the server gives', () => {
    expect('mhk2x9ab-1f2e').not.toMatch(HOST_TRIGGER_ID_RE)
    expect('mhk2x9ab-1f2e3d4c').toMatch(HOST_TRIGGER_ID_RE)
  })

  it('wait:true queues the park after the trigger, with the clock counted from now', async () => {
    const { host, call } = setup()
    const r = result(await call('trigger_create', { ...BASE, wait: true, wait_until: '2h' }))
    expect(r.outcome).toContain('queued to wait')
    const records = host.drain(HOME, KINDS).records as Array<Record<string, any>>
    expect(records.map((x) => x.kind)).toEqual(['op', 'task-fields'])
    expect(records[1]).toMatchObject({ taskId: TASK, fields: { phase: { value: 'WAITING' }, wait_until: { value: new Date(NOW + 2 * 3_600_000).toISOString() } } })
    expect(records[1].seq).toBeGreaterThan(records[0].seq)
    // The copy reads it as parked, as the server will.
    expect(result(await call('task_get', { id: TASK })).task.phase).toBe('WAITING')
  })

  it('wait:true with no clock parks for 4 hours from now; a watch of the user never parks', async () => {
    const a = setup()
    result(await a.call('trigger_create', { ...BASE, wait: true }))
    const parked = (a.host.drain(HOME, KINDS).records as Array<Record<string, any>>)[1]
    expect(parked.fields.wait_until.value).toBe(new Date(NOW + 4 * 3_600_000).toISOString())
    const b = setup()
    const r = result(await b.call('trigger_create', { ...BASE, wait: true, watches: 'ask' }))
    expect(r.outcome).toContain('watches the user')
    const records = b.host.drain(HOME, KINDS).records as Array<Record<string, any>>
    expect(records.map((x) => x.kind)).toEqual(['op'])
    expect(records[0].args.watches).toBe('ask')
  })

  it('a trigger for another task here goes to that task; pause and delete after it hold', async () => {
    const { host, table, call } = setup()
    const r = result(await call('trigger_create', { ...BASE, session: OTHER_TASK }))
    expect(r.outcome).toContain('not your task')
    expect(table.armed[0].deliver).toMatchObject({ taskId: OTHER_TASK })
    expect(result(await call('trigger_pause', { id: r.id }))).toMatchObject({ state: 'paused', changed: true })
    expect(host.triggerHolds().get(r.id)).toMatchObject({ on: false, created: true })
    expect(table.armed).toEqual([])
    expect(result(await call('trigger_delete', { id: r.id }))).toMatchObject({ state: 'deleted', changed: true })
    expect((host.drain(HOME, KINDS).records as Array<Record<string, any>>).map((x) => x.op)).toEqual(['trigger_create', 'trigger_pause', 'trigger_delete'])
  })

  it('refuses what the server would refuse, journaling nothing', async () => {
    const { host, table, call } = setup()
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...BASE, run: ' ' }, 'run is required'],
      [{ ...BASE, prompt: '' }, 'prompt is required'],
      [{ ...BASE, description: undefined }, 'description is required'],
      [{ ...BASE, description: 'x'.repeat(601) }, 'the limit is 600'],
      [{ ...BASE, every: '5s' }, 'at least 10s'],
      [{ ...BASE, every: 'soon' }, 'every is required'],
      [{ ...BASE, wait: 'yes' }, 'wait must be true or false'],
      [{ ...BASE, wait_until: 'tomorrowish' }, 'neither an ISO datetime'],
      [{ ...BASE, watches: 'everything' }, 'watches must be'],
      [{ ...BASE, maxFiresPerDay: -1 }, 'maxFiresPerDay'],
      [{ ...BASE, session: DONE_TASK }, 'is complete'],
      [{ ...BASE, id: 'mhk2x9ab-1f2e3d4c' }, 'takes no "id"'],
    ]
    for (const [args, words] of bad) {
      const r = await call('trigger_create', args)
      expect(!r.ok && r.error.code, words).toBe('bad_request')
      expect(!r.ok && r.error.message, words).toContain(words)
    }
    expect(host.drain(HOME, KINDS).records).toEqual([])
    expect(table.changes).toBe(0)
  })

  it('what only the server can do still needs it', async () => {
    const { host, call } = setup()
    for (const args of [
      { ...BASE, template: 'slack:channel-message', params: { channel: '#ops' } },
      { ...BASE, host: 'otherbox' },
      { ...BASE, session: 'mnowhere-0000' },
    ]) {
      const r = await call('trigger_create', args)
      expect(!r.ok && r.error.code, JSON.stringify(args)).toBe('hub_unreachable')
    }
    // This host by name, or the Mac's own name for it, is fine.
    result(await call('trigger_create', { ...BASE, host: 'devbox' }))
    expect(host.drain(HOME, KINDS).records).toHaveLength(1)
  })

  it('an older Mac (no trigger-create in its drains), or a daemon with no def check, keeps it on the server', async () => {
    for (const s of [setup({ drains: null }), setup({ drains: ['task-fields', 'letter'] }), setup({ validate: false })]) {
      const r = await s.call('trigger_create', BASE)
      expect(!r.ok && r.error.code).toBe('hub_unreachable')
      const listed = await s.host.handle(HOME, SID, 'tools.list', {})
      expect((listed.ok ? (listed.result.ops as Array<{ name: string }>) : []).map((o) => o.name)).not.toContain('trigger_create')
      expect(result(await s.call('trigger_list')).next).toContain('needs the Walnut server')
    }
    const now = setup()
    const listed = await now.host.handle(HOME, SID, 'tools.list', {})
    expect((listed.ok ? (listed.result.ops as Array<{ name: string }>) : []).map((o) => o.name)).toContain('trigger_create')
    expect(result(await now.call('trigger_list')).next).toContain('trigger_create arms one here now')
  })

  it('a def the daemon would not arm is refused at once', async () => {
    const { host, call } = setup({ validate: 'refuse' })
    const r = await call('trigger_create', BASE)
    expect(!r.ok && r.error).toMatchObject({ code: 'bad_request', message: expect.stringContaining('refused by this daemon') })
    expect(host.drain(HOME, KINDS).records).toEqual([])
  })

  it('the created trigger outlives a daemon restart and stops being held once the server took it', async () => {
    const first = setup()
    const r = result(await first.call('trigger_create', BASE))
    const again = setup({ dir: first.dir })
    expect(again.host.triggerHolds().get(r.id)).toMatchObject({ on: true, created: true, def: { id: r.id } })
    const { records } = again.host.drain(HOME, KINDS)
    again.host.ack(HOME, { seqs: records.map((x) => x.seq) })
    expect(again.host.triggerHolds().size).toBe(0)
  })
})

describe('a park queued while the server is away keeps the clock its caller meant', () => {
  it('for a Mac that stores the value as written (journal v2): a duration becomes a time here; a past time is refused', async () => {
    const { host, call } = setup()
    result(await call('task_update', { id: TASK, phase: 'WAITING', wait_until: '6h' }))
    result(await call('task_update', { id: OTHER_TASK, wait_until: '' }))
    const at = '2026-11-05T16:07:00.000Z'
    result(await call('task_update', { id: DONE_TASK, wait_until: at }))
    const past = await call('task_update', { id: TASK, wait_until: '2026-11-01T00:00:00Z' })
    expect(!past.ok && past.error.message).toContain('not in the future')
    const byTask = new Map((host.drain(HOME, KINDS).records as Array<Record<string, any>>).map((x) => [x.taskId, x.fields.wait_until?.value]))
    expect(byTask.get(TASK)).toBe(new Date(NOW + 6 * 3_600_000).toISOString())
    expect(byTask.get(OTHER_TASK)).toBe('')
    expect(byTask.get(DONE_TASK)).toBe(at)
  })

  it('for a Mac that replays v1 records through task_update, the value goes as written', async () => {
    const { host, call } = setup({ drains: null })
    result(await call('task_update', { id: TASK, phase: 'WAITING', wait_until: '90m' }))
    const [rec] = host.drain(HOME, KINDS).records as Array<Record<string, any>>
    expect(rec).toMatchObject({ kind: 'op', op: 'task_update', args: { wait_until: '90m' } })
  })
})

describe('every trigger write a session makes has an answer on its host', () => {
  it('each non-readonly trigger_* op is one the host answers while the server is away', async () => {
    await import('../../src/ops/triggers.js')
    const { listOps } = await import('../../src/ops/registry.js')
    const writes = listOps().filter((op) => op.name.startsWith('trigger_') && !op.tags.readonly).map((op) => op.name)
    expect(writes.length).toBeGreaterThan(0)
    const { host } = setup()
    const listed = await host.handle(HOME, SID, 'tools.list', {})
    const answered = new Set((listed.ok ? (listed.result.ops as Array<{ name: string }>) : []).map((o) => o.name))
    // A new trigger write op the host does not answer is a session left without its trigger
    // while the Mac sleeps (2026-11-03): answer it in offline-host-core.ts, or list it here with why.
    const serverOnly: Record<string, string> = {}
    expect(writes.filter((n) => !answered.has(n) && !serverOnly[n])).toEqual([])
  })
})
