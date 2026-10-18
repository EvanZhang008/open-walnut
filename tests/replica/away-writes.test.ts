/**
 * The away routes of a host replica (src/replica/away-writes.ts, away-reads.ts, WP10)
 * as one express app over the REAL write port, overlay, offline host and journal v2:
 * the request a person's console or phone makes, what the journal then holds, and
 * what the next read shows. The dispatcher's part (marking the request an away
 * write, src/replica/dispatch.ts) is stood in for by setting req.replicaWrite to a
 * linkWrite over the real offline host; the copy's own routes by a route that
 * answers the copy's rows the way the replica's task routes do.
 *
 * Pinned: every journaling row of the route table has a handler here and no handler
 * lacks a row; a request with no away write goes on to the real routes; a reorder is
 * one move with its anchor (more than one needs the Mac); a send to a Mac session
 * needs the Mac; a device removing itself leaves the device copy at once; reads show
 * the overlay and its mark only on answers made from the copies.
 */
import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { JHOME, TASK_A, TASK_B, SID_A, journalTmpDir, cleanupJournalDirs, journalHost, jslice, journalLines } from '../helpers/offline-journal-harness.js'
import { ROUTE_TABLE, classify, journals } from '../../src/replica/route-table.js'
import { AWAY_WRITE_PATTERNS, awayWrites, singleMove } from '../../src/replica/away-writes.js'
import { ASK_LAUNCH_PATTERNS } from '../../src/replica/ask-launch.js'
import { awayReads, overlayTiers } from '../../src/replica/away-reads.js'
import { createOverlay } from '../../src/replica/overlay.js'
import { createWritePort, type TaskRow } from '../../src/replica/write-port.js'
import { linkWrite } from '../../src/replica/ws-writes.js'
import { applyVoiceReply, VOICE_REPLY_MARKER } from '../../src/core/sessions/voice-reply.js'
import { createDeviceCopy } from '../../src/host-server/device-copy.js'
import type { OfflineJournalDeps } from '../../src/providers/offline-journal-core.js'
import { isLeaderWords, leaderErrorMessage } from '../../web/src/api/leader-presence'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE_TOKEN = 'marina-phone-token-0001'
const TABLET_TOKEN = 'acme-tablet-token-0002'

afterEach(() => cleanupJournalDirs())

