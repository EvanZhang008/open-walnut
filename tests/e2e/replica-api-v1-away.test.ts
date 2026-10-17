/**
 * The iOS app's `/api/v1` calls against a host replica while the Mac sleeps
 * (docs/plan/walnut-replica-servers-impl.md, WP7 and row R29): every call is
 * answered from the replica's copies (200, `x-walnut-offline`) or refused with
 * `503 needs_leader` and its reason, never another 5xx; a task edit and a create
 * are kept on the host for the Mac (WP10); and once the Mac wakes, the same calls
 * reach it again, the away writes are on it, and a write goes through.
 *
 * Every piece is a real process (tests/helpers/replica-cluster.ts): a
 * non-ephemeral Mac server child with its own daemon, a host daemon twin, and
 * the replica that daemon starts from the Mac's own `server.configure`. The Mac
 * sleeps by SIGSTOP (its sockets stay open and go silent), as a lid close does.
 * The phone's token is made on the Mac and reaches the replica in the device round.
 *
 * Twins: both (source, then standalone) when bun is on this machine, the source
 * twin alone otherwise; REPLICA_CLUSTER_TWINS=source|standalone|source,standalone picks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUN, HOST_TURN, startReplicaCluster, WINDOWS, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')

describe.each(TWINS)('the iOS app against a host replica with the Mac asleep (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let madeId = ''
  const answered: Array<{ call: string; status: number }> = []
  /** This host's session, read while the Mac answers (WP6's routes, live on the host). */
  const HOST_READS = ['/api/v1/sessions/{HOST}/history?tail=50', '/api/v1/sessions/{HOST}/transcript', '/api/v1/sessions/{HOST}/transcript?before=2026-01-01T00:00:00.000Z']
  const awakeHostReads = new Map<string, string>()
  const hostRead = (p: string) => p.replace('{HOST}', c.ids.hostSid)
  /** An answer with its time stamp left out (a transcript's `exportedAt` is when it was made). */
  const same = (text: string) => { const j = JSON.parse(text) as Record<string, unknown>; delete j.exportedAt; return j }

  /** One call as the phone makes it; every answer is recorded for the no-5xx check. */
  async function phone(method: string, p: string, body?: unknown) {
    const r = await c.replica(method, p, { token, ...(body === undefined ? {} : { body }) })
    answered.push({ call: `${method} ${p}`, status: r.status })
    return r
  }
  const away = (r: { headers: Record<string, unknown> }) => {
    expect(Number(r.headers['x-walnut-offline'])).toBeGreaterThan(0)
    expect(r.headers['x-walnut-answered-via']).toBe('replica')
  }
  const needsLeader = (r: { status: number; json: any }, why: string) => {
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why, retryAfter: 5 })
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    token = await c.pairDevice('acme-phone')
    // Awake: forwarded to the Mac.
    const awake = await c.replica('GET', '/api/v1/tasks', { token })
    expect(awake.status).toBe(200)
    expect(awake.headers['x-walnut-answered-via']).toBe('leader')
    for (const p of HOST_READS) {
      const r = await c.replica('GET', hostRead(p), { token })
      expect(r.status, `${p}: ${r.text.slice(0, 200)}`).toBe(200)
      awakeHostReads.set(p, r.text)
    }
    c.sleepMac()
    const ms = await c.waitAway(token)
    // Within the quiet window plus the 5 s the plan allows (and the poll's own step).
    expect(ms).toBeLessThan(WINDOWS.quietMs + 5_000 + 1_000)
    // Away for writes too (WP10): the quiet window has passed (`away`), not one failed
    // stream (`suspect`: reads come from the copies, a write is still forwarded to the Mac).
    const t0 = Date.now()
    for (;;) {
      const r = await c.replica('GET', '/api/v1/tasks', { token })
      if (r.headers['x-walnut-offline-why'] === 'away') break
      if (Date.now() - t0 > 60_000) throw new Error(`the replica never said away: ${String(r.headers['x-walnut-offline-why'])}`)
      await new Promise((ok) => setTimeout(ok, 250))
    }
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('status, instance and me answer from the replica', async () => {
    const status = await phone('GET', '/api/v1/status')
    expect(status.status).toBe(200)
    away(status)
    const instance = await phone('GET', '/api/v1/instance')
    expect(instance.status).toBe(200)
    const me = await phone('GET', '/api/v1/me')
    expect(me.status).toBe(200)
    away(me)
  })

  it('devices/self needs the Mac', async () => {
    needsLeader(await phone('POST', '/api/v1/devices/self', { name: 'acme-phone', platform: 'ios' }), 'device_changes_need_mac')
  })

  it('the task list and one task come from the copy, Unicode titles byte exact', async () => {
    const list = await phone('GET', '/api/v1/tasks')
    expect(list.status).toBe(200)
    away(list)
    const titles = JSON.stringify(list.json)
    expect(titles).toContain('Release plan')
    expect(titles).toContain('Fix the flaky build \u00e9t\u00e9')
    const one = await phone('GET', `/api/v1/tasks/${c.ids.board}`)
    expect(one.status).toBe(200)
    away(one)
    expect(JSON.stringify(one.json)).toContain('Ship on Friday after the rollback drill.')
  })

  it('a task edit and a create are kept on this host for the Mac (WP10), and a delete needs the Mac', async () => {
    const edit = await phone('PATCH', `/api/v1/tasks/${c.ids.board}`, { title: 'Release plan, moved' })
    expect(edit.status, edit.text.slice(0, 300)).toBe(200)
    expect(edit.json).toMatchObject({ queued: true, offline: true, task: { id: c.ids.board, title: 'Release plan, moved', replica_sync: 'pending' } })
    const made = await phone('POST', '/api/v1/tasks', { title: 'Made on the phone' })
    expect(made.status, made.text.slice(0, 300)).toBe(201)
    madeId = made.json.task.id as string
    // The list the phone reads next shows both, with their marks.
    const list = await phone('GET', '/api/v1/tasks')
    away(list)
    const rows = list.json.tasks as Array<{ id: string; title: string; replica_sync?: string }>
    expect(rows.find((t) => t.id === c.ids.board)).toMatchObject({ title: 'Release plan, moved', replica_sync: 'pending' })
    expect(rows.find((t) => t.id === madeId)).toMatchObject({ title: 'Made on the phone', replica_sync: 'pending' })
    needsLeader(await phone('DELETE', `/api/v1/tasks/${c.ids.board}`), 'task_writes_need_mac')
  })

  it('the session list comes from the copy; a send needs the Mac', async () => {
    const list = await phone('GET', '/api/v1/sessions')
    expect(list.status).toBe(200)
    away(list)
    const text = JSON.stringify(list.json)
    expect(text).toContain(c.ids.macSid)
    expect(text).toContain(c.ids.hostSid)
    // No process field reaches a copy.
    expect(text).not.toMatch(/"pid"\s*:/)
    // This host's session is not running (it ran one turn and stopped): the daemon says so, nothing is kept.
    const send = await phone('POST', `/api/v1/sessions/${c.ids.hostSid}/messages`, { text: 'hello' })
    expect(send.status, send.text.slice(0, 300)).toBe(409)
    expect(send.json.error).toMatchObject({ code: 'not_running' })
    // Pictures reach a session only through the Mac: refused whole, never answered 202 with them dropped.
    needsLeader(await phone('POST', `/api/v1/sessions/${c.ids.hostSid}/messages`, { text: 'see this', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }), 'images_need_mac')
    // A Mac session's composer stays the Mac's.
    needsLeader(await phone('POST', `/api/v1/sessions/${c.ids.macSid}/messages`, { text: 'hello' }), 'session_on_mac')
  })

  it('a Mac session\'s history and transcript need the Mac (they are on it)', async () => {
    needsLeader(await phone('GET', `/api/v1/sessions/${c.ids.macSid}/history`), 'session_on_mac')
    needsLeader(await phone('GET', `/api/v1/sessions/${c.ids.macSid}/transcript`), 'session_on_mac')
  })

  it('this host\'s session: its history, transcript and an older page are read on the host, the same answers as while the Mac answered', async () => {
    const rich = await phone('GET', `/api/v1/sessions/${c.ids.hostSid}/history?tail=50`)
    expect(rich.status).toBe(200)
    const rows = (rich.json.messages as Array<{ role: string; text: string }>).map((m) => `${m.role}: ${m.text}`)
    expect(rows).toEqual([`user: ${HOST_TURN.asked}`, `assistant: ${HOST_TURN.answered}`])
    const slim = await phone('GET', `/api/v1/sessions/${c.ids.hostSid}/transcript`)
    expect(slim.status).toBe(200)
    expect(slim.text).toContain(HOST_TURN.asked)
    expect(slim.text).toContain(HOST_TURN.answered)
    // WP6's routes, live on this host (not a copy, so no copy age): the answers the Mac's presence never changed.
    for (const p of HOST_READS) {
      const r = await phone('GET', hostRead(p))
      expect(r.status, `${p}: ${r.text.slice(0, 200)}`).toBe(200)
      expect(r.headers['x-walnut-offline'], p).toBeUndefined()
      expect(same(r.text), p).toEqual(same(awakeHostReads.get(p)!))
    }
  })

  it('no call was answered with a 5xx other than 503 needs_leader', () => {
    const bad = answered.filter((a) => a.status >= 500 && a.status !== 503)
    expect(bad).toEqual([])
  })

  it('the Mac wakes: the same calls reach it again, the away writes are on it, and an edit goes through', async () => {
    c.wakeMac()
    await c.waitBack(token)
    const made = await c.mac('GET', `/api/v1/tasks/${madeId}`)
    expect(made.status).toBe(200)
    expect(JSON.stringify(made.json)).toContain('Made on the phone')
    expect(JSON.stringify(made.json)).not.toContain('replica_sync')
    const moved = await c.mac('GET', `/api/v1/tasks/${c.ids.board}`)
    expect(JSON.stringify(moved.json)).toContain('Release plan, moved')
    const edit = await c.replica('PATCH', `/api/v1/tasks/${c.ids.board}`, { token, body: { title: 'Release plan, after the wake' } })
    expect(edit.status).toBe(200)
    expect(edit.headers['x-walnut-answered-via']).toBe('leader')
    const mine = await c.mac('GET', `/api/v1/tasks/${c.ids.board}`)
    expect(JSON.stringify(mine.json)).toContain('Release plan, after the wake')
  })
})
