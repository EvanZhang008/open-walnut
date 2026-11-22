/**
 * trigger_update while the Mac is away, a host's own session call (replica/away-trigger-update.ts):
 * the REAL op (src/ops/triggers.ts) runs against this host's routes as it does on the follower
 * (its GET and PATCH land in away-triggers.ts), the change is merged onto the copy's whole row with
 * the Mac's own merge, and the daemon is sent the fields that changed (the Mac replays exactly
 * those), the changed def and whether it ran. What only the Mac decides is refused for those fields
 * alone, by name and with why; nothing is sent then. A second change reads the first one back
 * (followerTriggers `changes`), so the def armed for it keeps both.
 */
import { describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { awayTriggers, type AwayTriggersDeps, type HereTrigger } from '../../src/replica/away-triggers.js'
import { LEADER_ONLY_TRIGGER_FIELDS, leaderOnlyTriggerFields, withChanges } from '../../src/replica/away-trigger-update.js'
import { buildTriggerUpdatePatch, triggerUpdateArgsOf, TRIGGER_UPDATE_FIELDS } from '../../src/core/routines/trigger-update-patch.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import { OFFLINE_HEADER } from '../../src/replica/dispatch.js'
import type { WriteActor } from '../../src/replica/write-port.js'
import { getOp } from '../../src/ops/index.js'

const SESSION: WriteActor = { kind: 'session', sid: 'aaaaaaaa-1111-4111-8111-111111111111' }
const TASK = 'mtask-lead-0001'
const ROW = {
  id: 'mcopy-watch-01', name: 'Pipeline watch', enabled: true, description: 'Checks the pipeline every 5 minutes.',
  schedule: { kind: 'every', everyMs: 300_000, anchorMs: 1_000 },
  check: { run: 'bash check.sh', host: 'devbox', cwd: '/work', timeoutSeconds: 30, maxFiresPerDay: 288 },
  executor: { type: 'session', config: { target: TASK, prompt: 'Look at the pipeline.', instructions: 'Look at the pipeline.' } },
  sessionTarget: 'isolated', payload: { kind: 'agentTurn', message: 'Look at the pipeline.' }, state: { lastRunAtMs: 2_000 },
}
const PAUSED = { ...ROW, id: 'mcopy-paused-1', enabled: false }
const OTHER_HOST = { ...ROW, id: 'mcopy-other-1', check: { ...ROW.check, host: 'other-box' } }
const ROUTINE = { id: 'mcopy-clock-01', name: 'Nightly reflection', enabled: true, schedule: { kind: 'cron', expr: '0 3 * * *' }, executor: { type: 'session', config: { target: TASK, prompt: 'Reflect.' } }, state: {} }
const DEF = { id: ROW.id, name: ROW.name, everyMs: 300_000, check: { run: 'bash check.sh', cwd: '/work', timeoutSeconds: 30 }, deliver: { taskId: TASK, prompt: 'Look at the pipeline.' } }

interface Sent { op: string; args: Record<string, unknown> }

function harness(here: HereTrigger[] = [{ id: ROW.id, state: 'armed', def: DEF, status: { nextRunAtMs: 9_000 } }], reply?: ReplicaWriteResult) {
  const sent: Sent[] = []
  const h = awayTriggers({
    actorOf: () => SESSION, hostKey: 'devbox', capabilities: () => ['follower-triggers-v1'],
    request: async (cmd, params) => {
      if (cmd !== 'follower.triggers') throw new Error(`unexpected ${cmd}`)
      return { ok: true, host: 'devbox', triggers: typeof params.triggerId === 'string' ? here.filter((t) => t.id === params.triggerId) : here }
    },
    findTask: async () => null, session: async () => ({ taskId: TASK, cwd: '/work' }),
    copyJobs: async () => [ROW, PAUSED, OTHER_HOST, ROUTINE].map((j) => structuredClone(j)) as unknown as Array<Record<string, unknown>>,
    label: (i) => String(i.name ?? ''), now: () => 5_000, log: () => {},
  } satisfies AwayTriggersDeps)
  const write = (opId: string): ReplicaWrite => ({
    opId, away: 'host-write', raw: Buffer.from(''),
    submit: async (op, args) => {
      sent.push({ op, args })
      return reply ?? { kind: 'applied', reply: { ok: true, triggerId: args.id, name: 'Pipeline watch', state: 'armed', changed: true, queued: true, offline: true, outcome: 'Updated "Pipeline watch" in place on this host.', next: 'Nothing else is required. Do not repeat the call.' } }
    },
    call: async () => ({ kind: 'refused', code: 'internal', message: 'not used' }),
  })
  /** One request through the handler, as dispatch.ts hands it on (offline header, the write port). */
  const route = (method: string, p: string, body?: unknown): Promise<{ status: number; body: any } | 'next'> => new Promise((resolve) => {
    const headers: Record<string, string> = { [OFFLINE_HEADER]: '1' }
    let status = 0
    const res = {
      headersSent: false, getHeader: (k: string) => headers[k], setHeader: (k: string, v: string) => { headers[k] = v },
      status(s: number) { status = s; return this }, json(b: unknown) { resolve({ status, body: b }); return this },
    } as unknown as Response
    const req = { method, path: p, headers: {}, query: {}, body: body ?? {}, ...(method === 'GET' ? {} : { replicaWrite: write(`op-${sent.length}`) }) } as unknown as Request
    h(req, res, () => resolve('next'))
  })
  /** The op's own `call` on this follower: its routes under /v1. */
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await route(method, `/v1${p}`, body)
    if (r === 'next') return { job: [ROW, PAUSED, OTHER_HOST, ROUTINE].find((j) => p.endsWith(j.id)) }
    if (r.status >= 400) throw Object.assign(new Error(`${r.body.error.code}: ${r.body.error.message}`), { body: r.body })
    return r.body
  }
  const update = (args: Record<string, unknown>) => getOp('trigger_update')!.handler!(args, call as never) as Promise<Record<string, unknown>>
  return { route, update, sent }
}

