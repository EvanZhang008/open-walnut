/**
 * This host's own agent_memory_write, human_inbox_send and trigger calls while the Mac is away
 * (replica/away-calls.ts, away-triggers.ts; task B): decided here with the copies and the Mac's
 * rules, sent to the daemon as one `follower.op` (whose records offline-follower-calls.test.ts
 * holds equal to the daemon's own), the daemon's answer passed on for the op to print. A phone
 * or a browser keeps its needs_leader answer (route-table.ts: these rows have `localAway` only).
 */
import { describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { awayCalls, callIdOfWrite, type AwayCallsDeps } from '../../src/replica/away-calls.js'
import { awayTriggers, mergeHereTriggers, type AwayTriggersDeps, type HereTrigger } from '../../src/replica/away-triggers.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import { OFFLINE_HEADER } from '../../src/replica/dispatch.js'
import type { WriteActor } from '../../src/replica/write-port.js'
import { classify } from '../../src/replica/route-table.js'
import { writeOpId } from '../../src/lib/op-call-id.js'
import { createLetterCheck } from '../../src/core/human-inbox/letter-check.js'
import { awayAnswer } from '../../src/ops/outcome.js'

const SESSION: WriteActor = { kind: 'session', sid: 'aaaaaaaa-1111-4111-8111-111111111111' }
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme', job: 'sync' }
const TASKS: Record<string, Record<string, unknown>> = {
  'mtask-lead-0001': { id: 'mtask-lead-0001', title: 'Lead', phase: 'IN_PROGRESS', project: 'Acme' },
  'mtask-done-0002': { id: 'mtask-done-0002', title: 'Done work', phase: 'COMPLETE', project: 'Acme' },
}
const findTask = async (ref: string) => {
  if (ref === 'mtask') throw new Error('Ambiguous ID prefix "mtask"')
  const hit = Object.values(TASKS).find((t) => t.id === ref || String(t.id).startsWith(ref))
  return hit ? { ...hit, id: String(hit.id) } : null
}

interface Sent { op: string; args: Record<string, unknown>; base?: unknown; actor?: WriteActor }

function run(handler: (req: Request, res: Response, next: () => void) => void, req: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: any } | 'next'> {
  return new Promise((resolve) => {
    const out: Record<string, string> = { ...headers }
    let status = 0
    const res = {
      headersSent: false,
      getHeader: (k: string) => out[k],
      setHeader: (k: string, v: string) => { out[k] = v },
      status(s: number) { status = s; return this },
      json(b: unknown) { resolve({ status, body: b }); return this },
    } as unknown as Response
    handler({ headers: {}, query: {}, ...req } as unknown as Request, res, () => resolve('next'))
  })
}

function write(opId: string, sent: Sent[], reply: ReplicaWriteResult = { kind: 'applied', reply: { queued: true, offline: true, outcome: 'Saved on this host.', next: 'Nothing else is required.', appendMs: 1, appendCpuMs: 1 } }, raw = ''): ReplicaWrite {
  return {
    opId, away: 'host-write', raw: Buffer.from(raw),
    submit: async (op, args, base, actor) => { sent.push({ op, args, base, actor }); return reply },
    call: async () => ({ kind: 'refused', code: 'internal', message: 'not used' }),
  }
}

function calls(actor: WriteActor | null = SESSION, over: Partial<AwayCallsDeps> = {}) {
  const check = createLetterCheck()
  return awayCalls({ actorOf: () => actor, findTask, letters: { opArgs: (a) => check.opArgs(a), shape: (a) => check.shape(a) }, log: () => {}, ...over })
}

describe('route table: these calls are this host\'s own, a device keeps needs_leader', () => {
  it.each([
    ['PUT', '/api/v1/tasks/mtask-lead-0001/agent-memory'], ['PUT', '/api/v1/tasks/mtask-lead-0001/memory-files/notes.md'],
    ['POST', '/api/v1/human-inbox'], ['POST', '/api/v1/routines/trigger'], ['POST', '/api/v1/routines/check-test'],
    ['PATCH', '/api/v1/routines/mabc-0001'], ['DELETE', '/api/v1/routines/mabc-0001'],
  ])('%s %s', (method, p) => {
    const d = classify(method, p)
    expect(d.row?.localAway).toBe('host-write')
    expect(d.away).toBe('needs-leader')
    expect(d.row?.pattern.includes('*')).toBe(false)
  })

  it('the console\'s routine routes keep their answer: no local rule', () => {
    expect(classify('PATCH', '/api/routines/mabc-0001').row?.localAway).toBeUndefined()
    expect(classify('DELETE', '/api/cron/mabc-0001').row?.localAway).toBeUndefined()
  })
})

describe('agent_memory_write here', () => {
  const CALL = 'oc-MemoryCall_0001'

  it('the call id rides out of the self-call\'s op id only when it is that call\'s first write to that route', () => {
    const p = '/tasks/mtask-lead-0001/agent-memory'
    expect(callIdOfWrite(writeOpId(CALL, 'PUT', p, 0), 'PUT', p)).toBe(CALL)
    expect(callIdOfWrite(writeOpId(CALL, 'PUT', p, 1), 'PUT', p)).toBe('')
    expect(callIdOfWrite(writeOpId(CALL, 'PUT', '/tasks/other/agent-memory', 0), 'PUT', p)).toBe('')
    expect(callIdOfWrite('op-minted-1234', 'PUT', p)).toBe('')
  })

  it('an append goes to the daemon with the task named, and its answer is the op\'s', async () => {
    const sent: Sent[] = []
    const opId = writeOpId(CALL, 'PUT', '/tasks/mtask-lead-0001/agent-memory', 0)
    const r = await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/agent-memory', body: { content: 'note', mode: 'append' }, replicaWrite: write(opId, sent) })
    expect(r).toEqual({ status: 200, body: { queued: true, offline: true, outcome: 'Saved on this host.', next: 'Nothing else is required.' } })
    expect(sent).toEqual([{ op: 'agent_memory_write', args: { task: 'mtask-lead-0001', content: 'note', callId: CALL }, base: undefined, actor: SESSION }])
    // The op prints it as it came.
    expect(awayAnswer(r !== 'next' ? r.body : null)).not.toBeNull()
  })

  it('a prefix names the task; an id this copy lacks is taken as it is; any other name is held for the Mac', async () => {
    const sent: Sent[] = []
    await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-lead/agent-memory', body: { content: 'a' }, replicaWrite: write('op-a1', sent) })
    await run(calls(), { method: 'PUT', path: '/v1/tasks/mowner-zz-0099/agent-memory', body: { content: 'b' }, replicaWrite: write('op-a2', sent) })
    await run(calls(), { method: 'PUT', path: '/v1/tasks/the%20lead/agent-memory', body: { content: 'c' }, replicaWrite: write('op-a3', sent) })
    expect(sent.map((s) => s.args)).toEqual([
      { task: 'mtask-lead-0001', content: 'a' }, { task: 'mowner-zz-0099', content: 'b' }, { task: 'the lead', content: 'c', held: true },
    ])
  })

  it('a memory folder note goes as a note of its task (held for its op), from a session only', async () => {
    const sent: Sent[] = []
    const opId = writeOpId(CALL, 'PUT', '/tasks/mtask-lead-0001/memory-files/release-steps.md', 0)
    await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/memory-files/release-steps.md', body: { content: '# Steps' }, replicaWrite: write(opId, sent) })
    expect(sent[0]!.args).toEqual({ task: 'mtask-lead-0001', content: '# Steps', file: 'release-steps.md', callId: CALL })
    const job = await run(calls(JOB), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/memory-files/x.md', body: { content: 'x' }, replicaWrite: write('op-j', []) })
    expect(job).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'memory_file_changes_need_mac' } } })
  })

  it.each([
    ['a note name that is not one', '/v1/tasks/mtask-lead-0001/memory-files/notes.txt', { content: 'x' }, 400, 'bad_request'],
    ['one of Walnut\'s own files', '/v1/tasks/mtask-lead-0001/memory-files/fleet.md', { content: 'x' }, 409, 'walnut_file'],
    ['a note too long', '/v1/tasks/mtask-lead-0001/memory-files/long.md', { content: 'x'.repeat(20_001) }, 413, 'note_too_long'],
    ['a note to the shared folder', '/v1/tasks/_shared/memory-files/team.md', { content: 'x' }, 400, 'bad_request'],
  ])('a memory folder note the Mac would refuse (memory-folder.ts checkOwnNote) is refused here: %s', async (_label, p, body, status, code) => {
    const sent: Sent[] = []
    const r = await run(calls(), { method: 'PUT', path: p, body, replicaWrite: write('op-n', sent) })
    expect(r).toMatchObject({ status, body: { error: { code } } })
    expect(sent).toEqual([])
  })

  it('a memory folder note to a complete task is held, as the Mac writes it (only MEMORY.md is kept as it was)', async () => {
    const sent: Sent[] = []
    await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-done-0002/memory-files/wrap-up.md', body: { content: '# Done' }, replicaWrite: write('op-c', sent) })
    expect(sent.map((x) => x.args)).toEqual([{ task: 'mtask-done-0002', content: '# Done', file: 'wrap-up.md' }])
  })

  it.each([
    ['a replace (this host does not hold the file)', '/v1/tasks/mtask-lead-0001/agent-memory', { content: 'all', mode: 'replace' }, 503, 'needs_leader'],
    ['a completed task', '/v1/tasks/mtask-done-0002/agent-memory', { content: 'late' }, 409, 'task_complete'],
    ['an ambiguous prefix', '/v1/tasks/mtask/agent-memory', { content: 'x' }, 400, 'bad_request'],
    ['no content', '/v1/tasks/mtask-lead-0001/agent-memory', {}, 400, 'bad_request'],
  ])('refuses %s and sends nothing', async (_label, p, body, status, code) => {
    const sent: Sent[] = []
    const r = await run(calls(), { method: 'PUT', path: p, body, replicaWrite: write('op-r', sent) })
    expect(r).toMatchObject({ status, body: { error: { code } } })
    expect(sent).toEqual([])
  })

  it('the daemon\'s refusal is the route\'s; a device, or a request not routed away, is never handled here', async () => {
    const refused = await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/agent-memory', body: { content: 'x' }, replicaWrite: write('op-x', [], { kind: 'refused', code: 'needs_leader', message: 'older Mac', detail: { why: 'mac_too_old' } }) })
    expect(refused).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'mac_too_old' } } })
    const device = await run(calls({ kind: 'device', deviceId: 'dev-1' }), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/agent-memory', body: { content: 'x' }, replicaWrite: write('op-d', []) })
    expect(device).toMatchObject({ status: 503, body: { error: { code: 'needs_leader' } } })
    expect(await run(calls(), { method: 'PUT', path: '/v1/tasks/mtask-lead-0001/agent-memory', body: { content: 'x' } })).toBe('next')
  })
})

