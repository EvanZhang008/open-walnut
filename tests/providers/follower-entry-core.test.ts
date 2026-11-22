/**
 * The follower entry (follower-entry-core.ts): what this host's own Walnut server asks its
 * daemon, as plain functions of (home, params). Both daemon twins call it (the source twin
 * inlines its text), so each case runs on the imported function and on its rebuilt text.
 * Each function is checked with the leader live, the leader away, and a daemon that no
 * longer owns its directory.
 */
import { describe, expect, it } from 'vitest'
import { createFollowerEntry, type FollowerEntryDeps } from '../../src/providers/follower-entry-core.js'
import type { HostStartAnswer, HostStartPlan } from '../../src/providers/host-start-core.js'

const HOME = '/home/marina/.open-walnut'
const QUIET = 30_000

type Factory = typeof createFollowerEntry
const rebuilt = new Function('__name', '"use strict"; return ' + createFollowerEntry.toString())((f: unknown) => f) as Factory
const FACTORIES: Array<[string, Factory]> = [['imported', createFollowerEntry], ['rebuilt from text', rebuilt]]

const plan: HostStartPlan = {
  sid: 'sid-new', taskId: 'task-1', mode: 'default', cwd: '/w', message: 'hello', args: ['--x'],
  record: { kind: 'session', sid: 'sid-new', taskId: 'task-1', host: 'h', cwd: '/w' },
} as unknown as HostStartPlan