describe('trigger_update on the follower', () => {
  it('a time limit change is merged onto the whole row: the daemon gets only that field to replay, the def as it runs now, and on', async () => {
    const { update, sent } = harness()
    const out = await update({ id: ROW.id, timeoutSeconds: 120 })
    expect(out).toMatchObject({ offline: true, queued: true })
    expect(sent).toEqual([{
      op: 'trigger_update',
      args: {
        id: ROW.id, args: { id: ROW.id, timeoutSeconds: 120 }, on: true,
        def: expect.objectContaining({ id: ROW.id, name: 'Pipeline watch', everyMs: 300_000, check: { run: 'bash check.sh', cwd: '/work', timeoutSeconds: 120 }, limits: { maxFiresPerDay: 288 }, deliver: expect.objectContaining({ taskId: TASK, prompt: 'Look at the pipeline.' }) }),
      },
    }])
  })

  it('every field trigger_update changes rides as its own argument, the rest of the row untouched', async () => {
    const { update, sent } = harness()
    await update({ id: ROW.id, every: '10m', prompt: 'Look again.', description: 'Checks it every 10 minutes.', name: 'Pipe watch', run: 'bash check2.sh', cwd: '', maxFiresPerDay: 0, watches: 'own' })
    expect(sent[0]!.args.args).toEqual({
      id: ROW.id, every: 600_000, prompt: 'Look again.', description: 'Checks it every 10 minutes.', name: 'Pipe watch', run: 'bash check2.sh', cwd: '', maxFiresPerDay: 0, watches: 'own',
    })
    expect(sent[0]!.args.def).toMatchObject({ name: 'Pipe watch', everyMs: 600_000, check: { run: 'bash check2.sh', timeoutSeconds: 30 }, deliver: { prompt: 'Look again.' } })
    expect((sent[0]!.args.def as { check: Record<string, unknown> }).check.cwd).toBeUndefined()
  })

  it('a trigger paused on the Mac and not armed here is changed from the copy\'s row and stays paused', async () => {
    const { update, sent } = harness([])
    await update({ id: PAUSED.id, timeoutSeconds: 60 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args).toMatchObject({ id: PAUSED.id, args: { id: PAUSED.id, timeoutSeconds: 60 }, on: false })
  })

  it('a second change reads the first back, so the def armed for it keeps both', async () => {
    const { update, sent } = harness([{ id: ROW.id, state: 'armed', def: { ...DEF, check: { ...DEF.check, timeoutSeconds: 120 } }, changes: { timeoutSeconds: 120, description: 'Changed here.' } }])
    await update({ id: ROW.id, every: '1m' })
    expect(sent[0]!.args.args).toEqual({ id: ROW.id, every: 60_000 })
    expect(sent[0]!.args.def).toMatchObject({ everyMs: 60_000, check: { timeoutSeconds: 120 } })
  })

  it('the list and the read show what changed here, by the Mac\'s own merge', async () => {
    const { route } = harness([{ id: ROW.id, state: 'armed', def: DEF, changes: { timeoutSeconds: 120, description: 'Changed here.', watches: 'own' } }])
    const one = await route('GET', `/v1/routines/${ROW.id}`)
    expect(one !== 'next' && one.body.job).toMatchObject({ description: 'Changed here.', ownWork: true, check: { timeoutSeconds: 120, run: 'bash check.sh', host: 'devbox' }, enabled: true })
    const list = await route('GET', '/v1/routines')
    expect(list !== 'next' && list.body.jobs.find((j: { id: string }) => j.id === ROW.id)).toMatchObject({ description: 'Changed here.' })
  })

  it('the same settings again change nothing and send nothing', async () => {
    const { update, sent } = harness()
    const out = await update({ id: ROW.id, timeoutSeconds: 30 })
    expect(out).toMatchObject({ offline: true, changed: false })
    expect(String(out.outcome)).toMatch(/already has these settings/)
    expect(sent).toEqual([])
  })

  it('the op\'s own refusals hold here as on the Mac: a blank name, an interval under 10 s', async () => {
    const { update, sent } = harness()
    await expect(update({ id: ROW.id, name: '  ' })).rejects.toThrow(/name cannot be blank/)
    await expect(update({ id: ROW.id, every: '5s' })).rejects.toThrow(/bad_request: a check may not poll faster than every 10s/)
    expect(sent).toEqual([])
  })
})

describe('what only the Mac decides', () => {
  it('names each field and why, and sends nothing: a host move, a template, the task it wakes, a prompt over 32 KB, a switch with a change', async () => {
    const { route, update, sent } = harness()
    const patch = (body: Record<string, unknown>) => route('PATCH', `/v1/routines/${ROW.id}`, body)
    const moved = await patch({ check: { ...ROW.check, host: 'other-box' } })
    expect(moved).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'fields', fields: ['host'], reasons: { host: LEADER_ONLY_TRIGGER_FIELDS.host } } } })
    expect(await patch({ check: { ...ROW.check, template: { id: 'acme:mail' } } })).toMatchObject({ body: { error: { why: 'fields', fields: ['template'] } } })
    expect(await patch({ executor: { type: 'session', config: { target: 'mtask-other-02', prompt: 'x' } } })).toMatchObject({ body: { error: { fields: ['session'] } } })
    expect(await patch({ enabled: false, name: 'Off' })).toMatchObject({ body: { error: { fields: ['enabled'] } } })
    const big = await update({ id: ROW.id, prompt: 'p'.repeat(33 * 1024), name: 'Big' }).catch((e: { body?: unknown }) => e.body)
    expect(big).toMatchObject({ error: { code: 'needs_leader', why: 'fields', fields: ['prompt'] } })
    expect(String((big as { error: { message: string } }).error.message)).toMatch(/^prompt \(this host delivers the fires itself/)
    expect(sent).toEqual([])
  })

  it('a trigger whose check runs on another host, a scheduled routine, one not in the copy: the whole change needs the Mac', async () => {
    const { route, update, sent } = harness()
    expect(await update({ id: OTHER_HOST.id, timeoutSeconds: 60 }).catch((e: { body?: unknown }) => e.body)).toMatchObject({ error: { code: 'needs_leader', why: 'routine_writes_need_mac' } })
    expect(await update({ id: ROUTINE.id, prompt: 'Reflect more.' }).catch((e: { body?: unknown }) => e.body)).toMatchObject({ error: { code: 'needs_leader', why: 'routine_writes_need_mac' } })
    expect(await route('PATCH', '/v1/routines/mnope-0000-01', { name: 'x' })).toMatchObject({ status: 503, body: { error: { why: 'routine_writes_need_mac' } } })
    expect(sent).toEqual([])
  })

  it('a trigger deleted here is not found; an older daemon\'s refusal is passed on', async () => {
    const gone = harness([{ id: ROW.id, state: 'deleted', def: DEF }])
    expect(await gone.route('PATCH', `/v1/routines/${ROW.id}`, { name: 'x' })).toMatchObject({ status: 404 })
    const old = harness(undefined, { kind: 'refused', code: 'needs_leader', message: 'trigger_update needs your Mac', detail: { why: 'not_queueable' } })
    expect(await old.route('PATCH', `/v1/routines/${ROW.id}`, { name: 'Renamed' })).toMatchObject({ status: 503, body: { error: { code: 'needs_leader' } } })
  })

  it('leaderOnlyTriggerFields: trigger_update\'s own patch has none', () => {
    const { patch } = buildTriggerUpdatePatch(ROW, { id: ROW.id, run: 'bash x.sh', prompt: 'y', every: '1m', watches: 'outside' })
    expect(leaderOnlyTriggerFields(ROW, patch)).toEqual([])
  })
})

describe('the patch and its arguments (trigger-update-patch.ts)', () => {
  it('each field trigger_update changes comes back as the same argument after the Mac\'s merge', () => {
    const args = { every: 120_000, timeoutSeconds: 90, maxFiresPerDay: 5, prompt: 'New words.', description: 'New description.', name: 'New name', run: 'bash new.sh', cwd: '/elsewhere', watches: 'own' }
    expect(Object.keys(args).sort()).toEqual([...TRIGGER_UPDATE_FIELDS].sort())
    for (const [k, v] of Object.entries(args)) {
      const after = withChanges(structuredClone(ROW), { [k]: v })
      expect(triggerUpdateArgsOf(ROW, after), k).toEqual({ [k]: v })
    }
  })
})