describe('human_inbox_send here', () => {
  const LETTER = { subject: 'CR 2 is ready', type: 'review', markdown: 'Please look', text: 'CR 2' }

  it('a letter the checks take goes whole to the daemon, answered 201 with the daemon\'s words', async () => {
    const sent: Sent[] = []
    const r = await run(calls(), { method: 'POST', path: '/v1/human-inbox', body: LETTER, replicaWrite: write('op-l1', sent, { kind: 'applied', reply: { letterId: 'lt-abc-123456', queued: true, offline: true, kind: 'letter', seq: 3, outcome: 'Saved.', next: 'Do not send it again.' } }) })
    expect(r).toMatchObject({ status: 201, body: { letterId: 'lt-abc-123456', queued: true } })
    expect(sent).toEqual([{ op: 'human_inbox_send', args: LETTER, base: undefined, actor: SESSION }])
  })

  it('a letter the store would refuse is refused here, and one over 1 MB needs the Mac; nothing sent', async () => {
    const sent: Sent[] = []
    const bad = await run(calls(), { method: 'POST', path: '/v1/human-inbox', body: { subject: 'Pick', type: 'action_required', markdown: 'x' }, replicaWrite: write('op-l2', sent) })
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
    const big = await run(calls(), { method: 'POST', path: '/v1/human-inbox', body: LETTER, replicaWrite: write('op-l3', sent, undefined, 'x'.repeat(1024 * 1024 + 1)) })
    expect(big).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'needs_mac' } } })
    expect(sent).toEqual([])
  })

  it('an info letter the user did not ask for is refused for a session as the Mac refuses it, needs the Mac for any other caller; one he asked for is kept', async () => {
    // 2026-11-21 real host run: it was saved here and refused unheard by the drain (info-letter-rule.ts).
    const INFO = { subject: 'Progress', type: 'info', markdown: 'Step 2 done', text: 'Step 2 done' }
    const sent: Sent[] = []
    const bySession = await run(calls(), { method: 'POST', path: '/v1/human-inbox', body: INFO, replicaWrite: write('op-i1', sent) })
    expect(bySession).toMatchObject({ status: 409, body: { error: { code: 'info_not_inbox' } } })
    const byJob = await run(calls({ kind: 'plugin-job', plugin: 'acme', job: 'sync' }), { method: 'POST', path: '/v1/human-inbox', body: INFO, replicaWrite: write('op-i2', sent) })
    expect(byJob).toMatchObject({ status: 503, body: { error: { code: 'needs_leader' } } })
    expect(sent).toEqual([])
    const asked = await run(calls(), { method: 'POST', path: '/v1/human-inbox', body: { ...INFO, user_asked: true }, replicaWrite: write('op-i3', sent) })
    expect(asked).toMatchObject({ status: 201 })
    expect(sent.map((x) => x.op)).toEqual(['human_inbox_send'])
  })
})

