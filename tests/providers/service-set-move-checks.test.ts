/**
 * What a service set move asks the shared daemon and this server before it stops anything there
 * (src/providers/service-set-move-checks.ts), with a fake link and fake store, runner and stop.
 * Guards review round 1: B4 (a stop counts only when the CLI is proven gone; sessions whose record
 * reads error or a stale stopped while their CLI lives are listed), B5 (work after the turn and a
 * fresh read of the host, never the stored status alone), B6 (this Walnut's triggers and plugin jobs
 * on the shared daemon emptied for its home), should-fix 7 (the follower stop is checked) and
 * should-fix 12 (host_exec runs of this Walnut's tasks hold the move).
 */
import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../src/core/types.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import type { TerminateResult } from '../../src/core/sessions/session-lifecycle.js'
import type { CliHolderAnswer } from '../../src/providers/remote-session-manager.js'
import { dropWalnutScope, moveSessions, openWorkThere, stopFollowerThere, stopProven, type MoveCheckDeps, type MoveCheckLink } from '../../src/providers/service-set-move-checks.js'

const HOME = '/home/u/.open-walnut'
const rec = (id: string, status: SessionRecord['process_status'], over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ claudeSessionId: id, host: 'h', process_status: status, engine: 'claude-code', ...over }) as SessionRecord
const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  v: 1000, cliState: 'idle', turnActive: false, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
  teamActive: false, cronActive: false, wakeupAt: null, lastResult: null, pid: 42, exitCode: null, ...over,
})

function link(o: { alive?: string[]; states?: Record<string, unknown>; caps?: string[]; replies?: Record<string, Record<string, unknown>>; underWay?: number } = {}) {
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const l: MoveCheckLink = {
    hostKey: 'h', home: HOME,
    send: async (cmd, params) => {
      sent.push({ cmd, params })
      if (cmd === 'list') return { ok: true, sessions: (o.alive ?? []).map((sid) => ({ sid, alive: true })) }
      if (cmd === 'getState') {
        const st = o.states?.[params.sid as string]
        if (st instanceof Error) throw st
        return (st as Record<string, unknown>) ?? { ok: true, exists: false }
      }
      return o.replies?.[cmd] ?? { ok: true }
    },
    hasCapability: (c) => (o.caps ?? []).includes(c),
    workUnderWay: () => o.underWay ?? 0,
    walnutId: async () => '0123456789abcdef0123',
  }
  return { l, sent }
}

const live = (over: Partial<SessionSnapshot> = {}) => ({ ok: true, exists: true, alive: true, snapshot: snap(over) })
const deps = (records: SessionRecord[], o: { inTurn?: string[]; outliving?: Record<string, string[]>; cron?: string[]; holder?: Record<string, CliHolderAnswer>; terminate?: (id: string) => Promise<TerminateResult> } = {}): MoveCheckDeps => ({
  records: async () => records,
  runner: async () => ({
    inTurn: (id) => (o.inTurn?.includes(id) ? true : null),
    outliving: (id) => (o.outliving?.[id] ?? []) as never,
    cronArmed: (id) => !!o.cron?.includes(id),
  }),
  holder: async (_l, sid) => o.holder?.[sid] ?? { state: 'free' },
  terminate: o.terminate ?? (async (id) => ({ status: 'terminated', sessionId: id, stopRequest: { id: 'r', requestedAt: '', state: 'confirmed' } })),
  ownTasks: async (ids) => new Set(ids.filter((t) => t.startsWith('mine'))),
})