function rig(delivered: string[] = [], opts: { journal?: Partial<OfflineJournalDeps> } = {}) {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const { host } = journalHost(dir, clock, { boards: true, deliver: async (_sid, body) => { delivered.push(body); return { ok: true } }, ...(opts.journal ? { journal: opts.journal } : {}) })
  host.configure(jslice({ boards: [{ taskId: TASK_A, html: '<p id="build">Build: green</p>', version: 2, threads: {} }] }))
  const copy: TaskRow[] = [
    { id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', pinned: true, pin_order: 0, focus_tier: 'focus' },
    { id: TASK_B, title: 'Worker: build the page', phase: 'IN_PROGRESS', project: 'Acme', pinned: true, pin_order: 1 },
    { id: 'mtaskccc-0003', title: 'Release plan', phase: 'TODO', project: 'Acme', pinned: true, pin_order: 2 },
  ]
  // The copy's Focus bar, as task-manager.ts splitTiers makes it (no custom tiers here).
  const copyTiers = () => {
    const pinned = copy.filter((t) => t.pinned === true).sort((a, b) => Number(a.pin_order) - Number(b.pin_order))
    const of = (tier: string) => pinned.filter((t) => t.focus_tier === tier).map((t) => t.id)
    return { pinned_tasks: pinned.map((t) => t.id), focus_tasks: of('focus'), wait_tasks: of('wait'), backlog_tasks: [], custom_tier_tasks: {},
      satellite_tasks: pinned.filter((t) => t.focus_tier !== 'focus' && t.focus_tier !== 'wait').map((t) => t.id) }
  }
  const devices = createDeviceCopy(path.join(dir, 'replica', 'devices.json'))
  devices.put({ devices: [
    { id: 'dev-marina-phone', name: 'Marina phone', tokenHash: sha(PHONE_TOKEN) },
    { id: 'dev-acme-tablet', name: 'Acme tablet', tokenHash: sha(TABLET_TOKEN) },
  ] })
  const reqLink = async (_cmd: string, params: Record<string, unknown>) => {
    const r = _cmd === 'follower.op' ? host.handleFollower(JHOME, params as never)
      : _cmd === 'follower.send' ? await host.deliverHuman(JHOME, String(params.sid), params.text, params.messageId)
      : { ok: false as const, error: { code: 'not_found', message: 'no such command here' } }
    return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code, ...(r.error.detail !== undefined ? { detail: r.error.detail } : {}) }
  }
  const overlay = createOverlay({ fetchPending: async () => host.pendingFor(JHOME, 0) as never, now: () => clock.now })
  const shown = async (id: string) => { await overlay.refresh(); return overlay.task(id, copy.find((t) => t.id === id) ?? null) as TaskRow | null }
  const port = createWritePort({ task: shown, board: async () => null, noteWritten: (e) => overlay.noteWritten(e), now: () => clock.now })
  const app = express()
  app.use(express.json())
  // The dispatcher's mark, for every write (the real one sets it only on a journaling row while away).
  app.use((req, res, next) => {
    if (req.method !== 'GET') req.replicaWrite = linkWrite({ request: reqLink, linked: () => true, log: () => {} }, String(req.headers['x-walnut-op-id'] ?? '') || undefined)
    if (req.headers['x-test-away'] === '1') res.setHeader('x-walnut-answered-via', 'replica')
    next()
  })
  app.use('/api', awayReads({ overlay, answeredAway: (res) => res.getHeader('x-walnut-answered-via') === 'replica' }))
  app.use('/api', awayWrites({
    port, task: shown, tiers: async () => { await overlay.refresh(); return overlayTiers(copyTiers(), overlay) },
    actorOf: (req) => { const h = String(req.headers.authorization ?? ''); const d = devices.verifyDevice(h.replace(/^Bearer /, '')); return d?.id ? { kind: 'device', deviceId: d.id, name: d.name } : null },
    sessionHere: async (sid) => sid === SID_A,
    revokeLocally: (id) => { devices.revoke(id) },
    log: () => {},
  }))
  // The copy's own reads (what the replica's task routes answer from the copy).
  app.get('/api/tasks', (_req, res) => { res.json({ tasks: copy.map((t) => ({ ...t })) }) })
  app.get('/api/focus/tasks', (_req, res) => { res.json(copyTiers()) })
  app.get('/api/tasks/:id', (req, res) => { const t = copy.find((x) => x.id === req.params.id); if (!t) { res.status(404).json({ error: 'Task not found' }); return } res.json({ task: { ...t } }) })
  app.post('/api/tasks/groups', (_req, res) => { res.status(299).json({ reached: 'the real route' }) })
  // TASK_B is TASK_A's worker: its team Board (?team=1) is the leader's, as board-v1.ts answers it.
  app.get('/api/v1/tasks/:id/board', (req, res) => { res.json({ board_task_id: req.params.id === TASK_B && req.query.team === '1' ? TASK_A : req.params.id, board: { html: '<p id="build">Build: green</p>', version: 2, updated_at: '2026-10-14T11:00:00.000Z', updated_by: 'human' }, threads: {}, marks: {}, board_version: 2 }) })
  const records = () => journalLines(dir).map((l) => JSON.parse(l)).filter((r) => typeof r.seq === 'number')
  return { dir, host, app, records, devices, copy, clock }
}

const auth = { authorization: `Bearer ${PHONE_TOKEN}` }

