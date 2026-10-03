/**
 * The per-turn snapshot routes and the rewind guard route
 * (src/web/routes/session-turns.ts over src/core/turn-snapshots/service.ts):
 * what each sends the session's daemon, how a daemon refusal maps to HTTP, and
 * that a guard which cannot answer degrades to `guard: null` instead of failing
 * the rewind dialog. The daemon is a stub; its cores have their own tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

interface Rec { claudeSessionId: string; cwd?: string; host?: string; title?: string; lastActiveAt: string; engine?: string; provider?: string }

const state = vi.hoisted(() => ({
  records: new Map<string, Rec>(),
  recent: [] as Rec[],
  caps: new Set<string>(['turn-snapshot-v1']),
  connected: true,
  bareFirst: false,
  sent: [] as Array<{ cmd: string; params: Record<string, unknown>; timeoutMs?: number }>,
  reply: (_cmd: string, _params: Record<string, unknown>): unknown => ({ ok: true }),
}))

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => state.records.get(id) ?? null,
  listRecentSessionRecords: async () => state.recent,
}))

vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: {} }) }))

vi.mock('../../../src/providers/daemon-connection.js', () => {
  const conn = {
    hasCapability: (c: string) => state.caps.has(c),
    send: async (cmd: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
      state.sent.push({ cmd, params, timeoutMs })
      const r = state.reply(cmd, params)
      if (r instanceof Error) throw r
      return r
    },
  }
  // A second live connection to the same daemon whose handshake listed no
  // capabilities (the local daemon holds a pooled and a direct one).
  const bare = { hasCapability: () => false, send: async () => { throw new Error('bare connection used') } }
  return {
    getConnectedDaemonConnection: () => (state.connected ? (state.bareFirst ? bare : conn) : null),
    listConnectedDaemonsByHost: () => new Map(state.connected ? [['__local__', state.bareFirst ? [bare, conn] : [conn]]] : []),
    getDaemonConnection: async () => { if (!state.connected) throw new Error('not reachable'); return conn },
    daemonConnectWouldWait: () => 'connected',
    getDaemonPoolStatus: () => [{ host: '__local__', connected: state.connected }],
    addOnDaemonHostConnected: () => () => {},
  }
})

const { sessionTurnsRouter } = await import('../../../src/web/routes/session-turns.js')
const { siblingSessions } = await import('../../../src/core/turn-snapshots/service.js')
const { turnSnapshotSettingsFrom, pushTurnSnapshotSettings, stopTurnSnapshotSettingsSync } = await import('../../../src/core/turn-snapshots/settings-push.js')

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/sessions', sessionTurnsRouter)
  return a
}

const NOW = Date.now()
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString()

beforeEach(() => {
  state.records.clear()
  state.recent = []
  state.caps = new Set(['turn-snapshot-v1'])
  state.connected = true
  state.bareFirst = false
  state.sent = []
  state.reply = () => ({ ok: true })
  state.records.set('s-a', { claudeSessionId: 's-a', cwd: '/work/repo', title: 'Session A', lastActiveAt: iso(0) })
  state.records.set('s-nocwd', { claudeSessionId: 's-nocwd', lastActiveAt: iso(0) })
})

describe('GET /api/sessions/:id/turns', () => {
  it("asks the session's daemon for its snapshots with the session's cwd", async () => {
    state.reply = (cmd) => cmd === 'turns.list'
      ? { id: 7, ok: true, enabled: true, repoRoot: '/work/repo', snapshots: [{ n: 1, kind: 'turn', files: [] }], skipped: [], lastTurnEndAt: 5 }
      : { ok: false }
    const res = await request(app()).get('/api/sessions/s-a/turns')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ supported: true, enabled: true, repoRoot: '/work/repo', cwd: '/work/repo', lastTurnEndAt: 5 })
    expect(res.body.snapshots).toHaveLength(1)
    expect(res.body.id).toBeUndefined()
    expect(res.body.ok).toBeUndefined()
    expect(state.sent).toEqual([{ cmd: 'turns.list', params: { sid: 's-a', cwd: '/work/repo' }, timeoutMs: 20_000 }])
  })

  it('says why there is no Turns view: no cwd, no daemon, a daemon without the capability', async () => {
    expect((await request(app()).get('/api/sessions/s-nocwd/turns')).body).toEqual({ supported: false, reason: 'no_cwd' })
    state.caps.clear()
    expect((await request(app()).get('/api/sessions/s-a/turns')).body).toMatchObject({ supported: false, reason: 'daemon_upgrade' })
    state.connected = false
    expect((await request(app()).get('/api/sessions/s-a/turns')).body).toMatchObject({ supported: false, reason: 'no_daemon' })
    expect(state.sent).toEqual([])
    expect((await request(app()).get('/api/sessions/nope/turns')).status).toBe(404)
    // A remote host nobody configured is "no daemon", without a dial.
    state.connected = true
    state.records.set('s-remote', { claudeSessionId: 's-remote', cwd: '/work/repo', host: 'devbox', lastActiveAt: iso(0) })
    expect((await request(app()).get('/api/sessions/s-remote/turns')).body).toMatchObject({ supported: false, reason: 'no_daemon', host: 'devbox' })
  })

  it('uses the live connection whose handshake listed the capability when the pooled one did not', async () => {
    state.bareFirst = true
    state.reply = () => ({ ok: true, enabled: true, repoRoot: '/work/repo', snapshots: [], skipped: [], lastTurnEndAt: null })
    const res = await request(app()).get('/api/sessions/s-a/turns')
    expect(res.body).toMatchObject({ supported: true, repoRoot: '/work/repo' })
    expect(state.sent.map((s) => s.cmd)).toEqual(['turns.list'])
  })

  it('a daemon that never answers is a 504, not a hang', async () => {
    state.reply = () => new Error('daemon command timeout: turns.list (20000ms)')
    const res = await request(app()).get('/api/sessions/s-a/turns')
    expect(res.status).toBe(504)
    expect(res.body.code).toBe('timeout')
  })
})

describe('GET /api/sessions/:id/turns/:n/diff', () => {
  it('passes the turn, the path and the comparison; refuses a bad request before the daemon', async () => {
    state.reply = () => ({ ok: true, path: 'a.ts', before: 'x', after: 'y', status: 'modified', fromN: 0, toN: 1 })
    const res = await request(app()).get('/api/sessions/s-a/turns/1/diff').query({ path: 'a.ts', against: 'worktree' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ path: 'a.ts', before: 'x', after: 'y' })
    expect(state.sent[0].params).toEqual({ sid: 's-a', cwd: '/work/repo', n: 1, path: 'a.ts', against: 'worktree' })
    expect((await request(app()).get('/api/sessions/s-a/turns/1/diff')).status).toBe(400)
    expect((await request(app()).get('/api/sessions/s-a/turns/-2/diff').query({ path: 'a' })).status).toBe(400)
    expect(state.sent).toHaveLength(1)
  })

  it("maps the core's error codes", async () => {
    state.reply = () => ({ ok: false, error: 'turns.diff failed: no snapshot 9', code: 'not-found' })
    const res = await request(app()).get('/api/sessions/s-a/turns/9/diff').query({ path: 'a.ts' })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'no snapshot 9', code: 'not_found' })
    state.reply = () => ({ ok: false, error: 'turns.diff failed: bad path', code: 'bad-request' })
    expect((await request(app()).get('/api/sessions/s-a/turns/1/diff').query({ path: '../x' })).status).toBe(400)
  })
})

describe('POST /api/sessions/:id/turns/:n/restore', () => {
  it('a dry run and a real restore; selected paths ride along', async () => {
    state.reply = (_c, p) => ({ ok: true, n: p.n, write: ['a.ts'], delete: [], keep: [], dryRun: p.dryRun === true, backupN: p.dryRun ? null : 4, afterN: p.dryRun ? null : 5 })
    const dry = await request(app()).post('/api/sessions/s-a/turns/2/restore').send({ dry_run: true })
    expect(dry.body).toMatchObject({ dryRun: true, write: ['a.ts'], backupN: null })
    const done = await request(app()).post('/api/sessions/s-a/turns/2/restore').send({ paths: ['a.ts', 7] })
    expect(done.body).toMatchObject({ dryRun: false, backupN: 4, afterN: 5 })
    expect(state.sent.map((s) => s.params)).toEqual([
      { sid: 's-a', cwd: '/work/repo', n: 2, dryRun: true },
      { sid: 's-a', cwd: '/work/repo', n: 2, paths: ['a.ts'] },
    ])
  })

  it('refuses while a turn runs (409 turn_running) and while git is busy (409 repo_busy)', async () => {
    state.reply = () => ({ ok: false, error: 'turns.restore failed: a turn of this session is running; restore after it ends', code: 'turn-running' })
    const running = await request(app()).post('/api/sessions/s-a/turns/2/restore').send({})
    expect(running.status).toBe(409)
    expect(running.body).toMatchObject({ code: 'turn_running', error: 'a turn of this session is running; restore after it ends' })
    state.reply = () => ({ ok: false, error: 'git is busy', code: 'index-locked' })
    const busy = await request(app()).post('/api/sessions/s-a/turns/2/restore').send({})
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ code: 'repo_busy', reason: 'index-locked' })
  })
})

describe('POST /api/sessions/:id/rewind/guard', () => {
  it('sends the files and the ranked sibling sessions; answers the guard', async () => {
    state.recent = [
      { claudeSessionId: 's-a', cwd: '/work/repo', lastActiveAt: iso(0) },
      { claudeSessionId: 's-b', cwd: '/work/repo', title: 'B', lastActiveAt: iso(60_000) },
      { claudeSessionId: 's-c', cwd: '/work/repo/sub', title: 'C', lastActiveAt: iso(1000) },
      { claudeSessionId: 's-remote', cwd: '/work/repo', host: 'devbox', lastActiveAt: iso(0) },
      { claudeSessionId: 's-codex', cwd: '/work/repo', engine: 'codex', lastActiveAt: iso(0) },
      { claudeSessionId: 's-old', cwd: '/work/repo', lastActiveAt: iso(30 * 24 * 3600_000) },
      { claudeSessionId: 's-far', cwd: '/elsewhere', lastActiveAt: iso(0) },
    ]
    const guard = { checked: true, repoRoot: '/work/repo', partial: false, files: [], conflicts: [{ path: '/work/repo/a.ts', rel: 'a.ts', exists: true, writers: [{ sid: 's-b', title: 'B', consistent: true }], conflict: true }] }
    state.reply = () => ({ id: 3, ok: true, ...guard })
    const res = await request(app()).post('/api/sessions/s-a/rewind/guard').send({ files: ['/work/repo/a.ts', 'relative.ts', 9] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ guard })
    expect(state.sent[0]).toMatchObject({ cmd: 'turns.guard', timeoutMs: 10_000 })
    expect(state.sent[0].params).toEqual({
      sid: 's-a', cwd: '/work/repo', files: ['/work/repo/a.ts'],
      siblings: [
        { sid: 's-c', cwd: '/work/repo/sub', title: 'C' },
        { sid: 's-b', cwd: '/work/repo', title: 'B' },
      ],
    })
  })

  it('degrades to guard: null when the guard cannot answer', async () => {
    state.caps.clear()
    expect((await request(app()).post('/api/sessions/s-a/rewind/guard').send({ files: ['/work/repo/a.ts'] })).body).toEqual({ guard: null, reason: 'daemon_upgrade' })
    state.caps.add('turn-snapshot-v1')
    state.reply = () => new Error('daemon command timeout: turns.guard (10000ms)')
    expect((await request(app()).post('/api/sessions/s-a/rewind/guard').send({ files: ['/work/repo/a.ts'] })).body).toEqual({ guard: null, reason: 'timeout' })
    state.reply = () => ({ ok: false, error: 'boom' })
    expect((await request(app()).post('/api/sessions/s-a/rewind/guard').send({ files: ['/work/repo/a.ts'] })).body).toEqual({ guard: null, reason: 'error' })
    expect((await request(app()).post('/api/sessions/s-nocwd/rewind/guard').send({ files: [] })).body).toEqual({ guard: null, reason: 'no_cwd' })
  })

  it('caps the siblings at twelve', async () => {
    state.recent = Array.from({ length: 30 }, (_, i) => ({ claudeSessionId: `s-${i}`, cwd: '/work/repo', lastActiveAt: iso(i * 1000) }))
    const sibs = await siblingSessions(state.records.get('s-a') as never, NOW)
    expect(sibs).toHaveLength(12)
    expect(sibs[0].sid).toBe('s-0')
  })
})

describe('turn snapshot settings push', () => {
  it('reads session.turn_snapshots with defaults and bounds', () => {
    expect(turnSnapshotSettingsFrom({})).toEqual({ enabled: true, keep: 100 })
    expect(turnSnapshotSettingsFrom({ session: { turn_snapshots: { enabled: false } } })).toEqual({ enabled: false, keep: 100 })
    expect(turnSnapshotSettingsFrom({ session: { turn_snapshots: { keep: 0 } } })).toEqual({ enabled: true, keep: 100 })
    expect(turnSnapshotSettingsFrom({ session: { turn_snapshots: { keep: 50_000.7 } } })).toEqual({ enabled: true, keep: 10_000 })
  })

  it('pushes once per host until the value or the connection changes; never to a daemon without the capability', async () => {
    stopTurnSnapshotSettingsSync()
    state.reply = (_c, p) => ({ ok: true, enabled: p.enabled, keep: p.keep, changed: true })
    await pushTurnSnapshotSettings('__local__')
    await pushTurnSnapshotSettings('__local__')
    expect(state.sent.filter((s) => s.cmd === 'turns.configure')).toHaveLength(1)
    expect(state.sent[0].params).toEqual({ enabled: true, keep: 100 })
    stopTurnSnapshotSettingsSync() // clears what was pushed: a reconnect pushes again
    state.bareFirst = true // the pool entry lacks the capability; the capable twin gets it
    await pushTurnSnapshotSettings('__local__')
    expect(state.sent.filter((s) => s.cmd === 'turns.configure')).toHaveLength(2)
    stopTurnSnapshotSettingsSync()
    state.sent = []
    state.caps.clear()
    await pushTurnSnapshotSettings('__local__')
    expect(state.sent).toHaveLength(0)
  })
})