describe('moveSessions (B4, B5)', () => {
  it('lists a session whose record reads error or a stale stopped while the daemon lists its CLI alive', async () => {
    const { l } = link({ alive: ['err', 'stale'], states: { err: live(), stale: live() } })
    const got = await moveSessions(l, deps([rec('err', 'error'), rec('stale', 'stopped'), rec('gone', 'stopped')]))
    expect(got).toEqual([{ id: 'err' }, { id: 'stale' }])
  })

  it('a record that reads idle with no CLI anywhere is left out; one whose CLI runs outside the shared daemon blocks the move', async () => {
    const { l } = link({ states: { dead: { ok: true, exists: true, alive: false, snapshot: snap({ cliState: 'dead' }) } } })
    expect(await moveSessions(l, deps([rec('dead', 'idle'), rec('nowhere', 'idle')]))).toEqual([])
    const held = await moveSessions(l, deps([rec('nowhere', 'idle')], { holder: { nowhere: { state: 'held', detail: 'live pid 9' } } }))
    expect(held).toEqual([{ id: 'nowhere', blocks: expect.stringMatching(/outside the shared daemon \(live pid 9\)/) }])
  })

  it('B5: the host\'s fresh word counts, not the stored status: a turn, a permission prompt, background work, a team, a wakeup, a /loop', async () => {
    const now = Date.now()
    const cases: Array<[Partial<SessionSnapshot>, RegExp]> = [
      [{ turnActive: true }, /in a turn/],
      [{ turnActive: true, pendingPermission: { requestId: 'p', toolName: 'Bash' } }, /in a turn/],
      [{ detachedBgCount: 1 }, /background command or subagent/],
      [{ teamActive: true }, /agent team/],
      [{ wakeupAt: now + 60_000 }, /wakeup it scheduled/],
      [{ cronActive: true }, /\/loop it armed/],
    ]
    for (const [over, why] of cases) {
      const { l } = link({ states: { s: live(over) } })
      // The store says idle every time.
      expect(await moveSessions(l, deps([rec('s', 'idle')])), JSON.stringify(over)).toEqual([{ id: 's', busy: expect.stringMatching(why) }])
    }
  })

  it('B5: this server\'s runner counts too (in a turn, outliving work, armed crons), and no answer from the host is busy', async () => {
    const { l } = link({ states: { a: live(), b: live(), c: live(), d: new Error('timed out') } })
    const got = await moveSessions(l, deps([rec('a', 'idle'), rec('b', 'idle'), rec('c', 'idle'), rec('d', 'idle')], { inTurn: ['a'], outliving: { b: ['team'] }, cron: ['c'] }))
    expect(got).toEqual([
      { id: 'a', busy: 'session a: in a turn' },
      { id: 'b', busy: 'session b: its agent team' },
      { id: 'c', busy: 'session c: a /loop it armed' },
      { id: 'd', busy: expect.stringMatching(/did not answer for it \(timed out\)/) },
    ])
  })

  it('B4: an ACP session blocks the move (its stop cannot be proven), and a daemon that cannot list its sessions throws', async () => {
    const { l } = link({ states: { x: live() } })
    expect(await moveSessions(l, deps([rec('x', 'idle', { engine: 'codex' as never })]))).toEqual([{ id: 'x', blocks: expect.stringMatching(/an ACP session/) }])
    const bad = link({ replies: {} })
    bad.l.send = async () => ({ ok: false, error: 'unknown command: list' })
    await expect(moveSessions(bad.l, deps([rec('x', 'idle')]))).rejects.toThrow(/did not list its sessions/)
  })
})

describe('stopProven (B4)', () => {
  const quiet = () => link({ alive: ['s'], states: { s: live() } })

  it('proven only when the daemon\'s cli.holder says no CLI of it runs', async () => {
    expect(await stopProven(quiet().l, 's', deps([rec('s', 'idle')]))).toEqual({ ok: true })
    expect(await stopProven(quiet().l, 's', deps([rec('s', 'idle')], { holder: { s: { state: 'held', detail: 'live pid 7' } } })))
      .toEqual({ ok: false, why: 'session s: a CLI of it still runs (live pid 7)' })
    expect(await stopProven(quiet().l, 's', deps([rec('s', 'idle')], { holder: { s: { state: 'too-old' } } })))
      .toMatchObject({ ok: false, why: expect.stringMatching(/cannot prove its CLI is gone/) })
  })

  it('a lost host, an unconfirmed stop or a refused stop (armed crons) is no proof', async () => {
    const lost = deps([rec('s', 'idle')], { terminate: async (id) => ({ status: 'terminated', sessionId: id, hostLost: { host: 'h', at: '' } }) })
    expect(await stopProven(quiet().l, 's', lost)).toMatchObject({ ok: false, why: expect.stringMatching(/host read as lost/) })
    const pending = deps([rec('s', 'idle')], { terminate: async (id) => ({ status: 'pending', sessionId: id, stopRequest: { id: 'r', requestedAt: '', state: 'pending' } }) })
    expect(await stopProven(quiet().l, 's', pending)).toMatchObject({ ok: false, why: expect.stringMatching(/did not confirm its stop \(pending\)/) })
    const cron = deps([rec('s', 'idle')], { terminate: async () => { throw Object.assign(new Error('crons'), { extra: { code: 'cron_owner' } }) } })
    expect(await stopProven(quiet().l, 's', cron)).toMatchObject({ ok: false, why: expect.stringMatching(/owns scheduled crons/) })
  })

  it('judged again right before its stop: a session that became busy is not stopped', async () => {
    let stopped = false
    const { l } = link({ alive: ['s'], states: { s: live({ turnActive: true }) } })
    const r = await stopProven(l, 's', deps([rec('s', 'idle')], { terminate: async (id) => { stopped = true; return { status: 'terminated', sessionId: id } } }))
    expect(r).toEqual({ ok: false, busy: true, why: 'session s: in a turn' })
    expect(stopped).toBe(false)
  })
})