function rig(over: { live?: boolean; owner?: boolean; handover?: boolean; backup?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const st = { live: over.live ?? false, owner: over.owner ?? true, handover: over.handover ?? false, backup: over.backup ?? false }
  const owners = new Map<string, string>([['sid-a', HOME]])
  const firsts = new Map<string, Promise<HostStartAnswer>>()
  const pendings: Array<Record<string, unknown>> = []
  let noteOk = true
  const ok = (result: unknown) => ({ ok: true as const, result })
  const deps = {
    fs: { statSync: () => ({ mtime: new Date(Date.UTC(2026, 10, 1)) }) },
    leaderBook: {
      recordOf: (h: string) => (h === HOME ? { walnutId: 'w-1', epoch: 3, holder: 'primary', backup: null } : null),
      primaryAgeMs: () => (st.live ? 1_000 : QUIET + 1),
      heardSinceBoot: () => true,
      backupLead: () => (st.backup ? { epoch: 4 } : null),
    },
    offline: {
      journalStats: () => ({ drainable: 2, records: 2 }),
      sessionsOf: (h: string) => (h === HOME ? { host: 'h', asOf: 'now', sessions: [{ sid: 'sid-a' }, { sid: 'sid-b' }] } : null),
      ownerOf: (sid: string) => owners.get(sid),
      pendingHandover: () => st.handover,
      deliverHuman: async (...a: unknown[]) => { calls.push(['deliverHuman', ...a]); return ok({ messageId: 'qm-1' }) },
      handleFollowerPeer: async (...a: unknown[]) => { calls.push(['peer', ...a]); return ok({ sent: true }) },
      handleFollowerWaiting: async (_h: string, req: Record<string, unknown>) => {
        calls.push(['op', req])
        return req.op === 'bad' ? { ok: false, error: { code: 'queue_full', message: 'full', detail: { n: 1 }, retryAfterMs: 50 } } : ok({ seq: 7 })
      },
      followerTriggers: (h: string, id: unknown) => ({ home: h, id }),
      followerTriggerTest: async () => ({ ok: false, error: { code: 'bad_request', message: 'no check' } }),
      pendingFor: (h: string, since: unknown) => ({ home: h, since }),
      checkTaskStart: () => ({ ok: true }),
      checkSession: () => ({ ok: true }),
      noteSessionWaiting: async (...a: unknown[]) => { calls.push(['noteSessionWaiting', ...a]); return noteOk ? ok({ seq: 9 }) : { ok: false, error: { code: 'journal_unwritable', message: 'no room' } } },
      noteSession: (...a: unknown[]) => { calls.push(['noteSession', ...a]); return noteOk ? ok({ seq: 1 }) : { ok: false, error: { code: 'journal_unwritable', message: 'no room' } } },
      noteRoutineTask: () => ok({}),
    },
    hostStart: {
      firstStart: (_h: string, sid: string) => firsts.get(sid) ?? null,
      precheck: () => null,
      plan: () => ({ ok: true, plan }),
      planTask: () => ({ ok: true, plan }),
      once: (_h: string, sid: string, run: () => Promise<HostStartAnswer>) => { const p = run(); firsts.set(sid, p); return p },
      begin: () => () => { calls.push(['released']) },
      holdPending: (_h: string, e: Record<string, unknown>) => { pendings.push(e) },
      releasePending: (h: string, sid: string) => { calls.push(['releasePending', h, sid]) },
      pendingStarts: () => [{ home: HOME, sid: 'sid-cut', record: { taskId: 'task-9' }, opId: 'op-9', at: 0 }],
    },
    primarySocketOpen: () => st.live,
    followerLinked: () => true,
    bridgeLink: () => ({ config: { enabled: true, url: 'wss://companion.example/bridge' }, adapter: {} }),
    settingsOf: () => ({ s: 1 }),
    reportServer: (...a: unknown[]) => { calls.push(['report', ...a]) },
    offlineAnswers: () => ({ total: 0 }),
    triggerAnswer: async (link: unknown) => (link === 'ws-1' ? ok({ delivered: true }) : { ok: false, code: 'wrong_socket', message: 'not that socket' }),
    takeoverMs: 60_000,
    quietMs: QUIET,
    ownsDir: () => st.owner,
    session: (sid: string) => (sid === 'sid-a' ? { state: 'running', jsonlPath: '/s.jsonl', foldState: { turnActive: true }, pendingCtrl: { reqId: 'r1', toolName: 'Bash', request: { subtype: 'can_use_tool', input: { c: 1 } } } } : undefined),
    sidTaken: (sid: string) => sid === 'sid-used',
    ran: (sid: string) => sid === 'sid-cut',
    answerPermission: async (...a: unknown[]) => { calls.push(['answerPermission', ...a]); return { ok: true as const, allow: true } },
    spawn: async (...a: unknown[]) => { calls.push(['spawn', ...a]) },
    marker: (...a: unknown[]) => { calls.push(['marker', ...a]) },
    stop: (sid: string) => { calls.push(['stop', sid]) },
    randomHex: () => 'abcd',
    log: () => {},
  } as unknown as FollowerEntryDeps<string>
  return { deps, calls, st, owners, pendings, failNotes: () => { noteOk = false } }
}

describe.each(FACTORIES)('follower entry (%s)', (_name, make) => {
  it('the leader answers only inside the quiet window and once heard since boot; a handover keeps the journal the writer', () => {
    const live = rig({ live: true })
    const e = make(live.deps)
    expect(e.primaryAnswers(HOME)).toBe(true)
    expect(e.mayWrite(HOME)).toBe(false)
    expect(e.quietWithFollower(HOME)).toBe(false)
    live.st.handover = true
    expect(e.mayWrite(HOME)).toBe(true)
    const away = make(rig().deps)
    expect(away.primaryAnswers(HOME)).toBe(false)
    expect(away.mayWrite(HOME)).toBe(true)
    expect(away.quietWithFollower(HOME)).toBe(true)
  })

  it('view: the leader record, the windows, the companion origin and the journal line; null for a Walnut it does not know', () => {
    const e = make(rig({ live: true }).deps)
    expect(e.view('/other')).toBeNull()
    expect(e.view(HOME)).toMatchObject({
      walnutId: 'w-1', home: HOME, epoch: 3, primaryConnected: true, takeoverMs: 60_000, quietMs: QUIET,
      bridge: { connected: true, companion: 'https://companion.example' }, settings: { s: 1 },
      journal: { drainable: 2 }, drainablePending: 2, offlineAnswers: { total: 0 },
    })
  })

  it('sessions: the copy with what runs here now (state, prompt, last activity)', () => {
    const e = make(rig().deps)
    expect(e.sessions('/other')).toEqual({ host: '', asOf: null, sessions: [] })
    const out = e.sessions(HOME) as { sessions: Array<Record<string, unknown>> }
    expect(out.sessions[0]).toMatchObject({ sid: 'sid-a', state: 'working', prompt: { requestId: 'r1', toolName: 'Bash', input: { c: 1 } }, lastActiveAt: '2026-11-01T00:00:00.000Z' })
    expect(out.sessions[1]).toEqual({ sid: 'sid-b', state: 'stopped' })
  })

  it('send and permission: refused while the leader answers and for another Walnut\'s session; delivered while it is away', async () => {
    const live = make(rig({ live: true }).deps)
    expect(await live.send(HOME, { sid: 'sid-a', text: 'hi' })).toEqual({ ok: false, error: 'follower.send: your Mac answers again; write through it', extra: { errorKind: 'leader_answers' } })
    const r = rig()
    const away = make(r.deps)
    expect(await away.send(HOME, { sid: 'sid-x', text: 'hi' })).toEqual({ ok: false, error: 'follower.send: not a session of this Walnut on this host', extra: { errorKind: 'not_found' } })
    expect(await away.send(HOME, { sid: 'sid-a', text: 'hi', messageId: 'qm-1' })).toEqual({ ok: true, result: { delivered: true, messageId: 'qm-1' } })
    expect(r.calls).toContainEqual(['deliverHuman', HOME, 'sid-a', 'hi', 'qm-1'])
    expect(await away.permission(HOME, { sid: 'sid-a', requestId: 'r1', allow: true })).toEqual({ ok: true, result: { status: 'resolved', requestId: 'r1', allow: true } })
    expect(r.calls.find((c) => c[0] === 'answerPermission')?.[3]).toBe('follower.permission')
  })

  it('op: the leader first, then the directory owner, then the journal; a refusal keeps its kind, detail and retry', async () => {
    expect(await make(rig({ live: true }).deps).op(HOME, { op: 'task_update' })).toMatchObject({ ok: false, extra: { errorKind: 'leader_answers' } })
    expect(await make(rig({ owner: false }).deps).op(HOME, { op: 'task_update' })).toEqual({
      ok: false, error: 'follower.op: this daemon no longer owns its directory', extra: { errorKind: 'journal_unwritable', detail: { why: 'not_owner' } },
    })
    const r = rig()
    const e = make(r.deps)
    expect(await e.op(HOME, { op: 'task_update', args: { id: 't' }, actor: 'me', opId: 'o1', base: 2, extra: 'dropped' })).toEqual({ ok: true, result: { seq: 7 } })
    expect(r.calls).toContainEqual(['op', { op: 'task_update', args: { id: 't' }, actor: 'me', opId: 'o1', base: 2 }])
    expect(await e.op(HOME, { op: 'bad' })).toEqual({ ok: false, error: 'follower.op: full', extra: { errorKind: 'queue_full', detail: { n: 1 }, retryAfterMs: 50 } })
  })

  it('peer: an online message passes whoever leads; a hold goes to a leading companion; the owner check holds', async () => {
    const live = rig({ live: true })
    expect(await make(live.deps).peer(HOME, { online: true })).toEqual({ ok: true, result: { sent: true } })
    expect(await make(rig({ live: true }).deps).peer(HOME, {})).toMatchObject({ ok: false, extra: { errorKind: 'leader_answers' } })
    expect(await make(rig({ backup: true }).deps).peer(HOME, { kind: 'hold' })).toMatchObject({ ok: false, extra: { errorKind: 'needs_leader', detail: { why: 'companion_leads' } } })
    expect(await make(rig({ owner: false }).deps).peer(HOME, {})).toMatchObject({ ok: false, extra: { errorKind: 'journal_unwritable' } })
  })

  it('triggers, trigger test, pending, report and a trigger delivery answer', async () => {
    const r = rig({ live: true })
    const e = make(r.deps)
    expect(e.triggers(HOME, { triggerId: 'tr-1' })).toEqual({ home: HOME, id: 'tr-1' })
    expect(e.pending(HOME, { sinceSeq: 4 })).toEqual({ home: HOME, since: 4 })
    expect(await e.triggerTest(HOME, {})).toEqual({ ok: false, error: 'follower.trigger.test: no check', extra: { errorKind: 'bad_request' } })
    e.report(HOME, { up: true })
    expect(r.calls).toContainEqual(['report', HOME, { up: true }])
    expect(await e.triggerDeliver('ws-1', {})).toEqual({ ok: true, result: { delivered: true } })
    expect(await e.triggerDeliver('ws-2', {})).toEqual({ ok: false, error: 'follower.trigger.deliver: not that socket', extra: { errorKind: 'wrong_socket' } })
  })

  it('start: refused while the leader answers or the dir is not ours; a used sid is taken; check runs the checks only', async () => {
    expect(await make(rig({ live: true }).deps).start(HOME, { sid: 's' })).toEqual({ ok: false, error: 'follower.start: your Mac answers again; start the ask through it', extra: { errorKind: 'leader_answers' } })
    expect(await make(rig({ owner: false }).deps).start(HOME, { sid: 's' })).toMatchObject({ ok: false, extra: { errorKind: 'journal_unwritable' } })
    const e = make(rig().deps)
    expect(await e.start(HOME, { sid: 'sid-used' })).toEqual({ ok: false, error: 'follower.start: that session id is taken on this host', extra: { errorKind: 'bad_request' } })
    expect(await e.start(HOME, { sid: 'sid-a' })).toEqual({ ok: true, result: { sid: 'sid-a', duplicate: true } })
    expect(await e.start(HOME, { sid: 'sid-new', check: true })).toEqual({ ok: true, result: { sid: 'sid-new', checked: true } })
  })

  it('start: the CLI runs, its record is journaled, the turn starts in the stream; a retry gets the first answer', async () => {
    const r = rig()
    const e = make(r.deps)
    const first = await e.start(HOME, { sid: 'sid-new', opId: 'op-1', actor: 'me' })
    expect(first).toEqual({ ok: true, result: { sid: 'sid-new', taskId: 'task-1', mode: 'default', cwd: '/w', messageId: 'qm-ask-abcd', seq: 9 } })
    expect(r.pendings).toEqual([{ sid: 'sid-new', record: plan.record, opId: 'op-1-session', actor: 'me' }])
    const order = r.calls.map((c) => c[0])
    expect(order.indexOf('spawn')).toBeLessThan(order.indexOf('noteSessionWaiting'))
    expect(r.calls).toContainEqual(['spawn', HOME, 'task-1', plan])
    expect(r.calls).toContainEqual(['marker', 'sid-new', 'hello', 'qm-ask-abcd'])
    expect(order).toContain('released')
    expect(await e.start(HOME, { sid: 'sid-new' })).toEqual({ ok: true, result: { ...(first as { result: Record<string, unknown> }).result, duplicate: true } })
  })

  it('start: a record that is not kept stops the CLI and answers the refusal', async () => {
    const r = rig()
    r.failNotes()
    const e = make(r.deps)
    expect(await e.start(HOME, { sid: 'sid-new' })).toEqual({ ok: false, error: 'follower.start: no room', extra: { errorKind: 'journal_unwritable' } })
    expect(r.calls).toContainEqual(['stop', 'sid-new'])
  })

  it('recoverPendingAsks: a start whose CLI ran is journaled under its op id, one that cannot be is stopped; each is released', () => {
    const r = rig()
    make(r.deps).recoverPendingAsks()
    expect(r.calls).toContainEqual(['noteSession', HOME, { taskId: 'task-9' }, 'op-9', undefined])
    expect(r.calls).toContainEqual(['releasePending', HOME, 'sid-cut'])
    const bad = rig()
    bad.failNotes()
    make(bad.deps).recoverPendingAsks()
    expect(bad.calls).toContainEqual(['stop', 'sid-cut'])
    expect(bad.calls).toContainEqual(['releasePending', HOME, 'sid-cut'])
  })
})