describe('triggers here', () => {
  const HERE: HereTrigger[] = [
    { id: 'mhere-made-01', state: 'armed', created: true, description: 'Made here.', def: { id: 'mhere-made-01', name: 'Made here', everyMs: 300_000, check: { run: 'bash a.sh', timeoutSeconds: 30 }, deliver: { taskId: 'mtask-lead-0001', prompt: 'Go' } }, status: { nextRunAtMs: 1_000 } },
    { id: 'mcopy-paused-1', state: 'paused', def: { id: 'mcopy-paused-1', name: 'Paused here', everyMs: 60_000, check: { run: 'bash b.sh' } } },
    { id: 'mcopy-gone-01', state: 'deleted', def: { id: 'mcopy-gone-01', name: 'Gone', everyMs: 60_000, check: { run: 'bash c.sh' } } },
  ]
  const COPY = [
    { id: 'mcopy-paused-1', name: 'Paused here', description: 'From the Mac.', enabled: true, check: { run: 'bash b.sh' }, state: { lastCheck: { outcome: 'quiet' } } },
    { id: 'mcopy-gone-01', name: 'Gone', enabled: true, check: { run: 'bash c.sh' } },
    { id: 'mcopy-other-1', name: 'Another host\'s', enabled: true, check: { run: 'bash d.sh', host: 'other-box' } },
  ]

  function triggers(over: Partial<AwayTriggersDeps> = {}, actor: WriteActor = SESSION) {
    const requests: Array<{ cmd: string; params: Record<string, unknown> }> = []
    const h = awayTriggers({
      actorOf: () => actor, hostKey: 'devbox', capabilities: () => ['follower-triggers-v1'],
      request: async (cmd, params) => {
        requests.push({ cmd, params })
        if (cmd === 'follower.triggers') return { ok: true, host: 'devbox', triggers: typeof params.id === 'string' ? HERE.filter((t) => t.id === params.id) : HERE }
        return { ok: true, result: { parsed: { fire: false }, wouldFire: false }, offline: true, outcome: 'The script parsed and would NOT fire right now.', next: 'Arm it.' }
      },
      findTask, session: async () => ({ taskId: 'mtask-lead-0001', cwd: '/work/lead' }),
      copyJobs: async () => COPY, label: (i) => String(i.name ?? i.description).slice(0, 48), now: () => 5_000, log: () => {},
      ...over,
    })
    return { h, requests }
  }

  it('the list is the copy with this host\'s triggers over it: made here added, paused here paused, deleted here gone', () => {
    const jobs = mergeHereTriggers(COPY, HERE, 'devbox', true, 5_000)
    expect(jobs.map((j) => [j.id, j.enabled])).toEqual([['mcopy-paused-1', false], ['mcopy-other-1', true], ['mhere-made-01', true]])
    expect(jobs[0]).toMatchObject({ description: 'From the Mac.', state: { lastCheck: { outcome: 'quiet' }, pausedAtMs: 5_000 } })
    expect(jobs[2]).toMatchObject({
      queued: true, name: 'Made here', description: 'Made here.', schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash a.sh', host: 'devbox', timeoutSeconds: 30 }, executor: { type: 'session', config: { target: 'mtask-lead-0001', prompt: 'Go' } }, state: { nextRunAtMs: 1_000 },
    })
    expect(mergeHereTriggers(COPY, HERE, 'devbox', false, 5_000).map((j) => j.id)).toEqual(['mcopy-other-1', 'mhere-made-01'])
  })

  it('GET /v1/routines and /v1/routines/:id answer merged only for this host\'s own call routed away', async () => {
    const { h } = triggers()
    const away = { [OFFLINE_HEADER]: '1' }
    const list = await run(h, { method: 'GET', path: '/v1/routines', query: { includeDisabled: 'true' } }, away)
    expect(list !== 'next' && list.body.jobs.map((j: { id: string }) => j.id)).toEqual(['mcopy-paused-1', 'mcopy-other-1', 'mhere-made-01'])
    expect(await run(h, { method: 'GET', path: '/v1/routines/mhere-made-01' }, away)).toMatchObject({ status: 200, body: { job: { id: 'mhere-made-01', enabled: true } } })
    expect(await run(h, { method: 'GET', path: '/v1/routines/mcopy-gone-01' }, away)).toMatchObject({ status: 404 })
    // Not this host's: the copy's own route answers.
    expect(await run(h, { method: 'GET', path: '/v1/routines/mcopy-other-1' }, away)).toBe('next')
    expect(await run(h, { method: 'GET', path: '/v1/routines/status' }, away)).toBe('next')
    expect(await run(h, { method: 'GET', path: '/v1/routines' })).toBe('next')
    expect(await run(triggers({ capabilities: () => [] }).h, { method: 'GET', path: '/v1/routines' }, away)).toBe('next')
    expect(await run(triggers({}, { kind: 'device', deviceId: 'dev-1' }).h, { method: 'GET', path: '/v1/routines' }, away)).toBe('next')
  })

  it('a create is decided here (target, folder, label, park) and sent whole', async () => {
    const { h } = triggers()
    const sent: Sent[] = []
    const r = await run(h, { method: 'POST', path: '/v1/routines/trigger', body: { run: ' bash a.sh ', prompt: 'Go', description: 'Checks  it.', every: '5m', wait: true, wait_until: '2h' }, replicaWrite: write('op-c1', sent) })
    expect(r).toMatchObject({ status: 201 })
    expect(sent).toEqual([{
      op: 'trigger_create', actor: SESSION, base: { phase: 'IN_PROGRESS', wait_until: 'unknown' },
      args: {
        run: 'bash a.sh', prompt: 'Go', description: 'Checks it.', name: 'Checks it.', everyMs: 300_000, taskId: 'mtask-lead-0001', cwd: '/work/lead',
        timeoutSeconds: 30, watches: null, own: true, park: { wait_until: new Date(5_000 + 2 * 3_600_000).toISOString() },
      },
    }])
  })

  it.each([
    ['a template', { template: 'slack:channel-message' }, 503, 'needs_leader'],
    ['an id', { id: 'mx-1', run: 'a', prompt: 'p', description: 'd', every: '5m' }, 400, 'bad_request'],
    ['another host', { host: 'other-box', run: 'a', prompt: 'p', description: 'd', every: '5m' }, 503, 'needs_leader'],
    ['a check too often', { run: 'a', prompt: 'p', description: 'd', every: '5s' }, 400, 'bad_request'],
    ['a description too long', { run: 'a', prompt: 'p', description: 'd'.repeat(601), every: '5m' }, 400, 'bad_request'],
    ['a bad watch', { run: 'a', prompt: 'p', description: 'd', every: '5m', watches: 'everything' }, 400, 'bad_request'],
    ['a completed task', { run: 'a', prompt: 'p', description: 'd', every: '5m', session: 'mtask-done-0002' }, 400, 'bad_request'],
    ['a task this copy lacks', { run: 'a', prompt: 'p', description: 'd', every: '5m', session: 'mnope-0000-1' }, 503, 'needs_leader'],
  ])('a create with %s is refused, nothing sent', async (_l, body, status, code) => {
    const { h } = triggers()
    const sent: Sent[] = []
    expect(await run(h, { method: 'POST', path: '/v1/routines/trigger', body, replicaWrite: write('op-c2', sent) })).toMatchObject({ status, body: { error: { code } } })
    expect(sent).toEqual([])
  })

  it('pause and resume are PATCH {enabled} alone (any other change is trigger_update: the Mac\'s); delete is DELETE', async () => {
    const { h } = triggers()
    const sent: Sent[] = []
    await run(h, { method: 'PATCH', path: '/v1/routines/mhere-made-01', body: { enabled: false }, replicaWrite: write('op-p', sent) })
    await run(h, { method: 'PATCH', path: '/v1/routines/mhere-made-01', body: { enabled: true }, replicaWrite: write('op-r', sent) })
    await run(h, { method: 'DELETE', path: '/v1/routines/mhere-made-01', body: {}, replicaWrite: write('op-d', sent) })
    expect(sent.map((s) => [s.op, s.args])).toEqual([['trigger_pause', { id: 'mhere-made-01' }], ['trigger_resume', { id: 'mhere-made-01' }], ['trigger_delete', { id: 'mhere-made-01' }]])
    const update = await run(h, { method: 'PATCH', path: '/v1/routines/mhere-made-01', body: { schedule: { kind: 'every', everyMs: 60_000 } }, replicaWrite: write('op-u', sent) })
    expect(update).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'routine_writes_need_mac' } } })
    const job = await run(triggers({}, JOB).h, { method: 'DELETE', path: '/v1/routines/mhere-made-01', body: {}, replicaWrite: write('op-j', sent) })
    expect(job).toMatchObject({ status: 503 })
    expect(sent).toHaveLength(3)
  })

  it('a test runs once through follower.trigger.test in the caller\'s folder; a running test\'s id and an older daemon need the Mac', async () => {
    const { h, requests } = triggers()
    const r = await run(h, { method: 'POST', path: '/v1/routines/check-test', body: { check: { run: 'bash a.sh', timeoutSeconds: 20 }, id: 'mhere-made-01' }, replicaWrite: write('op-t', []) })
    expect(r).toMatchObject({ status: 200, body: { offline: true, result: { wouldFire: false } } })
    expect(requests).toEqual([{ cmd: 'follower.trigger.test', params: { actor: SESSION, args: { run: 'bash a.sh', cwd: '/work/lead', timeoutSeconds: 20, id: 'mhere-made-01' } } }])
    expect(await run(h, { method: 'POST', path: '/v1/routines/check-test', body: { testId: 'tt_1' }, replicaWrite: write('op-t2', []) })).toMatchObject({ status: 503 })
    const old = await run(triggers({ capabilities: () => [] }).h, { method: 'POST', path: '/v1/routines/check-test', body: { check: { run: 'bash a.sh' } }, replicaWrite: write('op-t3', []) })
    expect(old).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'daemon_needs_upgrade' } } })
  })
})