describe('away routes: the table and the handlers agree', () => {
  it('every journaling row of the route table has a handler, and every handler a row', () => {
    const sample = (p: string) => p.replace(/:([a-z]+)/gi, (_m, n: string) => `${n}-1`)
    // Each handler's path journals by the table (a row of its own, or the exact row that covers it).
    for (const h of AWAY_WRITE_PATTERNS) expect(classify(h.method, sample(h.pattern)).away, `${h.method} ${h.pattern}`).toBe('host-write')
    // Each journaling row is a handler's.
    const handled = new Set(AWAY_WRITE_PATTERNS.map((r) => `${r.method} ${r.pattern}`))
    for (const r of ROUTE_TABLE.filter((x) => x.away === 'host-write')) expect(handled.has(`${r.method} ${r.pattern}`), `${r.method} ${r.pattern}`).toBe(true)
    // The only other journaling kinds: WP11's note writes (tests/replica/away-notes.test.ts) and
    // WP12's new ask (replica/ask-launch.ts answers exactly its rows).
    expect(ROUTE_TABLE.filter((r) => journals(r.away) && r.away !== 'host-write' && r.away !== 'note-write').map((r) => `${r.away} ${r.method} ${r.pattern}`))
    .toEqual(ASK_LAUNCH_PATTERNS.map((r) => `queue:ask ${r.method} ${r.pattern}`))
  })

  it('a reorder is one move with its anchor; more than one move is not', () => {
    expect(singleMove(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd'])).toEqual({ taskId: 'c', anchor: { after: 'a' } })
    expect(singleMove(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])).toEqual({ taskId: 'd', anchor: { before: 'a' } })
    expect(singleMove(['x', 'a', 'b', 'c'], ['b', 'a', 'c'])).toEqual({ taskId: 'b', anchor: { before: 'a' } })
    expect(singleMove(['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'c'])).toBeNull()
    expect(singleMove(['a', 'b'], ['a', 'b'])).toBeNull()
    expect(singleMove(['a', 'b'], ['a', 'z'])).toBeNull()
    // A task made here (not in the old order) is left out; the move of a known task still reads.
    expect(singleMove(['a', 'b', 'c'], ['new1', 'c', 'a', 'b'])).toEqual({ taskId: 'c', anchor: { before: 'a' } })
  })
})

describe('away routes: what a person\'s write becomes', () => {
  it('an edit, a create and a complete journal; the next read shows them with their marks; a 404 of a task made here answers it', async () => {
    const r = rig()
    const edit = await request(r.app).patch(`/api/tasks/${TASK_A}`).set(auth).set('x-walnut-op-id', 'op-console-edit-0001').send({ title: 'Leader work, renamed' })
    expect(edit.status).toBe(200)
    expect(edit.body.task).toMatchObject({ id: TASK_A, title: 'Leader work, renamed', replica_sync: 'pending' })
    const made = await request(r.app).post('/api/tasks').set(auth).send({ title: 'Book the rollback room', project: 'Acme' })
    expect(made.status).toBe(201)
    const madeId = made.body.task.id as string
    const done = await request(r.app).post(`/api/tasks/${TASK_B}/complete`).set(auth)
    expect(done.status).toBe(200)
    expect(r.records().map((x) => [x.kind, x.opId === 'op-console-edit-0001' ? 'kept' : 'minted'])).toEqual([
      ['task-fields', 'kept'], ['task-create', 'minted'], ['task-fields', 'minted'],
    ])
    const list = await request(r.app).get('/api/tasks').set(auth).set('x-test-away', '1')
    const byId = new Map((list.body.tasks as Array<{ id: string }>).map((t) => [t.id, t]))
    expect(byId.get(TASK_A)).toMatchObject({ title: 'Leader work, renamed', replica_sync: 'pending' })
    expect(byId.get(TASK_B)).toMatchObject({ phase: 'COMPLETE', replica_sync: 'pending' })
    // Made by a person: pinned, as the Mac's create pins it (the bottom of the board, Satellite).
    expect(byId.get(madeId)).toMatchObject({ title: 'Book the rollback room', replica_sync: 'pending', pinned: true })
    expect(byId.get('mtaskccc-0003')).not.toHaveProperty('replica_sync')
    // The board's own list (web/src/api/tasks.ts fetchTaskList) names a window for completed
    // tasks: a task made here is new, so it is in every window.
    const board = await request(r.app).get('/api/tasks?fields=list&completedWithinDays=7').set(auth).set('x-test-away', '1')
    expect((board.body.tasks as Array<{ id: string }>).find((t) => t.id === madeId)).toMatchObject({ replica_sync: 'pending' })
    const searched = await request(r.app).get('/api/tasks?q=rollback').set(auth).set('x-test-away', '1')
    expect((searched.body.tasks as Array<{ id: string }>).some((t) => t.id === madeId)).toBe(false)
    const bar = await request(r.app).get('/api/focus/tasks').set(auth).set('x-test-away', '1')
    expect(bar.body).toMatchObject({ pinned_tasks: [TASK_A, TASK_B, 'mtaskccc-0003', madeId], satellite_tasks: [TASK_B, 'mtaskccc-0003', madeId], focus_tasks: [TASK_A] })
    const one = await request(r.app).get(`/api/tasks/${madeId}`).set(auth).set('x-test-away', '1')
    expect(one.status).toBe(200)
    expect(one.body.task).toMatchObject({ id: madeId, replica_sync: 'pending' })
    // An answer the Mac made (forwarded) is never touched.
    const mac = await request(r.app).get('/api/tasks').set(auth)
    expect(JSON.stringify(mac.body)).not.toContain('replica_sync')
  })

  it('a Focus bar move of one task journals a task-move and answers the whole bar; a tier change too; more than one move needs the Mac', async () => {
    const r = rig()
    const ok = await request(r.app).put('/api/focus/reorder').set(auth).send({ task_ids: ['mtaskccc-0003', TASK_A, TASK_B] })
    expect(ok.status).toBe(200)
    // The Mac's TierResult shape (a pinned-only answer once wiped every tier in the console).
    expect(ok.body).toMatchObject({ pinned_tasks: ['mtaskccc-0003', TASK_A, TASK_B], focus_tasks: [TASK_A], satellite_tasks: ['mtaskccc-0003', TASK_B], wait_tasks: [], custom_tier_tasks: {} })
    expect(r.records()[0]).toMatchObject({ kind: 'task-move', taskId: 'mtaskccc-0003', anchor: { before: TASK_A } })
    const tier = await request(r.app).put(`/api/focus/tasks/${TASK_B}/tier`).set(auth).send({ tier: 'wait' })
    expect(tier.status).toBe(200)
    expect(tier.body).toMatchObject({ wait_tasks: [TASK_B], satellite_tasks: ['mtaskccc-0003'] })
    expect(r.records()[1]).toMatchObject({ kind: 'task-move', taskId: TASK_B, anchor: null, tier: 'wait', base: { focus_tier: 'unknown' } })
    // The bar read from the copies shows both, in order.
    const bar = await request(r.app).get('/api/focus/tasks').set(auth).set('x-test-away', '1')
    expect(bar.body).toMatchObject({ pinned_tasks: ['mtaskccc-0003', TASK_A, TASK_B], focus_tasks: [TASK_A], wait_tasks: [TASK_B], satellite_tasks: ['mtaskccc-0003'] })
    // A task list keeps the copy's order: the move's anchor is a place in the bar, not in a list.
    const list = await request(r.app).get('/api/tasks').set(auth).set('x-test-away', '1')
    expect(list.body.tasks.map((t: { id: string }) => t.id)).toEqual([TASK_A, TASK_B, 'mtaskccc-0003'])
    // Two moves at once (the bar reversed): the Mac's.
    const two = await request(r.app).put('/api/focus/reorder').set(auth).send({ task_ids: [TASK_B, TASK_A, 'mtaskccc-0003'] })
    expect(two.status).toBe(503)
    expect(two.body.error).toMatchObject({ code: 'needs_leader', why: 'reorder_needs_mac' })
    // An unpin answers the pins as they now show, folded in seq order as the Mac drains them.
    const unpin = await request(r.app).delete(`/api/focus/tasks/${TASK_A}`).set(auth)
    expect(unpin.status).toBe(200)
    expect(unpin.body.pinned_tasks).toEqual(['mtaskccc-0003', TASK_B])
    expect(r.records()).toHaveLength(3)
    // The Mac's checks, before anything is journaled (the drain would skip these silently).
    const badTier = await request(r.app).put(`/api/focus/tasks/${TASK_B}/tier`).set(auth).send({ tier: 'someday-maybe' })
    expect(badTier.status).toBe(400)
    expect(badTier.body.error).toMatchObject({ code: 'bad_request' })
    const unpinnedTier = await request(r.app).put(`/api/focus/tasks/${TASK_A}/tier`).set(auth).send({ tier: 'focus' })
    expect(unpinnedTier.status).toBe(400)
    expect(unpinnedTier.body.error.message).toMatch(/not pinned/)
    // A retired built-in name lands in its successor, as on the Mac.
    const retired = await request(r.app).put(`/api/focus/tasks/${TASK_B}/tier`).set(auth).send({ tier: 'backlog' })
    expect(retired.status).toBe(200)
    expect(retired.body.wait_tasks).toEqual([TASK_B])
    expect(r.records()).toHaveLength(4)
    expect(r.records()[3]).toMatchObject({ kind: 'task-move', taskId: TASK_B, tier: 'wait' })
    // Pinning a pinned task: the bar as it is, nothing journaled.
    const again = await request(r.app).post(`/api/focus/tasks/${TASK_B}`).set(auth)
    expect(again.status).toBe(200)
    expect(again.body.pinned_tasks).toEqual(['mtaskccc-0003', TASK_B])
    expect(r.records()).toHaveLength(4)
    // A completed task cannot be pinned (409 on the Mac too).
    expect((await request(r.app).post(`/api/tasks/${TASK_A}/complete`).set(auth)).status).toBe(200)
    const done = await request(r.app).post(`/api/focus/tasks/${TASK_A}`).set(auth)
    expect(done.status).toBe(409)
    expect(r.records()).toHaveLength(5)
    // A path no away handler names: needs the Mac (the table never marks it, but the router is safe anyway).
    const other = await request(r.app).post('/api/tasks/groups').set(auth).send({})
    expect(other.status).toBe(503)
    expect(other.body.error).toMatchObject({ why: 'needs_mac' })
    // A list's own order is no away write at all (the table: list_order_needs_mac).
    expect(classify('PATCH', '/api/tasks/reorder')).toMatchObject({ away: 'needs-leader', why: 'list_order_needs_mac' })
    expect(classify('PATCH', '/api/v1/tasks/reorder')).toMatchObject({ away: 'needs-leader', why: 'list_order_needs_mac' })
  })

  it('a send to this host\'s session goes to the daemon; to a Mac session it needs the Mac; a Board post journals', async () => {
    const delivered: string[] = []
    const r = rig(delivered)
    const mac = await request(r.app).post('/api/v1/sessions/mac-session-0001/messages').set(auth).send({ text: 'hello' })
    expect(mac.status).toBe(503)
    expect(mac.body.error).toMatchObject({ why: 'session_on_mac' })
    const here = await request(r.app).post(`/api/v1/sessions/${SID_A}/messages`).set(auth).set('x-walnut-op-id', 'op-console-send-0001').send({ text: 'Ship it after the drill' })
    expect(here.status).toBe(202)
    expect(here.body).toMatchObject({ delivered: true, messageId: 'qm-op-console-send-0001' })
    // Asked again (a lost answer): delivered once.
    const again = await request(r.app).post(`/api/v1/sessions/${SID_A}/messages`).set(auth).set('x-walnut-op-id', 'op-console-send-0001').send({ text: 'Ship it after the drill' })
    expect(again.status).toBe(202)
    expect(delivered).toEqual(['Ship it after the drill'])
    // Pictures ride only through the Mac: refused whole (never 202 with the pictures dropped), with or without text.
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    for (const b of [{ text: 'See the screenshot', images: [image] }, { images: [image] }]) {
      const pic = await request(r.app).post(`/api/v1/sessions/${SID_A}/messages`).set(auth).send(b)
      expect(pic.status).toBe(503)
      expect(pic.body.error).toMatchObject({ code: 'needs_leader', why: 'images_need_mac' })
    }
    // A voice-mode send keeps its spoken-answer line, as on the Mac.
    const voice = await request(r.app).post(`/api/v1/sessions/${SID_A}/messages`).set(auth).send({ text: 'Read me the status', voice: true })
    expect(voice.status).toBe(202)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toBe(applyVoiceReply('Read me the status'))
    expect(delivered[1]).toContain(VOICE_REPLY_MARKER)
    expect((await request(r.app).post(`/api/v1/sessions/${SID_A}/messages`).set(auth).send({ text: 'x', voice: 'yes' })).status).toBe(400)
    expect(delivered).toHaveLength(2)
    const post = await request(r.app).post(`/api/v1/tasks/${TASK_A}/board/threads/build`).set(auth).send({ text: 'Looks good' })
    expect(post.status).toBe(201)
    expect(r.records().map((x) => x.kind)).toEqual(['delivery', 'delivery', 'board'])
    // Read back away: the post is the person's (not a task's), marked; the copy's writer and time stay.
    const board = await request(r.app).get(`/api/v1/tasks/${TASK_A}/board?team=1`).set(auth).set('x-test-away', '1')
    expect(board.status).toBe(200)
    expect(board.body.threads.build).toEqual([expect.objectContaining({ author: 'user', text: 'Looks good', id: post.body.message.id })])
    expect(board.body.replica_sync).toBe('pending')
    expect(board.body.board).toEqual({ html: '<p id="build">Build: green</p>', version: 2, updated_at: '2026-10-14T11:00:00.000Z', updated_by: 'human' })
    // The same team Board opened from the worker's task: the leader's Board, with the post and its mark.
    const fromWorker = await request(r.app).get(`/api/v1/tasks/${TASK_B}/board?team=1`).set(auth).set('x-test-away', '1')
    expect(fromWorker.body.board_task_id).toBe(TASK_A)
    expect(fromWorker.body.threads.build).toEqual([expect.objectContaining({ author: 'user', text: 'Looks good', id: post.body.message.id })])
    expect(fromWorker.body.replica_sync).toBe('pending')
    // The worker's own Board (no team) is another document: nothing of the post.
    const own = await request(r.app).get(`/api/v1/tasks/${TASK_B}/board`).set(auth).set('x-test-away', '1')
    expect(own.body.threads).toEqual({})
    expect(own.body.replica_sync).toBeUndefined()
  })

  it('a device revoke while away is that device\'s own sign-out only: off the device copy at once, journaled; removing another device needs the Mac (plan WP10)', async () => {
    const r = rig()
    const other = await request(r.app).delete('/api/devices/Acme%20tablet').set(auth)
    expect(other.status).toBe(503)
    expect(other.body.error).toMatchObject({ why: 'device_changes_need_mac' })
    // `?target=cloud` names a pairing on the cloud companion, never this device's own: the Mac's.
    const cloud = await request(r.app).delete('/api/devices/Marina%20phone?target=cloud').set(auth)
    expect(cloud.status).toBe(503)
    expect(cloud.body.error).toMatchObject({ why: 'device_changes_need_mac' })
    expect(r.devices.verify(PHONE_TOKEN)).toBe('Marina phone')
    expect(r.records()).toEqual([])
    expect(r.devices.verify(TABLET_TOKEN)).toBe('Acme tablet')
    const self = await request(r.app).delete('/api/devices/Marina%20phone').set(auth)
    expect(self.status).toBe(200)
    expect(r.devices.verify(PHONE_TOKEN)).toBeNull()
    expect(r.records()[0]).toMatchObject({ kind: 'device-revoke', deviceId: 'dev-marina-phone' })
    // The Mac's next list still names it (it has not drained yet): it stays off.
    r.devices.put({ devices: [
      { id: 'dev-marina-phone', name: 'Marina phone', tokenHash: sha(PHONE_TOKEN) },
      { id: 'dev-acme-tablet', name: 'Acme tablet', tokenHash: sha(TABLET_TOKEN) },
    ] })
    expect(r.devices.verify(PHONE_TOKEN)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'replica', 'devices.json'), 'utf8')).revoked).toEqual([sha(PHONE_TOKEN)])
    // Not applied on the Mac yet: its list names the device (the overlay's mark waits for this).
    expect(r.devices.namedByMac('dev-marina-phone')).toBe(true)
    // The Mac applied it (its list drops the device): the hold ends with it.
    r.devices.put({ devices: [{ id: 'dev-acme-tablet', name: 'Acme tablet', tokenHash: sha(TABLET_TOKEN) }] })
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'replica', 'devices.json'), 'utf8')).revoked).toBeUndefined()
    expect(r.devices.namedByMac('dev-marina-phone')).toBe(false)
    expect(r.devices.namedByMac('dev-acme-tablet')).toBe(true)
    // A copy that heard no list since it started cannot tell: named.
    expect(createDeviceCopy(path.join(r.dir, 'replica', 'devices.json')).namedByMac('dev-marina-phone')).toBe(true)
    // A token the device copy has no stable id for cannot write (the Mac could not check it later).
    const anon = await request(r.app).patch(`/api/tasks/${TASK_A}`).set({ authorization: 'Bearer nobody' }).send({ title: 'x' })
    expect(anon.status).toBe(503)
    expect(anon.body.error).toMatchObject({ why: 'device_changes_need_mac' })
  })
})