describe('openWorkThere (should-fix 12)', () => {
  it('commands under way and host_exec runs of this Walnut\'s tasks hold the move; another Walnut\'s runs do not', async () => {
    expect(await openWorkThere(link({ underWay: 2 }).l, deps([]))).toMatch(/2 commands .* still under way/)
    const jobs = { 'exec.list': { ok: true, jobs: [{ running: true, taskId: 'mine-1' }, { running: true, taskId: 'theirs' }, { running: false, taskId: 'mine-2' }] } }
    expect(await openWorkThere(link({ caps: ['host-exec-v1'], replies: jobs }).l, deps([]))).toBe('1 host_exec run of this Walnut\'s tasks still runs there')
    const theirs = { 'exec.list': { ok: true, jobs: [{ running: true, taskId: 'theirs' }] } }
    expect(await openWorkThere(link({ caps: ['host-exec-v1'], replies: theirs }).l, deps([]))).toBe(null)
    expect(await openWorkThere(link({}).l, deps([]))).toBe(null)
  })
})

describe('dropWalnutScope (B6)', () => {
  it('empties this Walnut\'s triggers and plugin jobs for its home, the way the leader configures them', async () => {
    const { l, sent } = link({ caps: ['plugin-jobs-v1'] })
    await dropWalnutScope(l)
    expect(sent).toEqual([
      { cmd: 'triggers.configure', params: { config: { version: 1, triggers: [] }, home: HOME } },
      { cmd: 'jobs.configure', params: { home: HOME, spec: { v: 1, home: HOME, walnutId: '0123456789abcdef0123', jobs: [] } } },
    ])
  })

  it('a released clock with fires still to deliver, or a refusal, is no drop', async () => {
    await expect(dropWalnutScope(link({ replies: { 'triggers.configure': { ok: true, released: [{ id: 'c', pending: 2 }] } } }).l)).rejects.toThrow(/1 clock routine there still had fires/)
    await expect(dropWalnutScope(link({ caps: ['plugin-jobs-v1'], replies: { 'jobs.configure': { ok: false, error: 'no' } } }).l)).rejects.toThrow(/plugin jobs \(no\)/)
  })
})

describe('stopFollowerThere (should-fix 7)', () => {
  const sleep = async () => {}
  it('stops and sees it off; a refusal or a follower still running throws; only a daemon with no followers has nothing to stop', async () => {
    const ok = link({ caps: ['host-server-v1'], replies: { 'server.status': { ok: true, status: { state: 'off' } } } })
    await stopFollowerThere(ok.l, sleep)
    expect(ok.sent.map((s) => s.cmd)).toEqual(['server.configure', 'server.status'])
    await expect(stopFollowerThere(link({ caps: ['host-server-v1'], replies: { 'server.configure': { ok: false, error: 'busy' } } }).l, sleep)).rejects.toThrow(/refused \(busy\)/)
    await expect(stopFollowerThere(link({ caps: ['host-server-v1'], replies: { 'server.status': { ok: true, status: { state: 'running' } } } }).l, sleep)).rejects.toThrow(/still reads running/)
    await stopFollowerThere(link({ caps: ['host-server-v1'], replies: { 'server.configure': { ok: false, error: 'unknown command: server.configure' } } }).l, sleep)
    const none = link({})
    await stopFollowerThere(none.l, sleep)
    expect(none.sent).toEqual([])
  })
})