describe('away routes: a journal that does not take the write (row R20)', () => {
  it('a full journal answers 503 queue_full and keeps what it holds; the console says so in plain words', async () => {
    const r = rig([], { journal: { maxRecords: 2 } })
    expect((await request(r.app).patch(`/api/tasks/${TASK_A}`).set(auth).send({ title: 'First away edit' })).status).toBe(200)
    expect((await request(r.app).post('/api/tasks').set(auth).send({ title: 'Second away write', project: 'Acme' })).status).toBe(201)
    const before = r.records()
    const full = await request(r.app).post(`/api/tasks/${TASK_B}/complete`).set(auth)
    expect(full.status).toBe(503)
    expect(full.headers['retry-after']).toBe('5')
    expect(full.body.error).toMatchObject({ code: 'queue_full', retryAfter: 5 })
    // Nothing of it was kept, and nothing earlier was lost.
    expect(r.records()).toEqual(before)
    const list = await request(r.app).get('/api/tasks').set(auth).set('x-test-away', '1')
    const byId = new Map((list.body.tasks as Array<{ id: string }>).map((t) => [t.id, t]))
    expect(byId.get(TASK_A)).toMatchObject({ title: 'First away edit', replica_sync: 'pending' })
    expect(byId.get(TASK_B)).toMatchObject({ phase: 'IN_PROGRESS' })
    expect(byId.get(TASK_B)).not.toHaveProperty('replica_sync')
    // The words the console shows for this answer (web/src/api/client.ts reads the body and its status).
    const words = leaderErrorMessage(full.body, full.status)
    expect(words).toBe('This host already keeps as many changes as it can until your Mac is back; this one was not kept. Try it again once your Mac is back.')
    expect(isLeaderWords(words)).toBe(true)
  })

  it('a journal that cannot be written (a full disk) answers 503 journal_unwritable, keeps what it holds, and takes the same write once the disk has room', async () => {
    const disk = { full: false }
    const fullDiskFs = {
      ...fs,
      writeSync: (...a: Parameters<typeof fs.writeSync>) => {
        if (disk.full) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        return (fs.writeSync as (...b: unknown[]) => number)(...a)
      },
    } as unknown as typeof fs
    const r = rig([], { journal: { fs: fullDiskFs } })
    expect((await request(r.app).patch(`/api/tasks/${TASK_A}`).set(auth).send({ title: 'Kept before the disk filled' })).status).toBe(200)
    const before = r.records()
    disk.full = true
    const refused = await request(r.app).patch(`/api/tasks/${TASK_B}`).set(auth).set('x-walnut-op-id', 'op-console-disk-0001').send({ title: 'Written on a full disk' })
    expect(refused.status).toBe(503)
    expect(refused.headers['retry-after']).toBe('5')
    expect(refused.body.error).toMatchObject({ code: 'journal_unwritable', why: 'disk_full' })
    expect(r.records()).toEqual(before)
    const words = leaderErrorMessage(refused.body, refused.status)
    expect(words).toBe('This host could not keep this change: its disk is full. The changes it kept before are safe.')
    expect(isLeaderWords(words)).toBe(true)
    // The earlier write still shows; the refused one shows nowhere.
    const list = await request(r.app).get('/api/tasks').set(auth).set('x-test-away', '1')
    const byId = new Map((list.body.tasks as Array<{ id: string; title: string }>).map((t) => [t.id, t]))
    expect(byId.get(TASK_A)).toMatchObject({ title: 'Kept before the disk filled', replica_sync: 'pending' })
    expect(byId.get(TASK_B)).toMatchObject({ title: 'Worker: build the page' })
    // Room again: the same write (its op id kept) is journaled once.
    disk.full = false
    const again = await request(r.app).patch(`/api/tasks/${TASK_B}`).set(auth).set('x-walnut-op-id', 'op-console-disk-0001').send({ title: 'Written on a full disk' })
    expect(again.status).toBe(200)
    expect(r.records().filter((x) => x.opId === 'op-console-disk-0001')).toHaveLength(1)
  })
})

describe('away routes: the Mac\'s checks and derivations', () => {
  it('a bare status shows the phase the Mac will store; a field the Mac would refuse answers 400 and journals nothing', async () => {
    const r = rig()
    const done = await request(r.app).patch(`/api/tasks/${TASK_B}`).set(auth).send({ status: 'done' })
    expect(done.status).toBe(200)
    expect(done.body.task).toMatchObject({ id: TASK_B, status: 'done', phase: 'COMPLETE', replica_sync: 'pending' })
    const one = await request(r.app).get(`/api/tasks/${TASK_B}`).set(auth).set('x-test-away', '1')
    expect(one.body.task).toMatchObject({ status: 'done', phase: 'COMPLETE', replica_sync: 'pending' })
    const bad = await request(r.app).patch(`/api/tasks/${TASK_A}`).set(auth).send({ priority: 'whenever' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/^priority must be one of/) })
    expect(r.records().map((x) => x.taskId)).toEqual([TASK_B])
  })
})
